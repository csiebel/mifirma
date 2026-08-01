-- =============================================================================
-- MiFirma — roles de conexión
--
-- Las migraciones crean tres roles de GRUPO, sin login: `app_rw`,
-- `app_operador` y `app_migrador`. Son los que llevan los GRANT. Este script
-- crea los roles con los que efectivamente se conecta cada proceso y los hace
-- miembros del grupo que les corresponde.
--
-- ⚠ POR QUÉ ESTO NO ES OPCIONAL
--
-- La `DATABASE_URL` que entrega Railway usa el rol `postgres`, que es
-- superusuario. PostgreSQL **saltea todas las políticas RLS** para un
-- superusuario y para el dueño de la tabla. Si la aplicación se conecta con esa
-- URL, el aislamiento entre cuentas está apagado — y no hay ningún síntoma: los
-- tests siguen pasando, las consultas devuelven de más y nadie se entera.
--
-- La app se conecta SIEMPRE con `mifirma_app`. Nunca con `postgres`.
--
-- Se corre una sola vez, con la contraseña por variable para que no quede en el
-- historial del shell ni en el repositorio:
--
--   psql "$MIFIRMA_DB" -v ON_ERROR_STOP=1 \
--     -v pass_app='...' -v pass_op='...' -f db/roles-login.sql
--
-- Generá cada contraseña con:  openssl rand -base64 24
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: script de MiFirma ejecutado contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- mifirma_app — la aplicación en runtime. Sujeta a RLS.
-- -----------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'mifirma_app') then
    create role mifirma_app login;
  end if;
end $$;

alter role mifirma_app password :'pass_app';
grant app_rw to mifirma_app;

-- -----------------------------------------------------------------------------
-- mifirma_operador — la consola del proveedor del SaaS.
--
-- Conexión aparte a propósito: su límite es la AUSENCIA de GRANT sobre el
-- contenido de los clientes (test C4). Si compartiera conexión con la app, ese
-- límite no existiría.
-- -----------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'mifirma_operador') then
    create role mifirma_operador login;
  end if;
end $$;

alter role mifirma_operador password :'pass_op';
grant app_operador to mifirma_operador;

-- -----------------------------------------------------------------------------
-- Ninguno de los dos hereda nada más.
--
-- `nosuperuser` y `nobypassrls` son explícitos y no redundantes: dejan la
-- intención escrita, y si alguien con permisos altera el rol más adelante, el
-- diff lo muestra.
-- -----------------------------------------------------------------------------
alter role mifirma_app      nosuperuser nocreatedb nocreaterole nobypassrls;
alter role mifirma_operador nosuperuser nocreatedb nocreaterole nobypassrls;

commit;

-- -----------------------------------------------------------------------------
-- Verificación
-- -----------------------------------------------------------------------------
select rolname, rolsuper, rolbypassrls, rolcanlogin
  from pg_roles
 where rolname in ('mifirma_app','mifirma_operador','app_rw','app_operador','app_migrador')
 order by rolcanlogin desc, rolname;
