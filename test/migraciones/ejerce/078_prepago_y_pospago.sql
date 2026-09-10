-- =============================================================================
-- ejerce/078_prepago_y_pospago.sql
--
-- Lo que hay que probar, y todo es plata:
--
--   1. Sin configuración, una cuenta es pospago sin tope: nada cambia para nadie.
--   2. Prepago sin saldo: el despacho NO sale, y el error dice cuánto falta.
--   3. Una recarga acredita una vez, aunque se acredite dos.
--   4. Despachar reserva lo estimado (firmantes × precio); firmar consume y
--      devuelve esa parte de la reserva (el saldo no baja dos veces); cerrar el
--      circuito devuelve lo que sobró.
--   5. Pospago con tope: al tope frena; con levante del operador, pasa.
--   6. Quien firma no escribe plata directo, y un movimiento no se toca.
--   7. `estado_de_saldo` dice frenada / cerca del límite.
--
-- Con `is distinct from` (nota de método del ejerce 070). Como en el 076: el
-- que escribe (app_rw) y el que comprueba (dueño) son distintos.
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas.';
  end if;
end $cinturon$;

begin;

-- ── 0. Plan con precio 10 UYU la firma simple, suscripción, y el circuito
--       paralelo de los fixtures (3 firmantes, cuenta 2222) ───────────────────
insert into plan (id, codigo, nombre_i18n) values
  ('e7800000-0000-0000-0000-0000000000f1', 'ej78_plan', '{"es":"Plan del ejerce 78"}'::jsonb)
on conflict do nothing;
update suscripcion set estado = 'cancelada', fin = current_date
 where cuenta_id = '22222222-2222-2222-2222-222222222222' and estado = 'activa';
insert into suscripcion (cuenta_id, plan_id, moneda)
values ('22222222-2222-2222-2222-222222222222', 'e7800000-0000-0000-0000-0000000000f1', 'UYU');
insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, precio_unitario)
values ('e7800000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'firma', 'simple', 10.0000);

-- ═══ 1. Sin configuración: pospago sin tope ═════════════════════════════════
do $omision$
declare m record;
begin
  select * into m from app.modalidad_de_cuenta('22222222-2222-2222-2222-222222222222');
  if m.modalidad is distinct from 'pospago' then raise exception '1. Sin config dio %', m.modalidad; end if;
  if m.origen is distinct from 'por_omision' then raise exception '1. Origen %', m.origen; end if;
  if m.tope_excedente is not null then raise exception '1. Sin config apareció un tope'; end if;
end $omision$;

-- Y sin tope, un despacho pospago reserva sin frenar (cero plata en pospago).
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('app.identidad_id', '11111111-1111-1111-1111-111111111111', true);
end $ctx$;
do $pospago_libre$
declare v_id uuid;
begin
  v_id := app.reservar_despacho('66666666-6666-6666-6666-666666666666');
  if v_id is null then raise exception '1. Pospago sin tope no reservó'; end if;
end $pospago_libre$;
reset role;
do $chk1$
declare v_n int;
begin
  select count(*) into v_n from movimiento_saldo where cuenta_id = '22222222-2222-2222-2222-222222222222';
  if v_n is distinct from 0 then raise exception '1. Pospago movió plata (% movimientos)', v_n; end if;
  -- Se limpia la reserva para reusar el circuito en los casos siguientes.
  delete from reserva_saldo where circuito_id = '66666666-6666-6666-6666-666666666666';
end $chk1$;

-- ═══ 2. Prepago sin saldo: no sale ══════════════════════════════════════════
insert into billing_config (plan_id, modalidad, metrica, modelo_comision, umbral_aviso_saldo)
values ('e7800000-0000-0000-0000-0000000000f1', 'prepago', 'firma', 'precio_fijo', 15);

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $sinsaldo$
declare v_ok boolean; v_msg text;
begin
  begin
    perform app.reservar_despacho('66666666-6666-6666-6666-666666666666');
    v_ok := true;
  exception when sqlstate 'P0402' then v_ok := false; v_msg := sqlerrm; end;
  if v_ok is distinct from false then raise exception '2. ⚠⚠ Despachó sin saldo'; end if;
  if v_msg not like 'SIN_SALDO: faltan 30.00 UYU%' then
    raise exception '2. El error no dice cuánto falta: %', v_msg;
  end if;
end $sinsaldo$;
reset role;

-- ═══ 3. Una recarga acredita una vez ════════════════════════════════════════
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
do $recarga$
declare v_id uuid; v_saldo numeric;
begin
  insert into recarga (cuenta_id, moneda, monto_pagado, monto_acreditado, medio, motivo, creada_por)
  values ('22222222-2222-2222-2222-222222222222', 'UYU', 100, 100, 'manual', 'transferencia 123', 'ejerce')
  returning id into v_id;
  perform app.acreditar_recarga(v_id);
  perform app.acreditar_recarga(v_id);   -- dos veces
  v_saldo := app.saldo_disponible('22222222-2222-2222-2222-222222222222', 'UYU');
  if v_saldo is distinct from 100.0000 then raise exception '3. ⚠ Saldo % tras acreditar dos veces una recarga de 100', v_saldo; end if;
end $recarga$;
reset role;

-- ═══ 4. Reservar → consumir → liberar ═══════════════════════════════════════
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $reservar$
declare v_id uuid;
begin
  v_id := app.reservar_despacho('66666666-6666-6666-6666-666666666666');
  if v_id is null then raise exception '4. No reservó con saldo'; end if;
  -- Reintentar no reserva dos veces.
  if app.reservar_despacho('66666666-6666-6666-6666-666666666666') is distinct from v_id then
    raise exception '4. ⚠ La segunda reserva del mismo circuito creó otra';
  end if;
end $reservar$;
reset role;
do $chk4a$
declare v_saldo numeric; r record;
begin
  v_saldo := app.saldo_disponible('22222222-2222-2222-2222-222222222222', 'UYU');
  if v_saldo is distinct from 70.0000 then raise exception '4. Tras reservar 3×10 el saldo es % y tiene que ser 70', v_saldo; end if;
  select * into r from reserva_saldo where circuito_id = '66666666-6666-6666-6666-666666666666';
  if r.monto_estimado is distinct from 30.0000 then raise exception '4. Reserva estimada %', r.monto_estimado; end if;
  if (r.desglose->>'firmantes')::int is distinct from 3 then raise exception '4. Desglose %', r.desglose; end if;
end $chk4a$;

-- Firma uno: la línea facturable dispara el consumo.
-- ⚠ El id de la participación se saca ANTES de ponerse el traje de app_rw: bajo
-- RLS la cuenta no ve participaciones sin otorgamiento (truco del ejerce 073).
create temporary table firma_78 as
  select id from participacion
   where circuito_id = '66666666-6666-6666-6666-666666666666' and papel = 'firmante'
   order by creada_en limit 1;
grant select on firma_78 to app_rw;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $firmar$
declare v_part uuid; v_id uuid;
begin
  select id into v_part from firma_78;
  v_id := app.medir_firma(v_part, 'simple', 'sello_plataforma');
  if v_id is null then raise exception '4. El medidor no escribió la línea'; end if;
end $firmar$;
reset role;
do $chk4b$
declare v_saldo numeric; v_res numeric;
begin
  v_saldo := app.saldo_disponible('22222222-2222-2222-2222-222222222222', 'UYU');
  -- 100 − 30 reservado − 10 consumido + 10 liberado de la reserva = 70.
  if v_saldo is distinct from 70.0000 then
    raise exception '4. ⚠ Tras firmar una, el saldo es % y tiene que seguir en 70 (no baja dos veces)', v_saldo;
  end if;
  select -coalesce(sum(monto), 0) into v_res from movimiento_saldo
   where reserva_id = (select id from reserva_saldo where circuito_id = '66666666-6666-6666-6666-666666666666')
     and tipo in ('reserva','liberacion');
  if v_res is distinct from 20.0000 then raise exception '4. Sigue reservado % y tiene que ser 20', v_res; end if;
end $chk4b$;

-- Cierra el circuito: lo que quedó reservado vuelve.
update circuito set estado = 'completo', cerrado_en = now()
 where id = '66666666-6666-6666-6666-666666666666';
do $chk4c$
declare v_saldo numeric; r record;
begin
  v_saldo := app.saldo_disponible('22222222-2222-2222-2222-222222222222', 'UYU');
  if v_saldo is distinct from 90.0000 then
    raise exception '4. ⚠ Tras cerrar, el saldo es % y tiene que ser 90 (100 − 10 firmada)', v_saldo;
  end if;
  select * into r from reserva_saldo where circuito_id = '66666666-6666-6666-6666-666666666666';
  if r.estado is distinct from 'liquidada' then raise exception '4. La reserva quedó %', r.estado; end if;
end $chk4c$;

-- ═══ 5. Pospago con tope: frena; con levante, pasa ══════════════════════════
-- Override por cuenta: pospago, 0 incluidas, tope 2. El circuito tiene 3.
insert into billing_config (cuenta_id, modalidad, metrica, modelo_comision, incluido_mensual, tope_excedente)
values ('22222222-2222-2222-2222-222222222222', 'pospago', 'firma', 'precio_fijo', 0, 2);
-- El 6666… ya cerró (y un circuito completo no vuelve a enviado: trigger de la
-- 060). Se usa el 3333… de los fixtures, que está enviado y sin firmantes: se
-- le ponen tres.
-- (`posicion` es el LUGAR del firmante desde la 055: un firmante sin lugar no
-- pasa el check.)
insert into participacion (instancia_id, circuito_id, cuenta_propietaria_id, identidad_id, papel, orden, posicion)
select '55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333',
       '22222222-2222-2222-2222-222222222222', i, 'firmante', 1, n
  from unnest(array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002',
                    'aaaaaaaa-0000-0000-0000-000000000003']::uuid[]) with ordinality as t(i, n);

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $tope$
declare m record; v_ok boolean; v_msg text;
begin
  select * into m from app.modalidad_de_cuenta('22222222-2222-2222-2222-222222222222');
  if m.origen is distinct from 'cuenta' then raise exception '5. El override por cuenta no ganó (origen %)', m.origen; end if;
  begin
    perform app.reservar_despacho('33333333-3333-3333-3333-333333333333');
    v_ok := true;
  exception when sqlstate 'P0402' then v_ok := false; v_msg := sqlerrm; end;
  if v_ok is distinct from false then raise exception '5. ⚠⚠ Despachó pasado el tope'; end if;
  if v_msg not like 'TOPE_ALCANZADO%' then raise exception '5. Error inesperado: %', v_msg; end if;
end $tope$;
reset role;

-- El operador levanta el freno por un día.
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
insert into levante_de_limite (cuenta_id, hasta, monto_extra, motivo, por)
values ('22222222-2222-2222-2222-222222222222', now() + interval '1 day', null, 'cliente al día, factura en camino', 'ejerce');
reset role;

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $levante$
declare v_id uuid;
begin
  v_id := app.reservar_despacho('33333333-3333-3333-3333-333333333333');
  if v_id is null then raise exception '5. ⚠ Con levante vigente el despacho siguió frenado'; end if;
end $levante$;
reset role;

-- ═══ 6. Quien firma no escribe plata; un movimiento no se toca ══════════════
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $rw$
declare v_ok boolean;
begin
  begin
    insert into movimiento_saldo (cuenta_id, moneda, tipo, monto, creado_por)
    values ('22222222-2222-2222-2222-222222222222', 'UYU', 'recarga', 1000000, 'yo');
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then raise exception '6. ⚠⚠ Una cuenta se recargó sola'; end if;
end $rw$;
reset role;
do $inmutable$
declare v_ok boolean;
begin
  begin
    update movimiento_saldo set monto = monto + 1 where cuenta_id = '22222222-2222-2222-2222-222222222222';
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '6. ⚠⚠ Se pudo modificar un movimiento de saldo'; end if;
  begin
    delete from movimiento_saldo where cuenta_id = '22222222-2222-2222-2222-222222222222';
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '6. ⚠⚠ Se pudo borrar un movimiento de saldo'; end if;
end $inmutable$;

-- ═══ 7. estado_de_saldo ═════════════════════════════════════════════════════
do $estado$
declare e record;
begin
  -- Hoy la cuenta es pospago (override) con tope 2, levante vigente.
  select * into e from app.estado_de_saldo('22222222-2222-2222-2222-222222222222');
  if e.modalidad is distinct from 'pospago' then raise exception '7. Modalidad %', e.modalidad; end if;
  if e.levante_hasta is null then raise exception '7. No ve el levante'; end if;
  if e.frenada is distinct from false then raise exception '7. Con levante no puede estar frenada'; end if;

  -- Sin el levante y con 1 firma cobrada este mes de tope 2: cerca (≥ 80%) y no frenada.
  update levante_de_limite set revocado_en = now() where cuenta_id = '22222222-2222-2222-2222-222222222222';
  select * into e from app.estado_de_saldo('22222222-2222-2222-2222-222222222222');
  if e.consumidas_mes is distinct from 1::bigint then raise exception '7. Consumidas del mes: %', e.consumidas_mes; end if;
  if e.frenada is distinct from false then raise exception '7. Frenada con 1 de 2'; end if;

  -- Prepago con saldo 90 y umbral 15: ni cerca ni frenada.
  delete from billing_config where cuenta_id = '22222222-2222-2222-2222-222222222222';
  select * into e from app.estado_de_saldo('22222222-2222-2222-2222-222222222222');
  if e.modalidad is distinct from 'prepago' then raise exception '7. Volvió a % y tenía que ser prepago del plan', e.modalidad; end if;
  if e.saldo is distinct from 90.0000 then raise exception '7. Saldo %', e.saldo; end if;
  if e.cerca_del_limite is distinct from false or e.frenada is distinct from false then
    raise exception '7. Con 90 de saldo y umbral 15 dice cerca=% frenada=%', e.cerca_del_limite, e.frenada;
  end if;
end $estado$;

reset role;
rollback;
