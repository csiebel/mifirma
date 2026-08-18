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


-- ⚠ UN ROL ES DEL CLUSTER, NO DE LA BASE.
--
-- `probar.sh` borra y recrea la base `mifirma` en cada corrida, pero `app_rw`
-- NO se va con ella: vive en el servidor entero. El script intenta soltarlo, y
-- eso falla sin ruido en cuanto el rol tiene privilegios en otra base o el
-- usuario que corre no es superusuario — que es el caso normal de un Postgres
-- instalado a mano, donde uno usa su propio usuario.
--
-- Resultado: el banco andaba en una máquina y moría en otra con «role app_rw
-- already exists», sin que nada del proyecto hubiera cambiado.
--
-- Se crea sólo si falta. Un `if not exists` acá vale más que un `drop` allá:
-- borrar depende de permisos y de quién más lo esté usando; no crear dos veces,
-- no depende de nada.
do $rol$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_rw') then
    create role app_rw;
  end if;
  -- ⚠ `app_operador` también, y por un motivo que no es obvio: el CENTINELA de
  -- la 026 —que varias migraciones repiten al final— llama a
  -- `has_table_privilege('app_operador', …)`, y eso no devuelve falso cuando el
  -- rol no existe: revienta. Sin esta línea, cualquier migración nueva que traiga
  -- el centinela muere en el banco por una razón que no tiene nada que ver con
  -- lo que la migración hace. Agregado el 10/8/2026, mientras se probaba una
  -- migración que después se descartó: el arreglo del banco vale igual.
  if not exists (select 1 from pg_roles where rolname = 'app_operador') then
    create role app_operador;
  end if;
end $rol$;

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

-- El alta en dos pasos (migración 036) y el token que viaja por correo. Están acá
-- en esqueleto porque una migración que le toque una columna a una de estas dos
-- tablas falla por no encontrarla, no por lo que la migración hace — y el banco
-- daría rojo por el motivo equivocado. Agregado el 10/8/2026, probando una
-- migración que después se descartó: el arreglo del banco vale igual.
create table token_acceso (
  id uuid primary key default gen_random_uuid(),
  identidad_id uuid references identidad(id),
  tipo text, token_hash text, expira_en timestamptz,
  usado_en timestamptz, ip_uso inet,
  creado_en timestamptz not null default now()
);

create table registro_pendiente (
  id uuid primary key default gen_random_uuid(),
  token_acceso_id uuid not null unique references token_acceso(id) on delete cascade,
  identidad_id uuid not null references identidad(id),
  datos jsonb not null,
  creado_en timestamptz not null default now(),
  ip_solicitud inet
);

-- La credencial: lo que convierte una identidad en una cuenta de acceso, y por
-- donde entra el segundo factor. En esqueleto, por el mismo motivo que las dos
-- de arriba: la 061 le agrega columnas y el banco moría con «relation
-- "credencial" does not exist» — rojo por lo que al banco le falta, no por lo
-- que la migración hace. Agregado el 15/8/2026, probando la 061.
--
-- ⚠ Las columnas son las de la 003, incluida `otp_habilitado`: el banco tiene
-- que empezar donde empieza la base real, o una migración que BORRA esa columna
-- no estaría probando nada.
create table credencial (
  identidad_id uuid primary key references identidad(id),
  hash_password text,
  password_cambiada_en timestamptz,
  otp_habilitado boolean not null default false,
  telefono_e164 text,
  idp_externo text,
  idp_sujeto text,
  ultimo_acceso_en timestamptz,
  intentos_fallidos int not null default 0,
  bloqueada_hasta timestamptz,
  creada_en timestamptz not null default now()
);

-- Datos incómodos, que es para lo que existe este archivo: una credencial con
-- teléfono puesto de antes (la 061 no puede tratarla como propuesta) y otra
-- sin nada.
insert into credencial (identidad_id, hash_password, telefono_e164, otp_habilitado)
select id, 'hash-viejo', '+59899111222', false from identidad limit 1;

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
  -- La 055 reparte el lugar por antigüedad cuando el turno no alcanza para
  -- desempatar (paralelo: todos en orden 1). Sin esta columna acá, la
  -- migración corre en el banco por un camino que la base real no toma.
  creada_en timestamptz not null default now(),
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


-- ── quién entra a qué cuenta, y con qué rol ─────────────────────────────────
--
-- Agregado el 15/8/2026 para poder ejercer la 062. Sin esto, una migración que
-- decida permisos sobre la gente de una cuenta no se puede probar acá: muere
-- con «relation "membresia" does not exist», o sea rojo por lo que al banco le
-- falta y no por lo que la migración hace. Es la misma historia que credencial
-- en la 061. (Deuda 34.)
create table membresia (
  id uuid primary key default gen_random_uuid(),
  identidad_id uuid not null references identidad(id),
  cuenta_id uuid not null references cuenta(id),
  persona_id uuid,
  estado text not null default 'activa',
  desde timestamptz not null default now(),
  hasta timestamptz
);

create table rol (
  id uuid primary key default gen_random_uuid(),
  cuenta_id uuid references cuenta(id),
  nombre text not null
);

create table capacidad (
  id uuid primary key default gen_random_uuid(),
  recurso text not null,
  accion text not null,
  unique (recurso, accion)
);

create table rol_capacidad (
  rol_id uuid not null references rol(id),
  capacidad_id uuid not null references capacidad(id),
  primary key (rol_id, capacidad_id)
);

create table usuario_rol (
  identidad_id uuid not null references identidad(id),
  cuenta_id uuid not null references cuenta(id),
  rol_id uuid not null references rol(id),
  asignado_por uuid references identidad(id),
  primary key (identidad_id, cuenta_id, rol_id)
);

-- ── las funciones de contexto que la política nueva llama ───────────────────
--
-- ⚠ Leen `current_setting` con el MISMO valor por omisión que tenían cuando
-- eran constantes ('cuenta' y null), así que los `ejerce` anteriores no cambian
-- de comportamiento. Lo que se gana: un `ejerce` puede pararse en los zapatos
-- de un actor concreto con `set local app.cuenta = '...'` y ejercer una función
-- que decide permisos, en vez de mirar el catálogo y creerle.
create function app.actor() returns text language sql stable as $$
  select coalesce(nullif(current_setting('app.actor', true), ''), 'cuenta') $$;
create function app.cuenta_actual() returns uuid language sql stable as $$
  select nullif(current_setting('app.cuenta', true), '')::uuid $$;
create function app.identidad_actual() returns uuid language sql stable as $$
  select nullif(current_setting('app.identidad', true), '')::uuid $$;

-- Copia fiel de la de la 004: misma consulta, para que lo que se ejerce acá sea
-- lo que corre en la base de verdad.
create function app.tiene_capacidad(p_recurso text, p_accion text) returns boolean
language sql stable as $$
  select exists (
    select 1
      from usuario_rol ur
      join rol_capacidad rc on rc.rol_id = ur.rol_id
      join capacidad c on c.id = rc.capacidad_id
     where ur.identidad_id = app.identidad_actual()
       and ur.cuenta_id    = app.cuenta_actual()
       and c.recurso = p_recurso
       and c.accion  = p_accion
  ) $$;
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

-- ═══ LO INCÓMODO QUE AGREGA LA 055 ═══
--
-- La 055 separa el LUGAR (quién es cada uno) del TURNO (cuándo le toca). El
-- relleno tiene que resolver tres situaciones distintas y una de ellas NO tiene
-- respuesta correcta, así que las tres tienen que estar acá:
--
--   · serie    → turnos 1,2,3 y una persona por turno. Se traduce sin perder nada.
--   · paralelo → TODOS en turno 1. Un campo que dice «turno 1» no señala a
--                nadie en particular: es el defecto que la 055 viene a arreglar,
--                y lo que ya está guardado NO se puede desambiguar. Tiene que
--                quedar como «lo llena cualquiera».
--   · copias   → una participación por instancia, todas en turno 1. Ahí «turno
--                1» sí es una persona sola, y no hay nada que traducir.
--
-- ⚠ Además, el circuito 3333… que ya estaba arriba tiene un campo de firmante y
-- NINGUNA participación. Es el caso que rompe cualquier relleno escrito como un
-- join: hay que dejarlo pasar, no explotar.

insert into identidad (id, email_mostrado, nombre_mostrado) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ana@ejemplo.com',   'Ana'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'beto@ejemplo.com',  'Beto'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'carla@ejemplo.com', 'Carla');

-- ── (1) PARALELO: el acta del consorcio, ya enviada ─────────────────────────
insert into circuito (id, cuenta_propietaria_id, titulo, estado, modo) values
  ('66666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222',
   'Acta de asamblea', 'borrador', 'paralelo');

insert into instancia (id, circuito_id, cuenta_propietaria_id, numero) values
  ('66666666-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666',
   '22222222-2222-2222-2222-222222222222', 1);

-- Los tres en turno 1: es lo que significa paralelo. Con `creada_en` separada,
-- para que el reparto del lugar sea reproducible y no dependa del uuid.
insert into participacion (instancia_id, circuito_id, cuenta_propietaria_id,
                           identidad_id, papel, orden, creada_en) values
  ('66666666-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666',
   '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001',
   'firmante', 1, '2026-08-01 10:00:00+00'),
  ('66666666-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666',
   '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002',
   'firmante', 1, '2026-08-01 10:01:00+00'),
  ('66666666-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666',
   '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000003',
   'firmante', 1, '2026-08-01 10:02:00+00');

-- Un veedor, que NO firma. No tiene lugar y no debe recibir ninguno.
insert into participacion (instancia_id, circuito_id, cuenta_propietaria_id,
                           identidad_id, papel, orden, creada_en) values
  ('66666666-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666',
   '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
   'veedor', 1, '2026-08-01 10:03:00+00');

-- Tres campos «nombre y apellido», uno por propietario, los tres apuntando al
-- turno 1 — que es todo lo que el modelo viejo sabía decir.
insert into campo (circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n, tipo,
                   completa_emisor, orden_firmante, pagina, x, y, ancho, alto) values
  ('66666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222',
   'nombre_1', '{"es":"Nombre y apellido"}', 'texto', false, 1, 0, 10, 100, 100, 20),
  ('66666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222',
   'nombre_2', '{"es":"Nombre y apellido"}', 'texto', false, 1, 0, 10,  70, 100, 20),
  ('66666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222',
   'nombre_3', '{"es":"Nombre y apellido"}', 'texto', false, 1, 0, 10,  40, 100, 20),
  ('66666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222',
   'fecha_acta', '{"es":"Fecha"}', 'fecha', true, null, 0, 10, 130, 100, 20);
update circuito set estado = 'enviado' where id = '66666666-6666-6666-6666-666666666666';

-- ── (2) SERIE: dos turnos, dos personas. Se traduce sin ambigüedad ──────────
insert into circuito (id, cuenta_propietaria_id, titulo, estado, modo) values
  ('77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222',
   'Contrato en fila', 'borrador', 'serie');

insert into instancia (id, circuito_id, cuenta_propietaria_id, numero) values
  ('77777777-0000-0000-0000-000000000001', '77777777-7777-7777-7777-777777777777',
   '22222222-2222-2222-2222-222222222222', 1);

insert into participacion (instancia_id, circuito_id, cuenta_propietaria_id,
                           identidad_id, papel, orden, creada_en) values
  ('77777777-0000-0000-0000-000000000001', '77777777-7777-7777-7777-777777777777',
   '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001',
   'firmante', 1, '2026-08-02 10:00:00+00'),
  ('77777777-0000-0000-0000-000000000001', '77777777-7777-7777-7777-777777777777',
   '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002',
   'firmante', 2, '2026-08-02 10:01:00+00');

insert into campo (circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n, tipo,
                   completa_emisor, orden_firmante, pagina, x, y, ancho, alto) values
  ('77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222',
   'cargo_1', '{"es":"Cargo"}', 'texto', false, 1, 0, 10, 100, 100, 20),
  ('77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222',
   'cargo_2', '{"es":"Cargo"}', 'texto', false, 2, 0, 10,  70, 100, 20);
update circuito set estado = 'enviado' where id = '77777777-7777-7777-7777-777777777777';

-- ── (3) COPIAS: dos instancias, un firmante cada una ────────────────────────
insert into circuito (id, cuenta_propietaria_id, titulo, estado, modo) values
  ('88888888-8888-8888-8888-888888888888', '22222222-2222-2222-2222-222222222222',
   'Reglamento, una copia por persona', 'borrador', 'copias');

insert into instancia (id, circuito_id, cuenta_propietaria_id, numero) values
  ('88888888-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888',
   '22222222-2222-2222-2222-222222222222', 1),
  ('88888888-0000-0000-0000-000000000002', '88888888-8888-8888-8888-888888888888',
   '22222222-2222-2222-2222-222222222222', 2);

insert into participacion (instancia_id, circuito_id, cuenta_propietaria_id,
                           identidad_id, papel, orden, creada_en) values
  ('88888888-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888',
   '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001',
   'firmante', 1, '2026-08-03 10:00:00+00'),
  ('88888888-0000-0000-0000-000000000002', '88888888-8888-8888-8888-888888888888',
   '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002',
   'firmante', 1, '2026-08-03 10:01:00+00');

insert into campo (circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n, tipo,
                   completa_emisor, orden_firmante, pagina, x, y, ancho, alto) values
  ('88888888-8888-8888-8888-888888888888', '22222222-2222-2222-2222-222222222222',
   'acepto', '{"es":"Acepto"}', 'texto', false, 1, 0, 10, 100, 100, 20);
update circuito set estado = 'enviado' where id = '88888888-8888-8888-8888-888888888888';


-- ── lo que necesita la 063: EL EXPEDIENTE ───────────────────────────────────
--
-- ⚠⚠ `evidencia` faltaba, y sin ella el banco no podía probar NINGUNA de las
-- dieciocho migraciones que la tocan — incluidas la 020, que la crea, y la 021,
-- que arregló que la cadena se bifurcaba. La única tabla del producto con valor
-- probatorio era la única sin banco. Se agregó el 17/8/2026, al descubrirlo
-- desde la 063.
--
-- Va con las DOS cosas que la hacen distinta de cualquier otra tabla de acá, y
-- que son justamente las que una migración nueva se puede llevar por delante:
--
--   1. **ESTÁ PARTICIONADA POR MES.** Eso ya mordió el mismo día: el primer
--      intento de la 063 traía un índice UNIQUE que Postgres rechaza sobre una
--      tabla particionada si no incluye la columna de partición.
--   2. **TIENE EL TRIGGER DE LA CADENA.** El número de orden y los hashes no
--      los elige la aplicación. Una migración que inserte evidencia a mano y no
--      cuente con eso da resultados que no se parecen a la realidad.
--
-- ⚠ Es una copia FIEL de la 020 en lo estructural. Si la 020 cambiara, esto
-- también. No se "simplifica": un banco que no se parece a la base real da
-- verde sobre una historia que no existe.

create extension if not exists pgcrypto;

-- Sólo por la FK de `evidencia.sello_tiempo_id`. No se sella nada acá.
create table sello_tiempo (
  id            uuid primary key default gen_random_uuid(),
  estado        text not null default 'pendiente',
  solicitado_en timestamptz not null default now()
);

create table evidencia (
  id                      uuid not null default gen_random_uuid(),
  instancia_id            uuid not null references instancia(id),
  circuito_id             uuid not null references circuito(id),
  cuenta_propietaria_id   uuid not null references cuenta(id),
  identidad_id            uuid references identidad(id),
  participacion_id        uuid references participacion(id),
  actor_tipo              text not null check (actor_tipo in
                            ('firmante','emisor','sistema','proveedor','operador')),
  tipo                    text not null references tipo_evento(codigo),
  datos                   jsonb not null default '{}'::jsonb,
  ocurrido_en             timestamptz not null,
  registrado_en           timestamptz not null default now(),
  zona_horaria_mostrada   text,
  sello_tiempo_id         uuid references sello_tiempo(id),
  ip                      inet,
  user_agent              text,
  huella_dispositivo      text,
  canal                   text check (canal in ('web','email','sms','whatsapp','api','webhook','sistema')),
  sha256_documento        bytea,
  numero_orden            bigint not null,
  hash_contenido          bytea not null,
  hash_anterior           bytea,
  hash_propio             bytea not null,
  purgado_en              timestamptz,
  primary key (id, registrado_en)
) partition by range (registrado_en);

create table evidencia_default partition of evidencia default;

create index evidencia_por_instancia on evidencia (instancia_id, numero_orden);
create index evidencia_por_identidad on evidencia (identidad_id) where identidad_id is not null;
create index evidencia_por_tipo on evidencia (tipo, registrado_en);
create index evidencia_sin_sello on evidencia (registrado_en) where sello_tiempo_id is null;

-- Copia fiel del trigger de la 020: el número de orden y los hashes NO los
-- elige quien inserta.
create or replace function evidencia_encadenar() returns trigger
language plpgsql as $$
declare v_ant record;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.instancia_id::text, 0));
  select numero_orden, hash_propio into v_ant
    from evidencia
   where instancia_id = new.instancia_id
   order by numero_orden desc
   limit 1;
  new.numero_orden   := coalesce(v_ant.numero_orden, 0) + 1;
  new.hash_anterior  := v_ant.hash_propio;
  new.registrado_en  := now();
  new.hash_contenido := digest(
      new.instancia_id::text ||'|'|| new.numero_orden::text ||'|'||
      new.tipo ||'|'|| new.datos::text ||'|'||
      to_char(new.ocurrido_en at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.USOF') ||'|'||
      coalesce(new.identidad_id::text,'') ||'|'||
      coalesce(host(new.ip),'') ||'|'||
      coalesce(new.user_agent,'') ||'|'||
      coalesce(encode(new.sha256_documento,'hex'),'')
    , 'sha256');
  new.hash_propio := digest(
      coalesce(encode(new.hash_anterior,'hex'),'') ||'|'||
      encode(new.hash_contenido,'hex')
    , 'sha256');
  return new;
end $$;

create trigger evidencia_cadena before insert on evidencia
  for each row execute function evidencia_encadenar();

-- Los tipos que mira la 063. `notificacion.entregada` existe en el catálogo
-- real desde la 020 y NO LA ESCRIBÍA NADIE hasta la 063.
-- ⚠ Con los textos REALES de la 020, en los tres idiomas — no con resúmenes.
-- El ejerce/066 cuenta textos distintos en es/pt/en, y contra una siembra
-- inventada estaría afirmando sobre un mundo que no existe. `enviada` y
-- `fallida` arrancan con su texto viejo A PROPÓSITO: la 058 y la 064 los
-- corrigen durante la corrida, igual que pasó en la base real.
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('notificacion.enviada',   'envio',   'normal', 30,
   '{"es":"Se envió la notificación","pt":"Notificação enviada","en":"Notification sent"}'),
  ('notificacion.entregada', 'entrega', 'normal', 31,
   '{"es":"La notificación fue entregada","pt":"Notificação entregue","en":"Notification delivered"}'),
  ('notificacion.fallida',   'entrega', 'normal', 32,
   '{"es":"La notificación no se pudo entregar","pt":"A notificação não pôde ser entregue","en":"Notification could not be delivered"}')
on conflict (codigo) do nothing;

-- ── DATOS QUE ROMPEN ────────────────────────────────────────────────────────
--
-- El punto de este archivo no es tener las tablas: es tener FILAS INCÓMODAS.
-- Las tres de acá abajo son las que una migración sobre el amarre del
-- Message-ID se puede llevar por delante:
--
--   1. Un aviso CON Message-ID — el caso normal desde la 063.
--   2. Un aviso SIN Message-ID — **todos los avisos anteriores a la 063**, que
--      son los que ya están en la base real. Un índice o una consulta que no
--      los tolere se rompe contra producción y no acá.
--   3. Un evento de OTRO tipo que igual trae un `message_id` en sus datos — si
--      la búsqueda se olvida de filtrar por tipo, encuentra éste y ata la
--      entrega al evento equivocado.
insert into evidencia (
  instancia_id, circuito_id, cuenta_propietaria_id, identidad_id, participacion_id,
  actor_tipo, tipo, datos, ocurrido_en, canal, numero_orden, hash_contenido, hash_propio
) values
  ('88888888-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888',
   '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', null,
   'sistema', 'notificacion.enviada',
   '{"canal":"email","destino":"an•••@ejemplo.com","message_id":"con-id@mi-firma.digital"}'::jsonb,
   '2026-08-10 10:00:00+00', 'email', 0, ''::bytea, ''::bytea),

  ('88888888-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888',
   '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002', null,
   'sistema', 'notificacion.enviada',
   '{"canal":"email","destino":"be•••@ejemplo.com"}'::jsonb,
   '2026-08-10 10:01:00+00', 'email', 0, ''::bytea, ''::bytea),

  ('88888888-0000-0000-0000-000000000002', '88888888-8888-8888-8888-888888888888',
   '22222222-2222-2222-2222-222222222222', null, null,
   'sistema', 'documento.subido',
   '{"message_id":"con-id@mi-firma.digital"}'::jsonb,
   '2026-08-10 09:00:00+00', 'web', 0, ''::bytea, ''::bytea);

-- ── LA MARCA DEL BANCO ──────────────────────────────────────────────────────
-- Existe para una sola cosa: que un script de prueba pueda negarse a correr si
-- no está. La base de producción también se llama `mifirma`, así que el guard
-- del nombre no distingue el banco de la de verdad — ésta sí.
create table banco_de_pruebas (
  advertencia text primary key default
    'Base de descarte. Si ves esta tabla en producción, algo se corrió donde no debía.'
);
insert into banco_de_pruebas default values;
