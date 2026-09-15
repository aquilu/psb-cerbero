'use strict';

const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');

const COOKIE_NAME = 'cerbero_acceso';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Acceso opcional por PIN. Sin ACCESS_PIN la app queda abierta, que es lo esperado dentro de la red interna.
function createAccess({ accessPin, cookieSecret }) {
  const required = Boolean(accessPin);
  // La cookie depende del PIN: al cambiar ACCESS_PIN se cierran todas las sesiones.
  const token = required ? crypto.createHmac('sha256', cookieSecret).update(`pin:${accessPin}`).digest('hex') : null;

  const isAuthorized = (req) => !required || safeEqual(req.signedCookies?.[COOKIE_NAME], token);

  function requireAccess(req, res, next) {
    if (isAuthorized(req)) return next();
    res.status(401).json({ error: 'Se requiere el PIN de acceso.', accessRequired: true });
  }

  function login(req, res) {
    if (!required) return res.json({ authorized: true });
    if (!safeEqual(String(req.body?.pin ?? ''), accessPin)) {
      return res.status(401).json({ error: 'PIN incorrecto.', accessRequired: true });
    }
    res.cookie(COOKIE_NAME, token, {
      signed: true,
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      maxAge: MAX_AGE_MS,
    });
    res.json({ authorized: true });
  }

  function logout(req, res) {
    res.clearCookie(COOKIE_NAME);
    res.json({ authorized: !required });
  }

  const loginLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Espere unos minutos.' },
  });

  return { required, isAuthorized, requireAccess, login, logout, loginLimiter };
}

module.exports = { createAccess };
