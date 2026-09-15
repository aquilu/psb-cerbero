# Yita · Control de salida de material

> Repositorio `psb-cerbero`. La aplicación se llamaba Cerbero y desde la v2.0.0 se llama **Yita**.

[![CI](https://github.com/aquilu/psb-cerbero/actions/workflows/ci.yml/badge.svg)](https://github.com/aquilu/psb-cerbero/actions/workflows/ci.yml)
[![CodeQL](https://github.com/aquilu/psb-cerbero/actions/workflows/codeql.yml/badge.svg)](https://github.com/aquilu/psb-cerbero/actions/workflows/codeql.yml)

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

Los veredictos verdes y ámbar se limpian solos a los 15 segundos. Con el botón **Pausar**, el resultado se queda en pantalla para revisar con calma los datos del libro, y **Continuar** reanuda la cuenta regresiva. Los rojos y grises se quedan en pantalla hasta la siguiente lectura o hasta presionar `Esc`. El panel lateral guarda las últimas 20 lecturas de la sesión (veredicto y código, sin datos del usuario), solo en la memoria del navegador.

## Requisitos

- Node.js 22 o superior. Se recomienda **24 LTS** (ver `.nvmrc`).
- Una API key de Alma con permisos de **solo lectura** de **Bibs** y **Users**. Sin Users se muestra solo la identificación, sin el nombre.

## Instalación y desarrollo local

El repositorio es privado: se necesita acceso como colaborador (ver [docs/ENTREGA.md](docs/ENTREGA.md)).

```bash
git clone https://github.com/aquilu/psb-cerbero.git
cd psb-cerbero
npm ci
cp .env.example .env   # y complete ALMA_API_KEY
npm run dev            # http://localhost:3000 (se reinicia al cambiar el código)
npm test               # pruebas automáticas (no consultan Alma)
npm run audit:prod     # auditoría de dependencias de producción
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
| `NODE_ENV` | En producción | `production` activa las validaciones de producción. Azure App Service también se detecta solo. |
| `ACCESS_PIN` | **En producción** | PIN de acceso de al menos 8 caracteres. Sin él, la app no arranca en producción. |
| `COOKIE_SECRET` | Si hay `ACCESS_PIN` | Secreto aleatorio de al menos 32 caracteres para firmar la sesión. |
| `ALLOW_OPEN_ACCESS` | No | `true` permite producción sin PIN. Úselo **solo** si el acceso ya está restringido por red o por Entra ID. |
| `TRUST_PROXY` | No | Saltos de proxy de confianza. Automático: `1` en Azure y `false` en los demás entornos. |
| `SHOW_FULL_USER_ID` | No | `true` (por defecto) muestra la identificación completa y `false` solo los últimos 4 dígitos. |
| `SHOW_COVERS` | No | `true` (por defecto) muestra portadas de Open Library o Google Books; `false` evita peticiones a terceros. |
| `OVERDUE_GRACE_DAYS` | No | Días de gracia para préstamos vencidos. Con `0` (por defecto), cualquier préstamo vencido requiere autorización. |
| `WEBHOOK_SECRET` | No | Secreto para validar los webhooks de Alma. Si está vacío, `/webhooks` no existe. |

Para generar `COOKIE_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

El archivo `.env` contiene secretos y está en `.gitignore`: **nunca debe subirse al repositorio**.

## Seguridad

Yita muestra datos personales, así que trae controles de seguridad por defecto:
- PIN obligatorio en producción.
- Sesiones firmadas que vencen y se revocan.
- Límites contra fuerza bruta.
- CSP estricta y cabeceras de seguridad.
- Protección CSRF.
- Errores sin detalles internos.
- API key solo en headers.

La lista completa, la configuración obligatoria para producción y los riesgos aceptados están en **[SECURITY.md](SECURITY.md)**.

## Despliegue en Azure App Service

El despliegue lo hace el equipo del Banco: su punto de partida es **[docs/ENTREGA.md](docs/ENTREGA.md)** (qué versión clonar, quién genera cada secreto y cómo verificar). La guía técnica paso a paso está en **[docs/DEPLOY-AZURE.md](docs/DEPLOY-AZURE.md)**. En resumen:

1. App Service **Linux** con **Node 24 LTS**, solo HTTPS, TLS 1.2 como mínimo y comprobación de estado en `/healthz`.
2. Secretos (`ALMA_API_KEY`, `ACCESS_PIN`, `COOKIE_SECRET`) en **Key Vault** y referenciados desde las variables de entorno.
3. Restricción de acceso a las redes del Banco o autenticación con Entra ID.
4. Despliegue **automático con GitHub Actions** al publicar un Release (login OIDC, sin contraseñas guardadas), o **manual con ZIP**.

## Integración continua

| Workflow | Cuándo corre | Qué hace |
|---|---|---|
| [CI](.github/workflows/ci.yml) | Cada push y Pull Request | Pruebas en Node 22 y 24, `npm audit` y revisión de dependencias en PR. |
| [CodeQL](.github/workflows/codeql.yml) | Push a `master`, PR y semanal | Análisis estático de seguridad. En un repositorio privado requiere GitHub Code Security y la variable `CODE_SCANNING_ENABLED=true`; sin ellas se omite. |
| [Desplegar en Azure](.github/workflows/deploy-azure.yml) | Al publicar un Release o manual | Pruebas, paquete, despliegue y verificación de `/healthz`. Solo corre si existe la variable `AZURE_WEBAPP_NAME`. |
| [Dependabot](.github/dependabot.yml) | Semanal | Pull Requests con actualizaciones de librerías y Actions. |

## Endpoints

| Método y ruta | Descripción |
|---|---|
| `GET /` | Pantalla de la puerta |
| `GET /api/items/:barcode` | Veredicto en JSON para un código de barras (requiere sesión si hay PIN) |
| `GET /api/status` | Estado del acceso y opciones de la pantalla |
| `POST /api/access` | Inicia sesión con el PIN (`{ "pin": "..." }`) |
| `POST /api/logout` | Cierra la sesión y revoca el token |
| `GET /healthz` | Comprobación de estado (no consulta Alma) |
| `GET, POST /webhooks` | Webhooks de Alma (solo si hay `WEBHOOK_SECRET`) |

## Estructura

```
src/
  server.js              arranque, validación de configuración y apagado ordenado
  app.js                 Express: cabeceras de seguridad, rutas y errores
  config.js              variables de entorno y validación
  alma/client.js         cliente HTTP de Alma (timeout, reintento, errores tipificados)
  services/gate.js       lógica del veredicto de salida
  middleware/access.js   acceso por PIN y sesiones
  middleware/rate-limit.js  límites de peticiones
  middleware/same-origin.js protección CSRF
  routes/                api.js y webhooks.js
public/                  interfaz (HTML, CSS y JS sin compilación)
test/                    pruebas con node:test y un Alma simulado
docs/ENTREGA.md          entrega al equipo del Banco que despliega
docs/DEPLOY-AZURE.md     guía de despliegue
.github/                 CI, CodeQL, despliegue y Dependabot
```

## Privacidad

- La API key solo viaja en el header `Authorization`. Nunca va en URLs ni en los logs.
- Los logs registran IP, código de barras y veredicto, nunca nombres de usuarios.
- Las respuestas de la API no se guardan en caché (`Cache-Control: no-store`).
- El historial de lecturas no muestra datos del usuario, vive en la memoria del navegador y se borra al recargar la página.

## Licencia

[MIT](LICENSE)
