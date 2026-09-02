-- =============================================================================
-- MiFirma — test/migraciones/base-fixtures.sql
--
-- Los DATOS INCÓMODOS del banco de migraciones. NO el esquema.
--
-- ═══ POR QUÉ ESTÁ SEPARADO DEL ESQUEMA (deudas 34 y 77) ═══
--
-- Hasta el 21/8/2026 el banco cargaba `base-minima.sql`: un esqueleto de 21
-- tablas ESCRITO A MANO más estos datos. El esqueleto tenía dos defectos de
-- fondo:
--
--   1. No se parecía a la base real (67 tablas, RLS en 51, 153 políticas). Una
--      migración que rompiera una política pasaba el banco EN VERDE, porque el
--      banco no tenía ni la política ni la tabla. La regla de oro nº2 —la
--      autorización vive en la capa de datos— era justo lo que el banco no
--      probaba.
--   2. Sembraba el catálogo `tipo_evento` a mano, y ya mordió: el estreno de una
--      aserción trilingüe encontró textos inventados que no existían en ningún
--      catálogo real (17/8). Un banco que afirma sobre un mundo que no existe.
--
-- ═══ EL ARREGLO ═══
--
-- `probar.sh` ahora construye el esquema CORRIENDO LAS MIGRACIONES REALES desde
-- la 001 hasta la marca de `previas.txt` (050), y recién ahí carga ESTE archivo.
-- Consecuencias:
--
--   · El esquema del banco ES el de producción, a la 050. Aparecen `otorgamiento`
--     y las 51 tablas con RLS. Una migración que toque una política se prueba.
--   · `tipo_evento` YA viene sembrado por las migraciones, con el texto del
--     momento exacto (la 058 y la 064 lo corrigen DESPUÉS, como en la realidad).
--     Este archivo no lo toca: no hay catálogo que inventar.
--
-- ⚠ Los datos van en la forma de la 050, a propósito: campo con `orden_firmante`
-- (la 055 le pone `posicion_firmante` después), participación con `orden` sin
-- `posicion`. Son los estados incómodos que las migraciones 051→N transforman.
--
-- ⚠ Se carga como SUPERUSUARIO, así que la RLS no molesta la siembra. Que un
-- `ejerce` corra como `app_rw` para EJERCER la política es otra cosa (deuda 77b).
--
-- Lo incómodo que trae, igual que antes:
--   · un circuito ENVIADO con campos (dispara el trigger que los congela)
--   · un campo del emisor y uno de firmante (las dos ramas del relleno)
--   · un circuito en BORRADOR (para ejercer escrituras en los controles)
--   · los tres modos (serie / paralelo / copias) en su forma pre-055
--   · un aviso CON Message-ID, uno SIN, y un evento de otro tipo que igual trae
--     un message_id — los tres casos que la 063 se puede llevar por delante
--   · una credencial con teléfono puesto de antes (la 061 no la trata como propuesta)
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: fixtures de MiFirma cargadas contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- ── LA MARCA DEL BANCO ──────────────────────────────────────────────────────
-- Existe para una sola cosa: que un script de prueba pueda negarse a correr si
-- no está. La base de producción también se llama `mifirma`, así que el guard
-- del nombre no distingue el banco de la de verdad — esta tabla sí.
-- ⚠ Va PRIMERO: si un ejerce mira la marca antes de tocar nada (ejerce/057), la
-- encuentra sí o sí.
create table if not exists banco_de_pruebas (
  advertencia text primary key default
    'Base de descarte. Si ves esta tabla en producción, algo se corrió donde no debía.'
);
insert into banco_de_pruebas default values on conflict do nothing;

-- ── quiénes ─────────────────────────────────────────────────────────────────
-- ⚠ `email_normalizado` es NOT NULL en el esquema real (no lo era en el esqueleto).
insert into identidad (id, email_normalizado, email_mostrado) values
  ('11111111-1111-1111-1111-111111111111', 'claudio@ejemplo.com', 'claudio@ejemplo.com');
insert into identidad (id, email_normalizado, email_mostrado, nombre_mostrado) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ana@ejemplo.com',   'ana@ejemplo.com',   'Ana'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'beto@ejemplo.com',  'beto@ejemplo.com',  'Beto'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'carla@ejemplo.com', 'carla@ejemplo.com', 'Carla');

-- ⚠ `cuenta` real exige tipo/pais/moneda (el esqueleto sólo tenía nombre_mostrado).
insert into cuenta (id, tipo, nombre_mostrado, pais, moneda) values
  ('22222222-2222-2222-2222-222222222222', 'empresa', 'Interfase S.A.', 'UY', 'UYU');

-- Una credencial con teléfono puesto de antes (la 061 no puede tratarla como
-- propuesta) — el dato incómodo. A la 050, `credencial` tiene las columnas de la 003.
insert into credencial (identidad_id, hash_password, telefono_e164, otp_habilitado)
  values ('11111111-1111-1111-1111-111111111111', 'hash-viejo', '+59899111222', false);

-- ── el archivo base ─────────────────────────────────────────────────────────
-- ⚠ NUEVO respecto del esqueleto: en el esquema real `circuito.archivo_base_id`
-- es NOT NULL, así que hace falta un archivo al que apuntar. Uno solo alcanza:
-- el banco prueba la forma de los datos, no el contenido del PDF.
insert into archivo (id, sha256, bytes, mime, clase, cuenta_custodia_id, region, clave_almacenamiento) values
  ('a4c41111-0000-0000-0000-000000000001', '\x00'::bytea, 1, 'application/pdf', 'base',
   '22222222-2222-2222-2222-222222222222', 'local', 'banco/base.pdf');

-- ═══ UN DOCUMENTO YA ENVIADO CON CAMPOS ═══
-- Es lo que hizo fallar la 052 en la base real y lo que no había en ninguna prueba.
insert into circuito (id, cuenta_propietaria_id, creado_por_identidad_id, archivo_base_id,
                      titulo, modo, estado, pais_marco, nivel_firma) values
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111', 'a4c41111-0000-0000-0000-000000000001',
   'Uno ya enviado', 'serie', 'borrador', 'UY', 'simple'),
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111', 'a4c41111-0000-0000-0000-000000000001',
   'Uno en borrador', 'serie', 'borrador', 'UY', 'simple');

-- Los campos del enviado se insertan con el circuito todavía en borrador, porque
-- el trigger no deja meterlos después. Es el orden real de los hechos.
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

-- ═══ LOS TRES MODOS, EN SU FORMA PRE-055 ═══
-- La 055 separa el LUGAR (quién) del TURNO (cuándo). El relleno resuelve tres
-- situaciones y una NO tiene respuesta correcta, así que las tres tienen que estar:
--   · serie    → turnos 1,2,3, una persona por turno. Se traduce sin perder nada.
--   · paralelo → TODOS en turno 1: un campo que dice «turno 1» no señala a nadie.
--                Es el defecto que la 055 arregla, y lo guardado NO se desambigua.
--   · copias   → una participación por instancia, todas en turno 1. Ahí «turno 1»
--                sí es una persona sola.
-- ⚠ El 3333… de arriba tiene un campo de firmante y NINGUNA participación: el
-- caso que rompe cualquier relleno escrito como un join. Tiene que dejarse pasar.

-- ── (1) PARALELO: el acta del consorcio, ya enviada ─────────────────────────
insert into circuito (id, cuenta_propietaria_id, creado_por_identidad_id, archivo_base_id,
                      titulo, modo, estado, pais_marco, nivel_firma) values
  ('66666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111', 'a4c41111-0000-0000-0000-000000000001',
   'Acta de asamblea', 'paralelo', 'borrador', 'UY', 'simple');
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
insert into circuito (id, cuenta_propietaria_id, creado_por_identidad_id, archivo_base_id,
                      titulo, modo, estado, pais_marco, nivel_firma) values
  ('77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111', 'a4c41111-0000-0000-0000-000000000001',
   'Contrato en fila', 'serie', 'borrador', 'UY', 'simple');
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
insert into circuito (id, cuenta_propietaria_id, creado_por_identidad_id, archivo_base_id,
                      titulo, modo, estado, pais_marco, nivel_firma) values
  ('88888888-8888-8888-8888-888888888888', '22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111', 'a4c41111-0000-0000-0000-000000000001',
   'Reglamento, una copia por persona', 'copias', 'borrador', 'UY', 'simple');
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

-- ═══ EL EXPEDIENTE: TRES FILAS QUE ROMPEN ═══
-- ⚠⚠ `tipo_evento` NO se siembra acá: lo trae la migración 020 (y las que siguen),
-- con el texto del momento — la 058/064 lo corrigen después, como en la realidad.
-- Lo de acá son DATOS del expediente, no catálogo:
--   1. Un aviso CON Message-ID — el caso normal desde la 063.
--   2. Un aviso SIN Message-ID — todos los anteriores a la 063, los que ya están
--      en la base real. Una consulta que no los tolere se rompe contra producción.
--   3. Un evento de OTRO tipo que igual trae un message_id — si la búsqueda se
--      olvida de filtrar por tipo, ata la entrega al evento equivocado.
-- El trigger de la cadena (020) reescribe numero_orden y los hashes: se pasan en
-- cero a propósito, para que se vea que NO los elige quien inserta.
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

commit;
