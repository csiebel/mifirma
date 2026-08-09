#!/usr/bin/env bash
# =============================================================================
# MiFirma — db/migrar.sh
#
# Aplica las migraciones que FALTAN, en orden, y anota cada una en
# `migracion_aplicada`. Correrlo dos veces no hace nada la segunda vez.
#
#   source db/tunel.sh          # en la terminal A
#   npm run migrate
#
# ═══ POR QUÉ EXISTE ═══
#
# El comando anterior era esto:
#
#   for f in migrations/0*.sql; do psql "$MIFIRMA_DB" -f "$f" || break; done
#
# Corría TODAS, siempre, confiando en que cada migración vieja fuera idempotente.
# Funciona hasta que una no lo es — y no hay forma de saber cuáles se aplicaron.
# El 5 de agosto de 2026 la 051, la 052 y la 053 estaban escritas y commiteadas,
# y ninguna aplicada: costó una tarde entera, y el síntoma fueron pantallas con
# 500 que no decían nada.
#
# ═══ LO QUE NO HACE ═══
#
# ⚠ **No corre nada contra el banco de pruebas.** Eso es `test/migraciones/
# probar.sh`, y va ANTES que esto, siempre. Este script toca la base de verdad:
# el túnel va a Railway y no hay una segunda.
#
# ⚠ **No revierte.** Si una migración falla, se detiene ahí y deja la base como
# quedó. Las anteriores ya están aplicadas y anotadas, así que arreglar el
# archivo y volver a correr sigue desde donde se cortó.
# =============================================================================
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/.." && pwd)"

if [ -z "${MIFIRMA_DB:-}" ]; then
  echo "ABORTADO: falta \$MIFIRMA_DB." >&2
  echo "Es el superusuario, y sale de: source db/tunel.sh (en la terminal A)." >&2
  echo "⚠ NO uses \$DATABASE_URL: ése es mifirma_app y no puede migrar." >&2
  exit 1
fi

q() { psql "$MIFIRMA_DB" -v ON_ERROR_STOP=1 -tAq -c "$1"; }

# ── ¿Existe el registro? ────────────────────────────────────────────────────
#
# Si no existe, esta base todavía no tiene la 057. No se la aplica sola a
# propósito: la 057 trae el relleno de las 56 anteriores dándolas por aplicadas,
# y eso es una afirmación fuerte sobre una base que no conocemos. La corre una
# persona, mirando.
if [ "$(q "select to_regclass('public.migracion_aplicada') is not null")" != "t" ]; then
  echo "ABORTADO: esta base no tiene la tabla \`migracion_aplicada\`." >&2
  echo "" >&2
  echo "Corré primero, a mano y mirando lo que dice:" >&2
  echo "  psql \"\$MIFIRMA_DB\" -v ON_ERROR_STOP=1 -f migrations/057_migracion_aplicada.sql" >&2
  echo "" >&2
  echo "Esa migración da por aplicadas las 56 anteriores. Si esta base NO las" >&2
  echo "tiene todas, no la corras: estarías marcando como hecho algo que no está." >&2
  exit 1
fi

huella() { sha256sum "$1" | cut -d' ' -f1; }

pendientes=0
aplicadas=0
cambiadas=0
aldia=0

TOTAL="$(ls "$RAIZ"/migrations/[0-9][0-9][0-9]_*.sql | wc -l | tr -d ' ')"

# ── EL REGISTRO SE TRAE DE UNA ──────────────────────────────────────────────
#
# ⚠ Una sola consulta, no una por migración. La primera versión preguntaba
# adentro del bucle —57 conexiones— y **contra el túnel de Railway eso parece
# colgado**: cada conexión tarda, y entre una y otra el script no imprime nada.
# Claudio lo reportó así, textual: «el 3 queda trancado acá». En local ni se
# notaba; el túnel lo hizo evidente.
#
# > Regla: un bucle que abre una conexión por vuelta se mide contra la latencia
# > que va a tener de verdad, no contra la de un Postgres en la misma máquina.
REGISTRO="$(mktemp)"
trap 'rm -f "$REGISTRO"' EXIT
echo "── leyendo el registro de $TOTAL migraciones"
psql "$MIFIRMA_DB" -v ON_ERROR_STOP=1 -tAqF $'\t' \
  -c "select nombre, coalesce(hash_sha256, '?') from migracion_aplicada" > "$REGISTRO"

for f in "$RAIZ"/migrations/[0-9][0-9][0-9]_*.sql; do
  nombre="$(basename "$f")"
  h="$(huella "$f")"
  # Búsqueda local, sin viaje a la base.
  fila="$(awk -F'\t' -v n="$nombre" '$1 == n { print $2; exit }' "$REGISTRO")"

  if [ -n "$fila" ]; then
    # Ya aplicada. Lo único que queda por decir es si el archivo cambió.
    #
    # ⚠ '?' es el hash NULL del relleno de la 057: significa «no se sabe con qué
    # contenido se aplicó», NO «coincide». No se compara, y se dice por qué.
    if [ "$fila" != "?" ] && [ "$fila" != "$h" ]; then
      echo "⚠  $nombre — APLICADA, PERO EL ARCHIVO CAMBIÓ DESDE ENTONCES."
      echo "   La base tiene lo viejo y el repo dice otra cosa. No se vuelve a correr."
      echo "   Si el cambio importa, va como migración nueva."
      cambiadas=$((cambiadas + 1))
    fi
    aldia=$((aldia + 1))
    continue
  fi

  pendientes=$((pendientes + 1))
  echo "── aplicando $nombre"
  psql "$MIFIRMA_DB" -v ON_ERROR_STOP=1 -q -f "$f"

  # Se anota DESPUÉS y aparte: la migración trae su propio begin/commit, así que
  # no se la puede envolver. Si esto fallara, la migración quedaría aplicada y
  # sin anotar, y el próximo intento la correría de nuevo — por eso toda
  # migración tiene que poder correrse dos veces, que es lo que exige el banco.
  q "insert into migracion_aplicada (nombre, hash_sha256) values ('$nombre', '$h')
     on conflict (nombre) do update set hash_sha256 = excluded.hash_sha256" >/dev/null
  aplicadas=$((aplicadas + 1))
done

echo ""
if [ "$aplicadas" -eq 0 ]; then
  echo "✓ Nada que aplicar: las $aldia están al día."
else
  echo "✓ $aplicadas aplicada(s) y anotada(s); $aldia ya estaban."
fi
[ "$cambiadas" -gt 0 ] && echo "⚠ $cambiadas archivo(s) cambiaron después de haberse aplicado. Mirá arriba."
exit 0
