#!/usr/bin/env bash
# Aplica TODAS las migraciones en orden contra la base, usando el rol owner.
# Requiere psql en el PATH.
#
# Uso:
#   DATABASE_OWNER_URL=postgres://mifirma_owner:...@host:5432/mifirma ./scripts/migrar.sh
set -euo pipefail
: "${DATABASE_OWNER_URL:?Falta DATABASE_OWNER_URL}"
cd "$(dirname "$0")/.."
for f in migrations/*.sql; do
  echo ">> aplicando $f"
  psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -f "$f"
done
echo "Migraciones OK."
