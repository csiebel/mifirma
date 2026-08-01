-- =============================================================================
-- MiFirma — 010_operador.sql
-- Realm del operador: la consola de quien opera la plataforma.
--
-- Estas tablas vienen del chasis de Payroll NG, adaptadas: `empresa_id` pasa a
-- `cuenta_id`, y todo lo que referenciaba `usuario` ahora referencia
-- `identidad`, porque en MiFirma la identidad es global y precede a la cuenta.
--
-- ⚠ NO se crea la tabla `usuario` de payroll. Su rol lo cumplen `identidad`
--   (quién es la persona) y `credencial` (cómo entra), creadas en la 003. El
--   código de login hay que adaptarlo a ese modelo, no al revés.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Operador: el realm del proveedor del SaaS.
--
-- Vive fuera del modelo de cuentas: no tiene cuenta_id ni identidad. Es la
-- consola de quien opera la plataforma, y su acceso a los datos de los clientes
-- está limitado por GRANT (ver 009), no por estas tablas.
-- -----------------------------------------------------------------------------
create table operador (
  id                uuid primary key default gen_random_uuid(),
  usuario           text not null unique,
  nombre            text not null,
  password_hash     text not null,

  es_superadmin     boolean not null default false,
  activo            boolean not null default true,

  intentos_fallidos int not null default 0,
  bloqueado_hasta   timestamptz,

  mfa_secreto       text,                       -- MFA obligatorio: ver iso-27001.md §2
  mfa_habilitado_en timestamptz,

  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);

create table operador_capacidad (
  operador_id       uuid not null references operador(id) on delete cascade,
  capacidad         text not null,
  primary key (operador_id, capacidad)
);

-- El operador se autentica contra su propio realm; estas tablas no llevan RLS
-- por cuenta porque no pertenecen a ninguna. Se protegen por GRANT: el rol
-- app_rw no las toca.
revoke all on operador, operador_capacidad from public;
grant select, insert, update on operador, operador_capacidad to app_operador;


commit;
