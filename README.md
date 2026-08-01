# MiFirma — API

Firma electrónica de documentos, multiempresa y multiidioma. MVP: Uruguay,
Paraguay y Brasil.

El diseño vive en el proyecto de Claude (`MiFirmaCS`). Este README cubre
únicamente **cómo se corre esto**.

---

## La regla que ordena todo

**La autorización vive en la capa de datos**, en las políticas RLS de
PostgreSQL. No en la aplicación, no en la IA, no en el frontend. Una consulta
sin contexto no devuelve una fila.

De ahí se desprende todo lo demás de este archivo, incluido lo que sigue.

---

## ⚠ Con qué rol se conecta la app

**Nunca con `postgres`.** PostgreSQL saltea todas las políticas RLS para un
superusuario y para el dueño de las tablas. Si la app usa la `DATABASE_URL` que
entrega Railway —que es del rol `postgres`, superusuario— el aislamiento entre
cuentas queda apagado, los tests siguen pasando y no hay ningún síntoma hasta
que un cliente ve los documentos de otro.

Hay tres roles de **grupo**, sin login, que llevan los GRANT:

| Rol | Para qué | Ve contenido de clientes |
|---|---|---|
| `app_rw` | La aplicación en runtime | Sí, filtrado por RLS |
| `app_operador` | Consola del proveedor del SaaS | **No** — por ausencia de GRANT |
| `app_migrador` | Dueño de las tablas, corre migraciones | Sí |

Y dos roles de **conexión**, que crea `db/roles-login.sql`: `mifirma_app`
(miembro de `app_rw`) y `mifirma_operador` (miembro de `app_operador`).

Que el operador tenga conexión propia no es prolijidad: su límite **es** la
ausencia de GRANT. Compartiendo conexión con la app, ese límite no existiría.

---

## Puesta en marcha desde cero

### 1. Base

Postgres en Railway. La base que crea Railway se llama `railway`; la nuestra se
llama `mifirma` y hay que crearla:

```bash
railway connect Postgres          # abre psql contra 'railway'
create database mifirma;
```

Cada migración arranca con un guardia que aborta si `current_database()` no es
`mifirma`. Es la red que impide correrle las migraciones de MiFirma a la base de
payroll por error. No lo saques.

### 2. Túnel

**No habilites "Add Public Access"** en Railway. Expone la base a internet con
sólo una contraseña de por medio, y factura egress. El túnel cifrado del CLI
hace lo mismo sin exponer nada:

```bash
railway link                              # MiFirma → production → Postgres
railway connect Postgres --tunnel-only
```

Deja esa terminal abierta. Imprime un puerto local **efímero**, distinto en cada
sesión: no lo guardes en el `.zshrc`.

En otra terminal:

```bash
export MIFIRMA_DB="postgresql://postgres:LA_PASSWORD@127.0.0.1:EL_PUERTO/mifirma"
psql "$MIFIRMA_DB" -c "select current_database()"
```

Se llama `MIFIRMA_DB` y no `DATABASE_URL` a propósito: para que no se herede la
conexión de payroll de una terminal vieja o un `.env` olvidado.

### 3. Migraciones

Railway **no** corre migraciones solo. Van siempre antes del push:

```bash
for f in migrations/0*.sql; do
  echo "== $f"
  psql "$MIFIRMA_DB" -v ON_ERROR_STOP=1 -q -f "$f" || { echo "FALLÓ EN $f"; break; }
done
```

### 4. Roles de conexión

Una sola vez, con contraseñas generadas al momento para que no queden en el
historial del shell:

```bash
psql "$MIFIRMA_DB" -v ON_ERROR_STOP=1 \
  -v pass_app="$(openssl rand -base64 24)" \
  -v pass_op="$(openssl rand -base64 24)" \
  -f db/roles-login.sql
```

Anotá las dos contraseñas al generarlas: son las que van en las variables de
entorno del servicio de la app.

---

## Los tests

**Corren contra una base local, nunca contra Railway.** `test/semilla.sql` carga
datos sintéticos —Ana, Bruno, María, dos empresas, una factura— y eso en
producción es basura que después nadie sabe de dónde salió.

```bash
export MIFIRMA_TEST_DB="postgresql://localhost/mifirma_test"
createdb mifirma_test
for f in migrations/0*.sql; do psql "$MIFIRMA_TEST_DB" -v ON_ERROR_STOP=1 -q -f "$f"; done

psql "$MIFIRMA_TEST_DB" -q -f test/semilla.sql
psql "$MIFIRMA_TEST_DB" -q -c 'set role app_rw' -f test/rls_test.sql
psql "$MIFIRMA_TEST_DB" -q -f test/integridad_test.sql
psql "$MIFIRMA_TEST_DB" -q -f test/cobertura_test.sql
```

Los de RLS van con `set role app_rw` **a propósito**: como superusuario las
políticas se saltean y los veintiún tests pasarían sin probar absolutamente
nada.

| Archivo | Qué cubre |
|---|---|
| `test/rls_test.sql` | T1–T13: contexto vacío sin acceso, aislamiento entre cuentas, el firmante externo encerrado en su otorgamiento, `SET LOCAL` que no filtra entre transacciones, el otorgamiento irrevocable, y que la facturación no cruza cuentas |
| `test/integridad_test.sql` | T8b–T10: triggers de inmutabilidad, corridos como dueño |
| `test/cobertura_test.sql` | C1–C6: que no haya quedado **ninguna tabla** sin RLS, sin políticas, escribible por `app_rw`, visible para el operador, legible por `PUBLIC`, ni partición alcanzable salteando al padre |

`cobertura_test.sql` es el que hay que correr en CI antes de cada despliegue. No
prueba un caso: prueba que nadie se olvidó de nada.

---

## El schema de TypeScript

`src/db/schema.ts` se **genera**, no se escribe:

```bash
DATABASE_URL="$MIFIRMA_DB" npx kysely-codegen --dialect postgres --out-file src/db/schema.ts
```

Hay que regenerarlo después de cada migración, o TypeScript sigue creyendo en un
esquema que la base ya no tiene — un typecheck en cero que no significa nada.

`src/db/schema.payroll.ts.txt` es la copia del esquema de Payroll NG, guardada
sólo como referencia mientras se adapta el chasis.

---

## Estado

Quince migraciones, 44 tablas, 21 tests en verde.

Falta adaptar el chasis copiado de Payroll NG: el typecheck marca los archivos
que todavía le hablan al esquema viejo. El desglose y el orden están en
`claude/migraciones-del-chasis.md`, en el proyecto.

**`DEPLOY.md` y `RAILWAY.md` vienen de payroll y describen dos roles
—`mifirma_owner` y `app_user`— que no existen en ninguna migración. Hay que
reescribirlos contra lo que dice este README.**
