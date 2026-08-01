-- =============================================================================
-- MiFirma — 011_sesiones.sql
-- Códigos de un solo uso, dispositivos de confianza, tokens por correo y
-- credenciales de máquina para la API.
--
-- Adaptado del chasis de Payroll NG: `empresa_id` pasa a `cuenta_id` y todo lo
-- que referenciaba `usuario` ahora referencia `identidad`, porque en MiFirma la
-- identidad es global y precede a la cuenta.
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
-- Código de un solo uso (login de dos pasos).
--
-- Cambia respecto de payroll: apunta a `identidad`, no a `usuario`, y no lleva
-- cuenta_id — la identidad es global y el mismo código sirve sin importar en
-- qué cuenta vaya a entrar después.
-- -----------------------------------------------------------------------------
create table otp_login (
  id            uuid primary key default gen_random_uuid(),
  identidad_id  uuid not null references identidad(id),
  device_id     text not null,

  codigo_hash   text not null,          -- nunca el código en claro
  canal         text not null default 'sms' check (canal in ('sms','email','whatsapp')),

  expira_en     timestamptz not null,
  intentos      int not null default 0,
  usado         boolean not null default false,

  ip            inet,
  creado_en     timestamptz not null default now()
);

create index otp_login_vigentes on otp_login (identidad_id, device_id)
  where not usado;
create index otp_login_limpieza on otp_login (expira_en);

-- -----------------------------------------------------------------------------
-- Dispositivo de confianza: no vuelve a pedir código hasta que venza.
-- -----------------------------------------------------------------------------
create table dispositivo_confiable (
  id            uuid primary key default gen_random_uuid(),
  identidad_id  uuid not null references identidad(id),
  device_id     text not null,

  etiqueta      text,
  ip_alta       inet,
  user_agent    text,

  confiado_en   timestamptz not null default now(),
  ultimo_uso_en timestamptz not null default now(),
  expira_en     timestamptz not null,
  revocado_en   timestamptz,

  unique (identidad_id, device_id)
);

create index dispositivo_vigente on dispositivo_confiable (identidad_id)
  where revocado_en is null;

-- -----------------------------------------------------------------------------
-- Token de acceso por correo: reset de contraseña e invitación.
--
-- Distinto de `acceso_externo` (migración 007 del plan), que es el enlace del
-- FIRMANTE y apunta a un otorgamiento. Este es para entrar a la cuenta.
-- -----------------------------------------------------------------------------
create table token_acceso (
  id            uuid primary key default gen_random_uuid(),
  identidad_id  uuid not null references identidad(id),
  cuenta_id     uuid references cuenta(id),     -- null en reset de contraseña

  tipo          text not null check (tipo in ('reset','invitacion','verificacion_email')),
  token_hash    text not null unique,           -- sha256; el token en claro no toca la base

  expira_en     timestamptz not null,
  usado_en      timestamptz,
  ip_uso        inet,

  creado_en     timestamptz not null default now()
);

create index token_acceso_vigentes on token_acceso (identidad_id, tipo)
  where usado_en is null;

-- -----------------------------------------------------------------------------
-- Credencial de máquina para la API pública.
--
-- Entra por el mismo hook central y setea el mismo contexto RLS que una sesión
-- de usuario: un bug en un endpoint de API no cruza cuentas.
-- Ver `claude sesion-30-07-firma-simple-billing-api.md` §3.
-- -----------------------------------------------------------------------------
create table api_token (
  id            uuid primary key default gen_random_uuid(),
  cuenta_id     uuid not null references cuenta(id),

  nombre        text not null,
  token_sha256  text not null unique,
  prefijo       text not null,                  -- para mostrar sin revelar el token
  alcances      text[] not null default '{}',   -- scopes de la API

  activa        boolean not null default true,
  ultimo_uso_en timestamptz,
  ultimo_uso_ip inet,
  expira_en     timestamptz,

  creado_por    uuid references identidad(id),
  creado_en     timestamptz not null default now(),
  revocado_en   timestamptz
);

create index api_token_activos on api_token (cuenta_id) where activa and revocado_en is null;

-- =============================================================================
-- RLS
-- =============================================================================
alter table otp_login enable row level security;
create policy otp_login_all on otp_login for all using (
  app.actor() = 'sistema' or identidad_id = app.identidad_actual()
) with check (app.actor() = 'sistema');

alter table dispositivo_confiable enable row level security;
create policy dispositivo_select on dispositivo_confiable for select using (
  app.actor() = 'sistema' or identidad_id = any (app.identidades_del_actor()));
create policy dispositivo_insert on dispositivo_confiable for insert with check (
  app.actor() = 'sistema');
-- El usuario puede revocar sus propios dispositivos: es el "cerrar sesión en el
-- teléfono perdido" que las apps vuelven necesario.
create policy dispositivo_update on dispositivo_confiable for update using (
  app.actor() = 'sistema' or identidad_id = any (app.identidades_del_actor()));
create policy dispositivo_delete on dispositivo_confiable for delete using (false);

alter table token_acceso enable row level security;
create policy token_acceso_all on token_acceso for all using (
  app.actor() = 'sistema'
) with check (app.actor() = 'sistema');

alter table api_token enable row level security;
create policy api_token_select on api_token for select using (
     app.actor() = 'sistema'
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('cuenta','administrar'))
);
create policy api_token_insert on api_token for insert with check (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('cuenta','administrar'))
);
create policy api_token_update on api_token for update using (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('cuenta','administrar'))
);
create policy api_token_delete on api_token for delete using (false);

grant select, insert, update on otp_login, dispositivo_confiable, token_acceso, api_token to app_rw;

commit;
