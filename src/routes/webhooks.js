'use strict';

const crypto = require('node:crypto');
const express = require('express');

// Alma firma el cuerpo crudo con HMAC-SHA256 (base64) en el header X-Exl-Signature.
function isValidSignature(rawBody, secret, signature) {
  if (!signature) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('base64'));
  const received = Buffer.from(String(signature));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function createWebhooksRouter({ secret, logger = console }) {
  const router = express.Router();

  // Desafío de Alma al registrar el webhook
  router.get('/', (req, res) => {
    res.json({ challenge: req.query.challenge });
  });

  router.post('/', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!secret) return res.status(503).json({ errorMessage: 'Webhooks deshabilitados (falta WEBHOOK_SECRET).' });

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidSignature(rawBody, secret, req.get('X-Exl-Signature'))) {
      return res.status(401).json({ errorMessage: 'Invalid Signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ errorMessage: 'El cuerpo no es JSON válido.' });
    }

    const action = typeof payload?.action === 'string' ? payload.action.toLowerCase() : null;
    if (!action) return res.status(400).json({ errorMessage: 'Falta el campo action.' });

    switch (action) {
      default:
        logger.info(`[webhooks] Sin manejador para la acción ${action}`);
    }

    res.status(204).end();
  });

  return router;
}

module.exports = { createWebhooksRouter, isValidSignature };
