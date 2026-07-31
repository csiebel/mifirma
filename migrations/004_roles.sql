-- =============================================================================
-- MiFirma — 004_roles.sql
-- Roles y capacidades por cuenta. Mecánica heredada de Payroll NG;
-- solo cambia el catálogo de recursos y acciones.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Catálogo de capacidades del sistema
-- -----------------------------------------------------------------------------
create table capacidad (
  id                uuid primary key default gen_random_uuid(),
  recurso           text not null,
  accion            text not null,
  descripcion_i18n  jsonb not null,
  unique (recurso, accion)
);

insert into capacidad (recurso, accion, descripcion_i18n) values
  ('documento',  'crear',       '{"es":"Subir documentos"}'),
  ('documento',  'leer',        '{"es":"Ver documentos"}'),
  ('circuito',   'crear',       '{"es":"Armar circuitos de firma"}'),
  ('circuito',   'enviar',      '{"es":"Despachar circuitos"}'),
  ('circuito',   'cancelar',    '{"es":"Cancelar circuitos"}'),
  ('circuito',   'prorrogar',   '{"es":"Extender vencimientos"}'),
  ('plantilla',  'administrar', '{"es":"Administrar plantillas"}'),
  ('carpeta',    'organizar',   '{"es":"Crear y mover carpetas"}'),
  ('carpeta',    'permisos',    '{"es":"Administrar permisos de carpetas"}'),
  ('evidencia',  'leer',        '{"es":"Ver expedientes de evidencia"}'),
  ('lote',       'despachar',   '{"es":"Envío masivo desde planilla"}'),
  ('cuenta',     'administrar', '{"es":"Configurar la cuenta"}'),
  ('usuario',    'administrar', '{"es":"Administrar usuarios y roles"}'),
  ('facturacion','leer',        '{"es":"Ver facturación"}'),
  ('bitacora',   'leer',        '{"es":"Ver la bitácora de la cuenta"}');

-- -----------------------------------------------------------------------------
-- Roles: cada cuenta define los suyos
-- -----------------------------------------------------------------------------
create table rol (
  id                uuid primary key default gen_random_uuid(),
  cuenta_id         uuid references cuenta(id),   -- null = rol plantilla del sistema
  codigo            text not null,
  nombre_i18n       jsonb not null,
  sistema           boolean not null default false,   -- no editable por el cliente
  creado_en         timestamptz not null default now(),
  unique (cuenta_id, codigo)
);

create table rol_capacidad (
  rol_id            uuid not null references rol(id),
  capacidad_id      uuid not null references capacidad(id),
  primary key (rol_id, capacidad_id)
);

create table usuario_rol (
  id                uuid primary key default gen_random_uuid(),
  identidad_id      uuid not null references identidad(id),
  cuenta_id         uuid not null references cuenta(id),
  rol_id            uuid not null references rol(id),
  asignado_en       timestamptz not null default now(),
  asignado_por      uuid references identidad(id),
  unique (identidad_id, cuenta_id, rol_id)
);

create index usuario_rol_por_identidad on usuario_rol (identidad_id, cuenta_id);
create index usuario_rol_por_rol on usuario_rol (rol_id);

-- -----------------------------------------------------------------------------
-- ¿El actor tiene esta capacidad en la cuenta activa?
-- -----------------------------------------------------------------------------
create or replace function app.tiene_capacidad(p_recurso text, p_accion text)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.usuario_rol ur
    join public.rol_capacidad rc on rc.rol_id = ur.rol_id
    join public.capacidad c on c.id = rc.capacidad_id
    where ur.identidad_id = app.identidad_actual()
      and ur.cuenta_id = app.cuenta_actual()
      and c.recurso = p_recurso
      and c.accion = p_accion
  )
$$;

commit;
