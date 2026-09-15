'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const { createAccess } = require('./middleware/access');
const { createApiRouter } = require('./routes/api');
const { createWebhooksRouter } = require('./routes/webhooks');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ config, gate, logger = console, logRequests = true }) {
  const app = express();
  const access = createAccess(config);

  app.disable('x-powered-by');
  // Azure App Service termina TLS en su proxy frontal
  app.set('trust proxy', 1);

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok', version: config.version });
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'connect-src': ["'self'"],
          // Portadas de Open Library (redirige a archive.org) y Google Books
          'img-src': [
            "'self'",
            'data:',
            'https://covers.openlibrary.org',
            'https://*.archive.org',
            'https://books.google.com',
            'https://*.googleusercontent.com',
          ],
          // En el servidor de desarrollo se sirve por HTTP
          'upgrade-insecure-requests': null,
        },
      },
    }),
  );
  app.use(compression());

  if (logRequests) {
    morgan.token('verdict', (req, res) => res.locals.verdict || '-');
    app.use(
      morgan(':remote-addr ":method :url" :status :verdict :response-time ms', {
        skip: (req) => !req.originalUrl.startsWith('/api/') && !req.originalUrl.startsWith('/webhooks'),
      }),
    );
  }

  app.use(cookieParser(config.cookieSecret || crypto.randomBytes(32).toString('hex')));

  app.use('/webhooks', createWebhooksRouter({ secret: config.webhookSecret, logger }));
  app.use('/api', createApiRouter({ gate, access, config }));

  app.use(
    express.static(PUBLIC_DIR, {
      maxAge: config.isProduction ? '10m' : 0,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use((req, res) => res.status(404).type('text').send('No encontrado'));

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error(err);
    if (res.headersSent) return next(err);
    res.status(status).json({ error: status >= 500 ? 'Error interno del servidor.' : err.message });
  });

  return app;
}

module.exports = { createApp };
