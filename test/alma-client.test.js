'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createAlmaClient,
  AlmaError,
  AlmaNotFoundError,
  AlmaUnauthorizedError,
  AlmaUnavailableError,
} = require('../src/alma/client');

const KEY = 'l8xxCLAVEDEPRUEBA';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return handler(new URL(String(url)), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(fetchImpl, options = {}) {
  return createAlmaClient({
    host: 'https://alma.test',
    path: '/almaws/v1',
    apiKey: KEY,
    retryDelayMs: 1,
    fetchImpl,
    ...options,
  });
}

describe('alma client', () => {
  it('envía la API key solo en el header y codifica los parámetros', async () => {
    const fetchImpl = fakeFetch(() => json(200, { ok: true }));

    await client(fetchImpl).get('/items', { item_barcode: 'abc&limit=1' });

    const [{ url, init }] = fetchImpl.calls;
    assert.equal(url.pathname, '/almaws/v1/items');
    assert.equal(url.searchParams.get('item_barcode'), 'abc&limit=1');
    assert.equal(url.searchParams.has('limit'), false);
    assert.equal(url.searchParams.has('apikey'), false);
    assert.ok(!url.href.includes(KEY));
    assert.equal(init.headers.Authorization, `apikey ${KEY}`);
    assert.equal(init.headers.Accept, 'application/json');
  });

  it('sigue la redirección de /items quitando la apikey de la URL', async () => {
    const fetchImpl = fakeFetch((url, init, n) =>
      n === 1
        ? new Response(null, {
            status: 302,
            headers: { location: `https://alma.test/almaws/v1/bibs/1/holdings/2/items/3?apikey=${KEY}` },
          })
        : json(200, { item_data: { pid: '3' } }),
    );

    const data = await client(fetchImpl).get('/items', { item_barcode: '123' });

    assert.equal(data.item_data.pid, '3');
    assert.equal(fetchImpl.calls[1].url.pathname, '/almaws/v1/bibs/1/holdings/2/items/3');
    assert.ok(!fetchImpl.calls[1].url.href.includes(KEY));
    assert.equal(fetchImpl.calls[1].init.headers.Authorization, `apikey ${KEY}`);
  });

  it('no sigue redirecciones ni URLs hacia otro host', async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://malicioso.test/x' } }));

    await assert.rejects(client(fetchImpl).get('/items'), AlmaError);
    await assert.rejects(client(fetchImpl).get('https://otro.test/almaws/v1/items'), /Host no permitido/);
  });

  it('traduce el código 401689 a AlmaNotFoundError', async () => {
    const fetchImpl = fakeFetch(() =>
      json(400, { errorsExist: true, errorList: { error: [{ errorCode: '401689', errorMessage: 'No items found' }] } }),
    );

    await assert.rejects(client(fetchImpl).get('/items'), (err) => {
      assert.ok(err instanceof AlmaNotFoundError);
      assert.equal(err.code, '401689');
      return true;
    });
  });

  it('traduce el error UNAUTHORIZED en XML a AlmaUnauthorizedError', async () => {
    const xml =
      '<web_service_result><errorsExist>true</errorsExist><errorList><error><errorCode>UNAUTHORIZED</errorCode>' +
      '<errorMessage>API-key not defined or not configured to allow this API.</errorMessage></error></errorList></web_service_result>';
    const fetchImpl = fakeFetch(() => new Response(xml, { status: 400, headers: { 'content-type': 'application/xml' } }));

    await assert.rejects(client(fetchImpl).get('/users/1'), AlmaUnauthorizedError);
  });

  it('reintenta una vez ante errores 5xx', async () => {
    const fetchImpl = fakeFetch((url, init, n) => (n === 1 ? new Response('fallo', { status: 503 }) : json(200, { ok: 1 })));

    const data = await client(fetchImpl).get('/items');

    assert.deepEqual(data, { ok: 1 });
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('no reintenta errores de negocio (4xx)', async () => {
    const fetchImpl = fakeFetch(() => json(400, { errorList: { error: [{ errorCode: '401689' }] } }));

    await assert.rejects(client(fetchImpl).get('/items'), AlmaNotFoundError);
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('corta por timeout y reporta AlmaUnavailableError', async () => {
    const fetchImpl = fakeFetch(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    );

    await assert.rejects(client(fetchImpl, { timeoutMs: 20, retries: 0 }).get('/items'), (err) => {
      assert.ok(err instanceof AlmaUnavailableError);
      assert.match(err.message, /no respondió en 20 ms/);
      return true;
    });
  });
});
