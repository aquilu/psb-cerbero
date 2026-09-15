'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');
const request = require('supertest');

const { version } = require('../package.json');
const { createApp } = require('../src/app');
const { loadConfig, validateConfig } = require('../src/config');
const { clientKey, stripPort } = require('../src/middleware/rate-limit');
const { createGateService } = require('../src/services/gate');
const { makeItem, makeLoan, createFakeAlma, silentLogger } = require('./helpers/fake-alma');

const PIN = '24681357';
const COOKIE_SECRET = 'secreto-de-cookie-solo-para-pruebas-0123456789';
const WEBHOOK_SECRET = 'secreto-webhook';

function testConfig(env = {}) {
  return loadConfig({ ALMA_API_KEY: 'clave-de-prueba', ...env }, {});
}

function buildApp({ env, gate, almaOptions, now } = {}) {
  const onLoan = makeItem({ barcode: '29000000000001', pid: '230000000000017486', base: '0', process: 'LOAN' });
  const inPlace = makeItem({ barcode: '29000000000002', pid: '230000000000027486' });
  const alma = createFakeAlma({
    items: [onLoan, inPlace],
    loans: [{ itemPid: onLoan.item_data.pid, loan: makeLoan({ item: onLoan }) }],
    ...almaOptions,
  });
  return createApp({
    config: testConfig(env),
    gate: gate || createGateService({ alma, logger: silentLogger }),
    logger: silentLogger,
    logRequests: false,
    now,
  });
}

const cookieFrom = (res) => res.headers['set-cookie'][0].split(';')[0];

describe('config', () => {
  it('acepta API_KEY (v1) y config.json como respaldo', () => {
    assert.equal(loadConfig({ API_KEY: 'desde-env' }, {}).alma.apiKey, 'desde-env');
    const legacy = loadConfig({}, { API_KEY: 'desde-json', ALMA_HOST: 'https://api-eu.hosted.exlibrisgroup.com/' });
    assert.equal(legacy.alma.apiKey, 'desde-json');
    assert.equal(legacy.alma.host, 'https://api-eu.hosted.exlibrisgroup.com');
  });

  it('valida variables obligatorias y la fuerza de los secretos', () => {
    assert.match(validateConfig(loadConfig({}, {})).join(), /ALMA_API_KEY/);
    assert.match(validateConfig(testConfig({ ACCESS_PIN: '1234', COOKIE_SECRET })).join(), /al menos 8/);
    assert.match(validateConfig(testConfig({ ACCESS_PIN: PIN, COOKIE_SECRET: 'corto' })).join(), /COOKIE_SECRET/);
    assert.deepEqual(validateConfig(testConfig({ ACCESS_PIN: PIN, COOKIE_SECRET })), []);
    assert.deepEqual(validateConfig(testConfig()), []);
  });

  it('en producción o en Azure exige ACCESS_PIN, salvo ALLOW_OPEN_ACCESS=true', () => {
    assert.match(validateConfig(testConfig({ NODE_ENV: 'production' })).join(), /ACCESS_PIN es obligatorio/);
    assert.match(validateConfig(testConfig({ WEBSITE_SITE_NAME: 'yita' })).join(), /ACCESS_PIN es obligatorio/);
    assert.deepEqual(validateConfig(testConfig({ NODE_ENV: 'production', ALLOW_OPEN_ACCESS: 'true' })), []);
    assert.deepEqual(validateConfig(testConfig({ NODE_ENV: 'production', ACCESS_PIN: PIN, COOKIE_SECRET })), []);
  });

  it('solo confía en el proxy en Azure o si se configura', () => {
    assert.equal(testConfig().trustProxy, false);
    assert.equal(testConfig({ WEBSITE_SITE_NAME: 'yita' }).trustProxy, 1);
    assert.equal(testConfig({ WEBSITE_SITE_NAME: 'yita', TRUST_PROXY: 'false' }).trustProxy, false);
    assert.equal(testConfig({ TRUST_PROXY: 'true' }).trustProxy, 1);
    assert.equal(testConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
  });

  it('usa America/Bogota si TZ no es válida', () => {
    assert.equal(testConfig({ TZ: 'Marte/Olympus' }).timeZone, 'America/Bogota');
  });
});

describe('rate-limit', () => {
  it('normaliza la IP: sin puerto (Azure) y sin prefijo IPv4 mapeado', () => {
    assert.equal(stripPort('198.51.100.7:40001'), '198.51.100.7');
    assert.equal(stripPort('::ffff:192.168.0.108'), '192.168.0.108');
    assert.equal(stripPort('[2001:db8::1]:443'), '2001:db8::1');
    assert.equal(clientKey({ ip: '198.51.100.7:40001' }), clientKey({ ip: '198.51.100.7:40002' }));
    assert.notEqual(clientKey({ ip: '::ffff:192.168.0.108' }), clientKey({ ip: '::ffff:192.168.0.109' }));
  });
});

describe('app', () => {
  it('GET /healthz responde ok, sin versión y con cabeceras de seguridad', async () => {
    const res = await request(buildApp()).get('/healthz').expect(200);
    assert.deepEqual(res.body, { status: 'ok' });
    assert.ok(res.headers['content-security-policy']);
  });

  it('GET / sirve la interfaz con cabeceras de seguridad estrictas', async () => {
    const res = await request(buildApp()).get('/').expect(200).expect('content-type', /html/);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /font-src 'self'(;|$)/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(res.headers['permissions-policy'], /camera=\(\)/);
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  it('SHOW_COVERS=false quita los dominios de portadas de la CSP', async () => {
    const on = await request(buildApp()).get('/');
    assert.match(on.headers['content-security-policy'], /covers\.openlibrary\.org/);

    const off = buildApp({ env: { SHOW_COVERS: 'false' } });
    assert.doesNotMatch((await request(off).get('/')).headers['content-security-policy'], /openlibrary|google/);
    assert.equal((await request(off).get('/api/status')).body.showCovers, false);
  });

  it('COOP y HSTS solo sobre HTTPS a través de un proxy de confianza', async () => {
    const spoofed = await request(buildApp()).get('/').set('X-Forwarded-Proto', 'https').expect(200);
    assert.equal(spoofed.headers['strict-transport-security'], undefined, 'sin proxy de confianza se ignora');
    assert.equal(spoofed.headers['cross-origin-opener-policy'], undefined);
    assert.equal(spoofed.headers['origin-agent-cluster'], undefined);

    const azure = await request(buildApp({ env: { TRUST_PROXY: '1' } }))
      .get('/')
      .set('X-Forwarded-Proto', 'https')
      .expect(200);
    assert.equal(azure.headers['cross-origin-opener-policy'], 'same-origin');
    assert.match(azure.headers['strict-transport-security'], /max-age=31536000/);
  });

  it('GET /api/items/:barcode devuelve el veredicto sin caché', async () => {
    const app = buildApp();

    const ok = await request(app).get('/api/items/29000000000001').expect(200);
    assert.equal(ok.body.verdict, 'PRESTADO');
    assert.equal(ok.headers['cache-control'], 'no-store');

    const stop = await request(app).get('/api/items/29000000000002').expect(200);
    assert.equal(stop.body.verdict, 'NO_PRESTADO');
    assert.equal(stop.body.allowed, false);

    const missing = await request(app).get('/api/items/29009999999999').expect(404);
    assert.equal(missing.body.verdict, 'NO_ENCONTRADO');
    assert.equal(missing.headers['cache-control'], 'no-store');
  });

  it('responde 502 con ERROR_ALMA si Alma no está disponible', async () => {
    const res = await request(buildApp({ almaOptions: { unavailable: true } }))
      .get('/api/items/29000000000001')
      .expect(502);
    assert.equal(res.body.verdict, 'ERROR_ALMA');
  });

  it('no expone detalles de errores internos ni de validación', async () => {
    const gate = { checkItem: async () => { throw new Error('detalle interno secreto'); } };
    const internal = await request(buildApp({ gate })).get('/api/items/123').expect(500);
    assert.deepEqual(internal.body, { error: 'Error interno del servidor.' });

    const badParam = await request(buildApp()).get('/api/items/%E0%A4%A').expect(400);
    assert.deepEqual(badParam.body, { error: 'Solicitud inválida.' });

    const badJson = await request(buildApp())
      .post('/api/access')
      .set('Content-Type', 'application/json')
      .send('{"pin":')
      .expect(400);
    assert.deepEqual(badJson.body, { error: 'Solicitud inválida.' });
    assert.equal(badJson.headers['cache-control'], 'no-store');
  });

  describe('ACCESS_PIN', () => {
    const env = { ACCESS_PIN: PIN, COOKIE_SECRET };

    it('exige el PIN antes de consultar y solo muestra la versión con acceso', async () => {
      const agent = request.agent(buildApp({ env }));

      const status = await agent.get('/api/status').expect(200);
      assert.equal(status.body.accessRequired, true);
      assert.equal(status.body.authorized, false);
      assert.equal(status.body.version, undefined);

      const denied = await agent.get('/api/items/29000000000001').expect(401);
      assert.equal(denied.headers['cache-control'], 'no-store');
      await agent.post('/api/access').send({ pin: '00000000' }).expect(401);
      await agent.post('/api/access').send({ pin: PIN }).expect(200);

      assert.equal((await agent.get('/api/items/29000000000001').expect(200)).body.verdict, 'PRESTADO');
      assert.equal((await agent.get('/api/status')).body.version, version);
    });

    it('cada inicio de sesión emite un token distinto y el cierre de sesión lo revoca', async () => {
      const app = buildApp({ env });
      const first = cookieFrom(await request(app).post('/api/access').send({ pin: PIN }).expect(200));
      const second = cookieFrom(await request(app).post('/api/access').send({ pin: PIN }).expect(200));
      assert.notEqual(first, second);

      await request(app).get('/api/items/29000000000001').set('Cookie', first).expect(200);
      await request(app).post('/api/logout').set('Cookie', first).send({}).expect(200);
      await request(app).get('/api/items/29000000000001').set('Cookie', first).expect(401);
      await request(app).get('/api/items/29000000000001').set('Cookie', second).expect(200);
    });

    it('la sesión vence a las 12 horas aunque el navegador conserve la cookie', async () => {
      let clock = Date.parse('2026-09-15T12:00:00Z');
      const app = buildApp({ env, now: () => clock });
      const cookie = cookieFrom(await request(app).post('/api/access').send({ pin: PIN }).expect(200));

      clock += 11 * 60 * 60 * 1000;
      await request(app).get('/api/items/29000000000001').set('Cookie', cookie).expect(200);
      clock += 2 * 60 * 60 * 1000;
      await request(app).get('/api/items/29000000000001').set('Cookie', cookie).expect(401);
    });

    it('rechaza cookies manipuladas', async () => {
      const app = buildApp({ env });
      const [name, value] = cookieFrom(await request(app).post('/api/access').send({ pin: PIN })).split('=');
      const [, nonce, signature] = value.split('.');
      const extended = `${name}=${Date.now() + 10 * 60 * 60 * 1000}.${nonce}.${signature}`;

      await request(app).get('/api/items/29000000000001').set('Cookie', extended).expect(401);
      await request(app).get('/api/items/29000000000001').set('Cookie', `${name}=cualquier-cosa`).expect(401);
    });

    it('frena la fuerza bruta del PIN por IP y X-Forwarded-For no lo evita', async () => {
      const app = buildApp({ env });
      for (let i = 0; i < 10; i++) {
        await request(app).post('/api/access').set('X-Forwarded-For', `10.9.0.${i}`).send({ pin: '00000000' }).expect(401);
      }
      await request(app).post('/api/access').set('X-Forwarded-For', '10.9.0.99').send({ pin: PIN }).expect(429);
    });

    it('rechaza POST desde otro sitio (CSRF) o sin JSON', async () => {
      const app = buildApp({ env });
      await request(app).post('/api/logout').set('Sec-Fetch-Site', 'cross-site').send({}).expect(403);
      await request(app).post('/api/logout').set('Origin', 'https://evil.example').send({}).expect(403);
      await request(app).post('/api/logout').set('Content-Type', 'text/plain').send('x').expect(415);
      await request(app)
        .post('/api/access')
        .set('Host', 'yita.example')
        .set('Origin', 'https://yita.example')
        .set('Sec-Fetch-Site', 'same-origin')
        .send({ pin: PIN })
        .expect(200);
    });
  });

  describe('webhooks', () => {
    const env = { WEBHOOK_SECRET };
    const sign = (body) => crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');
    const post = (app, body, signature) => {
      const req = request(app).post('/webhooks').set('Content-Type', 'application/json');
      return (signature ? req.set('X-Exl-Signature', signature) : req).send(body);
    };

    it('sin WEBHOOK_SECRET la ruta no existe', async () => {
      await request(buildApp()).get('/webhooks?challenge=abc').expect(404);
      await request(buildApp()).post('/webhooks').send({ action: 'LOAN' }).expect(404);
    });

    it('responde el desafío de Alma y rechaza valores inválidos', async () => {
      const app = buildApp({ env });
      const res = await request(app).get('/webhooks?challenge=abc-123').expect(200);
      assert.deepEqual(res.body, { challenge: 'abc-123' });
      await request(app).get('/webhooks?challenge=%3Cscript%3Ealert(1)%3C%2Fscript%3E').expect(400);
    });

    it('valida la firma sobre el cuerpo crudo', async () => {
      const app = buildApp({ env });
      const body = '{"action":"LOAN",  "id":"1"}';
      await post(app, body, sign(body)).expect(204);
      await post(app, body, 'firma-falsa').expect(401);
      await post(app, body).expect(401);
    });

    it('rechaza cuerpos sin action', async () => {
      const app = buildApp({ env });
      const body = '{"id":"1"}';
      await post(app, body, sign(body)).expect(400);
    });
  });
});
