# Deploy en Railway — MiFirma

Guía concreta para Railway. El detalle general (variables, roles) está en
`DEPLOY.md`; acá va el paso a paso específico de Railway y el armado de dominios.

## Flujo

1. Proyecto + Postgres.
2. Roles de base (`mifirma_owner` + `app_user`) y migraciones, desde tu Mac.
3. Servicio de la app (desde GitHub, con el Dockerfile).
4. Variables de entorno de la app.
5. Primer operador + correo/Twilio.
6. Dominios y HTTPS.

---

## 0. Prerrequisitos

- Cuenta en **railway.com**.
- El proyecto en un repo de **GitHub** (Railway despliega desde ahí). Si no lo tenés en GitHub, podés usar la CLI: `npm i -g @railway/cli`, `railway login`, `railway up`.
- `psql` en tu Mac (ya lo tenés con Homebrew).

---

## 1. Proyecto + Postgres

- New Project → **Add PostgreSQL** (o "New → Database → PostgreSQL").
- Railway crea un servicio Postgres con un rol superusuario `postgres` y estas variables (pestaña del Postgres → Variables / Connect): `DATABASE_URL` (red **privada**), `DATABASE_PUBLIC_URL` (acceso **externo**), `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`.
- Copiá `DATABASE_PUBLIC_URL`: la vas a usar desde tu Mac en el paso 2.
- La base se llama `railway` por defecto (confirmá en `PGDATABASE`).

---

## 2. Roles de base + migraciones (desde tu Mac, una sola vez)

La app usa **dos** roles, y esto es de seguridad, no un capricho: la app **no** debe correr como el superusuario, porque entonces se saltea el aislamiento por empresa (RLS).

- `mifirma_owner`: dueño del esquema; corre migraciones y los flujos privilegiados (login, alta de empresas).
- `app_user`: el rol con el que corre la app en runtime; sujeto a RLS.

**a)** Conectado como el superusuario `postgres` (usá `DATABASE_PUBLIC_URL`), creá `mifirma_owner`:

```bash
psql "PEGÁ_AQUÍ_DATABASE_PUBLIC_URL" <<'SQL'
CREATE ROLE mifirma_owner LOGIN PASSWORD 'CLAVE_OWNER_FUERTE' CREATEROLE BYPASSRLS;
GRANT ALL ON DATABASE railway TO mifirma_owner;
SQL
```

`CREATEROLE` es para que pueda crear `app_user` dentro de la migración; `BYPASSRLS` para los flujos privilegiados; `GRANT ALL ON DATABASE` para que pueda crear el esquema. (Si Railway rechazara `BYPASSRLS`, sacalo: al correr las migraciones como `mifirma_owner`, queda dueño de las tablas, que alcanza para los flujos que usa.)

**b)** Corré TODAS las migraciones **como mifirma_owner** (mismo host/puerto/base que `DATABASE_PUBLIC_URL`, pero con el rol y la clave de `mifirma_owner`):

```bash
export DATABASE_OWNER_URL="postgres://mifirma_owner:CLAVE_OWNER_FUERTE@HOST_PUBLICO:PUERTO/railway"
bash scripts/migrar.sh
```

**c)** La migración 001 crea `app_user` como NOLOGIN. Dale login + clave:

```bash
psql "$DATABASE_OWNER_URL" -c "ALTER ROLE app_user LOGIN PASSWORD 'CLAVE_APP_FUERTE';"
```

---

## 3. Servicio de la app

- En el mismo proyecto → **New → GitHub Repo** y elegí tu repo (o por CLI: `railway up`).
- Railway detecta el `Dockerfile` y lo usa (el `railway.json` se lo confirma y le pone el healthcheck en `/health`).
- Railway inyecta `PORT` solo; la app ya lo respeta.

---

## 4. Variables de entorno de la app

En el servicio de la app → **Variables**:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | `postgres://app_user:CLAVE_APP_FUERTE@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` |
| `DATABASE_OWNER_URL` | `postgres://mifirma_owner:CLAVE_OWNER_FUERTE@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` |
| `APP_BASE_URL` | tu dominio final (al principio, la URL `*.up.railway.app`) |
| `OPERADOR_JWT_SECRET` | un secreto fuerte |
| `GATEWAY_ENC_KEY` | un secreto fuerte (**no lo cambies después**: rompe lo guardado) |
| `ANTHROPIC_API_KEY` | tu key (opcional; sin esto el asistente no anda) |
| `AUTH_DEV_SECRET` | un secreto fuerte (mientras uses el login propio) |

`${{Postgres.PGHOST}}` y compañía son **referencias** a las variables del servicio Postgres; Railway las resuelve a la red privada (entre servicios). Si preferís, pegá los valores literales del host/puerto/base privados.

Generar un secreto:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **CRÍTICO:** `DATABASE_URL` tiene que conectar como `app_user`, **no** como el rol `postgres` que Railway provee por defecto. Si la app corre como `postgres` (superusuario), se saltea el RLS y se cae el aislamiento por empresa. Por eso lo definís explícito como arriba.

---

## 5. Primer operador + correo/Twilio

Con la app ya arriba (su URL de Railway o tu dominio):

```bash
# Apuntando a la base de prod (DATABASE_OWNER_URL), creá el superadmin de operador:
npm run operador -- crear-superadmin <usuario> "<clave-de-8-o-mas>" "<nombre>"
```

Entrá a `https://TU-DOMINIO/operador`, configurá **correo** y **Twilio** (se guardan cifrados en la base). Sin eso no salen los OTP ni los mails.

---

## 6. Dominios y HTTPS

Tenés `mifirmang.com` y `mifirmanewgeneration.com`. La app sirve el sitio en `/` y la consola en `/app`, así que **un solo dominio cubre todo**.

1. **Registralos** en un registrador (Namecheap, Porkbun, Cloudflare Registrar…). Esto lo hacés vos; yo no puedo registrarlos. Para el DNS conviene **Cloudflare** (gratis y resuelve bien el dominio raíz).
2. En Railway → servicio de la app → **Settings → Networking → Custom Domain** → agregá `mifirmang.com`. Railway te da un destino (un CNAME).
3. En tu DNS:
   - Subdominio (ej. `www` o `app.mifirmang.com`): un registro **CNAME** → el destino de Railway.
   - Dominio raíz (`mifirmang.com`): si tu DNS soporta CNAME en la raíz (Cloudflare lo hace con *CNAME flattening*), apuntalo ahí; si no, usá **ALIAS/ANAME**.
4. Railway emite el **certificado TLS** solo, cuando el DNS resuelve (puede tardar unos minutos).
5. Segundo dominio (`mifirmanewgeneration.com`): agregalo también como Custom Domain en el mismo servicio (los dos sirven la app), o redirigilo al primario desde el registrador/DNS.
6. Cuando el dominio ande, poné `APP_BASE_URL=https://mifirmang.com` para que los links de los correos usen ese.

---

## 7. Verificación

- `https://TU-DOMINIO/health` → `{"ok":true}`.
- `https://TU-DOMINIO/` → sitio; `/app` → consola; `/operador` → operador.
- Desde el teléfono: abrí `/app`, probá el responsive y "Agregar a inicio" (la PWA).

Cuando esto ande, recién ahí tiene sentido seguir con **push notifications**.
