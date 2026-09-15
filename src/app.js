'use strict';

const path = require('node:path');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const { createAccess } = require('./middleware/access');
const { clientIp } = require('./middleware/rate-limit');
const { createApiRouter } = require('./routes/api');
const { createWebhooksRouter } = require('./routes/webhooks');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Portadas: Open Library (redirige a archive.org) y Google Books. Se desactivan con SHOW_COVERS=false.
const COVER_HOSTS = [
  'https://covers.openlibrary.org',
  'https://*.archive.org',
  'https://books.google.com',
  'https://*.googleusercontent.com',
];

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

// Mensajes genéricos: no se reenvían al cliente los mensajes internos de Express o del parser JSON
const ERROR_MESSAGES = {
  400: 'Solicitud inválida.',
  401: 'No autorizado.',
  403: 'Solicitud no permitida.',
  404: 'No encontrado.',
  413: 'Solicitud demasiado grande.',
  415: 'Tipo de contenido no soportado.',
};

function createApp({ config, gate, logger = console, logRequests = true, now }) {
  const app = express();
  const access = createAccess({ accessPin: config.accessPin, cookieSecret: config.cookieSecret, now });

  app.disable('x-powered-by');
  // Por defecto solo en Azure App Service (1 salto); en la red interna no se confía en X-Forwarded-*
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'connect-src': ["'self'"],
          'font-src': ["'self'"],
          'img-src': ["'self'", ...(config.showCovers ? COVER_HOSTS : [])],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          // En el servidor de desarrollo se sirve por HTTP
          'upgrade-insecure-requests': null,
        },
      },
      frameguard: { action: 'deny' },
      // COOP y HSTS solo tienen efecto sobre HTTPS: en HTTP (red interna) el navegador los
      // ignora y llena la consola de advertencias. Se envían más abajo solo en HTTPS.
      crossOriginOpenerPolicy: false,
      strictTransportSecurity: false,
      // Origin-Agent-Cluster es solo una sugerencia; en una IP con otras apps (otros puertos)
      // el navegador no puede aplicarla y genera advertencias.
      originAgentCluster: false,
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    if (req.secure) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });

  app.use(compression());

  if (logRequests) {
    morgan.token('client-ip', (req) => clientIp(req));
    morgan.token('verdict', (req, res) => res.locals.verdict || '-');
    app.use(
      morgan(':client-ip ":method :url" :status :verdict :response-time ms', {
        skip: (req) => !req.originalUrl.startsWith('/api/') && !req.originalUrl.startsWith('/webhooks'),
      }),
    );
  }

  app.use(cookieParser());

  if (config.webhookSecret) {
    app.use('/webhooks', createWebhooksRouter({ secret: config.webhookSecret, logger }));
  }
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
    res
      .status(status)
      .json({ error: status >= 500 ? 'Error interno del servidor.' : ERROR_MESSAGES[status] || 'Solicitud inválida.' });
  });

  return app;
}

module.exports = { createApp };
