-- =============================================================================
-- MiFirma — 003_identidad.sql
-- Identidad global, anclajes probados, credenciales, membresías y personas.
--
-- Decisión estructural: la identidad es GLOBAL y PRECEDE a la cuenta.
-- Cuando se invita a firmar a alguien que no tiene cuenta, se crea su identidad
-- en estado 'latente' y los otorgamientos se emiten contra su identidad_id.
-- El día que se registra, no hay nada que migrar.
-- Ver propiedad-y-otorgamientos.md §0 y §7.1.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Identidad: la persona natural, a escala global del sistema
-- -----------------------------------------------------------------------------
create table identidad (
  id                    uuid primary key default gen_random_uuid(),

  email_normalizado     text not null unique,      -- lower(btrim(email))
  email_mostrado        text not null,
  email_verificado_en   timestamptz,

  nombre_mostrado       text,
  idioma_preferido      text,                      -- BCP 47, gana sobre todo lo demás

  -- La verdad sobre "quién es" vive en anclaje_identidad. Este es el principal,
  -- denormalizado para lectura. FK diferida al final de este archivo.
  anclaje_principal_id  uuid,

  estado                text not null default 'latente'
                          check (estado in ('latente','activa','suspendida','fusionada')),
  fusionada_en_id       uuid references identidad(id),

  creada_en             timestamptz not null default now(),
  creada_por_cuenta_id  uuid references cuenta(id),

  constraint identidad_fusionada_coherente
    check ((estado = 'fusionada') = (fusionada_en_id is not null))
);

create index identidad_por_estado on identidad (estado);
create index identidad_fusionadas on identidad (fusionada_en_id) where fusionada_en_id is not null;

-- FK circular pendiente de 002
alter table cuenta
  add constraint cuenta_titular_fk
  foreign key (identidad_titular_id) references identidad(id);

-- -----------------------------------------------------------------------------
-- Anclajes: las formas probadas de demostrar quién sos
--
-- El mail verificado es UN anclaje de nivel bajo, no la única puerta.
-- Un firmante que entra por tuID y nunca verificó su mail está mejor
-- identificado que uno que sí lo verificó.
-- -----------------------------------------------------------------------------
create table anclaje_identidad (
  id                    uuid primary key default gen_random_uuid(),
  identidad_id          uuid not null references identidad(id),

  tipo                  text not null check (tipo in ('email','telefono','documento','idp','dispositivo')),

  valor_normalizado     text,                 -- email | E.164

  pais                  char(2),              -- para tipo='documento'
  documento_tipo        text,                 -- 'ci' | 'ruc' | 'cpf' | 'cnpj' | 'pasaporte'
  documento_numero_norm text,                 -- sin puntos, guiones ni separadores

  idp                   text,                 -- 'tuid' | 'gov_br' | 'google'
  idp_sujeto            text,

  metodo_prueba         text not null check (metodo_prueba in
                          ('verificacion_email','otp_sms','oidc','firma_avanzada',
                           'firma_cualificada','biometria_dispositivo','manual_operador')),
  emisor                text,                 -- 'ANEL' | 'e-Firma' | 'ICP-Brasil'
  nivel_garantia        text not null check (nivel_garantia in ('bajo','sustancial','alto')),
  sujeto_certificado    text,                 -- DN completo, tal cual
  serie_certificado     text,

  probado_en            timestamptz not null default now(),
  vigente_hasta         timestamptz,
  revocado_en           timestamptz,
  evidencia_id          uuid,                 -- FK diferida a evidencia (010)

  creado_en             timestamptz not null default now()
);

-- Un documento identifica a UNA sola identidad en el sistema.
create unique index anclaje_documento_uq
  on anclaje_identidad (pais, documento_tipo, documento_numero_norm)
  where tipo = 'documento' and revocado_en is null;

create unique index anclaje_email_uq
  on anclaje_identidad (valor_normalizado)
  where tipo = 'email' and revocado_en is null;

create unique index anclaje_idp_uq
  on anclaje_identidad (idp, idp_sujeto)
  where tipo = 'idp' and revocado_en is null;

create index anclaje_por_identidad on anclaje_identidad (identidad_id) where revocado_en is null;

alter table identidad
  add constraint identidad_anclaje_principal_fk
  foreign key (anclaje_principal_id) references anclaje_identidad(id);

-- -----------------------------------------------------------------------------
-- Credenciales: 0..1 por identidad. Su existencia convierte una identidad
-- latente en una cuenta de acceso. Es lo que en payroll es `usuario`.
-- -----------------------------------------------------------------------------
create table credencial (
  identidad_id          uuid primary key references identidad(id),
  hash_password         text,
  password_cambiada_en  timestamptz,
  otp_habilitado        boolean not null default false,
  telefono_e164         text,
  idp_externo           text,
  idp_sujeto            text,
  ultimo_acceso_en      timestamptz,
  bloqueada_hasta       timestamptz,
  intentos_fallidos     int not null default 0,
  creada_en             timestamptz not null default now(),
  unique (idp_externo, idp_sujeto)
);

-- -----------------------------------------------------------------------------
-- Persona: legajo dentro de una cuenta de tipo empresa.
-- Frontera dura: NO cruza cuentas. Lo que cruza es `identidad`, que no tiene
-- datos de legajo — así el cruce no filtra el organigrama de nadie.
-- -----------------------------------------------------------------------------
create table persona (
  id                    uuid primary key default gen_random_uuid(),
  cuenta_id             uuid not null references cuenta(id),
  identidad_id          uuid references identidad(id),

  legajo                text,
  nombres               text,
  apellidos             text,
  cargo                 text,
  unidad_organizativa_id uuid,          -- organigrama, se completa al copiar de payroll
  jefe_persona_id       uuid references persona(id),

  creada_en             timestamptz not null default now(),
  unique (cuenta_id, legajo)
);

create index persona_por_cuenta on persona (cuenta_id);
create index persona_por_identidad on persona (identidad_id);

-- -----------------------------------------------------------------------------
-- Membresía: identidad ↔ cuenta, con vigencia.
-- "Cuándo dejó de trabajar acá" es una pregunta con consecuencias de
-- autorización, no un dato de RRHH: por eso vive acá y no en persona.
-- -----------------------------------------------------------------------------
create table membresia (
  id                    uuid primary key default gen_random_uuid(),
  identidad_id          uuid not null references identidad(id),
  cuenta_id             uuid not null references cuenta(id),
  persona_id            uuid references persona(id),

  desde                 date not null default current_date,
  hasta                 date,
  estado                text not null default 'activa'
                          check (estado in ('activa','suspendida','terminada')),
  creada_en             timestamptz not null default now(),

  constraint membresia_estado_coherente
    check ((hasta is null) = (estado <> 'terminada'))
);

create unique index membresia_vigente_uq
  on membresia (identidad_id, cuenta_id) where hasta is null;
create index membresia_por_identidad on membresia (identidad_id) where estado = 'activa';
create index membresia_por_cuenta on membresia (cuenta_id) where estado = 'activa';

-- -----------------------------------------------------------------------------
-- Resolución de identidad, anti-enumeración.
--
-- Devuelve lo mismo exista o no la identidad. Si devolviera algo distinto,
-- sería un oráculo para enumerar usuarios del sistema — el mismo problema que
-- /entrar ya resuelve en payroll.
-- -----------------------------------------------------------------------------
create or replace function app.resolver_identidad(p_email text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_norm text := lower(btrim(p_email));
begin
  if v_norm !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'email inválido';
  end if;

  insert into public.identidad (email_normalizado, email_mostrado, estado, creada_por_cuenta_id)
  values (v_norm, btrim(p_email), 'latente', app.cuenta_actual())
  on conflict (email_normalizado) do nothing;

  select id into v_id from public.identidad where email_normalizado = v_norm;
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- Identidades del actor: la actual más las fusionadas en ella.
--
-- Cuando dos identidades resultan ser la misma persona (misma cédula probada
-- por certificado), NO se mueven los otorgamientos: se marca la fusión y la RLS
-- resuelve por este conjunto. Los otorgamientos históricos nunca se tocan.
-- Ver propiedad-y-otorgamientos.md §7.4.
-- -----------------------------------------------------------------------------
create or replace function app.identidades_del_actor() returns uuid[]
language sql stable security definer set search_path = pg_catalog, public
as $$
  with recursive cadena as (
    select id from public.identidad where id = app.identidad_actual()
    union
    select i.id from public.identidad i join cadena c on i.fusionada_en_id = c.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) from cadena
$$;

commit;
