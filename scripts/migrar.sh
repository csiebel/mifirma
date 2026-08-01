#!/usr/bin/env bash
# Aplica TODAS las migraciones en orden contra la base, usando el rol owner.
# Requiere psql en el PATH.
#
# Uso:
#   MIFIRMA_DB=postgresql://postgres:...@host:puerto/mifirma ./scripts/migrar.sh
set -euo pipefail
: "${MIFIRMA_DB:?Falta MIFIRMA_DB}"
cd "$(dirname "$0")/.."
for f in migrations/*.sql; do
  echo ">> aplicando $f"
  psql "$MIFIRMA_DB" -v ON_ERROR_STOP=1 -f "$f"
done
echo "Migraciones OK."
