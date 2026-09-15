# Entrega de Yita al equipo de despliegue del Banco

Este documento es para quien **despliega** Yita en Azure. El desarrollo lo hace la Red de Bibliotecas del Banco de la República en el repositorio `aquilu/psb-cerbero`; el despliegue y la operación en Azure los hace el equipo de infraestructura o desarrollo del Banco.

## 1. Qué se entrega

| Elemento | Detalle |
|---|---|
| Versión | Tag **`v2.0.0`**. Los cambios están en [CHANGELOG.md](../CHANGELOG.md). |
| Qué es | Una aplicación Node.js 24 (Express 5) que consulta Alma y muestra en las puertas si un libro puede salir. |
| Seguridad | Los controles, la configuración obligatoria y los riesgos aceptados están en [SECURITY.md](../SECURITY.md). |
| Despliegue | La guía completa de Azure App Service está en [DEPLOY-AZURE.md](DEPLOY-AZURE.md). |
| Calidad | 50 pruebas automáticas y `npm audit` sin vulnerabilidades en la fecha de entrega. |

## 2. Acceso al código

El repositorio es **privado**.

1. La Red de Bibliotecas lo invita como colaborador del repositorio.
2. Acepte la invitación desde el correo de GitHub o en https://github.com/aquilu/psb-cerbero/invitations.
3. Clone **el tag de la versión**, no la rama `master`, que puede tener cambios en curso:

   ```bash
   gh auth login            # o use una llave SSH o un token personal de GitHub
   git clone --branch v2.0.0 https://github.com/aquilu/psb-cerbero.git yita
   cd yita
   git describe --tags      # debe mostrar: v2.0.0
   git rev-parse HEAD       # confirme este commit con el equipo de desarrollo por un canal interno
   ```

**Si el Banco despliega desde su propio repositorio** (su organización de GitHub o Azure DevOps):

```bash
git clone --bare https://github.com/aquilu/psb-cerbero.git psb-cerbero.git
cd psb-cerbero.git
git push --mirror <URL del repositorio del Banco>

# Para cada versión nueva que publique el desarrollo:
git fetch origin --tags
git push <URL del repositorio del Banco> vX.Y.Z
```

## 3. Secretos: quién los genera y cómo se reciben

**Ningún secreto debe viajar por correo, chat, tickets ni quedar en el repositorio.** Todos se guardan directamente en **Azure Key Vault** (paso 2 de [DEPLOY-AZURE.md](DEPLOY-AZURE.md)).

| Variable | Quién la genera | Cómo |
|---|---|---|
| `ALMA_API_KEY` | El Banco, con la cuenta institucional del Ex Libris Developer Network | Crear una key **exclusiva para producción** con permisos **solo lectura** de **Bibs** y **Users** (región North America) y cargarla directamente en Key Vault. No se reutilizan las keys que se usaron en desarrollo. |
| `ACCESS_PIN` | La Red de Bibliotecas | Mínimo 8 caracteres. Quien administra Key Vault lo carga y la Red de Bibliotecas lo comunica a las sedes por un canal interno. |
| `COOKIE_SECRET` | Quien despliega, en el momento | `openssl rand -hex 32`, directo a Key Vault. No hace falta que nadie lo conozca. |

Los valores que no son secretos (`ALMA_HOST`, `NODE_ENV`, `TZ`, etc.) están en el paso 3 de la guía de Azure.

## 4. Desplegar

Siga [DEPLOY-AZURE.md](DEPLOY-AZURE.md) en este orden:

1. **Paso 1:** App Service Linux con Node 24 LTS, solo HTTPS, TLS 1.2, FTP deshabilitado y comprobación de estado en `/healthz`.
2. **Pasos 2 y 3:** Key Vault, identidad administrada y variables de entorno.
3. **Paso 4:** restricción de acceso a las redes del Banco o Entra ID.
4. **Desplegar** con una de estas opciones:
   - **ZIP manual** (paso 5B):

     ```bash
     npm ci && npm test && npm run audit:prod
     npm ci --omit=dev
     zip -r yita.zip package.json package-lock.json LICENSE src public node_modules
     az webapp deploy --resource-group <grupo> --name <app> --src-path yita.zip --type zip
     ```

   - **Pipeline del Banco (Azure DevOps)**, equivalente:

     ```yaml
     trigger: none
     pool:
       vmImage: ubuntu-latest
     steps:
       - task: UseNode@1
         inputs:
           version: '24.x'
       - script: npm ci && npm test && npm audit --omit=dev --audit-level=high
         displayName: Pruebas y auditoría
       - script: |
           npm ci --omit=dev
           zip -r "$(Build.ArtifactStagingDirectory)/yita.zip" package.json package-lock.json LICENSE src public node_modules
         displayName: Paquete de producción
       - task: AzureWebApp@1
         inputs:
           azureSubscription: '<conexión de servicio>'
           appType: webAppLinux
           appName: '<app>'
           package: '$(Build.ArtifactStagingDirectory)/yita.zip'
     ```

   - **GitHub Actions** (paso 5A): solo si el repositorio desde el que se despliega tiene configurados los secretos de Azure.

**Recomendado:** desplegar primero en un **slot de staging**, verificar y luego intercambiarlo con producción. Así el cambio no tiene tiempo de inactividad y se puede revertir con un clic.

```bash
az webapp deployment slot create --resource-group <grupo> --name <app> --slot staging --configuration-source <app>
az webapp deploy --resource-group <grupo> --name <app> --slot staging --src-path yita.zip --type zip
# verificar https://<app>-staging.azurewebsites.net y luego:
az webapp deployment slot swap --resource-group <grupo> --name <app> --slot staging --target-slot production
```

## 5. Verificación después de desplegar

- [ ] `https://<app>/healthz` responde `{"status":"ok"}`.
- [ ] `https://<app>/api/status` indica `"accessRequired": true`.
- [ ] `https://<app>/api/items/123` sin iniciar sesión responde **401**.
- [ ] Las cabeceras incluyen `Strict-Transport-Security`, `Content-Security-Policy` y `X-Frame-Options: DENY`.
- [ ] En el navegador: se ingresa el PIN y se escanean códigos de prueba que entrega la Red de Bibliotecas:
  - [ ] Libro prestado: verde, con nombre del usuario.
  - [ ] Libro en estantería: rojo.
  - [ ] Préstamo vencido: ámbar.
- [ ] Los registros (`az webapp log tail`) no muestran «Configuración inválida» ni errores de Alma.

## 6. Si algo falla

- **Revertir:** intercambie de nuevo el slot o despliegue el ZIP de la versión anterior.
- **Diagnóstico:** tabla *Solución de problemas* de [DEPLOY-AZURE.md](DEPLOY-AZURE.md#solución-de-problemas).
- **Soporte:** el equipo de desarrollo de la Red de Bibliotecas. Incluya la hora, la URL, lo que se ve en pantalla y las líneas de log, **sin** secretos ni datos de usuarios.

## 7. Versiones nuevas

El equipo de desarrollo publica cada versión con un tag `vX.Y.Z` y su entrada en el CHANGELOG, y avisa al equipo de despliegue. Para desplegarla:

```bash
cd yita
git fetch --tags
git checkout vX.Y.Z
```

Luego repita los pasos 4 y 5. Revise en el CHANGELOG si la versión trae variables nuevas o una sección de *Migración*.
