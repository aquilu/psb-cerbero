'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const pkg = require('../package.json');

const DEFAULT_TIME_ZONE = 'America/Bogota';
const MIN_PIN_LENGTH = 8;
const MIN_COOKIE_SECRET_LENGTH = 32;

// Compatibilidad con v1: config.json con ALMA_HOST, ALMA_PATH, API_KEY y WEBHOOK_SECRET.
function readLegacyConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|si|sí)$/i.test(String(value).trim());
}

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('es-CO', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Solo se confía en X-Forwarded-For/-Proto detrás de un proxy conocido. Azure App Service define
// WEBSITE_SITE_NAME y termina TLS en un salto; en la red interna no hay proxy y confiar en esas
// cabeceras permitiría falsificar la IP (saltarse los límites de intentos) y el protocolo.
function resolveTrustProxy(value, env) {
  if (!value) return env.WEBSITE_SITE_NAME ? 1 : false;
  if (/^(false|0|no)$/i.test(value)) return false;
  if (/^(true|yes|si|sí)$/i.test(value)) return 1;
  return /^\d+$/.test(value) ? Number(value) : value;
}

function loadConfig(env = process.env, legacy = readLegacyConfig()) {
  const get = (...keys) => {
    for (const key of keys) {
      if (env[key]) return String(env[key]).trim();
      if (legacy[key]) return String(legacy[key]).trim();
    }
    return '';
  };
  const timeZone = get('TZ');

  return {
    version: pkg.version,
    // Azure App Service no define NODE_ENV: WEBSITE_SITE_NAME también cuenta como producción
    isProduction: env.NODE_ENV === 'production' || Boolean(env.WEBSITE_SITE_NAME),
    port: get('PORT') || '3000',
    timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE,
    alma: {
      host: (get('ALMA_HOST') || 'https://api-na.hosted.exlibrisgroup.com').replace(/\/+$/, ''),
      path: '/' + (get('ALMA_PATH') || '/almaws/v1').replace(/^\/+|\/+$/g, ''),
      apiKey: get('ALMA_API_KEY', 'API_KEY'),
      timeoutMs: toPositiveInt(get('ALMA_TIMEOUT_MS'), 8000),
    },
    webhookSecret: get('WEBHOOK_SECRET'),
    accessPin: get('ACCESS_PIN'),
    cookieSecret: get('COOKIE_SECRET'),
    allowOpenAccess: toBool(get('ALLOW_OPEN_ACCESS'), false),
    trustProxy: resolveTrustProxy(get('TRUST_PROXY'), env),
    showFullUserId: toBool(get('SHOW_FULL_USER_ID'), true),
    showCovers: toBool(get('SHOW_COVERS'), true),
    overdueGraceDays: Math.max(0, Number.parseInt(get('OVERDUE_GRACE_DAYS'), 10) || 0),
  };
}

function validateConfig(config) {
  const errors = [];
  if (!config.alma.apiKey) errors.push('Falta ALMA_API_KEY (API key de Alma).');
  try {
    new URL(config.alma.host);
  } catch {
    errors.push(`ALMA_HOST no es una URL válida: ${config.alma.host}`);
  }
  if (config.accessPin && config.accessPin.length < MIN_PIN_LENGTH) {
    errors.push(`ACCESS_PIN debe tener al menos ${MIN_PIN_LENGTH} caracteres.`);
  }
  if (config.accessPin && config.cookieSecret.length < MIN_COOKIE_SECRET_LENGTH) {
    errors.push(
      `COOKIE_SECRET es obligatorio con ACCESS_PIN y debe tener al menos ${MIN_COOKIE_SECRET_LENGTH} caracteres ` +
        `(genere uno con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))").`,
    );
  }
  // La API entrega nombres e identificaciones: en producción no puede quedar abierta por descuido.
  if (config.isProduction && !config.accessPin && !config.allowOpenAccess) {
    errors.push(
      'En producción ACCESS_PIN es obligatorio. Si el acceso ya está restringido por red o por ' +
        'Entra ID en Azure, defina ALLOW_OPEN_ACCESS=true.',
    );
  }
  return errors;
}

module.exports = { loadConfig, validateConfig };
