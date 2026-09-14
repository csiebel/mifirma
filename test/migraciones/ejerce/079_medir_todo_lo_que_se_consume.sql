-- =============================================================================
-- ejerce/079_medir_todo_lo_que_se_consume.sql
--
-- Lo que hay que probar, y todo es plata:
--
--   1. Que la firma se siga midiendo EXACTAMENTE igual que antes, y que la
--      ventana `firma_facturable` la muestre como la mostraba la tabla.
--   2. Que la ventana deje escribir SÓLO `liquidacion_id` y nada más.
--   3. Que un SMS se mida POR SEGMENTOS, y que el saldo descuente
--      precio × cantidad y no el precio. Con las firmas daba igual porque la
--      cantidad era siempre 1; con tres segmentos, no.
--   4. Que el sello de tiempo de alcance `lote` NO se cobre y el de una firma sí
--      (decisión del 30/7: el sello del lote diario es costo nuestro).
--   5. Que medir dos veces lo mismo deje UNA sola línea.
--   6. Que el disco se mida una vez por mes, y que correrlo dos veces el mismo
--      mes no duplique.
--   7. Que las cantidades incluidas cuenten TODAS las del período, no sólo las
--      cobradas (la trampa que agarró el ejerce de la 076).
--   8. Que el operador no pueda escribir líneas medidas.
--   9. Que el despacho de un circuito y el cierre de un documento se midan solos
--      desde la base, sin que nadie los llame.
--
-- ═══ NOTA DE MÉTODO (heredada del ejerce 076, y sigue valiendo) ═══
--
-- ⚠ Bajo `app_rw` con actor 'cuenta' NO se pueden LEER las líneas escritas: la
-- policy pide la capacidad 'facturacion/leer', que la cuenta de prueba no tiene.
-- Un ejerce que lee con el rol equivocado se engaña solo: todo da NULL y las
-- comparaciones pasan. Por eso el medidor corre como `app_rw` —que es quien lo
-- va a llamar de verdad— y las comprobaciones se hacen con el rol dueño, con el
-- id viajando por una tabla temporal.
--
-- ⚠⚠ Y la lección propia de esta migración: `app.medir()` NUNCA LANZA. Así que
-- ningún caso de acá se da por bueno porque "no tiró error": todos miran EL
-- CONTENIDO DE LA FILA. Una función que atrapa todo hace invisible cualquier
-- sabotaje que se apoye en la excepción.
--
-- ⚠ Con `is distinct from` siempre: `<>` no detecta que algo devuelva NULL.
--
-- ⚠ NOTA PARA EL FUTURO: el ejerce de la 076 hace `delete from firma_facturable`
-- con el trigger apagado. Desde esta migración eso es una VISTA y ese ejerce
-- sólo corre contra una base migrada hasta la 076, que es como lo corre
-- `probar.sh`. Si alguien lo corre sobre una base con la 079, va a fallar, y no
-- es un defecto: es que está probando un esquema que ya no existe.
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas.';
  end if;
  if to_regclass('public.evento_medible') is null then
    raise exception 'ABORTADO: no existe evento_medible; la 079 no corrió.';
  end if;
end $cinturon$;

begin;

-- ── 0. El escenario: un plan con precios para todo, y la cuenta en prepago ───
insert into plan (id, codigo, nombre_i18n) values
  ('e7900000-0000-0000-0000-0000000000f1', 'ej79_plan', '{"es":"Plan del ejerce 79"}'::jsonb)
on conflict do nothing;

insert into suscripcion (cuenta_id, plan_id, moneda)
values ('22222222-2222-2222-2222-222222222222', 'e7900000-0000-0000-0000-0000000000f1', 'UYU')
on conflict do nothing;

insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, precio_unitario) values
  ('e7900000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'firma', 'simple', 10.0000),
  ('e7900000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'sms', null, 2.0000),
  ('e7900000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'sello_tsa', null, 1.0000),
  ('e7900000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'circuito', null, 5.0000),
  ('e7900000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'documento', null, 3.0000),
  ('e7900000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'almacenamiento', null, 0.5000),
  ('e7900000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'identidad_digital', null, 4.0000)
on conflict do nothing;

-- Lo que nos cuesta un SMS por fuera.
insert into tarifa_costo (concepto, pais, moneda, costo_unitario)
values ('sms', 'UY', 'USD', 0.045000) on conflict do nothing;

create temporary table firmas_79 as
  select row_number() over (order by p.creada_en, p.id) as n, p.id
    from participacion p where p.papel = 'firmante';
grant select on firmas_79 to app_rw, app_operador;

create temporary table medido_79 (caso text primary key, id uuid);
grant select, insert, delete on medido_79 to app_rw, app_operador;

do $hay$
declare v_n int;
begin
  select count(*) into v_n from firmas_79;
  if v_n < 5 then raise exception '0. El banco tiene % participaciones firmables y hacen falta 5', v_n; end if;
end $hay$;

-- ═══ 1. La firma se mide igual, y la ventana la muestra ═════════════════════
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
insert into medido_79 (caso, id)
select 'firma', app.medir_firma((select id from firmas_79 where n = 1), 'simple', null);

reset role;
do $firma$
declare r record; v record; v_id uuid;
begin
  select id into v_id from medido_79 where caso = 'firma';
  if v_id is null then
    raise exception '1. ⚠⚠ La firma no dejó línea: se perdió el hecho de que se firmó';
  end if;

  select * into r from evento_medible where id = v_id;
  if r.tipo is distinct from 'firma' then raise exception '1. Tipo %', r.tipo; end if;
  if r.precio_unitario is distinct from 10.0000 then raise exception '1. Precio % y la lista dice 10', r.precio_unitario; end if;
  if r.cantidad is distinct from 1::numeric then raise exception '1. Cantidad %', r.cantidad; end if;
  if r.unidad is distinct from 'unidad' then raise exception '1. Unidad %', r.unidad; end if;
  if r.pais is distinct from 'UY'::char(2) then raise exception '1. País % (tiene que ser el del EMISOR)', r.pais; end if;
  if r.clave_idempotencia is distinct from ('firma:' || r.participacion_id::text) then
    raise exception '1. La clave de idempotencia de una firma no es la esperada: %', r.clave_idempotencia;
  end if;

  -- ⚠ Y por la ventana tiene que verse EXACTAMENTE lo mismo, porque hay código
  -- y tres pantallas que sólo saben leer por ahí.
  select * into v from firma_facturable where id = v_id;
  if v.id is null then
    raise exception '1. ⚠⚠ La línea existe pero la ventana no la muestra: consumos.ts y la liquidación quedaron ciegos';
  end if;
  if v.precio_unitario is distinct from r.precio_unitario
     or v.cuenta_id is distinct from r.cuenta_id
     or v.nivel_firma is distinct from r.nivel_firma
     or v.cobrada is distinct from r.cobrada then
    raise exception '1. La ventana muestra algo distinto de la línea real';
  end if;
  -- `costo_proveedor` es el nombre viejo de `costo_externo`: si se perdió el
  -- alias, la liquidación deja de ver lo que debe pagar.
  if v.costo_proveedor is distinct from r.costo_externo then
    raise exception '1. La ventana perdió el alias costo_proveedor';
  end if;
end $firma$;

-- Y lo que NO es una firma no puede asomarse por esa ventana.
do $solo_firmas$
declare v_n int;
begin
  perform app.medir('sms', '22222222-2222-2222-2222-222222222222', 'ej79:ventana:sms', 1);
  select count(*) into v_n from firma_facturable where id in
    (select id from evento_medible where tipo = 'sms');
  if v_n <> 0 then
    raise exception '1b. ⚠⚠ Un SMS se ve por la ventana de firmas: la liquidación le pagaría a un proveedor por SMS';
  end if;
end $solo_firmas$;

-- ═══ 2. La ventana deja escribir SÓLO la liquidación ════════════════════════
do $ventana$
declare v_id uuid; v_ok boolean := false;
begin
  select id into v_id from medido_79 where caso = 'firma';

  update firma_facturable set liquidacion_id = 'e7900000-0000-0000-0000-00000000aaaa' where id = v_id;
  if (select liquidacion_id from evento_medible where id = v_id)
       is distinct from 'e7900000-0000-0000-0000-00000000aaaa'::uuid then
    raise exception '2. La liquidación no se pudo marcar por la ventana, y la 074 hace exactamente eso';
  end if;

  begin
    update firma_facturable set precio_unitario = 999 where id = v_id;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception '2. ⚠⚠ Se pudo cambiar el precio por la ventana: una línea facturable editable no sirve para discutir una factura';
  end if;
end $ventana$;

-- ═══ 3. El SMS se mide por segmentos, y el saldo descuenta precio × cantidad ═
--
-- ⚠ Es el caso que con firmas no podía fallar nunca, porque la cantidad era
-- siempre 1. Tres segmentos a 2 pesos son 6 pesos, no 2.
insert into billing_config (cuenta_id, modalidad, metrica, modelo_comision, margen_pct)
values ('22222222-2222-2222-2222-222222222222', 'prepago', 'firma', 'margen_pct', 10.000)
on conflict do nothing;

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
insert into medido_79 (caso, id)
select 'sms3', app.medir_sms('22222222-2222-2222-2222-222222222222', 3, 'BR', 'ej79:sms:tres');

reset role;
do $sms$
declare r record; v_consumo numeric;
begin
  select * into r from evento_medible where id = (select id from medido_79 where caso = 'sms3');
  if r.id is null then raise exception '3. El SMS no dejó línea'; end if;
  if r.cantidad is distinct from 3::numeric then
    raise exception '3. ⚠ Se midieron % segmentos y fueron 3: el portugués sale más caro y así se cobraría de menos', r.cantidad;
  end if;
  if r.unidad is distinct from 'segmento' then raise exception '3. Unidad %', r.unidad; end if;
  if r.precio_unitario is distinct from 2.0000 then raise exception '3. Precio por segmento %', r.precio_unitario; end if;
  if r.costo_externo is distinct from 0.045000::numeric then
    raise exception '3. El costo externo salió % y la tarifa dice 0.045', r.costo_externo;
  end if;
  if (r.detalle ->> 'pais_destino') is distinct from 'BR' then
    raise exception '3. El detalle perdió el país de destino';
  end if;

  select sum(-monto) into v_consumo from movimiento_saldo
   where evento_medible_id = r.id and tipo = 'consumo';
  if v_consumo is distinct from 6.0000 then
    raise exception '3. ⚠⚠ El saldo descontó % y tres segmentos a 2 son 6: se está cobrando el precio, no el total', v_consumo;
  end if;
end $sms$;

-- ═══ 4. El sello del LOTE no se cobra; el de una firma sí ═══════════════════
do $sellos$
declare v_inst uuid; v_lote uuid; v_firma uuid; v_n int;
begin
  select i.id into v_inst from instancia i
    join circuito c on c.id = i.circuito_id
   where c.cuenta_propietaria_id = '22222222-2222-2222-2222-222222222222' limit 1;
  if v_inst is null then raise exception '4. El banco no tiene una instancia de esa cuenta'; end if;

  insert into sello_tiempo (alcance, raiz, autoridad, estado, instancia_id, sellado_en)
  values ('lote', '\\x00'::bytea, 'digicert', 'sellado', v_inst, now()) returning id into v_lote;
  insert into sello_tiempo (alcance, raiz, autoridad, estado, instancia_id, sellado_en)
  values ('firma', '\\x01'::bytea, 'digicert', 'sellado', v_inst, now()) returning id into v_firma;

  select count(*) into v_n from evento_medible where clave_idempotencia = 'sello:' || v_lote::text;
  if v_n <> 0 then
    raise exception '4. ⚠⚠ Se le cobró al cliente el sello del LOTE diario, que por decisión del 30/7 es costo nuestro';
  end if;

  select count(*) into v_n from evento_medible where clave_idempotencia = 'sello:' || v_firma::text;
  if v_n <> 1 then
    raise exception '4. El sello de una firma no se midió: se regala lo que nos cuesta';
  end if;

  -- Y uno que falló no se cobra: no hubo sello.
  insert into sello_tiempo (alcance, raiz, autoridad, estado, instancia_id)
  values ('firma', '\\x02'::bytea, 'globalsign', 'fallido', v_inst) returning id into v_lote;
  select count(*) into v_n from evento_medible where clave_idempotencia = 'sello:' || v_lote::text;
  if v_n <> 0 then
    raise exception '4. ⚠ Se cobró un sello que no se llegó a obtener';
  end if;
end $sellos$;

-- ═══ 5. Medir dos veces lo mismo deja UNA línea ═════════════════════════════
do $idem$
declare v_a uuid; v_b uuid; v_n int;
begin
  select app.medir('sms', '22222222-2222-2222-2222-222222222222', 'ej79:idem', 1) into v_a;
  select app.medir('sms', '22222222-2222-2222-2222-222222222222', 'ej79:idem', 1) into v_b;
  select count(*) into v_n from evento_medible where clave_idempotencia = 'ej79:idem';
  if v_n <> 1 then
    raise exception '5. ⚠⚠ La misma cosa se midió % veces: un reintento se cobraría dos veces', v_n;
  end if;
  if v_a is null then raise exception '5. La primera medición no devolvió id'; end if;
  if v_b is not null then raise exception '5. La segunda devolvió id y tenía que no hacer nada'; end if;
end $idem$;

-- ═══ 6. El disco: una foto por mes, y repetirla no duplica ══════════════════
do $disco$
declare v_n1 int; v_n2 int; v_filas int; r record;
begin
  select app.medir_almacenamiento() into v_n1;
  select app.medir_almacenamiento() into v_n2;

  select count(*) into v_filas from evento_medible
   where tipo = 'almacenamiento' and periodo = to_char(now(), 'YYYY-MM');
  if v_filas <> v_n1 then
    raise exception '6. ⚠⚠ Se anotó el disco % vez/veces por cuenta en el mismo mes y tiene que ser una', v_filas;
  end if;
  if v_n2 <> 0 then
    raise exception '6. La segunda corrida anotó % filas nuevas: la clave de idempotencia no frena', v_n2;
  end if;

  if v_n1 > 0 then
    select * into r from evento_medible where tipo = 'almacenamiento' limit 1;
    if r.unidad is distinct from 'mb' then raise exception '6. El disco se anotó en % y tiene que ser mb', r.unidad; end if;
    if (r.detalle ->> 'bytes') is null then raise exception '6. El detalle perdió los bytes de origen'; end if;
  end if;
end $disco$;

-- ═══ 7. Las incluidas cuentan TODAS, no sólo las cobradas ═══════════════════
--
-- ⚠ La trampa que agarró el ejerce de la 076: si se cuentan sólo las cobradas,
-- el contador se queda en cero, las tres primeras salen gratis y la cuarta
-- también. Nunca se cobra nada y nadie se entera.
update precio_metrica set cantidad_incluida = 3
 where plan_id = 'e7900000-0000-0000-0000-0000000000f1' and metrica = 'circuito';

do $incluidas$
declare i int; v_total int; v_cobradas int;
begin
  for i in 1..4 loop
    perform app.medir('circuito_despachado', '22222222-2222-2222-2222-222222222222',
                      'ej79:circ:' || i::text, 1);
  end loop;

  select count(*), count(*) filter (where cobrada) into v_total, v_cobradas
    from evento_medible
   where tipo = 'circuito_despachado' and clave_idempotencia like 'ej79:circ:%';

  if v_total is distinct from 4 then raise exception '7. Se midieron % y fueron 4', v_total; end if;
  if v_cobradas is distinct from 1 then
    raise exception '7. ⚠⚠ Con 3 incluidas y 4 consumos se cobraron %, y tiene que ser 1', v_cobradas;
  end if;
end $incluidas$;

update precio_metrica set cantidad_incluida = 0
 where plan_id = 'e7900000-0000-0000-0000-0000000000f1' and metrica = 'circuito';

-- ═══ 8. El operador no escribe líneas medidas ═══════════════════════════════
do $operador$
declare v_ok boolean := false;
begin
  begin
    set local role app_operador;
    perform set_config('app.actor', 'operador', true);
    insert into evento_medible (cuenta_id, periodo, tipo, pais, moneda, clave_idempotencia)
    values ('22222222-2222-2222-2222-222222222222', to_char(now(), 'YYYY-MM'), 'sms', 'UY', 'UYU', 'ej79:operador');
  exception when others then v_ok := true;
  end;
  reset role;
  if not v_ok then
    raise exception '8. ⚠⚠ El operador escribió una línea medida: podría escribirle el precio a un cliente';
  end if;
end $operador$;

-- ═══ 9. El despacho y el cierre se miden solos, desde la base ═══════════════
do $solos$
declare v_circ uuid; v_inst uuid; v_n int;
begin
  -- Un circuito en borrador que pasa a despachado.
  select id into v_circ from circuito
   where estado = 'borrador' and cuenta_propietaria_id = '22222222-2222-2222-2222-222222222222' limit 1;
  if v_circ is not null then
    update circuito set estado = 'enviado' where id = v_circ;
    select count(*) into v_n from evento_medible where clave_idempotencia = 'circuito:' || v_circ::text;
    if v_n <> 1 then
      raise exception '9. ⚠ Se despachó un circuito y nadie lo midió (quedaron % líneas)', v_n;
    end if;
    -- Y volver a tocarlo no vuelve a cobrar.
    update circuito set estado = 'enviado' where id = v_circ;
    select count(*) into v_n from evento_medible where clave_idempotencia = 'circuito:' || v_circ::text;
    if v_n <> 1 then raise exception '9. Un segundo update cobró el circuito de nuevo'; end if;
  else
    raise exception '9. El banco no tiene un circuito en borrador de esa cuenta';
  end if;

  -- Un documento que se termina de firmar.
  select i.id into v_inst from instancia i join circuito c on c.id = i.circuito_id
   where c.cuenta_propietaria_id = '22222222-2222-2222-2222-222222222222'
     and i.estado <> 'firmada' limit 1;
  if v_inst is not null then
    -- ⚠ Hay máquina de estados: pendiente → en_curso → firmada. Saltear un paso
    -- la rechaza, y está bien que la rechace.
    update instancia set estado = 'en_curso' where id = v_inst and estado = 'pendiente';
    update instancia set estado = 'firmada' where id = v_inst;
    select count(*) into v_n from evento_medible where clave_idempotencia = 'documento:' || v_inst::text;
    if v_n <> 1 then
      raise exception '9. ⚠ Se terminó un documento y nadie lo midió (quedaron % líneas)', v_n;
    end if;
  end if;
end $solos$;

-- ═══ 10. Una línea medida no se corrige ni se borra ═════════════════════════
do $inmutable$
declare v_id uuid; v_ok boolean;
begin
  select id into v_id from evento_medible where tipo = 'sms' limit 1;

  v_ok := false;
  begin
    update evento_medible set precio_unitario = 1 where id = v_id;
  exception when others then v_ok := true; end;
  if not v_ok then raise exception '10. Se pudo cambiar el precio de una línea medida'; end if;

  v_ok := false;
  begin
    delete from evento_medible where id = v_id;
  exception when others then v_ok := true; end;
  if not v_ok then raise exception '10. Se pudo borrar una línea medida'; end if;
end $inmutable$;

-- ═══ 11. Lo que NO se cobra no puede bajar el saldo ════════════════════════
--
-- ⚠⚠ Este caso nació de un sabotaje que los diez primeros NO detectaban: quitarle
-- al wallet la condición de `cobrada` y dejar que descuente igual. El daño sería
-- silencioso y caro: a un cliente con tres firmas incluidas le bajaría el saldo
-- por las tres, y el sello del lote diario —que por decisión del 30/7 es costo
-- nuestro— también se lo comería.
-- ⚠ El tope se calcula sobre lo que YA hay medido del período, no con un número
-- fijo: el primer intento de este caso puso "2 incluidas" cuando el ejerce ya
-- había medido cuatro cosas de ese tipo más arriba, y la línea salía cobrada.
-- Un caso que depende de lo que hicieron los casos anteriores no prueba lo que
-- dice que prueba.
do $no_cobrada$
declare v_id uuid; v_mov int; v_ya numeric;
begin
  select coalesce(sum(cantidad), 0) into v_ya from evento_medible
   where cuenta_id = '22222222-2222-2222-2222-222222222222'
     and periodo = to_char(now(), 'YYYY-MM') and tipo = 'verificacion_identidad';

  update precio_metrica set cantidad_incluida = v_ya + 1
   where plan_id = 'e7900000-0000-0000-0000-0000000000f1' and metrica = 'identidad_digital';

  select app.medir('verificacion_identidad', '22222222-2222-2222-2222-222222222222',
                   'ej79:nocobrada', 1) into v_id;
  if v_id is null then raise exception '11. No se midió'; end if;
  if (select precio_unitario from evento_medible where id = v_id) is distinct from 4.0000 then
    raise exception '11. El precio no salió de la lista: %',
      (select precio_unitario from evento_medible where id = v_id);
  end if;
  if (select cobrada from evento_medible where id = v_id) is distinct from false then
    raise exception '11. La línea salió cobrada y estaba dentro de lo incluido';
  end if;

  select count(*) into v_mov from movimiento_saldo where evento_medible_id = v_id;
  if v_mov <> 0 then
    raise exception '11. ⚠⚠ Una línea NO cobrada movió el saldo % vez/veces: lo incluido en el plan se estaría cobrando igual', v_mov;
  end if;

  update precio_metrica set cantidad_incluida = 0
   where plan_id = 'e7900000-0000-0000-0000-0000000000f1' and metrica = 'identidad_digital';
end $no_cobrada$;

-- ═══ 12. Una firma avanzada sin proveedor no existe ═════════════════════════
--
-- ⚠ El otro sabotaje que los diez primeros no veían: quitar el check que ata el
-- nivel con el proveedor. Una firma avanzada sin proveedor es una firma avanzada
-- que nadie hizo, y se facturaría como avanzada.
--
-- ⚠ Y al revés también: una simple CON proveedor le generaría liquidación a un
-- socio que no firmó nada.
do $coherencia$
declare v_ok boolean;
begin
  v_ok := false;
  begin
    insert into evento_medible (cuenta_id, periodo, tipo, pais, moneda, nivel_firma, clave_idempotencia)
    values ('22222222-2222-2222-2222-222222222222', to_char(now(), 'YYYY-MM'), 'firma', 'UY', 'UYU',
            'avanzada', 'ej79:avanzada_sin_proveedor');
  exception when others then v_ok := true; end;
  if not v_ok then
    raise exception '12. ⚠⚠ Entró una firma avanzada sin proveedor: se facturaría como avanzada algo que nadie firmó';
  end if;

  v_ok := false;
  begin
    insert into evento_medible (cuenta_id, periodo, tipo, pais, moneda, nivel_firma, clave_idempotencia)
    values ('22222222-2222-2222-2222-222222222222', to_char(now(), 'YYYY-MM'), 'firma', 'UY', 'UYU',
            'firmada_sin_nivel', 'ej79:sin_nivel');
  exception when others then v_ok := true; end;
  if not v_ok then
    raise exception '12. Entró una firma con un nivel que no existe';
  end if;

  -- ⚠⚠⚠ Y el caso que parecía cubierto y NO lo estaba: una firma SIN nivel.
  --
  -- `medible_nivel_coherente` no lo atrapa, y la razón es la hermana de una
  -- lección que este proyecto ya tenía anotada para las funciones: con
  -- `nivel_firma` en NULL, la expresión entera da NULL — y **un CHECK que
  -- evalúa a NULL se considera CUMPLIDO**. O sea, el candado que parece cubrirlo
  -- lo deja pasar en silencio.
  --
  -- Medido el 14/9 quitando un check por vez: con `medible_firma_con_nivel` la
  -- fila se rechaza; sin él entra, aunque el otro siga puesto. Los dos checks NO
  -- son redundantes, y por eso este caso existe.
  v_ok := false;
  begin
    insert into evento_medible (cuenta_id, periodo, tipo, pais, moneda, clave_idempotencia)
    values ('22222222-2222-2222-2222-222222222222', to_char(now(), 'YYYY-MM'), 'firma', 'UY', 'UYU',
            'ej79:nivel_nulo');
  exception when others then v_ok := true; end;
  if not v_ok then
    raise exception '12. ⚠⚠ Entró una firma SIN nivel: no se puede cobrar ni contar contra un tope, y el check de coherencia no la ve porque da NULL';
  end if;

  -- Y un SMS sin nivel ni proveedor tiene que entrar sin problema: los checks
  -- son de las firmas, no de todo.
  if app.medir('sms', '22222222-2222-2222-2222-222222222222', 'ej79:sms_libre', 1) is null then
    raise exception '12. ⚠ Los checks de firma le cerraron la puerta a un SMS';
  end if;
end $coherencia$;

-- ═══ 13. Las dos puertas que llama el código ════════════════════════════════
--
-- ⚠⚠ `app.medir_ia` y `app.medir_sms` son lo que invocan `consumo_ia.ts` y
-- `twilio.ts`. El camino de TypeScript NO se puede ejercitar desde acá, y en el
-- caso de la IA tampoco en producción: el asistente todavía no existe como
-- producto (RUMBO R1). Así que se prueba la mitad que sí se puede — la función—
-- y la otra mitad queda declarada como no ejecutada, que es distinto de
-- declararla buena.
do $puertas$
declare v_id uuid; r record; v_vista record;
begin
  select app.medir_ia('22222222-2222-2222-2222-222222222222', 'claude-opus-5',
                      1200, 800, 0.031500, 'USD', 'ej79:ia:uno') into v_id;
  if v_id is null then raise exception '13. medir_ia no dejó línea'; end if;

  select * into r from evento_medible where id = v_id;
  if r.tipo is distinct from 'asistente_ia' then raise exception '13. Tipo %', r.tipo; end if;
  if r.cantidad is distinct from 2000::numeric then
    raise exception '13. La cantidad es % y son 1200 + 800 tokens', r.cantidad;
  end if;
  if r.unidad is distinct from 'token' then raise exception '13. Unidad %', r.unidad; end if;
  if (r.detalle ->> 'modelo') is distinct from 'claude-opus-5' then
    raise exception '13. El detalle perdió el modelo';
  end if;
  if (r.detalle ->> 'input_tokens')::bigint is distinct from 1200::bigint then
    raise exception '13. El detalle perdió los tokens de entrada';
  end if;

  -- ⚠ Y la ventana `consumo_ia` tiene que seguir devolviendo lo que devolvía la
  -- tabla: agregado por (cuenta, período, modelo). Es lo que leen la pantalla de
  -- Consumos, operador.ts y borrar_empresa.ts.
  perform app.medir_ia('22222222-2222-2222-2222-222222222222', 'claude-opus-5',
                       300, 100, 0.008000, 'USD', 'ej79:ia:dos');
  select * into v_vista from consumo_ia
   where cuenta_id = '22222222-2222-2222-2222-222222222222'
     and modelo = 'claude-opus-5' and periodo = to_char(now(), 'YYYY-MM');
  if v_vista.input_tokens is distinct from 1500::bigint then
    raise exception '13. ⚠⚠ La ventana de IA suma % tokens de entrada y son 1200 + 300: dejó de agregar', v_vista.input_tokens;
  end if;
  if v_vista.output_tokens is distinct from 900::bigint then
    raise exception '13. La ventana de IA suma % tokens de salida y son 800 + 100', v_vista.output_tokens;
  end if;

  -- Y el SMS por su puerta propia, con el mínimo de un segmento.
  select app.medir_sms('22222222-2222-2222-2222-222222222222', 0, 'UY', 'ej79:sms:cero') into v_id;
  if (select cantidad from evento_medible where id = v_id) is distinct from 1::numeric then
    raise exception '13. Un SMS de cero segmentos tiene que contar uno: se manda igual y se paga igual';
  end if;
end $puertas$;

do $listo$ begin
  raise notice '✓ 079: se mide todo lo que se consume, por una sola puerta, y la ventana de firmas sigue mostrando lo de siempre.';
end $listo$;

rollback;
