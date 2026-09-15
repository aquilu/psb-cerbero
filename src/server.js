'use strict';

const { loadConfig, validateConfig } = require('./config');
const { createAlmaClient } = require('./alma/client');
const { createGateService } = require('./services/gate');
const { createApp } = require('./app');

const config = loadConfig();
const errors = validateConfig(config);
if (errors.length) {
  console.error(`Configuración inválida:\n  - ${errors.join('\n  - ')}\nRevise el archivo .env (ver .env.example).`);
  process.exit(1);
}

if (!config.accessPin) {
  console.warn(
    config.isProduction
      ? 'ALLOW_OPEN_ACCESS=true: la API no pide PIN. El acceso debe estar restringido por red o por Entra ID.'
      : 'ACCESS_PIN no está definido: cualquier equipo con acceso a este servidor puede consultar préstamos.',
  );
}

const alma = createAlmaClient(config.alma);
const gate = createGateService({
  alma,
  timeZone: config.timeZone,
  showFullUserId: config.showFullUserId,
  overdueGraceDays: config.overdueGraceDays,
});
const app = createApp({ config, gate });

const server = app.listen(config.port, () => {
  console.log(`Yita (psb-cerbero) v${config.version} escuchando en el puerto ${config.port} (Alma: ${config.alma.host})`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`El puerto ${config.port} ya está en uso.`);
  else if (err.code === 'EACCES') console.error(`El puerto ${config.port} requiere privilegios elevados.`);
  else console.error(err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`${signal} recibido, cerrando el servidor...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
