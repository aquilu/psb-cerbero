'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { VERDICTS } = require('../services/gate');

const STATUS_BY_VERDICT = {
  [VERDICTS.NO_ENCONTRADO]: 404,
  [VERDICTS.CODIGO_INVALIDO]: 400,
  [VERDICTS.ERROR_ALMA]: 502,
};

function createApiRouter({ gate, access, config }) {
  const router = express.Router();

  router.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Demasiadas consultas seguidas. Espere un momento.' },
    }),
  );
  router.use(express.json({ limit: '10kb' }));

  router.get('/status', (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      version: config.version,
      accessRequired: access.required,
      authorized: access.isAuthorized(req),
    });
  });

  router.post('/access', access.loginLimiter, access.login);
  router.post('/logout', access.logout);

  router.get('/items/:barcode', access.requireAccess, async (req, res) => {
    const result = await gate.checkItem(req.params.barcode);
    res.locals.verdict = result.verdict;
    res
      .set('Cache-Control', 'no-store')
      .status(STATUS_BY_VERDICT[result.verdict] || 200)
      .json(result);
  });

  router.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

  return router;
}

module.exports = { createApiRouter };
