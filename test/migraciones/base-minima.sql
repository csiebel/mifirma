-- =============================================================================
-- MiFirma — test/migraciones/base-minima.sql
--
-- Un esqueleto de la base, **con datos que rompen migraciones**, para poder
-- correr una migración nueva antes de correrla contra la de verdad.
--
-- ═══ POR QUÉ EXISTE ═══
--
-- El 5 de agosto de 2026 la migración 052 falló en la base real con dos
-- defectos que ninguna prueba anterior podía encontrar:
--
--   1. El relleno de una columna nueva chocó contra el trigger que congela los
--      campos de un documento ya despachado. Bastaba UN documento enviado para
--      que la migración muriera — o sea, cualquier base con la que se haya
--      trabajado un día.
--   2. Una restricción vieja (`campo_tiene_dueno`) hacía IMPOSIBLE guardar un
--      campo del modo nuevo. La migración entraba bien y la función quedaba
--      rota: el error aparecía después, en una pantalla, sin relación aparente.
--
-- Los dos son de la misma familia: **una migración que sólo se leyó no está
-- probada, y una que se probó contra una base vacía tampoco.** Lo que las
-- encuentra es correrlas contra datos que se parezcan a los de verdad.
--
-- ═══ CÓMO SE USA ═══
--
--   createdb mifirma_prueba && psql mifirma_prueba -c 'alter database ...'
--
-- La base TIENE que llamarse `mifirma`: todas las migraciones abren con un
-- guard que aborta si no. Con un Postgres de descarte:
--
--   psql -U postgres -c 'drop database if exists mifirma'
--   psql -U postgres -c 'create database mifirma'
--   psql -U postgres -d mifirma -f test/migraciones/base-minima.sql
--   psql -U postgres -d mifirma -v ON_ERROR_STOP=1 -f migrations/0NN_....sql
--
-- Y correrla DOS VECES: una migración que no se puede repetir es una migración
-- que no se puede arreglar a mitad de camino.
--
-- ⚠ Esto NO reemplaza al esquema real. Es sólo lo que las migraciones de campos
-- tocan o miran. Cuando una migración nueva toque otras tablas, se agregan acá
-- las mínimas para que corra — con datos en el estado incómodo, no vacías.
--
-- Lo incómodo que ya trae:
--   · un circuito ENVIADO con campos (dispara `campo_congelado`)
--   · un campo del emisor y uno de firmante (las dos ramas del relleno)
--   · un circuito en BORRADOR (para poder ejercer escrituras en los controles)
-- =============================================================================


create role app_rw;
create schema app;

create table identidad (
  id uuid primary key default gen_random_uuid(),
  email_mostrado text, nombre_mostrado text
);

create table cuenta (
  id uuid primary key default gen_random_uuid(),
  nombre_mostrado text, tipo text default 'empresa', estado text default 'activa',
  identidad_titular_id uuid references identidad(id)
);

create table circuito (
  id uuid primary key default gen_random_uuid(),
  cuenta_propietaria_id uuid not null references cuenta(id),
  titulo text, estado text not null default 'borrador',
  modo text not null default 'serie' check (modo in ('serie','paralelo','copias')),
  creado_en timestamptz not null default now()
);

create table instancia (
  id uuid primary key default gen_random_uuid(),
  circuito_id uuid not null references circuito(id),
  cuenta_propietaria_id uuid not null references cuenta(id),
  numero int not null,
  estado text not null default 'pendiente',
  unique (circuito_id, numero)
);

create table participacion (
  id uuid primary key default gen_random_uuid(),
  instancia_id uuid not null references instancia(id),
  circuito_id uuid not null references circuito(id),
  cuenta_propietaria_id uuid not null references cuenta(id),
  identidad_id uuid not null references identidad(id),
  papel text not null, orden int not null default 1,
  estado text not null default 'pendiente',
  unique (instancia_id, identidad_id, papel)
);

-- ── campo, tal como lo dejó la 038 ──────────────────────────────────────────
create table campo (
  id uuid primary key default gen_random_uuid(),
  circuito_id uuid not null references circuito(id) on delete cascade,
  cuenta_propietaria_id uuid not null references cuenta(id),
  codigo text not null,
  etiqueta_i18n jsonb not null,
  tipo text not null check (tipo in
    ('texto','parrafo','numero','fecha','moneda','casilla','opcion')),
  opciones jsonb,
  completa_emisor boolean not null default false,
  orden_firmante int,
  obligatorio boolean not null default false,
  valor_por_defecto text,
  validacion jsonb,
  pagina int not null check (pagina >= 0),
  x numeric(10,3) not null, y numeric(10,3) not null,
  ancho numeric(10,3) not null check (ancho > 0),
  alto numeric(10,3) not null check (alto > 0),
  orden int not null default 0,
  creado_en timestamptz not null default now(),
  unique (circuito_id, codigo),
  constraint campo_tiene_dueno check (
    (completa_emisor and orden_firmante is null)
    or (not completa_emisor and orden_firmante is not null)),
  constraint campo_opciones_si_corresponde check (
    (tipo = 'opcion') = (opciones is not null))
);

create or replace function campo_solo_en_borrador() returns trigger
language plpgsql as $$
declare v_estado text;
begin
  select estado into v_estado from public.circuito
   where id = coalesce(new.circuito_id, old.circuito_id);
  if v_estado is distinct from 'borrador' then
    raise exception 'el documento ya se envió: los campos no se pueden cambiar'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create trigger campo_congelado
  before insert or update or delete on campo
  for each row execute function campo_solo_en_borrador();

create table valor_campo (
  id uuid primary key default gen_random_uuid(),
  campo_id uuid not null references campo(id) on delete cascade,
  instancia_id uuid not null references instancia(id),
  cuenta_propietaria_id uuid not null references cuenta(id),
  valor text, valor_normalizado text,
  completado_por uuid references identidad(id),
  completado_en timestamptz,
  origen text not null default 'manual',
  congelado_en timestamptz, sha256_valor bytea,
  unique (campo_id, instancia_id)
);

-- ── las funciones de contexto que la política nueva llama ───────────────────
create function app.actor() returns text language sql stable as $$ select 'cuenta'::text $$;
create function app.cuenta_actual() returns uuid language sql stable as $$ select null::uuid $$;
create function app.identidades_del_actor() returns uuid[] language sql stable as $$ select '{}'::uuid[] $$;
create function app.tiene_otorgamiento(uuid, uuid, text) returns boolean
  language sql stable as $$ select false $$;

-- ═══ DATOS QUE REPRODUCEN LA BASE DE CLAUDIO ═══
--
-- Lo que importa: un documento YA ENVIADO con campos. Es lo que hizo fallar la
-- 052 en la base real y lo que no había en ninguna prueba.
insert into identidad (id, email_mostrado) values
  ('11111111-1111-1111-1111-111111111111', 'claudio@ejemplo.com');
insert into cuenta (id, nombre_mostrado) values
  ('22222222-2222-2222-2222-222222222222', 'Interfase S.A.');

insert into circuito (id, cuenta_propietaria_id, titulo, estado) values
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
   'Uno ya enviado', 'enviado'),
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222',
   'Uno en borrador', 'borrador');

-- Los campos del enviado se insertan con el circuito todavía en borrador,
-- porque el trigger no deja meterlos después. Es el orden real de los hechos.
update circuito set estado = 'borrador' where id = '33333333-3333-3333-3333-333333333333';
insert into campo (circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n, tipo,
                   completa_emisor, orden_firmante, pagina, x, y, ancho, alto) values
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
   'razon_social', '{"es":"Razón social"}', 'texto', false, 1, 0, 10, 10, 100, 20),
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
   'fecha_emision', '{"es":"Fecha"}', 'fecha', true, null, 0, 10, 40, 100, 20);
update circuito set estado = 'enviado' where id = '33333333-3333-3333-3333-333333333333';

insert into instancia (id, circuito_id, cuenta_propietaria_id, numero) values
  ('55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222222', 1);

-- ── el catálogo de eventos del expediente (020) ─────────────────────────────
-- `evidencia.tipo` es una FK contra esto. Toda migración que agregue un evento
-- lo inserta acá, y sin la tabla no se puede probar ninguna.
create table tipo_evento (
  codigo text primary key,
  categoria text not null check (categoria in
    ('envio','entrega','acceso','identidad','consentimiento','firma','rechazo','ciclo','sistema')),
  peso text not null default 'normal' check (peso in ('normal','alto')),
  descripcion_i18n jsonb not null,
  orden int not null default 100
);
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('documento.subido', 'ciclo', 'normal', 10, '{"es":"Se subió el documento"}'),
  ('firma.marca_movida', 'firma', 'normal', 68, '{"es":"El firmante movió su firma"}');

-- ── lo que necesita la 054 ──────────────────────────────────────────────────
create table marca_firma (
  id uuid primary key default gen_random_uuid(),
  participacion_id uuid not null references participacion(id),
  instancia_id uuid not null references instancia(id),
  circuito_id uuid not null references circuito(id),
  cuenta_propietaria_id uuid not null references cuenta(id),
  tipo text not null, pagina int not null,
  x numeric(10,3) not null, y numeric(10,3) not null,
  ancho numeric(10,3) not null, alto numeric(10,3) not null,
  x_propuesta numeric(10,3), y_propuesta numeric(10,3),
  movida_en timestamptz, movida_por uuid references identidad(id),
  creada_por uuid references identidad(id)
);
