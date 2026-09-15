'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Normaliza la IP del cliente para los límites de peticiones:
// - Azure App Service envía X-Forwarded-For como "IP:puerto"; sin quitar el puerto cada
//   conexión TCP tendría su propio contador.
// - Node en doble pila entrega IPv4 como "::ffff:a.b.c.d"; tratada como IPv6 /56 todas las
//   IPv4 compartirían un solo contador.
function stripPort(ip) {
  const value = String(ip ?? '').trim();
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  const v4 = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4) return v4[1];
  const v6 = value.match(/^\[([0-9a-fA-F:.]+)\](?::\d+)?$/);
  if (v6) return v6[1];
  return value;
}

function clientIp(req) {
  return stripPort(req.ip || req.socket?.remoteAddress);
}

function clientKey(req) {
  return ipKeyGenerator(clientIp(req));
}

function createLimiter({ windowMs, limit, message, ...options }) {
  return rateLimit({
    windowMs,
    limit,
    message,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: clientKey,
    // Sin proxy de confianza X-Forwarded-For se ignora a propósito: no es un error de configuración
    validate: { xForwardedForHeader: false },
    ...options,
  });
}

module.exports = { createLimiter, clientIp, clientKey, stripPort };
