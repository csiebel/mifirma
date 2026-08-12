-- =============================================================================
-- MiFirma — test/migraciones/ejerce/059_espejos_del_campo.sql
--
-- La prueba de COMPORTAMIENTO de la 059. `probar.sh` la corre sola después de
-- las dos pasadas.
--
-- ═══ QUÉ DECIDE ═══
--
-- Que la migración entre dos veces prueba el catálogo. Lo que importa acá:
--
--  1. Un campo viejo —insertado sin nombrar la columna— queda con `[]`, que es
--     «sin espejos», y todo lo anterior sigue significando lo mismo.
--  2. La base rechaza un espejo que no es un arreglo, y un arreglo pasado del
--     tope. Si el check se cae, un PDF hostil con quinientos widgets se vuelve
--     quinientas marcas por firma.
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ⚠ EL CINTURÓN. La base de producción también se llama `mifirma`: se exige la
-- marca que sólo pone `base-minima.sql`. Éste escribe datos.
do $guard$ begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = 'banco_de_pruebas') then
    raise exception 'ABORTADO: no encuentro la marca del banco. Si esto es la base real, MENOS MAL.';
  end if;
end $guard$;

do $espejos$
declare
  v_cuenta uuid; v_circuito uuid; v_campo uuid; v_esp jsonb; v_ok boolean;
begin
  insert into cuenta (nombre_mostrado) values ('Banco 059') returning id into v_cuenta;
  insert into circuito (cuenta_propietaria_id, titulo) values (v_cuenta, 'Banco 059')
    returning id into v_circuito;

  -- ── 1. Un campo insertado como siempre queda SIN espejos, no sin valor ────
  insert into campo (circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n,
                     tipo, quien_completa, pagina, x, y, ancho, alto)
       values (v_circuito, v_cuenta, 'nombre_paciente', '{"es":"Nombre"}',
               'texto', 'cualquiera', 0, 100, 700, 180, 18)
    returning id into v_campo;

  select espejos into v_esp from campo where id = v_campo;
  if v_esp is null or v_esp::text <> '[]' then
    raise exception 'Un campo insertado sin espejos quedó con «%», no con []. Lo viejo cambió de significado.', v_esp;
  end if;

  -- ── 2. Dos espejos con la forma esperada entran ───────────────────────────
  update campo set espejos =
    '[{"pagina":1,"x":100,"y":770,"ancho":180,"alto":18},
      {"pagina":2,"x":100,"y":770,"ancho":180,"alto":18}]'::jsonb
   where id = v_campo;

  -- ── 3. Algo que no es un arreglo NO entra ─────────────────────────────────
  v_ok := false;
  begin
    update campo set espejos = '{"pagina":1}'::jsonb where id = v_campo;
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'La base aceptó espejos que no son un arreglo. El check no está haciendo nada.';
  end if;

  -- ── 4. Un arreglo pasado del tope NO entra ────────────────────────────────
  v_ok := false;
  begin
    update campo set espejos =
      (select jsonb_agg(jsonb_build_object('pagina', 0, 'x', 1, 'y', 1, 'ancho', 5, 'alto', 5))
         from generate_series(1, 31))
     where id = v_campo;
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'La base aceptó 31 espejos con tope de 30. Un PDF hostil se vuelve quinientas marcas.';
  end if;

  -- Limpieza: la fila de prueba no debe parecer un dato real.
  delete from campo where id = v_campo;
  delete from circuito where id = v_circuito;
  delete from cuenta where id = v_cuenta;
end $espejos$;
