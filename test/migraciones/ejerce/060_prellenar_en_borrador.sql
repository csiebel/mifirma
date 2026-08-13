-- =============================================================================
-- MiFirma — test/migraciones/ejerce/060_prellenar_en_borrador.sql
--
-- La prueba de COMPORTAMIENTO de la 060. Una migración de permisos que corre
-- dos veces no prueba nada de lo que importa: importa a quién le dice que sí
-- `app.puede_completar_campo` ANTES y DESPUÉS del despacho. Es la lección de
-- la 055, aplicada a la migración que la modifica.
--
-- Las preguntas, en una tabla:
--
--            │ campo emisor │ campo firmante │ campo cualquiera
--   emisor,  │      sí      │  sí ⚠ LA NUEVA │       sí
--   borrador │              │                │
--   emisor,  │      no      │       no       │       no
--   enviado  │              │                │
--   firmante │      no      │  sí (el suyo)  │  no si el emisor
--   (enviado)│              │                │  ya lo prellenó
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ⚠ EL CINTURÓN. Este archivo ESCRIBE. Se exige la marca del banco.
do $guard$ begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = 'banco_de_pruebas') then
    raise exception 'ABORTADO: esto escribe datos de prueba y no encuentro la marca del banco. Si esto es la base real, MENOS MAL.';
  end if;
end $guard$;

begin;

insert into identidad (id, email_mostrado, nombre_mostrado) values
  ('ffff0000-0000-0000-0000-00000000000e', 'emisora.f@ejemplo.com', 'Emisora ejerce'),
  ('ffff0000-0000-0000-0000-00000000000a', 'ana.f@ejemplo.com',     'Ana ejerce 060');

-- Un circuito EN BORRADOR y otro que se va a despachar, con la misma forma: un
-- campo del emisor, uno del firmante (lugar 1) y uno de cualquiera.
--
-- ⚠ El segundo NACE en borrador y se despacha DESPUÉS de definirle los campos,
-- porque así es el ciclo real y la base lo exige: el trigger
-- `campo_solo_en_borrador` rechaza definir campos sobre un circuito enviado —
-- lo descubrió este mismo archivo al intentar el atajo.
insert into circuito (id, cuenta_propietaria_id, titulo, estado, modo) values
  ('ffff1111-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'Borrador para prellenar', 'borrador', 'copias'),
  ('ffff1111-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'Enviado: la ventana cerrada', 'borrador', 'copias');

insert into instancia (id, circuito_id, cuenta_propietaria_id, numero, estado) values
  ('ffff2222-0000-0000-0000-000000000001', 'ffff1111-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222', 1, 'pendiente'),
  ('ffff2222-0000-0000-0000-000000000002', 'ffff1111-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222', 1, 'en_curso');

-- Ana firma en el circuito enviado (para probar que su campo sigue siendo suyo).
insert into participacion (instancia_id, circuito_id, cuenta_propietaria_id,
                           identidad_id, papel, orden, posicion, estado) values
  ('ffff2222-0000-0000-0000-000000000002', 'ffff1111-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222', 'ffff0000-0000-0000-0000-00000000000a',
   'firmante', 1, 1, 'notificada');

-- Los tres tipos de campo, en los dos circuitos (mismos códigos, ids distintos).
insert into campo (id, circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n, tipo,
                   completa_emisor, quien_completa, posicion_firmante,
                   pagina, x, y, ancho, alto) values
  -- en borrador
  ('ffff3333-0000-0000-0000-000000000001', 'ffff1111-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222', 'sueldo', '{"es":"Sueldo"}', 'moneda',
   true, 'emisor', null, 0, 10, 100, 100, 20),
  ('ffff3333-0000-0000-0000-000000000002', 'ffff1111-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222', 'telefono', '{"es":"Teléfono"}', 'texto',
   false, 'firmante', 1, 0, 10, 70, 100, 20),
  ('ffff3333-0000-0000-0000-000000000003', 'ffff1111-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222', 'comentario', '{"es":"Comentario"}', 'texto',
   false, 'cualquiera', null, 0, 10, 40, 100, 20),
  -- en el enviado
  ('ffff3333-0000-0000-0000-000000000011', 'ffff1111-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222', 'sueldo', '{"es":"Sueldo"}', 'moneda',
   true, 'emisor', null, 0, 10, 100, 100, 20),
  ('ffff3333-0000-0000-0000-000000000012', 'ffff1111-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222', 'telefono', '{"es":"Teléfono"}', 'texto',
   false, 'firmante', 1, 0, 10, 70, 100, 20),
  ('ffff3333-0000-0000-0000-000000000013', 'ffff1111-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222', 'comentario', '{"es":"Comentario"}', 'texto',
   false, 'cualquiera', null, 0, 10, 40, 100, 20);

-- El campo de CUALQUIERA del segundo circuito queda prellenado por la emisora
-- —como lo dejaría el envío desde planilla— TODAVÍA en borrador, que es cuando
-- la 060 lo permite. Recién después se despacha.
insert into valor_campo (campo_id, instancia_id, cuenta_propietaria_id,
                         valor, completado_por, completado_en, origen) values
  ('ffff3333-0000-0000-0000-000000000013', 'ffff2222-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222', 'sin observaciones',
   'ffff0000-0000-0000-0000-00000000000e', now(), 'planilla');

update circuito set estado = 'en_curso'
 where id = 'ffff1111-0000-0000-0000-000000000002';

commit;

-- El otorgamiento se da por bueno: lo que se prueba es de quién es cada campo
-- y cuándo, no el circuito de otorgamientos.
create or replace function app.tiene_otorgamiento(uuid, uuid, text) returns boolean
  language sql stable as $$ select true $$;

do $ejerce$
declare
  v_cuenta   uuid := '22222222-2222-2222-2222-222222222222';
  v_ana      uuid := 'ffff0000-0000-0000-0000-00000000000a';
  v_i_borr   uuid := 'ffff2222-0000-0000-0000-000000000001';
  v_i_env    uuid := 'ffff2222-0000-0000-0000-000000000002';
  v_mal      text := '';
begin
  -- ═══ LA EMISORA, EN BORRADOR: puede TODO — la 060 es esta columna ═══
  execute format(
    'create or replace function app.cuenta_actual() returns uuid '
    'language sql stable as $f$ select %L::uuid $f$', v_cuenta);
  execute
    'create or replace function app.actor() returns text '
    'language sql stable as $f$ select ''cuenta''::text $f$';

  if not app.puede_completar_campo('ffff3333-0000-0000-0000-000000000001', v_i_borr) then
    v_mal := v_mal || E'\n  la emisora NO puede su propio campo en borrador (esto andaba desde la 038)';
  end if;
  if not app.puede_completar_campo('ffff3333-0000-0000-0000-000000000002', v_i_borr) then
    v_mal := v_mal || E'\n  ⚠ la emisora NO puede prellenar el campo del firmante en borrador — la 060 no está haciendo nada';
  end if;
  if not app.puede_completar_campo('ffff3333-0000-0000-0000-000000000003', v_i_borr) then
    v_mal := v_mal || E'\n  ⚠ la emisora NO puede prellenar el campo de cualquiera en borrador';
  end if;

  -- ═══ LA EMISORA, YA ENVIADO: la ventana está CERRADA para los tres ═══
  if app.puede_completar_campo('ffff3333-0000-0000-0000-000000000011', v_i_env) then
    v_mal := v_mal || E'\n  ⚠ la emisora puede tocar su campo DESPUÉS del despacho — la ventana no cierra';
  end if;
  if app.puede_completar_campo('ffff3333-0000-0000-0000-000000000012', v_i_env) then
    v_mal := v_mal || E'\n  ⚠⚠ la emisora puede tocar el campo del firmante DESPUÉS del despacho — esto reescribe lo que la gente ya vio';
  end if;
  if app.puede_completar_campo('ffff3333-0000-0000-0000-000000000013', v_i_env) then
    v_mal := v_mal || E'\n  ⚠ la emisora puede tocar el campo de cualquiera después del despacho';
  end if;

  -- ═══ ANA, FIRMANTE EN EL ENVIADO ═══ Su campo sigue siendo suyo (puede
  -- corregir el prellenado hasta firmar); el de cualquiera que la emisora ya
  -- respondió, no — primer escritor quedó, la regla de siempre.
  execute
    'create or replace function app.cuenta_actual() returns uuid '
    'language sql stable as $f$ select null::uuid $f$';
  execute
    'create or replace function app.actor() returns text '
    'language sql stable as $f$ select ''externo''::text $f$';
  execute format(
    'create or replace function app.identidades_del_actor() returns uuid[] '
    'language sql stable as $f$ select array[%L]::uuid[] $f$', v_ana);

  if not app.puede_completar_campo('ffff3333-0000-0000-0000-000000000012', v_i_env) then
    v_mal := v_mal || E'\n  ⚠ Ana NO puede corregir SU campo prellenado — el prellenado no puede ser una jaula';
  end if;
  if app.puede_completar_campo('ffff3333-0000-0000-0000-000000000013', v_i_env) then
    v_mal := v_mal || E'\n  ⚠ Ana puede reescribir el campo de cualquiera que la emisora ya respondió';
  end if;
  if app.puede_completar_campo('ffff3333-0000-0000-0000-000000000011', v_i_env) then
    v_mal := v_mal || E'\n  ⚠ Ana puede escribir el campo del EMISOR';
  end if;

  if v_mal <> '' then
    raise exception E'La 060 no hace lo que dice:%', v_mal;
  end if;

  raise notice '✓ ejercido: en borrador la emisora prellena todo; enviado, cada campo vuelve a ser de su dueño.';
end
$ejerce$;
