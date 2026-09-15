# Despliegue de Yita en Azure App Service

Esta guía deja Yita en **Azure App Service (Linux, Node 24 LTS)** con la configuración de seguridad que exige [SECURITY.md](../SECURITY.md). Hay dos formas de desplegar:

- **A. GitHub Actions (recomendada):** al publicar un Release en GitHub se corren las pruebas y la auditoría, y luego se despliega automáticamente.
- **B. Manual con ZIP:** desde un equipo con Azure CLI.

Los comandos usan [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) y se pueden ejecutar en **Azure Cloud Shell** (https://shell.azure.com). Reemplace los valores de ejemplo:

```bash
RG=rg-yita                 # grupo de recursos
LOCATION=eastus            # región
PLAN=plan-yita             # plan de App Service
APP=yita-bibliotecas       # nombre de la app (debe ser único en Azure)
KV=kv-yita-bibliotecas     # Key Vault (único en Azure)
```

---

## 1. Crear o preparar el App Service

> Si ya existe el App Service de la versión anterior (Cerbero), vaya al paso 1.2 y revise la sección [Migración desde v1](#migración-desde-v1-cerbero).

### 1.1 Crear los recursos

```bash
az group create --name $RG --location $LOCATION
az appservice plan create --resource-group $RG --name $PLAN --is-linux --sku B1
az webapp create --resource-group $RG --plan $PLAN --name $APP --runtime "NODE:24-lts"
```

### 1.2 Configuración segura de la plataforma

```bash
# Node 24 LTS, siempre activo, HTTP/2, TLS 1.2+, sin FTP y comprobación de estado
az webapp config set --resource-group $RG --name $APP \
  --linux-fx-version "NODE|24-lts" --startup-file "npm start" \
  --always-on true --http20-enabled true --min-tls-version 1.2 --ftps-state Disabled \
  --generic-configurations '{"healthCheckPath": "/healthz"}'

# Solo HTTPS
az webapp update --resource-group $RG --name $APP --https-only true

# Deshabilitar credenciales básicas de publicación (SCM y FTP)
for kind in scm ftp; do
  az resource update --resource-group $RG --name $kind --namespace Microsoft.Web \
    --resource-type basicPublishingCredentialsPolicies --parent sites/$APP --set properties.allow=false
done
```

En el portal está en **Configuración → Configuración general**: pila Node 24 LTS, comando de inicio `npm start`, Always On activado, versión mínima de TLS 1.2, estado de FTP deshabilitado y credenciales básicas de publicación en *Desactivado*. **HTTPS Only** se activa en **Configuración → Configuración general**, y la ruta de estado en **Supervisión → Comprobación de estado** (`/healthz`).

## 2. Secretos en Key Vault

```bash
# Identidad administrada de la app
az webapp identity assign --resource-group $RG --name $APP
PRINCIPAL_ID=$(az webapp identity show --resource-group $RG --name $APP --query principalId -o tsv)

# Key Vault con control de acceso RBAC
az keyvault create --resource-group $RG --name $KV --location $LOCATION --enable-rbac-authorization true
KV_ID=$(az keyvault show --name $KV --query id -o tsv)
az role assignment create --assignee-object-id $PRINCIPAL_ID --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope $KV_ID

# Secretos (quien ejecute esto necesita el rol "Key Vault Secrets Officer")
az keyvault secret set --vault-name $KV --name alma-api-key  --value "<API key de Alma>"
az keyvault secret set --vault-name $KV --name access-pin    --value "<PIN de al menos 8 caracteres>"
az keyvault secret set --vault-name $KV --name cookie-secret --value "$(openssl rand -hex 32)"
```

## 3. Variables de entorno

```bash
az webapp config appsettings set --resource-group $RG --name $APP --settings \
  NODE_ENV=production \
  TZ=America/Bogota \
  SCM_DO_BUILD_DURING_DEPLOYMENT=false \
  ALMA_HOST=https://api-na.hosted.exlibrisgroup.com \
  ALMA_PATH=/almaws/v1 \
  ALMA_API_KEY="@Microsoft.KeyVault(VaultName=$KV;SecretName=alma-api-key)" \
  ACCESS_PIN="@Microsoft.KeyVault(VaultName=$KV;SecretName=access-pin)" \
  COOKIE_SECRET="@Microsoft.KeyVault(VaultName=$KV;SecretName=cookie-secret)" \
  SHOW_FULL_USER_ID=true \
  SHOW_COVERS=true \
  OVERDUE_GRACE_DAYS=0
```

| Variable | Valor en Azure | Nota |
|---|---|---|
| `NODE_ENV` | `production` | Activa las validaciones de producción. |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` | El paquete ya trae `node_modules`; Azure no compila nada. |
| `ALMA_API_KEY`, `ACCESS_PIN`, `COOKIE_SECRET` | Referencias a Key Vault | En el portal deben aparecer con una marca verde de **Key Vault Reference**. |
| `TRUST_PROXY` | *(no definir)* | En Azure se detecta solo (`WEBSITE_SITE_NAME`) y vale 1. |
| `ALLOW_OPEN_ACCESS` | *(no definir)* | Solo si quita el PIN porque usa Entra ID o restricción de IP (paso 4). |
| `WEBHOOK_SECRET` | *(opcional)* | Solo si se registran webhooks en Alma; guárdelo también en Key Vault. |

Si falta una variable obligatoria, la app **no arranca** y el motivo aparece en **Supervisión → Secuencia de registro**.

## 4. Restringir el acceso (recomendado además del PIN)

**Por red:** permita solo las IP públicas de salida de las sedes del Banco.

```bash
az webapp config access-restriction add --resource-group $RG --name $APP \
  --rule-name sedes-banrep --action Allow --ip-address <IP-o-rango-CIDR> --priority 100
# Repita por cada rango. Al existir una regla Allow, todo lo demás queda denegado.
```

**Por identidad (Entra ID):** en **Configuración → Autenticación → Agregar proveedor de identidades → Microsoft**, restrinja a la organización y marque *Requerir autenticación*. Así cada persona inicia sesión con su cuenta del Banco. Si usa esta opción, puede quitar `ACCESS_PIN` y `COOKIE_SECRET` y definir `ALLOW_OPEN_ACCESS=true`.

> `/healthz` debe seguir respondiendo a la comprobación de estado de Azure. Esta no pasa por las restricciones de acceso, pero sí por la autenticación. Si activa Entra ID, excluya `/healthz` en la configuración de rutas sin autenticación, o use la opción de restricción por red.

---

## 5A. Despliegue con GitHub Actions (recomendado)

El workflow [`.github/workflows/deploy-azure.yml`](../.github/workflows/deploy-azure.yml) instala las dependencias, corre las pruebas y `npm audit`, empaqueta solo lo necesario, entra a Azure con **OIDC** (sin contraseñas guardadas en GitHub), despliega y verifica `/healthz`.

### Configuración inicial (una sola vez)

1. **Identidad para GitHub en Entra ID**, con permiso solo sobre esta app:

   ```bash
   APP_ID=$(az ad app create --display-name "yita-github-deploy" --query appId -o tsv)
   az ad sp create --id $APP_ID
   az role assignment create --assignee $APP_ID --role "Website Contributor" \
     --scope $(az webapp show --resource-group $RG --name $APP --query id -o tsv)

   az ad app federated-credential create --id $APP_ID --parameters '{
     "name": "github-psb-cerbero-production",
     "issuer": "https://token.actions.githubusercontent.com",
     "subject": "repo:aquilu/psb-cerbero:environment:production",
     "audiences": ["api://AzureADTokenExchange"]
   }'

   echo "AZURE_CLIENT_ID=$APP_ID"
   echo "AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)"
   echo "AZURE_SUBSCRIPTION_ID=$(az account show --query id -o tsv)"
   ```

2. **En GitHub** (**Settings** del repositorio):
   - **Environments → New environment → `production`**. Opcional pero recomendado: *Required reviewers*, para que alguien apruebe cada despliegue.
   - **Secrets and variables → Actions → Secrets:** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
   - **Secrets and variables → Actions → Variables:** `AZURE_WEBAPP_NAME` = nombre de la app (`$APP`).
   - **Security → Private vulnerability reporting:** activar.

### Desplegar

- **Con un Release:** **Releases → Draft a new release**, elija el tag (por ejemplo `v2.0.0`) y pulse **Publish release**.
- **Manual:** **Actions → Desplegar en Azure → Run workflow**.

El avance se ve en la pestaña **Actions**. Al terminar, el job muestra la URL de la app.

## 5B. Despliegue manual con ZIP

Desde un equipo con Node 24 y Azure CLI, sobre el tag que se quiere desplegar:

```bash
git clone https://github.com/aquilu/psb-cerbero.git && cd psb-cerbero
git checkout v2.0.0
npm ci && npm test && npm audit --omit=dev --audit-level=high
npm ci --omit=dev
zip -r yita.zip package.json package-lock.json LICENSE src public node_modules

az login
az webapp deploy --resource-group $RG --name $APP --src-path yita.zip --type zip
```

---

## 6. Verificación después de desplegar

```bash
URL=https://$APP.azurewebsites.net

curl -fsS $URL/healthz                     # {"status":"ok"}
curl -sI $URL/ | grep -iE 'strict-transport|content-security|x-frame|permissions-policy'
curl -s  $URL/api/status                   # "accessRequired": true
curl -s -o /dev/null -w '%{http_code}\n' $URL/api/items/123   # 401 sin PIN
```

Luego abra la URL, ingrese el PIN y escanee un libro prestado y uno que esté en estantería.

**Registros:**

```bash
az webapp log config --resource-group $RG --name $APP --application-logging filesystem --level information
az webapp log tail --resource-group $RG --name $APP
```

## Migración desde v1 (Cerbero)

| v1 (Cerbero) | v2 (Yita) |
|---|---|
| `API_KEY` | `ALMA_API_KEY`. `API_KEY` sigue funcionando, pero se recomienda renombrarla y moverla a Key Vault. |
| `config.json` | Variables de entorno. |
| Comando de inicio `node ./bin/www` | `npm start` |
| Sin control de acceso | `ACCESS_PIN` y `COOKIE_SECRET` **obligatorios**: la app no arranca sin ellos. |
| Node antiguo | Node 24 LTS (`NODE|24-lts`) |

Recuerde avisar a las sedes el PIN nuevo antes de desplegar.

## Solución de problemas

| Síntoma | Causa probable |
|---|---|
| La app no arranca y el log dice «Configuración inválida» | Falta `ACCESS_PIN` o `COOKIE_SECRET`, el PIN tiene menos de 8 caracteres o el secreto menos de 32. |
| La referencia a Key Vault aparece en rojo | La identidad administrada no tiene el rol *Key Vault Secrets User* o el nombre del secreto no coincide. |
| «Verificación manual» en todas las lecturas | La API key no es válida, `ALMA_HOST` es de otra región o Alma no responde. Revise los registros. |
| No aparece el nombre del usuario | La API key no tiene permiso de lectura de **Users** en el Developer Network de Ex Libris. |
| El workflow falla en *Iniciar sesión en Azure* | La credencial federada no coincide con `repo:aquilu/psb-cerbero:environment:production`, o faltan los secretos en GitHub. |
| 403 al ingresar el PIN | La página se abrió desde otro dominio o hay un proxy intermedio que cambia el `Host`. Use la URL directa de la app. |
