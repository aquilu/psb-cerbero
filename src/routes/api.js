'use strict';

const express = require('express');
const { createLimiter } = require('../middleware/rate-limit');
const { sameOriginOnly } = require('../middleware/same-origin');
const { VERDICTS } = require('../services/gate');

const STATUS_BY_VERDICT = {
  [VERDICTS.NO_ENCONTRADO]: 404,
  [VERDICTS.CODIGO_INVALIDO]: 400,
  [VERDICTS.ERROR_ALMA]: 502,
};

function createApiRouter({ gate, access, config }) {
  const router = express.Router();

  // Ninguna respuesta de la API, incluidos los errores, debe quedar en caché: puede tener datos personales
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(
    createLimiter({
      windowMs: 60 * 1000,
      limit: 120,
      message: { error: 'Demasiadas consultas seguidas. Espere un momento.' },
    }),
  );
  router.use(express.json({ limit: '10kb' }));

  router.get('/status', (req, res) => {
    const authorized = access.isAuthorized(req);
    res.json({
      accessRequired: access.required,
      authorized,
      showCovers: config.showCovers,
      // La versión solo se informa a quien tiene acceso
      ...(authorized && { version: config.version }),
    });
  });

  router.post('/access', sameOriginOnly, ...access.loginLimiters, access.login);
  router.post('/logout', sameOriginOnly, access.logout);

  router.get('/items/:barcode', access.requireAccess, async (req, res) => {
    const result = await gate.checkItem(req.params.barcode);
    res.locals.verdict = result.verdict;
    res.status(STATUS_BY_VERDICT[result.verdict] || 200).json(result);
  });

  router.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

  return router;
}

module.exports = { createApiRouter };
