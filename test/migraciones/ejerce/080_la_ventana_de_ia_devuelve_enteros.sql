-- =============================================================================
-- ejerce/080_la_ventana_de_ia_devuelve_enteros.sql
--
-- Lo que hay que probar:
--
--   1. Que la ventana siga agregando bien (que la corrección de tipo no se haya
--      llevado puesto el `group by`).
--   2. Que los tokens salgan como ENTEROS, que es todo el punto de la migración.
--   3. Que los permisos hayan vuelto: el `drop view` se los lleva, y sin ellos
--      la consola del operador deja de ver el consumo de IA.
--
-- ⚠ El caso 3 existe porque el `drop` es silencioso con los permisos: la vista
-- queda perfecta y la pantalla vacía, sin un solo error en ningún log.
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas.';
  end if;
end $cinturon$;

begin;

-- ═══ 1 y 2. Agrega bien, y devuelve enteros ═════════════════════════════════
do $ventana$
declare r record; v_tipo_in text; v_tipo_out text;
begin
  perform app.medir_ia('22222222-2222-2222-2222-222222222222', 'modelo_ej80',
                       1000, 500, 0.02, 'USD', 'ej80:ia:uno');
  perform app.medir_ia('22222222-2222-2222-2222-222222222222', 'modelo_ej80',
                       250, 125, 0.01, 'USD', 'ej80:ia:dos');

  select * into r from consumo_ia
   where cuenta_id = '22222222-2222-2222-2222-222222222222'
     and modelo = 'modelo_ej80' and periodo = to_char(now(), 'YYYY-MM');

  if r.cuenta_id is null then
    raise exception '1. La ventana no devolvió la fila agregada';
  end if;
  if r.input_tokens is distinct from 1250::bigint then
    raise exception '1. Suma % tokens de entrada y son 1000 + 250', r.input_tokens;
  end if;
  if r.output_tokens is distinct from 625::bigint then
    raise exception '1. Suma % tokens de salida y son 500 + 125', r.output_tokens;
  end if;

  -- ⚠ Y el tipo, que es el motivo de esta migración. Se pregunta al catálogo,
  -- no al valor: un numeric 1250 y un bigint 1250 se comparan iguales, así que
  -- mirar el número NO distingue el defecto. Es la misma trampa que `<>` con
  -- NULL, con otra cara.
  select data_type into v_tipo_in from information_schema.columns
   where table_name = 'consumo_ia' and column_name = 'input_tokens';
  select data_type into v_tipo_out from information_schema.columns
   where table_name = 'consumo_ia' and column_name = 'output_tokens';

  if v_tipo_in is distinct from 'bigint' then
    raise exception '2. ⚠⚠ input_tokens sale como % y la tabla que se reemplazó decía bigint', v_tipo_in;
  end if;
  if v_tipo_out is distinct from 'bigint' then
    raise exception '2. ⚠⚠ output_tokens sale como % y la tabla que se reemplazó decía bigint', v_tipo_out;
  end if;
end $ventana$;

-- ═══ 3. Los permisos volvieron después del drop ═════════════════════════════
do $permisos$
declare v_n int;
begin
  select count(*) into v_n from information_schema.role_table_grants
   where table_name = 'consumo_ia' and privilege_type = 'SELECT'
     and grantee in ('app_rw', 'app_operador');
  if v_n <> 2 then
    raise exception '3. ⚠⚠ Quedaron % permisos de lectura sobre la ventana y tienen que ser 2: sin ellos la pantalla queda vacía sin un solo error', v_n;
  end if;
end $permisos$;

do $listo$ begin
  raise notice '✓ 080: la ventana de IA agrega bien, devuelve enteros y volvió con sus permisos.';
end $listo$;

rollback;
