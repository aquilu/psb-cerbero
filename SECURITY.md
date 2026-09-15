# Seguridad de Yita

Yita consulta préstamos en Alma y muestra **datos personales** (nombre e identificación del usuario) en las puertas de salida de la Red de Bibliotecas del Banco de la República. Por eso aplica la Ley 1581 de 2012 de protección de datos personales, y la aplicación debe desplegarse con los controles de este documento.

## Reportar una vulnerabilidad

No abra un *issue* público. Use **Security → Report a vulnerability** en este repositorio (reporte privado de GitHub) o escriba al responsable del sistema en la Red de Bibliotecas. Incluya los pasos para reproducir el problema y el impacto que observó.

## Controles implementados

| Área | Control |
|---|---|
| **Acceso** | PIN de acceso (`ACCESS_PIN`, mínimo 8 caracteres). En producción, y en Azure (se detecta con `WEBSITE_SITE_NAME`), la aplicación **no arranca sin PIN**, salvo que se declare `ALLOW_OPEN_ACCESS=true` porque el acceso ya está restringido por red o por Entra ID. |
| **Sesión** | Cada inicio de sesión emite un token propio (`emitido.nonce.HMAC-SHA256`) firmado con `COOKIE_SECRET` (mínimo 32 caracteres) y con el PIN. El servidor verifica la firma y la vigencia de 12 h, y el cierre de sesión revoca el token. Al cambiar el PIN se invalidan todas las sesiones. La cookie es `HttpOnly`, `SameSite=Strict` y, con HTTPS, `Secure` con el prefijo `__Host-`. |
| **Fuerza bruta y abuso** | Límite de PIN erróneos: 10 cada 15 minutos por IP y 100 cada 15 minutos en total. La API admite 120 consultas por minuto por IP y los webhooks 60. La IP se normaliza (sin puerto ni prefijo `::ffff:`). |
| **Proxy** | Solo se confía en `X-Forwarded-For` y `X-Forwarded-Proto` en Azure App Service (1 salto) o si se configura `TRUST_PROXY`. En la red interna estas cabeceras se ignoran y no permiten falsificar la IP ni el protocolo. |
| **CSRF** | Los `POST` exigen el mismo origen (`Sec-Fetch-Site` y `Origin`) y un cuerpo JSON, además de la cookie `SameSite=Strict`. |
| **Cabeceras HTTP** | CSP sin `unsafe-inline` (`default-src 'self'`, `frame-ancestors 'none'`, imágenes externas solo si `SHOW_COVERS=true`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` y `Cross-Origin-Resource-Policy`. Sobre HTTPS se agregan HSTS y `Cross-Origin-Opener-Policy`. No se envía `X-Powered-By`. |
| **Caché** | Todas las respuestas de `/api`, incluidos los errores, llevan `Cache-Control: no-store`. |
| **Entradas** | El código de barras se valida con una lista blanca (letras, números y `. _ / -`, máximo 64 caracteres) y se le quitan los caracteres de control e invisibles. Los parámetros hacia Alma se codifican. JSON limitado a 10 KB y webhooks a 64 KB. |
| **Salidas** | Los errores devuelven mensajes genéricos, sin trazas ni mensajes internos. La interfaz pinta los datos con `textContent`, nunca con HTML. La versión solo se informa a quien tiene acceso. |
| **Integración con Alma** | La API key viaja solo en el header `Authorization`, nunca en la URL ni en los logs. Solo se permiten llamadas y redirecciones hacia el host de Alma configurado (sin SSRF). Cada petición tiene timeout y un solo reintento. |
| **Webhooks** | La ruta solo existe si hay `WEBHOOK_SECRET`. La firma HMAC-SHA256 se valida sobre el cuerpo crudo con comparación de tiempo constante, y el desafío se valida. |
| **Secretos** | Los secretos viven en variables de entorno (Key Vault en Azure). `.env` está en `.gitignore` y el historial de git no contiene secretos. |
| **Registro** | Una línea por consulta: IP, ruta, estado, veredicto y tiempo. No se registran nombres ni la API key. |
| **Dependencias** | Pocas dependencias y mantenidas, con `package-lock.json`. `npm audit` en CI, Dependabot semanal, CodeQL (`security-extended`) y *dependency review* en cada Pull Request. Las GitHub Actions están fijadas por SHA. |
| **Despliegue** | Login OIDC desde GitHub Actions (sin contraseñas guardadas), solo HTTPS, TLS 1.2 como mínimo, FTP y credenciales básicas deshabilitados. Ver [docs/DEPLOY-AZURE.md](docs/DEPLOY-AZURE.md). |

## Configuración obligatoria antes de producción

- [ ] `ACCESS_PIN` de al menos 8 caracteres, distinto por ambiente, y `COOKIE_SECRET` aleatorio de 32 bytes o más.
- [ ] `ALMA_API_KEY`, `ACCESS_PIN` y `COOKIE_SECRET` como referencias a **Azure Key Vault**.
- [ ] **HTTPS Only** activo, TLS 1.2 como mínimo, FTP deshabilitado y credenciales básicas de publicación (SCM/FTP) deshabilitadas.
- [ ] **Restricciones de acceso** de App Service limitadas a las redes del Banco, o **App Service Authentication** con Entra ID.
- [ ] API key de Alma **solo lectura** (Bibs y Users) y exclusiva de esta aplicación.
- [ ] Comprobación de estado apuntando a `/healthz`.

## Riesgos conocidos y decisiones

| Riesgo | Decisión o mitigación |
|---|---|
| El PIN es compartido por sede y no identifica a cada persona. | Aceptado para la operación en puerta. Para trazabilidad individual, active App Service Authentication con Entra ID. |
| La revocación de sesiones vive en memoria, por instancia. | Con una sola instancia basta. Si escala a varias, un token revocado sigue siendo válido en las otras instancias hasta vencer (máximo 12 h). Para invalidar todo al instante, cambie `ACCESS_PIN`. |
| En la red interna el servidor de desarrollo usa HTTP. | Solo para pruebas. En producción use HTTPS (Azure) o un proxy inverso con certificado interno. |
| La identificación completa del usuario se ve en pantalla. | Decisión operativa para comparar con el documento. Se puede limitar a los últimos 4 dígitos con `SHOW_FULL_USER_ID=false`. El historial de lecturas no muestra datos del usuario. |
| Las portadas se piden a Open Library y Google Books (el ISBN llega a terceros). | Decisión de producto. `SHOW_COVERS=false` elimina esas peticiones y los dominios externos de la CSP. Las imágenes se piden sin *referrer*. |

## Última revisión

- **15 de septiembre de 2026, v2.0.0.** Revisión de código y pruebas dinámicas contra una instancia local, con cabeceras, fuerza bruta, suplantación de proxy, CSRF, sesiones, entradas y errores. Se corrigieron todos los hallazgos críticos, altos, medios y bajos. `npm audit`: 0 vulnerabilidades.
