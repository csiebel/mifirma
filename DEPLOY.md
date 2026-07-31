# Despliegue — MiFirma

Guía para sacar la app de tu Mac y ponerla online. Lo que se despliega es **un
solo servicio Node** (el backend Fastify, que también sirve la consola, la PWA y
los íconos) **+ una base PostgreSQL**. No hay frontend separado.

> Esta guía es host-agnóstica: el `Dockerfile` corre en casi cualquier lado.
> Más abajo hay una recomendación concreta de dónde hostear.

---

## 1. Lo que necesitás antes de empezar

- Una base **PostgreSQL** accesible (administrada o propia).
- Un lugar para correr el **contenedor** (PaaS o VPS).
- Las credenciales/valores de las variables de entorno (sección 4).

---

## 2. Modelo de dos roles en la base

La app usa **dos** conexiones a la misma base, a propósito:

- `DATABASE_URL` → rol **`app_user`**, sujeto a RLS. Es como conecta la app en runtime. Nunca evade el aislamiento por empresa.
- `DATABASE_OWNER_URL` → rol **`mifirma_owner`**, dueño del esquema. Solo para correr migraciones y el alta de empresas. Evade RLS.

Esto requiere poder **crear roles** en la base. En PostgreSQL administrado (Neon,
Supabase, Railway, RDS, etc.) el rol admin que te dan ya puede hacerlo.

---

## 3. Preparar la base (una sola vez)

```bash
# a) Creá la base y el rol owner (si tu proveedor no lo hizo ya).
#    En managed PG, usá el rol admin que te dieron como "owner".
createdb mifirma
psql mifirma -c "CREATE ROLE mifirma_owner LOGIN PASSWORD 'PONÉ_UNA_CLAVE_FUERTE';"
psql mifirma -c "ALTER DATABASE mifirma OWNER TO mifirma_owner;"

# b) Corré TODAS las migraciones en orden, como owner.
export DATABASE_OWNER_URL="postgres://mifirma_owner:LA_CLAVE@TU_HOST:5432/mifirma"
bash scripts/migrar.sh

# c) La migración 001 crea app_user como NOLOGIN. Dale acceso de login + clave,
#    para que la app pueda conectar con DATABASE_URL.
psql "$DATABASE_OWNER_URL" -c "ALTER ROLE app_user LOGIN PASSWORD 'OTRA_CLAVE_FUERTE';"
```

> `scripts/migrar.sh` aplica `migrations/*.sql` en orden (arregla el viejo `npm
> run migrate`, que solo corría la 001). Necesita `psql` en el PATH.

Cuando agregues una migración nueva más adelante, la corrés sola contra prod:
`psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -f migrations/034_xxx.sql`.

---

## 4. Variables de entorno

Partí de `.env.example`. Las que importan en producción:

| Variable | Para qué | Nota |
|---|---|---|
| `DATABASE_URL` | conexión de la app (app_user) | con la clave del paso 3c |
| `DATABASE_OWNER_URL` | migraciones / alta de empresas | con la clave del paso 3a |
| `PORT` | puerto | muchos hosts lo inyectan solos |
| `APP_BASE_URL` | URL pública (links en correos) | ej. `https://app.tudominio.com` |
| `OPERADOR_JWT_SECRET` | firma de sesión de la consola de operador | generá uno fuerte |
| `GATEWAY_ENC_KEY` | cifra credenciales de pasarelas de pago | **no la cambies después** (rompe lo guardado) |
| `ANTHROPIC_API_KEY` | asistente (IA) | opcional; sin esto el chat no anda |
| `AUTH_*` | validación de JWT / IdP | ver abajo |

Generar un secreto fuerte:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Sobre `AUTH_*`:** hoy el login de la consola funciona con `AUTH_DEV_SECRET`
(HS256, pensado para desarrollo). Para producción de verdad conviene un IdP real
(definir `AUTH_JWKS_URL` / `AUTH_ISSUER` / `AUTH_AUDIENCE`); mientras tanto, si
usás el login propio, poné un `AUTH_DEV_SECRET` largo y secreto.

**Correo (SMTP) y SMS/WhatsApp (Twilio) NO van por env:** se configuran después
de desplegar, desde la **consola de operador** (`/operador`), y se guardan
cifrados en la base. Sin eso, los OTP y los mails no salen.

---

## 5. Construir y correr

### Opción A — probar el contenedor localmente (recomendado antes de subir)

```bash
docker compose up -d db
# esperá a que la db esté "healthy", después:
DATABASE_OWNER_URL=postgres://mifirma_owner:owner_local@localhost:5433/mifirma bash scripts/migrar.sh
psql "postgres://mifirma_owner:owner_local@localhost:5433/mifirma" -c "ALTER ROLE app_user LOGIN PASSWORD 'app_local';"
docker compose up -d app
# abrí http://localhost:3000/app
```

### Opción B — en el host (build + run con tus variables)

```bash
docker build -t mifirma .
docker run -p 3000:3000 --env-file .env mifirma
```

---

## 6. Primer operador y datos iniciales

```bash
# Creá el primer superadmin de la consola de operador (una vez, contra prod):
npm run operador -- crear-superadmin <usuario> "<clave-de-8-o-mas>" "<nombre>"
```

Después entrá a `/operador`, configurá el **correo** y **Twilio**, y desde la
consola de empresa (`/app`) ya podés operar.

---

## 7. Dominio, HTTPS y chequeos

- Apuntá tu dominio al host y activá **HTTPS** (la mayoría de los PaaS lo dan solo). La PWA y los push **exigen** HTTPS.
- Health check: `GET /health` devuelve `{ "ok": true }`.
- Smoke test post-deploy: abrí `/` (sitio), `/app` (consola), logueate, generá un recibo, y probá instalar la PWA desde el teléfono.

---

## 8. Dónde hostear (recomendación)

Cualquier combinación de **Postgres administrado + host de contenedores** sirve.
Para arrancar simple:

- **Más fácil de todo:** Render o Railway. Subís el `Dockerfile`, agregás un
  Postgres administrado del mismo proveedor, cargás las variables en el panel, y
  te dan HTTPS y dominio. Bueno para validar rápido.
- **Más cerca de la región (LATAM):** Fly.io tiene región **São Paulo (`gru`)**,
  que baja la latencia para Uruguay/Paraguay/Brasil. Es Docker-nativo.
- **Postgres administrado suelto:** Neon o Supabase (capas gratis generosas) si
  preferís separar la base del host de la app.

Más adelante, cuando importe la **residencia de datos** por país (UE/Brasil), vas
a querer segmentar por región — pero para el MVP, una región cercana alcanza.
