# Changelog

Todos los cambios relevantes de este proyecto. El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [2.0.0] - 2026-09-15

Reescritura completa de la aplicación, que pasa a llamarse **Yita** (antes Cerbero): nueva interfaz para la puerta, backend moderno, controles de seguridad para producción y corrección de errores que podían dar un veredicto equivocado.

### Corregido
- **Crítico:** con varias copias de un mismo título, la puerta podía mostrar el préstamo de **otra copia**. Por ejemplo, decía que un ejemplar que estaba en la estantería estaba prestado, o mostraba al usuario equivocado. La v1 consultaba `/bibs/{mms_id}/loans`, que devuelve los préstamos de todo el título, y tomaba el primero. Ahora se consulta el préstamo del ejemplar escaneado (`/bibs/{mms}/holdings/{holding}/items/{pid}/loans`) y se confirma que corresponda a ese ejemplar.
- La API key se enviaba también en la URL (`?apikey=`) y quedaba en los logs. Ahora solo va en el header `Authorization`, incluso cuando Alma redirige.
- El host `api-na` estaba fijo en el código e ignoraba la configuración.
- El código de barras se concatenaba sin codificar en la URL de Alma, lo que permitía inyectar parámetros. Ahora se valida y se codifica.
- La plantilla tenía un error de sintaxis de JavaScript y las portadas nunca cargaban.
- La fecha de vencimiento se mostraba en formato ISO y se comparaba en UTC. Ahora se muestra en español y se calcula en la zona horaria de Bogotá.
- Webhooks: la app fallaba si `WEBHOOK_SECRET` estaba vacío o si faltaba `action`, y la firma se validaba sobre el JSON re-serializado. Ahora se valida sobre el cuerpo crudo con comparación de tiempo constante.
- La página de error mostraba el stack trace al público.
- Nombre del usuario duplicado: en Alma, `first_name` a veces ya incluye el segundo nombre y `middle_name` lo repite (por ejemplo "LUZ ELENA ELENA ACOSTA"). Ahora se arma el nombre sin repetir.
- En cada consulta se llamaba a `/conf/libraries` sin usar el resultado, y había código muerto de la función "scan".

### Seguridad
- **Acceso obligatorio en producción:** sin `ACCESS_PIN` la aplicación no arranca en producción ni en Azure, salvo con `ALLOW_OPEN_ACCESS=true` cuando el acceso ya está restringido por red o por Entra ID. El PIN debe tener al menos 8 caracteres y `COOKIE_SECRET` al menos 32.
- **Sesiones:** cada inicio de sesión emite un token propio con vigencia de 12 h verificada en el servidor. Cerrar sesión revoca el token y cambiar el PIN invalida todas las sesiones. La cookie usa el prefijo `__Host-` sobre HTTPS.
- **Proxy de confianza:** solo se confía en `X-Forwarded-For` y `X-Forwarded-Proto` en Azure o con `TRUST_PROXY`. Así no se pueden falsificar la IP (para saltarse los límites) ni el protocolo en la red interna.
- **Límites de peticiones:** los PIN erróneos se limitan por IP y en total, y hay límites para la API y los webhooks. La IP se normaliza quitando el puerto que envía Azure y el prefijo `::ffff:`.
- **Cabeceras:** CSP más estricta (`frame-ancestors 'none'`, `font-src 'self'`, dominios de portadas solo si `SHOW_COVERS=true`), `X-Frame-Options: DENY` y `Permissions-Policy`. `/healthz` también las recibe. COOP y HSTS se envían solo sobre HTTPS, así se evitan advertencias en la consola del navegador cuando se usa por HTTP en la red interna. Todas las respuestas de `/api`, incluidos los errores, llevan `Cache-Control: no-store`.
- **CSRF:** los `POST` exigen el mismo origen y un cuerpo JSON.
- **Menos información expuesta:** errores con mensajes genéricos, la versión solo visible con acceso, `/webhooks` inexistente sin secreto y desafío validado, y el historial en pantalla sin datos del usuario. Se quitan los caracteres invisibles del código de barras.
- `SECURITY.md` documenta los controles, la configuración obligatoria y los riesgos aceptados.

### Agregado
- Pantalla para la puerta: veredicto a pantalla completa con color, icono y sonido; foco permanente en el lector; limpieza automática con botón **Pausar/Continuar** para revisar los datos del libro con calma; historial de las últimas 20 lecturas; indicador de conexión y diseño adaptable a tablet y celular.
- Veredictos claros: *Puede salir*, *Requiere autorización (préstamo vencido)*, *No prestado*, *En proceso*, *No encontrado*, *Código inválido* y *Verificación manual*.
- **Préstamos vencidos:** ya no se autoriza la salida automáticamente. La pantalla indica cuántos días lleva vencido y que la salida debe autorizarla un representante de la biblioteca. `OVERDUE_GRACE_DAYS` permite configurar un margen de días (0 por defecto).
- Nombre y grupo del usuario del préstamo (requiere permiso de lectura de Users en la API key). Si la API key no tiene ese permiso, se muestra solo la identificación sin fallar.
- API JSON `GET /api/items/:barcode`, `GET /healthz` para Azure y acceso por PIN (`ACCESS_PIN`).
- Timeout y un reintento ante fallas de Alma. Si Alma no responde, la pantalla pide verificación manual en lugar de mostrar un error técnico.
- Opciones `SHOW_FULL_USER_ID` y `SHOW_COVERS`.
- **Despliegue en Azure:** guía paso a paso ([docs/DEPLOY-AZURE.md](docs/DEPLOY-AZURE.md)) con Key Vault, restricciones de acceso y Entra ID, y workflow de GitHub Actions que despliega al publicar un Release (login OIDC).
- **Integración continua:** pruebas en Node 22 y 24, `npm audit`, CodeQL, revisión de dependencias en PR y Dependabot. Las Actions están fijadas por SHA.
- 50 pruebas automáticas (`npm test`) con Alma simulado, incluida la regresión de varias copias y las pruebas de seguridad.

### Cambiado
- La aplicación se llama **Yita** (antes Cerbero). El repositorio sigue siendo `psb-cerbero`.
- Node.js 22+ (recomendado 24 LTS) y Express 5. Se eliminaron dependencias abandonadas o sin uso: `request`, `jade`, `async`, `nconf`, `moment`, `express-session`, `body-parser`, `serve-favicon`.
- La configuración ahora vive en variables de entorno (`.env`) y `.env.example` documenta cada una.
- El punto de entrada pasa de `bin/www` a `src/server.js`. `npm start` no cambia.
- `LICENSE`: se agrega a la Red de Bibliotecas del Banco de la República como titular, conservando el aviso original.

### Migración desde v1
- Renombre `API_KEY` a `ALMA_API_KEY`. El nombre anterior y `config.json` siguen funcionando como respaldo.
- Defina `ACCESS_PIN` y `COOKIE_SECRET` en producción: sin ellos la aplicación no arranca.
- Cambie el comando de inicio a `npm start` y la pila a Node 24 LTS. Ver [docs/DEPLOY-AZURE.md](docs/DEPLOY-AZURE.md#migración-desde-v1-cerbero).
- Se eliminó `app.json` (Heroku), porque la app se despliega en Azure App Service.

## [1.0.0] - 2023-05-17

- Versión original: consulta de ítems por código de barras con usuario y fecha de vencimiento, basada en `simple-node-alma-apis` de Ex Libris.

[2.0.0]: https://github.com/aquilu/psb-cerbero/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/aquilu/psb-cerbero/releases/tag/v1.0.0
