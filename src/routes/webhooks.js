'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createLimiter } = require('../middleware/rate-limit');

const CHALLENGE_RE = /^[A-Za-z0-9._~-]{1,256}$/;

// Alma firma el cuerpo crudo con HMAC-SHA256 (base64) en el header X-Exl-Signature.
function isValidSignature(rawBody, secret, signature) {
  if (!signature) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('base64'));
  const received = Buffer.from(String(signature));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

// Solo se monta si WEBHOOK_SECRET está definido (ver app.js).
function createWebhooksRouter({ secret, logger = console }) {
  if (!secret) throw new Error('Los webhooks requieren WEBHOOK_SECRET');
  const router = express.Router();

  router.use(createLimiter({ windowMs: 60 * 1000, limit: 60, message: { errorMessage: 'Too many requests' } }));

  // Desafío de Alma al registrar el webhook
  router.get('/', (req, res) => {
    const challenge = typeof req.query.challenge === 'string' ? req.query.challenge : '';
    if (!CHALLENGE_RE.test(challenge)) return res.status(400).json({ errorMessage: 'Invalid challenge' });
    res.json({ challenge });
  });

  router.post('/', express.raw({ type: '*/*', limit: '64kb' }), (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidSignature(rawBody, secret, req.get('X-Exl-Signature'))) {
      return res.status(401).json({ errorMessage: 'Invalid Signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ errorMessage: 'Invalid JSON' });
    }

    const action = typeof payload?.action === 'string' ? payload.action.toLowerCase() : null;
    if (!action) return res.status(400).json({ errorMessage: 'Missing action' });

    switch (action) {
      default:
        logger.info(`[webhooks] Sin manejador para la acción ${action.slice(0, 64)}`);
    }

    res.status(204).end();
  });

  return router;
}

module.exports = { createWebhooksRouter, isValidSignature };
