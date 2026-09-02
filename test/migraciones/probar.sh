#!/usr/bin/env bash
# =============================================================================
# MiFirma — test/migraciones/probar.sh
#
# Corre una migración contra un Postgres de descarte antes de tocar la de
# verdad. Dos veces, porque una migración que no se puede repetir es una que no
# se puede arreglar a mitad de camino.
#
#   test/migraciones/probar.sh migrations/054_lo_que_sea.sql
#
# Necesita un Postgres local escuchando. Con el docker-compose del repo:
#
#   docker compose up -d db
#   PGHOST=localhost PGPORT=5432 PGUSER=postgres test/migraciones/probar.sh migrations/054_...
#
# ⚠ Borra y recrea la base `mifirma` del servidor al que apunte. Nunca apuntarlo
# al túnel de Railway: `$MIFIRMA_DB` es la base REAL.
#
# ═══ CÓMO SE CONSTRUYE LA BASE (deudas 34 y 77, 21/8/2026) ═══
#
# Antes se cargaba `base-minima.sql`: un esqueleto de 21 tablas escrito a mano.
# No se parecía a la base real —67 tablas, RLS en 51, 153 políticas— así que una
# migración que rompiera una POLÍTICA pasaba el banco en verde. La regla de oro
# nº2 (la autorización vive en la capa de datos) era lo único que el banco no
# probaba.
#
# Ahora el esquema se construye CORRIENDO LAS MIGRACIONES REALES, de la 001 hasta
# la marca de `previas.txt` (la 050), y recién ahí se cargan los DATOS incómodos
# (`base-fixtures.sql`). Dos ventajas: el esquema del banco ES el de producción a
# la 050, y `tipo_evento` viene sembrado por las migraciones —con el texto del
# momento— en vez de a mano, que ya mordió una vez (siembra inventada, 17/8).
# =============================================================================
set -euo pipefail

MIG="${1:-}"
if [ -z "$MIG" ] || [ ! -f "$MIG" ]; then
  echo "Uso: $0 migrations/0NN_algo.sql" >&2
  exit 1
fi

AQUI="$(cd "$(dirname "$0")" && pwd)"
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"

# ⚠ El cinturón. Si alguien exporta PGHOST apuntando al túnel, esto borra la
# base de producción. Se comprueba que el puerto NO sea el del túnel de Railway,
# que db/tunel.sh escribe en db/.env.tunel.
if [ -f "$AQUI/../../db/.env.tunel" ]; then
  PUERTO_TUNEL="$(sed -n 's/.*:\([0-9]\{4,\}\)\/mifirma.*/\1/p' "$AQUI/../../db/.env.tunel" | head -1)"
  if [ -n "${PUERTO_TUNEL:-}" ] && [ "$PGPORT" = "$PUERTO_TUNEL" ]; then
    echo "ABORTADO: PGPORT=$PGPORT es el puerto del túnel. Esto borraría la base real." >&2
    exit 1
  fi
fi

# ── HASTA DÓNDE LLEGA EL ESQUEMA BASE, Y DESDE DÓNDE VAN LAS PREVIAS ─────────
#
# `previas.txt` guarda UN dato estable: `desde: NNN`. Es la primera migración que
# corre como «previa». Todo lo ANTERIOR (001..NNN-1) construye el esquema base;
# todo lo que va de NNN hasta la que se prueba (exclusive) son las previas. Un
# solo número gobierna las dos mitades: agregar una migración no requiere tocar
# nada acá.
MARCA="$AQUI/previas.txt"
DESDE=""
[ -f "$MARCA" ] && DESDE="$(sed -n 's/^[[:space:]]*desde:[[:space:]]*\([0-9]\{3\}\).*/\1/p' "$MARCA" | head -1)"
if [ -z "$DESDE" ]; then
  echo "ABORTADO: falta la línea 'desde: NNN' en test/migraciones/previas.txt." >&2
  echo "Es la primera migración que corre como previa; lo anterior arma el esquema base." >&2
  exit 1
fi

# El número de la que se está probando: se corre todo lo ANTERIOR a ella.
HASTA="$(basename "$MIG" | sed -n 's/^\([0-9]\{3\}\).*/\1/p')"
if [ -z "$HASTA" ]; then
  echo "ABORTADO: '$(basename "$MIG")' no empieza con tres dígitos." >&2
  exit 1
fi

MIGDIR="$AQUI/../../migrations"

echo "── base limpia"
psql -q -d postgres -c 'drop database if exists mifirma'
psql -q -d postgres -c 'create database mifirma'

# ── LOS ROLES ───────────────────────────────────────────────────────────────
# ⚠ Un rol es del CLÚSTER, no de la base: no se va con el `drop database`. Las
# migraciones les hacen GRANT, así que tienen que existir ANTES. Se crean sólo si
# faltan —un `drop` allá depende de permisos y de quién más lo use; un `create if
# not exists` no depende de nada— y por eso el banco andaba en una máquina y
# moría en otra con «role app_rw already exists». `app_operador` también: el
# centinela de la 026 llama a `has_table_privilege('app_operador', …)`, que
# revienta si el rol no existe.
psql -q -d postgres -c "do \$r\$ begin
  if not exists (select 1 from pg_roles where rolname='app_rw')       then create role app_rw;       end if;
  if not exists (select 1 from pg_roles where rolname='app_operador') then create role app_operador; end if;
end \$r\$;"

# ── EL ESQUEMA: las migraciones reales, de la 001 hasta ANTES de DESDE ───────
BASE=0
for m in "$MIGDIR"/[0-9][0-9][0-9]_*.sql; do
  [ -e "$m" ] || continue
  n="$(basename "$m" | cut -c1-3)"
  # `10#` fuerza base decimal: sin eso, «050» se lee como octal y «008» explota.
  if [ "$((10#$n))" -lt "$((10#$DESDE))" ]; then
    psql -q -d mifirma -v ON_ERROR_STOP=1 -f "$m" >/dev/null
    BASE=$((BASE + 1))
  fi
done
echo "── esquema: $BASE migración$([ "$BASE" -eq 1 ] || echo es) (001 → $(printf '%03d' $((10#$DESDE - 1))))"

# ── LOS DATOS INCÓMODOS ─────────────────────────────────────────────────────
echo "── datos: base-fixtures.sql"
psql -q -d mifirma -v ON_ERROR_STOP=1 -f "$AQUI/base-fixtures.sql" >/dev/null

# ── LAS PREVIAS: de DESDE hasta ANTES de la que se prueba ────────────────────
CORRIDAS=0
for previa in "$MIGDIR"/[0-9][0-9][0-9]_*.sql; do
  [ -e "$previa" ] || continue
  n="$(basename "$previa" | cut -c1-3)"
  if [ "$((10#$n))" -ge "$((10#$DESDE))" ] && [ "$((10#$n))" -lt "$((10#$HASTA))" ]; then
    echo "── previa: $(basename "$previa")"
    psql -q -d mifirma -v ON_ERROR_STOP=1 -f "$previa" >/dev/null
    CORRIDAS=$((CORRIDAS + 1))
  fi
done
echo "── ($CORRIDAS previa$([ "$CORRIDAS" -eq 1 ] || echo s), de la $DESDE en adelante)"

echo "── $(basename "$MIG") — primera pasada"
psql -q -d mifirma -v ON_ERROR_STOP=1 -f "$MIG"

echo "── $(basename "$MIG") — segunda pasada (tiene que dar lo mismo)"
psql -q -d mifirma -v ON_ERROR_STOP=1 -f "$MIG"

# ── Y SI TRAE PRUEBA DE COMPORTAMIENTO, SE CORRE ────────────────────────────
#
# Correr una migración dos veces prueba que ENTRA y que se puede repetir. No
# prueba que HAGA LO QUE DICE. La 055 es el ejemplo: entraba perfecto y la
# pregunta que importaba —¿el campo de Beto lo puede completar Ana?— no la
# contestaba nadie.
#
# Si existe `ejerce/<mismo nombre>.sql`, se corre acá, contra la base ya
# migrada. Es opcional: una migración sin comportamiento nuevo no lo necesita.
EJERCE="$AQUI/ejerce/$(basename "$MIG")"
if [ -f "$EJERCE" ]; then
  echo "── ejerce/$(basename "$MIG") — el comportamiento, no el catálogo"
  psql -q -d mifirma -v ON_ERROR_STOP=1 -f "$EJERCE"
else
  echo "── (sin prueba de comportamiento: no hay ejerce/$(basename "$MIG"))"
fi

echo ""
echo "✓ Corre, corre dos veces$([ -f "$EJERCE" ] && echo ", y hace lo que dice")."
