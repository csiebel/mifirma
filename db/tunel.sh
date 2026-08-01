# =============================================================================
# MiFirma — abre el túnel a la base y deja MIFIRMA_DB listo.
#
#   source db/tunel.sh
#
# Se usa con `source`, no ejecutándolo: el `export` tiene que quedar en TU
# shell, no en un subproceso que muere al terminar.
#
# El túnel queda corriendo en segundo plano y vive mientras viva esa terminal.
# Para cerrarlo antes: `tunel_cerrar`.
#
# Por qué túnel y no "Add Public Access": el acceso público deja la base
# alcanzable desde internet con sólo la contraseña de por medio, y factura
# egress. El túnel no expone nada. El puerto efímero es el precio, y este script
# es para no pagarlo a mano.
# =============================================================================

tunel_cerrar() {
  if [ -n "$MIFIRMA_TUNEL_PID" ] && kill -0 "$MIFIRMA_TUNEL_PID" 2>/dev/null; then
    kill "$MIFIRMA_TUNEL_PID" 2>/dev/null
    echo "Túnel cerrado (pid $MIFIRMA_TUNEL_PID)."
  else
    echo "No hay túnel abierto en esta terminal."
  fi
  unset MIFIRMA_TUNEL_PID MIFIRMA_DB DATABASE_URL DATABASE_OPERADOR_URL
}

# Si ya hay uno vivo en esta terminal, no abrimos otro.
if [ -n "$MIFIRMA_TUNEL_PID" ] && kill -0 "$MIFIRMA_TUNEL_PID" 2>/dev/null; then
  echo "Ya hay un túnel abierto (pid $MIFIRMA_TUNEL_PID)."
  echo "MIFIRMA_DB -> $(printf '%s' "$MIFIRMA_DB" | sed 's|://[^@]*@|://***@|')"
else
  MIFIRMA_TUNEL_LOG="$(mktemp -t mifirma-tunel)"
  railway connect Postgres --tunnel-only >"$MIFIRMA_TUNEL_LOG" 2>&1 &
  MIFIRMA_TUNEL_PID=$!

  # Esperamos a que imprima la URL. Hasta 30 segundos: la primera vez tarda más
  # porque negocia la sesión SSH.
  _url=""
  for _i in $(seq 1 30); do
    if ! kill -0 "$MIFIRMA_TUNEL_PID" 2>/dev/null; then
      echo "El túnel murió al arrancar. Salida:"
      cat "$MIFIRMA_TUNEL_LOG"
      unset MIFIRMA_TUNEL_PID
      return 1 2>/dev/null || exit 1
    fi
    _url=$(grep -oE 'postgresql://[^[:space:]]+' "$MIFIRMA_TUNEL_LOG" | head -1)
    [ -n "$_url" ] && break
    sleep 1
  done

  if [ -z "$_url" ]; then
    echo "El túnel no imprimió la URL en 30 segundos. Salida:"
    cat "$MIFIRMA_TUNEL_LOG"
    kill "$MIFIRMA_TUNEL_PID" 2>/dev/null
    unset MIFIRMA_TUNEL_PID
    return 1 2>/dev/null || exit 1
  fi

  # Railway apunta a la base `railway`; la nuestra es `mifirma`.
  export MIFIRMA_DB="${_url%/railway}/mifirma"
  export MIFIRMA_TUNEL_PID MIFIRMA_TUNEL_LOG
  unset _url _i

  echo "Túnel abierto (pid $MIFIRMA_TUNEL_PID)."
  # Sin la contraseña, para que no quede en el scrollback ni en capturas.
  echo "MIFIRMA_DB -> $(printf '%s' "$MIFIRMA_DB" | sed 's|://[^@]*@|://***@|')"
fi


# ---------------------------------------------------------------------------
# Las tres conexiones
#
# `MIFIRMA_DB` es el superusuario `postgres`: sirve para migraciones y para
# psql, y NADA MÁS. La aplicación NUNCA se conecta con él — PostgreSQL saltea
# todas las políticas RLS para un superusuario, así que usarlo apaga el
# aislamiento entre cuentas sin producir ningún síntoma.
#
# `DATABASE_URL` es con lo que corre la app y los scripts (`mifirma_app`), y
# `DATABASE_OPERADOR_URL` la consola del proveedor (`mifirma_operador`). Las dos
# se arman acá porque el puerto del túnel cambia en cada sesión.
#
# Las contraseñas salen de db/.env.local, que está en .gitignore. Si no existe,
# la app no arranca — y eso es preferible a que arranque como superusuario.
# ---------------------------------------------------------------------------
[ -f "$(dirname "${BASH_SOURCE[0]:-db/tunel.sh}")/.env.local" ] \
  && . "$(dirname "${BASH_SOURCE[0]:-db/tunel.sh}")/.env.local"

_hostpuerto="${MIFIRMA_DB#*@}"; _hostpuerto="${_hostpuerto%%/*}"

if [ -n "$MIFIRMA_APP_PASSWORD" ]; then
  export DATABASE_URL="postgresql://mifirma_app:${MIFIRMA_APP_PASSWORD}@${_hostpuerto}/mifirma"
  echo "DATABASE_URL          -> mifirma_app@${_hostpuerto}/mifirma"
else
  unset DATABASE_URL
  echo "⚠ Falta MIFIRMA_APP_PASSWORD en db/.env.local: la app y los scripts no van a conectar."
fi

if [ -n "$MIFIRMA_OPERADOR_PASSWORD" ]; then
  export DATABASE_OPERADOR_URL="postgresql://mifirma_operador:${MIFIRMA_OPERADOR_PASSWORD}@${_hostpuerto}/mifirma"
  echo "DATABASE_OPERADOR_URL -> mifirma_operador@${_hostpuerto}/mifirma"
fi

# ---------------------------------------------------------------------------
# Y además se dejan en un archivo, no sólo en el entorno.
#
# El puerto del túnel cambia en cada sesión, y el servidor lo toma UNA vez al
# arrancar. Si el túnel se cae y se reabre en otro puerto, el proceso sigue
# apuntando al viejo y todo falla con ECONNREFUSED — un error que no dice
# "reabrí el túnel", dice "no me puedo conectar", y manda a buscar el problema
# en la base.
#
# Con este archivo, cualquier proceso que arranque después toma el puerto
# vigente, sin importar en qué terminal se haya abierto el túnel. `src/index.ts`
# lo carga pisando lo que venga del entorno.
#
# Tiene contraseñas: está en .gitignore junto con .env.local.
# ---------------------------------------------------------------------------
_dir="$(dirname "${BASH_SOURCE[0]:-db/tunel.sh}")"
{
  echo "# Generado por db/tunel.sh — NO editar a mano, se pisa en cada túnel."
  [ -n "$DATABASE_URL" ]          && echo "DATABASE_URL=$DATABASE_URL"
  [ -n "$DATABASE_OPERADOR_URL" ] && echo "DATABASE_OPERADOR_URL=$DATABASE_OPERADOR_URL"
  echo "MIFIRMA_DB=$MIFIRMA_DB"
} > "$_dir/.env.tunel"
chmod 600 "$_dir/.env.tunel" 2>/dev/null
echo "Puerto vigente escrito en db/.env.tunel (lo lee el servidor al arrancar)."

# Y se le avisa al servidor que ya está corriendo en la OTRA terminal.
#
# `tsx watch` reinicia el proceso cuando cambia un archivo fuente, pero no mira
# db/.env.tunel — no está importado desde ningún lado. Tocar index.ts dispara ese
# reinicio, y el servidor vuelve a levantar con el puerto nuevo sin que haya que
# ir a la otra terminal a matarlo.
#
# Si no hay ningún servidor corriendo, esto no hace nada.
touch "$_dir/../src/index.ts" 2>/dev/null
unset _hostpuerto _dir

# Prueba de vida: si esto no dice `mifirma`, algo quedó mal.
psql "$MIFIRMA_DB" -tAc "select 'conectado a ' || current_database()" 2>&1
