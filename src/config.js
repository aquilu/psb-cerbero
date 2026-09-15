'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const pkg = require('../package.json');

const DEFAULT_TIME_ZONE = 'America/Bogota';

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
    isProduction: env.NODE_ENV === 'production',
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
    showFullUserId: toBool(get('SHOW_FULL_USER_ID'), true),
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
  if (config.accessPin && !config.cookieSecret) {
    errors.push('COOKIE_SECRET es obligatorio cuando ACCESS_PIN está definido.');
  }
  return errors;
}

module.exports = { loadConfig, validateConfig };
