# Yita · Control de salida de material

> Repositorio `psb-cerbero`. La aplicación se llamaba Cerbero y desde la v2.0.0 se llama **Yita**.

Aplicación para las puertas de salida de la **Red de Bibliotecas del Banco de la República**. El personal escanea el código de barras de cada libro que sale y la pantalla dice, con color y sonido, si el material **puede salir**. La verificación se hace en tiempo real contra [Alma (Ex Libris)](https://developers.exlibrisgroup.com/alma/apis/).

Así se evita que alguien se lleve un libro que no está prestado o que está cargado a otra persona.

## Cómo funciona en la puerta

1. Se escanea el libro. El campo del lector mantiene el foco solo, así que no hace falta hacer clic.
2. Yita consulta el ejemplar y **su préstamo activo** en Alma.
3. La pantalla muestra el veredicto:

| Veredicto | Color | Qué hacer |
|---|---|---|
| **Puede salir** | Verde | Compare el nombre o la identificación con el documento de la persona. |
| **Requiere autorización (préstamo vencido)** | Ámbar | No sale automáticamente. La salida debe autorizarla un representante de la biblioteca. |
| **No puede salir: no prestado** | Rojo | El usuario debe pasar por el mostrador de préstamo. |
| **No puede salir: en proceso** | Rojo | El ejemplar está en tránsito, en reserva u otro proceso. Verifique en circulación. |
| **Código no encontrado / inválido** | Rojo | Vuelva a escanear o verifique el código. |
| **Verificación manual** | Gris | Alma no respondió. Verifique el préstamo manualmente. |

Los veredictos verdes se limpian solos a los 15 segundos. Con el botón **Pausar**, el resultado se queda en pantalla para revisar con calma los datos del libro. Los ámbar, rojos y grises se quedan en pantalla hasta la siguiente lectura o hasta presionar `Esc`. El panel lateral guarda las últimas 20 lecturas de la sesión, solo en la memoria del navegador.

## Requisitos

- Node.js 22 o superior (recomendado: 24 LTS)
- Una API key de Alma con permiso de **lectura de Bibs**. Si además tiene lectura de **Users**, se muestra el nombre del usuario; si no, solo su identificación.

## Instalación y desarrollo local

```bash
git clone https://github.com/aquilu/psb-cerbero.git
cd psb-cerbero
npm ci
cp .env.example .env   # y complete ALMA_API_KEY
npm run dev            # http://localhost:3000 (se reinicia al cambiar el código)
npm test               # pruebas automáticas (no consultan Alma)
```

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ALMA_API_KEY` | Sí | API key de Alma. `API_KEY` también se acepta por compatibilidad con v1. |
| `ALMA_HOST` | No | Por defecto `https://api-na.hosted.exlibrisgroup.com` |
| `ALMA_PATH` | No | Por defecto `/almaws/v1` |
| `ALMA_TIMEOUT_MS` | No | Tiempo máximo por consulta a Alma. Por defecto `8000`. |
| `PORT` | No | Por defecto `3000`. Azure lo define automáticamente. |
| `TZ` | No | Zona horaria para los vencimientos. Por defecto `America/Bogota`. |
| `SHOW_FULL_USER_ID` | No | `true` (por defecto) muestra la identificación completa y `false` solo los últimos 4 dígitos. |
| `OVERDUE_GRACE_DAYS` | No | Días de gracia para préstamos vencidos. Con `0` (por defecto), cualquier préstamo vencido requiere autorización. |
| `ACCESS_PIN` | No | Si se define, la pantalla pide este PIN antes de consultar. Recomendado si la app es accesible desde internet. |
| `COOKIE_SECRET` | Si hay `ACCESS_PIN` | Secreto largo y aleatorio para firmar la cookie de acceso. |
| `WEBHOOK_SECRET` | No | Secreto para validar los webhooks de Alma. Si está vacío, `/webhooks` responde 503. |

El archivo `.env` contiene secretos y está en `.gitignore`: **nunca debe subirse al repositorio**.

## Despliegue en Azure App Service

1. Cree o use un App Service **Linux** con la pila **Node 24 LTS**.
2. En *Configuración → Variables de entorno*, defina `ALMA_API_KEY` y, si aplica, `ACCESS_PIN`, `COOKIE_SECRET` y `NODE_ENV=production`.
3. El comando de inicio es `npm start`. Azure lo detecta desde `package.json`.
4. En *Supervisión → Comprobación de estado*, use la ruta `/healthz`.
5. Despliegue desde GitHub (Deployment Center) o con `az webapp up`.

## Endpoints

| Método y ruta | Descripción |
|---|---|
| `GET /` | Pantalla de la puerta |
| `GET /api/items/:barcode` | Veredicto en JSON para un código de barras |
| `GET /api/status` | Versión y estado del acceso por PIN |
| `POST /api/access` | Valida el PIN (`{ "pin": "..." }`) |
| `GET /healthz` | Comprobación de estado (no consulta Alma) |
| `GET, POST /webhooks` | Webhooks de Alma (firma HMAC en `X-Exl-Signature`) |

## Estructura

```
src/
  server.js            arranque y apagado ordenado
  app.js               Express: seguridad, rutas y errores
  config.js            variables de entorno y validación
  alma/client.js       cliente HTTP de Alma (timeout, reintento, errores tipificados)
  services/gate.js     lógica del veredicto de salida
  middleware/access.js acceso opcional por PIN
  routes/              api.js y webhooks.js
public/                interfaz (HTML, CSS y JS sin compilación)
test/                  pruebas con node:test y un Alma simulado
```

## Privacidad

- La API key solo viaja en el header `Authorization`. Nunca va en URLs ni en los logs.
- Los logs registran el código de barras y el veredicto, nunca nombres de usuarios.
- El historial de lecturas vive en la memoria del navegador y se borra al recargar la página.

## Licencia

[MIT](LICENSE)
