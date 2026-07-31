-- =============================================================================
-- MiFirma — 002_cuenta.sql
-- El tenant. Todo cuelga de acá.
--
-- Decisión del 30/7: el tenant es `cuenta`, con tipo empresa o persona.
-- La tabla `empresa` sigue existiendo pero como DETALLE de una cuenta de tipo
-- empresa, no como tenant. Ver repositorio-campos-y-envio-masivo.md §1.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Catálogos
-- -----------------------------------------------------------------------------
create table plan (
  id                uuid primary key default gen_random_uuid(),
  codigo            text not null unique,
  nombre_i18n       jsonb not null,
  activo            boolean not null default true,
  orden             int not null default 100,
  creado_en         timestamptz not null default now()
);

create table industria (
  id                uuid primary key default gen_random_uuid(),
  codigo            text not null unique,
  nombre_i18n       jsonb not null
);

-- -----------------------------------------------------------------------------
-- Cuenta: el tenant
-- -----------------------------------------------------------------------------
create table cuenta (
  id                    uuid primary key default gen_random_uuid(),
  tipo                  text not null check (tipo in ('empresa','persona')),

  nombre_mostrado       text not null,
  pais                  char(2) not null,
  -- BCP 47 como text, no char(2): hoy 'es', mañana 'pt-BR' sin migrar.
  idioma                text not null default 'es',
  moneda                char(3) not null,

  -- Titular cuando tipo='persona'. La FK se agrega en 003 (dependencia circular
  -- con identidad, que a su vez referencia cuenta).
  identidad_titular_id  uuid,

  -- Modo de custodia de la clave raíz de cifrado. Ver iso-27001.md §3.1.
  modo_clave            text not null default 'gestionada'
                          check (modo_clave in ('gestionada','dedicada','propia')),

  -- Quién sella los documentos de firma simple de esta cuenta.
  -- Ver proveedores-y-adaptadores.md §7.bis.
  modo_sello            text not null default 'plataforma'
                          check (modo_sello in ('plataforma','cuenta','firmante')),

  estado                text not null default 'activa'
                          check (estado in ('activa','suspendida','cerrada')),
  plan_id               uuid references plan(id),

  creada_en             timestamptz not null default now(),
  suspendida_en         timestamptz,
  cerrada_en            timestamptz,

  constraint cuenta_persona_con_titular
    check ((tipo = 'persona') = (identidad_titular_id is not null))
);

create index cuenta_por_estado on cuenta (estado) where estado = 'activa';
create index cuenta_por_pais on cuenta (pais);

-- -----------------------------------------------------------------------------
-- Empresa: detalle de una cuenta de tipo empresa.
-- OJO al copiar de payroll: acá `empresa` YA NO es el tenant.
-- -----------------------------------------------------------------------------
create table empresa (
  cuenta_id             uuid primary key references cuenta(id),
  razon_social          text not null,
  identificacion_fiscal text,
  industria_id          uuid references industria(id),
  domicilio             text,
  actualizada_en        timestamptz not null default now()
);

-- Solo las cuentas de tipo empresa pueden tener fila en `empresa`.
create or replace function empresa_solo_cuenta_empresa() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from cuenta c where c.id = new.cuenta_id and c.tipo = 'empresa') then
    raise exception 'la cuenta % no es de tipo empresa', new.cuenta_id;
  end if;
  return new;
end $$;

create trigger empresa_tipo_coherente before insert or update on empresa
  for each row execute function empresa_solo_cuenta_empresa();

commit;
