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

# Las migraciones anteriores que hay que correr antes, en orden. La lista vive
# en `previas.txt` y son NOMBRES: los archivos se leen de `migrations/`, no se
# copian acá. Una copia de una migración es una migración que se va a
# desactualizar sola y va a hacer pasar una prueba que la base real no pasa.
LISTA="$AQUI/previas.txt"
if [ -f "$LISTA" ]; then
  while IFS= read -r nombre; do
    case "$nombre" in ''|'#'*) continue ;; esac
    echo "── previa: $nombre"
    psql -q -d mifirma -v ON_ERROR_STOP=1 -f "$AQUI/../../migrations/$nombre" >/dev/null
  done < "$LISTA"
fi

echo "── $(basename "$MIG") — primera pasada"
psql -q -d mifirma -v ON_ERROR_STOP=1 -f "$MIG"

echo "── $(basename "$MIG") — segunda pasada (tiene que dar lo mismo)"
psql -q -d mifirma -v ON_ERROR_STOP=1 -f "$MIG"

echo ""
echo "✓ Corre, y corre dos veces."
