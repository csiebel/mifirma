-- =============================================================================
-- MiFirma — test/migraciones/ejerce/055_el_lugar_del_firmante.sql
--
-- La prueba de COMPORTAMIENTO de la 055. `probar.sh` la corre sola después de
-- las dos pasadas, si existe un archivo con el nombre de la migración acá.
--
-- ═══ POR QUÉ HACE FALTA ═══
--
-- Correr una migración dos veces prueba que **entra** y que se puede repetir. No
-- prueba que **haga lo que dice**. La 055 existe para que en paralelo un campo
-- de una persona no lo pueda completar otra, y eso no se ve en el catálogo: se
-- ve preguntándole a `app.puede_completar_campo`, que es quien decide de verdad.
--
-- Antes de la 055, la respuesta a las cuatro preguntas de abajo era «sí» a
-- todas: el campo de Beto lo podía completar Ana, porque la regla comparaba
-- turnos y en paralelo todos valen 1.
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ⚠ EL CINTURÓN. Este archivo ESCRIBE. La base de producción también se llama
-- `mifirma`, así que el guard del nombre no alcanza: se exige la marca que sólo
-- pone `base-minima.sql`.
do $guard$ begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = 'banco_de_pruebas') then
    raise exception 'ABORTADO: esto escribe datos de prueba y no encuentro la marca del banco. Si esto es la base real, MENOS MAL.';
  end if;
end $guard$;

begin;

-- ── el escenario: un acta en paralelo, dos firmantes, un campo de cada uno ───
insert into identidad (id, email_mostrado, nombre_mostrado) values
  ('eeee0000-0000-0000-0000-00000000000a', 'ana.e@ejemplo.com',  'Ana ejerce'),
  ('eeee0000-0000-0000-0000-00000000000b', 'beto.e@ejemplo.com', 'Beto ejerce');

insert into circuito (id, cuenta_propietaria_id, titulo, estado, modo) values
  ('eeee1111-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'Acta para ejercer', 'borrador', 'paralelo');

insert into instancia (id, circuito_id, cuenta_propietaria_id, numero, estado) values
  ('eeee2222-0000-0000-0000-000000000001', 'eeee1111-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222', 1, 'en_curso');

-- Los dos en el turno 1 —es lo que significa paralelo— y en lugares distintos.
insert into participacion (instancia_id, circuito_id, cuenta_propietaria_id,
                           identidad_id, papel, orden, posicion, estado) values
  ('eeee2222-0000-0000-0000-000000000001', 'eeee1111-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222', 'eeee0000-0000-0000-0000-00000000000a',
   'firmante', 1, 1, 'notificada'),
  ('eeee2222-0000-0000-0000-000000000001', 'eeee1111-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222', 'eeee0000-0000-0000-0000-00000000000b',
   'firmante', 1, 2, 'notificada');

insert into campo (id, circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n, tipo,
                   completa_emisor, quien_completa, posicion_firmante,
                   pagina, x, y, ancho, alto) values
  ('eeee3333-0000-0000-0000-000000000001', 'eeee1111-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222', 'nombre_de_ana', '{"es":"Nombre"}', 'texto',
   false, 'firmante', 1, 0, 10, 100, 100, 20),
  ('eeee3333-0000-0000-0000-000000000002', 'eeee1111-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222', 'nombre_de_beto', '{"es":"Nombre"}', 'texto',
   false, 'firmante', 2, 0, 10, 70, 100, 20);

commit;

-- ── se hace pasar por cada uno y se le pregunta a la base ────────────────────
--
-- Se reemplazan los dos stubs de contexto que trae `base-minima.sql`. El
-- otorgamiento se da por bueno: lo que se está probando no es quién tiene
-- permiso de firmar, es a QUIÉN pertenece cada campo.
create or replace function app.tiene_otorgamiento(uuid, uuid, text) returns boolean
  language sql stable as $$ select true $$;

do $ejerce$
declare
  v_ana   uuid := 'eeee0000-0000-0000-0000-00000000000a';
  v_beto  uuid := 'eeee0000-0000-0000-0000-00000000000b';
  v_inst  uuid := 'eeee2222-0000-0000-0000-000000000001';
  v_c_ana uuid := 'eeee3333-0000-0000-0000-000000000001';
  v_c_bet uuid := 'eeee3333-0000-0000-0000-000000000002';
  v_mal   text := '';
begin
  -- Ana
  execute format(
    'create or replace function app.identidades_del_actor() returns uuid[] '
    'language sql stable as $f$ select array[%L]::uuid[] $f$', v_ana);

  if not app.puede_completar_campo(v_c_ana, v_inst) then
    v_mal := v_mal || E'\n  Ana NO puede completar su propio campo';
  end if;
  -- ⚠ ÉSTA es la que fallaba antes de la 055.
  if app.puede_completar_campo(v_c_bet, v_inst) then
    v_mal := v_mal || E'\n  ⚠ Ana PUEDE completar el campo de Beto — el lugar no está atando nada';
  end if;

  -- Beto
  execute format(
    'create or replace function app.identidades_del_actor() returns uuid[] '
    'language sql stable as $f$ select array[%L]::uuid[] $f$', v_beto);

  if not app.puede_completar_campo(v_c_bet, v_inst) then
    v_mal := v_mal || E'\n  Beto NO puede completar su propio campo';
  end if;
  if app.puede_completar_campo(v_c_ana, v_inst) then
    v_mal := v_mal || E'\n  ⚠ Beto PUEDE completar el campo de Ana — el lugar no está atando nada';
  end if;

  -- Un tercero que no participa no puede tocar nada.
  execute
    'create or replace function app.identidades_del_actor() returns uuid[] '
    'language sql stable as $f$ select array[''11111111-1111-1111-1111-111111111111'']::uuid[] $f$';

  if app.puede_completar_campo(v_c_ana, v_inst)
     or app.puede_completar_campo(v_c_bet, v_inst) then
    v_mal := v_mal || E'\n  ⚠ alguien que no firma este documento puede completar campos';
  end if;

  if v_mal <> '' then
    raise exception E'El lugar NO está atando el campo a la persona:%', v_mal;
  end if;

  raise notice '✓ ejercido: en paralelo, cada campo es de su dueño y de nadie más.';
end
$ejerce$;

-- ── y que el lugar no se pueda duplicar ──────────────────────────────────────
do $unico$
declare v_ok boolean := false;
begin
  begin
    insert into participacion (instancia_id, circuito_id, cuenta_propietaria_id,
                               identidad_id, papel, orden, posicion, estado)
    values ('eeee2222-0000-0000-0000-000000000001', 'eeee1111-0000-0000-0000-000000000001',
            '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
            'firmante', 1, 1, 'pendiente');
  exception when unique_violation then
    v_ok := true;
  end;

  if not v_ok then
    raise exception 'Dos personas pudieron ocupar el MISMO lugar del mismo documento.';
  end if;
  raise notice '✓ ejercido: dos personas no pueden ocupar el mismo lugar.';
end
$unico$;
