'use strict';

// Códigos de Alma que significan "no existe": ítem por código de barras y usuario.
const NOT_FOUND_CODES = new Set(['401689', '401690', '401861', '401890']);
const UNAUTHORIZED_CODES = new Set(['UNAUTHORIZED', 'INVALID_REQUEST_KEY']);

class AlmaError extends Error {
  constructor(message, { status, code, trackingId, cause } = {}) {
    super(message, { cause });
    this.name = 'AlmaError';
    this.status = status;
    this.code = code;
    this.trackingId = trackingId;
  }
}

class AlmaNotFoundError extends AlmaError {
  name = 'AlmaNotFoundError';
}

class AlmaUnauthorizedError extends AlmaError {
  name = 'AlmaUnauthorizedError';
}

class AlmaUnavailableError extends AlmaError {
  name = 'AlmaUnavailableError';
}

// Alma responde errores en JSON o en XML según el endpoint.
function parseAlmaError(body) {
  if (!body) return {};
  try {
    const error = JSON.parse(body)?.errorList?.error;
    const first = Array.isArray(error) ? error[0] : error;
    if (first) {
      return { code: String(first.errorCode ?? ''), message: first.errorMessage, trackingId: first.trackingId };
    }
  } catch {
    // no es JSON
  }
  const tag = (name) => body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
  return { code: tag('errorCode'), message: tag('errorMessage'), trackingId: tag('trackingId') };
}

// La API key viaja solo en el header; Alma la agrega a las URL de redirección y ahí se elimina.
function stripApiKey(url) {
  url.searchParams.delete('apikey');
  return url;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createAlmaClient({
  host,
  path = '/almaws/v1',
  apiKey,
  timeoutMs = 8000,
  retries = 1,
  retryDelayMs = 300,
  maxRedirects = 3,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) throw new Error('Se requiere la API key de Alma');
  const base = new URL(host);
  const basePath = path.replace(/\/+$/, '');
  const headers = { Authorization: `apikey ${apiKey}`, Accept: 'application/json' };

  function buildUrl(endpoint, query) {
    const url = /^https?:\/\//i.test(endpoint) ? new URL(endpoint) : new URL(basePath + endpoint, base);
    if (url.origin !== base.origin) throw new AlmaError(`Host no permitido: ${url.origin}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return stripApiKey(url);
  }

  async function requestOnce(url) {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let res;
      let text;
      try {
        res = await fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status >= 300 && res.status < 400) {
          res.body?.cancel().catch(() => {});
        } else {
          text = await res.text();
        }
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        throw new AlmaUnavailableError(
          timedOut ? `Alma no respondió en ${timeoutMs} ms` : 'No fue posible conectar con Alma',
          { cause: err },
        );
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new AlmaError(`Redirección sin destino (${res.status})`, { status: res.status });
        current = stripApiKey(new URL(location, current));
        if (current.origin !== base.origin) {
          throw new AlmaError('Redirección de Alma a un host no permitido', { status: res.status });
        }
        continue;
      }

      if (res.ok) {
        try {
          return text ? JSON.parse(text) : {};
        } catch (err) {
          throw new AlmaError('La respuesta de Alma no es JSON válido', { status: res.status, cause: err });
        }
      }

      const info = parseAlmaError(text);
      const message = info.message || `Error HTTP ${res.status} de Alma`;
      const details = { status: res.status, code: info.code, trackingId: info.trackingId };
      if (NOT_FOUND_CODES.has(info.code) || res.status === 404) throw new AlmaNotFoundError(message, details);
      if (UNAUTHORIZED_CODES.has(info.code) || res.status === 401 || res.status === 403) {
        throw new AlmaUnauthorizedError(message, details);
      }
      if (res.status === 429 || res.status >= 500) throw new AlmaUnavailableError(message, details);
      throw new AlmaError(message, details);
    }
    throw new AlmaError('Demasiadas redirecciones desde Alma');
  }

  async function get(endpoint, query) {
    const url = buildUrl(endpoint, query);
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestOnce(url);
      } catch (err) {
        if (!(err instanceof AlmaUnavailableError) || attempt >= retries) throw err;
        await sleep(retryDelayMs);
      }
    }
  }

  return { get };
}

module.exports = {
  createAlmaClient,
  AlmaError,
  AlmaNotFoundError,
  AlmaUnauthorizedError,
  AlmaUnavailableError,
};
