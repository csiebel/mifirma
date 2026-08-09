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

echo "── base limpia"
psql -q -d postgres -c 'drop database if exists mifirma'
psql -q -d postgres -c 'drop role if exists app_rw' 2>/dev/null || true
psql -q -d postgres -c 'create database mifirma'
psql -q -d mifirma -v ON_ERROR_STOP=1 -f "$AQUI/base-minima.sql" >/dev/null

# ── LAS MIGRACIONES ANTERIORES ──────────────────────────────────────────────
#
# ⚠⚠ ESTO SE CALCULA. Antes era una lista escrita a mano en `previas.txt`, y
# **se desactualizó las dos veces que se pudo desactualizar**: le faltó la 054
# en agosto, se arregló, y para cuando llegó la 057 le faltaba la 056. Una lista
# de «todas las anteriores» que hay que acordarse de tocar cada vez que se
# agrega una migración no es un invariante: es una convención, y las
# convenciones se olvidan.
#
# Y el modo en que falla es el peor: **el banco da verde**. Corre una historia
# incompleta, la migración entra contra un esquema que no existe en ningún lado,
# y la que revienta es la base real.
#
# Ahora `previas.txt` guarda UN dato que sí es estable —hasta dónde llega
# `base-minima.sql`— y el resto sale de `migrations/`: todo lo que está después
# de esa marca y antes de la que se está probando. Agregar una migración no
# requiere acordarse de nada.
MARCA="$AQUI/previas.txt"
DESDE=""
[ -f "$MARCA" ] && DESDE="$(sed -n 's/^[[:space:]]*desde:[[:space:]]*\([0-9]\{3\}\).*/\1/p' "$MARCA" | head -1)"
if [ -z "$DESDE" ]; then
  echo "ABORTADO: falta la línea 'desde: NNN' en test/migraciones/previas.txt." >&2
  echo "Es hasta dónde llega base-minima.sql. Sin eso no se sabe qué correr antes." >&2
  exit 1
fi

# El número de la que se está probando: se corre todo lo ANTERIOR a ella.
HASTA="$(basename "$MIG" | sed -n 's/^\([0-9]\{3\}\).*/\1/p')"
if [ -z "$HASTA" ]; then
  echo "ABORTADO: '$(basename "$MIG")' no empieza con tres dígitos." >&2
  exit 1
fi

CORRIDAS=0
for previa in "$AQUI/../../migrations/"[0-9][0-9][0-9]_*.sql; do
  [ -e "$previa" ] || continue
  n="$(basename "$previa" | cut -c1-3)"
  # `10#` fuerza base decimal: sin eso, «050» se lee como octal y «008» explota.
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
