'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');
const request = require('supertest');

const { createApp } = require('../src/app');
const { loadConfig, validateConfig } = require('../src/config');
const { createGateService } = require('../src/services/gate');
const { makeItem, makeLoan, createFakeAlma, silentLogger } = require('./helpers/fake-alma');

function testConfig(env = {}) {
  return loadConfig({ ALMA_API_KEY: 'clave-de-prueba', ...env }, {});
}

function buildApp({ env, gate, almaOptions } = {}) {
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
  });
}

describe('config', () => {
  it('acepta API_KEY (v1) y config.json como respaldo', () => {
    assert.equal(loadConfig({ API_KEY: 'desde-env' }, {}).alma.apiKey, 'desde-env');
    const legacy = loadConfig({}, { API_KEY: 'desde-json', ALMA_HOST: 'https://api-eu.hosted.exlibrisgroup.com/' });
    assert.equal(legacy.alma.apiKey, 'desde-json');
    assert.equal(legacy.alma.host, 'https://api-eu.hosted.exlibrisgroup.com');
  });

  it('valida variables obligatorias', () => {
    assert.match(validateConfig(loadConfig({}, {})).join(), /ALMA_API_KEY/);
    assert.match(validateConfig(testConfig({ ACCESS_PIN: '1234' })).join(), /COOKIE_SECRET/);
    assert.deepEqual(validateConfig(testConfig()), []);
  });

  it('usa America/Bogota si TZ no es válida', () => {
    assert.equal(testConfig({ TZ: 'Marte/Olympus' }).timeZone, 'America/Bogota');
  });
});

describe('app', () => {
  it('GET /healthz responde ok', async () => {
    const res = await request(buildApp()).get('/healthz').expect(200);
    assert.equal(res.body.status, 'ok');
  });

  it('GET / sirve la interfaz con cabeceras de seguridad', async () => {
    const res = await request(buildApp()).get('/').expect(200).expect('content-type', /html/);
    assert.ok(res.headers['content-security-policy']);
    assert.equal(res.headers['x-powered-by'], undefined);
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
  });

  it('responde 502 con ERROR_ALMA si Alma no está disponible', async () => {
    const res = await request(buildApp({ almaOptions: { unavailable: true } }))
      .get('/api/items/29000000000001')
      .expect(502);
    assert.equal(res.body.verdict, 'ERROR_ALMA');
  });

  it('no expone el stack de errores internos', async () => {
    const gate = { checkItem: async () => { throw new Error('detalle interno secreto'); } };
    const res = await request(buildApp({ gate })).get('/api/items/123').expect(500);
    assert.deepEqual(res.body, { error: 'Error interno del servidor.' });
  });

  describe('ACCESS_PIN', () => {
    const env = { ACCESS_PIN: '2468', COOKIE_SECRET: 'secreto-cookie' };

    it('exige el PIN antes de consultar', async () => {
      const agent = request.agent(buildApp({ env }));

      const status = await agent.get('/api/status').expect(200);
      assert.equal(status.body.accessRequired, true);
      assert.equal(status.body.authorized, false);

      await agent.get('/api/items/29000000000001').expect(401);
      await agent.post('/api/access').send({ pin: '0000' }).expect(401);
      await agent.post('/api/access').send({ pin: '2468' }).expect(200);
      const res = await agent.get('/api/items/29000000000001').expect(200);
      assert.equal(res.body.verdict, 'PRESTADO');
    });
  });

  describe('webhooks', () => {
    const secret = 'secreto-webhook';
    const sign = (body) => crypto.createHmac('sha256', secret).update(body).digest('base64');

    it('responde el desafío de Alma', async () => {
      const res = await request(buildApp()).get('/webhooks?challenge=abc').expect(200);
      assert.deepEqual(res.body, { challenge: 'abc' });
    });

    it('sin WEBHOOK_SECRET responde 503 en vez de fallar', async () => {
      await request(buildApp()).post('/webhooks').send({ action: 'LOAN' }).expect(503);
    });

    it('valida la firma sobre el cuerpo crudo', async () => {
      const app = buildApp({ env: { WEBHOOK_SECRET: secret } });
      const body = '{"action":"LOAN",  "id":"1"}';

      await request(app).post('/webhooks').set('content-type', 'application/json').set('X-Exl-Signature', sign(body)).send(body).expect(204);
      await request(app).post('/webhooks').set('content-type', 'application/json').set('X-Exl-Signature', 'firma-falsa').send(body).expect(401);
      await request(app).post('/webhooks').set('content-type', 'application/json').send(body).expect(401);
    });

    it('rechaza cuerpos sin action', async () => {
      const app = buildApp({ env: { WEBHOOK_SECRET: secret } });
      const body = '{"id":"1"}';
      await request(app).post('/webhooks').set('content-type', 'application/json').set('X-Exl-Signature', sign(body)).send(body).expect(400);
    });
  });
});
