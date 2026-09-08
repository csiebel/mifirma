-- =============================================================================
-- ejerce/074_liquidacion_a_proveedores.sql
--
-- Lo que hay que probar, y todo es plata:
--
--   1. Que emitir CONGELE el número y marque las líneas que lo componen — y que
--      una firma que llega después NO entre en un documento ya emitido.
--   2. Que una liquidación emitida no cambie de importe ni vuelva para atrás.
--   3. Que `app_rw` no vea las liquidaciones: no son de ningún cliente.
--
-- Con `is distinct from` (nota de método del ejerce 070).
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas.';
  end if;
end $cinturon$;

begin;

-- ── 0. Un proveedor con revenue share y tres firmas suyas ────────────────────
insert into proveedor_firma (id, codigo, nombre_mostrado, activo_global, entorno, endpoints, parametros)
values ('aaaa0074-0000-0000-0000-00000000000a', 'ej74_share', 'Socio 74', true, 'integracion', '{}'::jsonb, '{}'::jsonb);
insert into proveedor_capacidad (proveedor_id, firma_hash, identifica_titular, formatos_devueltos)
values ('aaaa0074-0000-0000-0000-00000000000a', true, true, '{pkcs7}');
insert into proveedor_pais (proveedor_id, pais, capacidades, niveles, modelo_economico, revenue_share_pct)
values ('aaaa0074-0000-0000-0000-00000000000a', 'PY', '{firma}', '{avanzada}', 'revenue_share', 30.000);

-- Tres firmas de 20, con 6 a liquidar cada una.
insert into firma_facturable (participacion_id, instancia_id, cuenta_id, periodo, pais, nivel_firma,
                              proveedor_id, moneda, precio_unitario, modelo_economico, a_liquidar)
select p.id, p.instancia_id, '22222222-2222-2222-2222-222222222222', '2026-09', 'PY', 'avanzada',
       'aaaa0074-0000-0000-0000-00000000000a', 'USD', 20.0000, 'revenue_share', 6.0000
  from participacion p where p.papel = 'firmante' order by p.creada_en limit 3;

set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;

-- ═══ 1. Lo pendiente, y emitir ══════════════════════════════════════════════
do $emitir$
declare r record; v_id uuid; v_n int;
begin
  select * into r from app.liquidacion_pendiente('2026-09')
   where proveedor_id = 'aaaa0074-0000-0000-0000-00000000000a';
  if r.firmas is distinct from 3::bigint then raise exception '1. Pendiente: % firmas y son 3', r.firmas; end if;
  if r.a_liquidar is distinct from 18.0000 then raise exception '1. Pendiente: a liquidar % y son 18', r.a_liquidar; end if;

  v_id := app.liquidacion_emitir('aaaa0074-0000-0000-0000-00000000000a', 'PY', '2026-09', 'USD', 'ejerce');

  select * into r from liquidacion_proveedor where id = v_id;
  if r.estado is distinct from 'emitida' then raise exception '1. Estado tras emitir: %', r.estado; end if;
  if r.firmas is distinct from 3::bigint then raise exception '1. Emitida con % firmas', r.firmas; end if;
  if r.a_liquidar is distinct from 18.0000 then raise exception '1. Emitida con % a liquidar', r.a_liquidar; end if;
  if r.emitida_en is null then raise exception '1. Emitida sin fecha de emisión'; end if;

  -- ⚠ Las líneas quedaron marcadas: ya no aparecen como pendientes.
  select count(*) into v_n from app.liquidacion_pendiente('2026-09')
   where proveedor_id = 'aaaa0074-0000-0000-0000-00000000000a';
  if v_n is distinct from 0 then
    raise exception '1. ⚠ Después de emitir siguen apareciendo % pendientes: se pagarían dos veces', v_n;
  end if;
end $emitir$;

-- 1b. ⚠⚠ Una firma que llega después NO entra en el documento ya emitido.
reset role;
insert into firma_facturable (participacion_id, instancia_id, cuenta_id, periodo, pais, nivel_firma,
                              proveedor_id, moneda, precio_unitario, modelo_economico, a_liquidar)
select p.id, p.instancia_id, '22222222-2222-2222-2222-222222222222', '2026-09', 'PY', 'avanzada',
       'aaaa0074-0000-0000-0000-00000000000a', 'USD', 20.0000, 'revenue_share', 6.0000
  from participacion p
 where p.papel = 'firmante'
   and not exists (select 1 from firma_facturable f where f.participacion_id = p.id)
 order by p.creada_en limit 1;

set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
do $tarde$
declare r record; v_ok boolean;
begin
  -- Aparece como pendiente otra vez, para el período siguiente.
  select * into r from app.liquidacion_pendiente('2026-09')
   where proveedor_id = 'aaaa0074-0000-0000-0000-00000000000a';
  if r.firmas is distinct from 1::bigint then
    raise exception '1b. La firma tardía no quedó pendiente (vinieron %)', r.firmas;
  end if;

  -- Y volver a emitir el mismo período no la mete en el documento viejo.
  begin
    perform app.liquidacion_emitir('aaaa0074-0000-0000-0000-00000000000a', 'PY', '2026-09', 'USD', 'ejerce');
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then
    raise exception '1b. ⚠⚠ Se pudo reabrir una liquidación ya emitida';
  end if;
end $tarde$;

-- ═══ 2. Una liquidación emitida no cambia ═══════════════════════════════════
do $inmutable$
declare v_ok boolean; v_id uuid;
begin
  select id into v_id from liquidacion_proveedor
   where proveedor_id = 'aaaa0074-0000-0000-0000-00000000000a';

  begin
    update liquidacion_proveedor set a_liquidar = 1 where id = v_id;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '2. ⚠ Se pudo cambiar el importe de una liquidación emitida'; end if;

  begin
    delete from liquidacion_proveedor where id = v_id;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '2. ⚠ Se pudo borrar una liquidación emitida'; end if;

  -- Pagarla sí: es lo único que pasa después.
  begin
    update liquidacion_proveedor set estado = 'pagada', pagada_en = now(), referencia_pago = 'transf 123'
     where id = v_id;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from true then raise exception '2. ⚠⚠ No se pudo pagar una liquidación emitida'; end if;

  -- Pero no vuelve para atrás.
  begin
    update liquidacion_proveedor set estado = 'emitida', pagada_en = null where id = v_id;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '2. Una liquidación pagada volvió a emitida'; end if;
end $inmutable$;

-- ═══ 3. app_rw no ve las liquidaciones ══════════════════════════════════════
reset role;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $rw$
declare v_ok boolean;
begin
  begin
    perform 1 from liquidacion_proveedor limit 1;
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then
    raise exception '3. ⚠ La conexión de la aplicación ve las liquidaciones — no son de ningún cliente';
  end if;
end $rw$;

reset role;
rollback;
