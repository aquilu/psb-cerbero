# Changelog

Todos los cambios relevantes de este proyecto. El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [2.0.0] - 2026-09-15

Reescritura completa de la aplicación, que pasa a llamarse **Yita** (antes Cerbero): nueva interfaz para la puerta, backend moderno y corrección de errores que podían dar un veredicto equivocado.

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

### Agregado
- Pantalla para la puerta: veredicto a pantalla completa con color, icono y sonido; foco permanente en el lector; limpieza automática con botón **Pausar** para revisar los datos del libro con calma; historial de las últimas 20 lecturas; indicador de conexión y diseño adaptable a tablet y celular.
- Veredictos claros: *Puede salir*, *Requiere autorización (préstamo vencido)*, *No prestado*, *En proceso*, *No encontrado*, *Código inválido* y *Verificación manual*.
- **Préstamos vencidos:** ya no se autoriza la salida automáticamente. La pantalla indica cuántos días lleva vencido y que la salida debe autorizarla un representante de la biblioteca. `OVERDUE_GRACE_DAYS` permite configurar un margen de días (0 por defecto).
- API JSON `GET /api/items/:barcode`, `GET /healthz` para Azure y acceso opcional por PIN (`ACCESS_PIN`).
- Timeout y un reintento ante fallas de Alma. Si Alma no responde, la pantalla pide verificación manual en lugar de mostrar un error técnico.
- Si la API key no tiene permiso de Usuarios, se muestra solo la identificación sin fallar.
- Cabeceras de seguridad (helmet/CSP), límite de peticiones y compresión. `Cross-Origin-Opener-Policy` y `Strict-Transport-Security` solo se envían sobre HTTPS, así se evitan advertencias en la consola del navegador cuando se usa por HTTP en la red interna.
- 41 pruebas automáticas (`npm test`) con Alma simulado, incluida la regresión de varias copias.

### Cambiado
- La aplicación se llama **Yita** (antes Cerbero). El repositorio sigue siendo `psb-cerbero`.
- Node.js 22+ y Express 5. Se eliminaron dependencias abandonadas o sin uso: `request`, `jade`, `async`, `nconf`, `moment`, `express-session`, `body-parser`, `serve-favicon`.
- La configuración ahora vive en variables de entorno (`.env`) y `.env.example` documenta cada una.
- El punto de entrada pasa de `bin/www` a `src/server.js`. `npm start` no cambia.

### Migración desde v1
- Renombre `API_KEY` a `ALMA_API_KEY`. El nombre anterior y `config.json` siguen funcionando como respaldo.
- Se eliminó `app.json` (Heroku), porque la app se despliega en Azure App Service.

## [1.0.0] - 2023-05-17

- Versión original: consulta de ítems por código de barras con usuario y fecha de vencimiento, basada en `simple-node-alma-apis` de Ex Libris.

[2.0.0]: https://github.com/aquilu/psb-cerbero/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/aquilu/psb-cerbero/releases/tag/v1.0.0
