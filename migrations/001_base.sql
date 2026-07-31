-- =============================================================================
-- MiFirma — 001_base.sql
-- Extensiones, esquema app, funciones de contexto y roles de base.
--
-- Todo el modelo de autorización se apoya en las funciones de este archivo.
-- Si algo de acá está mal, todo lo demás está mal.
-- =============================================================================

-- Guardia: esta migración NO debe correr contra la base de Payroll NG.
do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Extensiones
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto;   -- gen_random_uuid(), digest()
create extension if not exists ltree;      -- rutas de carpetas

create schema if not exists app;

-- -----------------------------------------------------------------------------
-- Roles de base
--
-- app_rw       : la aplicación. Sujeta a RLS.
-- app_operador : consola del proveedor. SIN acceso a contenido de clientes.
--                La ausencia de GRANT es el control, no una política que se
--                pueda pasar por alto. Ver iso-27001.md §2.
-- app_migrador : dueño de las tablas. Corre migraciones. No lo usa la app.
-- -----------------------------------------------------------------------------
do $roles$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_migrador') then
    create role app_migrador;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_rw') then
    create role app_rw;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_operador') then
    create role app_operador;
  end if;
end $roles$;

grant usage on schema public to app_rw, app_operador;
grant usage on schema app    to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- Contexto de la sesión
--
-- La aplicación setea estos GUC con SET LOCAL al inicio de cada transacción.
-- NUNCA con SET de sesión: el pool reutiliza conexiones y un GUC filtrado a la
-- request siguiente es una fuga de datos entre usuarios.
-- Ver propiedad-y-otorgamientos.md §4 y R12.
-- -----------------------------------------------------------------------------

-- 'cuenta' | 'externo' | 'operador' | 'sistema' | 'anonimo'
create or replace function app.actor() returns text
  language sql stable
  as $$ select coalesce(nullif(current_setting('app.actor', true), ''), 'anonimo') $$;

create or replace function app.identidad_actual() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.identidad_id', true), '')::uuid $$;

create or replace function app.cuenta_actual() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.cuenta_id', true), '')::uuid $$;

create or replace function app.otorgamiento_externo() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.otorgamiento_id', true), '')::uuid $$;

-- Anclajes de identidad acreditados EN ESTA SESIÓN (no los que la identidad
-- tiene). Entrar con mail acredita el anclaje de mail; entrar por tuID acredita
-- además el de documento con nivel alto.
create or replace function app.anclajes_probados() returns uuid[]
  language sql stable
  as $$
    select coalesce(
      string_to_array(nullif(current_setting('app.anclajes_probados', true), ''), ',')::uuid[],
      '{}'::uuid[])
  $$;

create or replace function app.nivel_garantia_sesion() returns text
  language sql stable
  as $$ select coalesce(nullif(current_setting('app.nivel_garantia', true), ''), 'ninguno') $$;

create or replace function app.nivel_alcanza(p_minimo text) returns boolean
  language sql immutable
  as $$
    select case app.nivel_garantia_sesion()
             when 'alto' then 3 when 'sustancial' then 2 when 'bajo' then 1 else 0 end
         >= case p_minimo
             when 'alto' then 3 when 'sustancial' then 2 when 'bajo' then 1 else 0 end
  $$;

-- ¿La sesión probó ser esta identidad, de alguna forma?
create or replace function app.identidad_probada() returns boolean
  language sql stable
  as $$
    select app.identidad_actual() is not null
       and cardinality(app.anclajes_probados()) > 0
  $$;

-- Idioma efectivo de la sesión, para app.t() sobre columnas jsonb.
create or replace function app.idioma_actual() returns text
  language sql stable
  as $$ select coalesce(nullif(current_setting('app.idioma', true), ''), 'es') $$;

create or replace function app.t(p_i18n jsonb, p_fallback text default null)
returns text language sql immutable as $$
  select coalesce(
    p_i18n ->> app.idioma_actual(),
    p_i18n ->> 'es',
    p_fallback
  )
$$;

grant execute on all functions in schema app to app_rw, app_operador;

commit;
