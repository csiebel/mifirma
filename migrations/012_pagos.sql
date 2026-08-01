-- =============================================================================
-- MiFirma — 012_pagos.sql
-- Con qué se nos paga: pasarelas (configuración del operador), catálogos
-- bancarios y el medio de pago guardado de cada cuenta.
--
-- ⚠ CAMBIO respecto de payroll. Allá `medio_pago` era la forma en que la
--   empresa le paga el sueldo al empleado (cuelga de `relacion_laboral`): eso
--   es dominio de payroll y no se trae. Acá `medio_pago` es la forma en que el
--   CLIENTE nos paga a nosotros, y cuelga de `cuenta`. Mismo nombre, otra cosa.
--
-- Regla que no se negocia (ISO 27001 §A.8.24 y PCI por elevación):
-- ningún dato de tarjeta toca esta base. Guardamos el token de la pasarela,
-- los últimos cuatro dígitos y la marca, nada más.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Pasarelas de pago: configuración global del operador.
--
-- Una pasarela puede estar habilitada en varios países y cobrar en varias
-- monedas. `cobra_usd` no es cosmético: el diseño de billing (§5, D5) exige que
-- en cada país haya al menos una pasarela capaz de cobrar en dólares, salvo
-- donde el paquete de país lo prohíba (Brasil, probablemente).
-- -----------------------------------------------------------------------------
create table pasarela_pago (
  id                    uuid primary key default gen_random_uuid(),
  proveedor             text not null,          -- 'mercadopago' | 'stripe' | 'dlocal' | ...
  nombre                text not null,
  modo                  text not null default 'sandbox' check (modo in ('sandbox','produccion')),

  -- Credenciales: solo cifradas. La clave de cifrado vive en el KMS del
  -- operador, no en la base. Ver iso-27001.md §3.
  client_id             text,
  client_secret_cifrado text,
  webhook_secret_cifrado text,

  activa                boolean not null default true,
  orden                 int not null default 100,

  creada_en             timestamptz not null default now(),
  actualizada_en        timestamptz not null default now(),

  unique (proveedor, modo)
);

-- Dónde y en qué moneda puede cobrar cada pasarela. El operador lo administra;
-- el país se resuelve por `cuenta.pais`.
create table pasarela_pais (
  pasarela_id           uuid not null references pasarela_pago(id) on delete cascade,
  pais                  char(2) not null,
  moneda                char(3) not null,       -- ISO 4217
  es_default            boolean not null default false,
  activa                boolean not null default true,
  primary key (pasarela_id, pais, moneda)
);

-- Una sola pasarela por defecto por país y moneda.
create unique index pasarela_default_unica on pasarela_pais (pais, moneda)
  where es_default and activa;

-- -----------------------------------------------------------------------------
-- Catálogos bancarios.
--
-- Se traen de payroll porque la transferencia bancaria sigue siendo forma
-- corriente de pago de un SaaS en UY y PY, y porque el catálogo es dato
-- verificable por país, no código.
-- -----------------------------------------------------------------------------
create table banco (
  id                uuid primary key default gen_random_uuid(),
  pais              char(2) not null,
  nombre            text not null,
  codigo            text,                       -- código local (BCU, BCP, COMPE en BR)
  activo            boolean not null default true,
  orden             int not null default 100,
  unique (pais, nombre)
);

create table tipo_cuenta_bancaria (
  id                uuid primary key default gen_random_uuid(),
  pais              char(2) not null,
  codigo            text not null,
  nombre_i18n       jsonb not null,
  activo            boolean not null default true,
  orden             int not null default 100,
  unique (pais, codigo)
);

-- -----------------------------------------------------------------------------
-- Medio de pago de la cuenta: con qué nos paga el cliente.
-- -----------------------------------------------------------------------------
create table medio_pago (
  id                uuid primary key default gen_random_uuid(),
  cuenta_id         uuid not null references cuenta(id) on delete cascade,

  tipo              text not null check (tipo in ('tarjeta','debito_bancario','transferencia')),

  -- Tarjeta: SOLO el token de la pasarela y lo mínimo para mostrarlo.
  pasarela_id       uuid references pasarela_pago(id),
  token_externo     text,
  marca             text,                       -- 'visa' | 'mastercard' | ...
  ultimos_cuatro    char(4),
  vence_mes         int check (vence_mes between 1 and 12),
  vence_anio        int,

  -- Débito bancario / transferencia.
  banco_id          uuid references banco(id),
  tipo_cuenta_id    uuid references tipo_cuenta_bancaria(id),
  numero_cuenta     text,
  titular           text,

  moneda            char(3),
  es_default        boolean not null default false,
  activo            boolean not null default true,

  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now(),

  -- Coherencia: la tarjeta va con token de pasarela; lo bancario, con banco.
  constraint medio_pago_coherente check (
    case tipo
      when 'tarjeta' then pasarela_id is not null and token_externo is not null
      else banco_id is not null
    end
  ),
  -- Nunca el número completo: 16 dígitos en `numero_cuenta` para un medio de
  -- tipo tarjeta sería un PAN, y eso acá no entra.
  constraint tarjeta_sin_numero check (tipo <> 'tarjeta' or numero_cuenta is null)
);

create unique index medio_pago_default_unico on medio_pago (cuenta_id)
  where es_default and activo;

-- =============================================================================
-- Semilla: catálogos bancarios de los tres países del MVP.
-- Bancos comerciales principales; el operador completa desde la consola.
-- =============================================================================
insert into banco (pais, nombre, orden) values
  ('UY','Banco República (BROU)', 10),
  ('UY','Banco Santander', 20),
  ('UY','Itaú', 30),
  ('UY','BBVA', 40),
  ('UY','Scotiabank', 50),
  ('UY','Banco Bandes', 60),
  ('UY','HSBC', 70),
  ('UY','Banque Heritage', 80),
  ('PY','Banco Nacional de Fomento', 10),
  ('PY','Banco Itaú Paraguay', 20),
  ('PY','Banco Continental', 30),
  ('PY','Sudameris Bank', 40),
  ('PY','Banco GNB', 50),
  ('PY','Banco Atlas', 60),
  ('PY','Ueno Bank', 70),
  ('BR','Banco do Brasil', 10),
  ('BR','Itaú Unibanco', 20),
  ('BR','Bradesco', 30),
  ('BR','Caixa Econômica Federal', 40),
  ('BR','Santander Brasil', 50),
  ('BR','Banco Inter', 60),
  ('BR','Nubank', 70);

insert into tipo_cuenta_bancaria (pais, codigo, nombre_i18n, orden) values
  ('UY','caja_ahorro', '{"es":"Caja de ahorro","pt":"Poupança","en":"Savings"}', 10),
  ('UY','cuenta_corriente','{"es":"Cuenta corriente","pt":"Conta corrente","en":"Checking"}', 20),
  ('PY','caja_ahorro', '{"es":"Caja de ahorro","pt":"Poupança","en":"Savings"}', 10),
  ('PY','cuenta_corriente','{"es":"Cuenta corriente","pt":"Conta corrente","en":"Checking"}', 20),
  ('BR','poupanca',    '{"es":"Caja de ahorro","pt":"Conta poupança","en":"Savings"}', 10),
  ('BR','corrente',    '{"es":"Cuenta corriente","pt":"Conta corrente","en":"Checking"}', 20),
  ('BR','pagamento',   '{"es":"Cuenta de pago","pt":"Conta de pagamento","en":"Payment account"}', 30);

-- =============================================================================
-- RLS
--
-- Pasarelas y catálogos son configuración del operador: no llevan RLS por
-- cuenta, se protegen por GRANT. `medio_pago` sí es del cliente, y es tenant
-- duro: la plata no cruza cuentas ni por otorgamiento (billing-diseno §7).
-- =============================================================================
revoke all on pasarela_pago, pasarela_pais from public;
grant select, insert, update, delete on pasarela_pago, pasarela_pais to app_operador;
-- La aplicación necesita leer la pasarela para cobrar, jamás escribirla.
grant select on pasarela_pago, pasarela_pais to app_rw;

grant select on banco, tipo_cuenta_bancaria to app_rw, app_operador;
grant insert, update, delete on banco, tipo_cuenta_bancaria to app_operador;

alter table medio_pago enable row level security;

create policy medio_pago_select on medio_pago for select using (
     app.actor() = 'sistema'
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('cuenta','administrar'))
);
create policy medio_pago_insert on medio_pago for insert with check (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('cuenta','administrar'))
);
create policy medio_pago_update on medio_pago for update using (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('cuenta','administrar'))
);
-- No se borra un medio de pago: se desactiva. La factura vieja tiene que poder
-- decir con qué se cobró.
create policy medio_pago_delete on medio_pago for delete using (false);

grant select, insert, update on medio_pago to app_rw;

commit;
