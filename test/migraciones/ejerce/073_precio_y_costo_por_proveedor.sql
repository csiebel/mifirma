-- =============================================================================
-- ejerce/073_precio_y_costo_por_proveedor.sql
--
-- Cuatro cosas, y las dos primeras son plata:
--
--   1. Que el precio del PROVEEDOR gane sobre el general, y que el general siga
--      valiendo cuando no hay uno específico. Si esto se invierte, se le cobra
--      de menos (o de más) a todos los que firman con el proveedor caro.
--   2. Que el modelo económico no pueda quedar a medias: un revenue share sin
--      porcentaje no se puede liquidar, y un porcentaje colgado de un modelo
--      que no lo usa es un número que alguien va a leer mal.
--   3. Que la línea facturable sea INMUTABLE de verdad — salvo la marca de
--      liquidación, que es lo único que pasa después.
--   4. Que la escriba el sistema y no la cuenta, ni el operador.
--
-- Todo con `is distinct from` (nota de método del ejerce 070).
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas. Falta la marca banco_de_pruebas.';
  end if;
end $cinturon$;

begin;

-- ── 0. El escenario ──────────────────────────────────────────────────────────
--
-- Dos proveedores en PY: uno que nos cobra, otro con revenue share. Y un plan
-- con precio general y precio propio para el caro.
insert into proveedor_firma (id, codigo, nombre_mostrado, activo_global, entorno, endpoints, parametros)
values ('aaaa0073-0000-0000-0000-00000000000a', 'ej73_cobra', 'Nos cobra', true, 'integracion', '{}'::jsonb, '{}'::jsonb),
       ('aaaa0073-0000-0000-0000-00000000000b', 'ej73_share', 'Revenue share', true, 'integracion', '{}'::jsonb, '{}'::jsonb);
insert into proveedor_capacidad (proveedor_id, firma_hash, identifica_titular, formatos_devueltos)
values ('aaaa0073-0000-0000-0000-00000000000a', true, true, '{pkcs7}'),
       ('aaaa0073-0000-0000-0000-00000000000b', true, true, '{pkcs7}');

insert into plan (id, codigo, nombre_i18n)
values ('aaaa0073-0000-0000-0000-000000000001', 'ej73_plan', '{"es":"Plan 73"}'::jsonb);

-- ═══ 1. El modelo económico ═════════════════════════════════════════════════
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;

do $modelo$
declare v_ok boolean;
begin
  -- El que nos cobra: costo, sin porcentaje.
  insert into proveedor_pais (proveedor_id, pais, capacidades, niveles, modelo_economico, costo_por_firma, moneda_costo)
  values ('aaaa0073-0000-0000-0000-00000000000a', 'PY', '{firma}', '{avanzada}', 'costo', 12.0000, 'USD');

  -- El del revenue share: porcentaje, y NADA de costo.
  insert into proveedor_pais (proveedor_id, pais, capacidades, niveles, modelo_economico, revenue_share_pct)
  values ('aaaa0073-0000-0000-0000-00000000000b', 'PY', '{firma}', '{avanzada}', 'revenue_share', 30.000);

  -- ⚠ Un revenue share SIN porcentaje no se puede liquidar: no entra.
  begin
    update proveedor_pais set revenue_share_pct = null
     where proveedor_id = 'aaaa0073-0000-0000-0000-00000000000b';
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '1. Entró un revenue share sin porcentaje'; end if;

  -- Ni un revenue share que ADEMÁS nos cobre: o reparte o cobra.
  begin
    update proveedor_pais set costo_por_firma = 5
     where proveedor_id = 'aaaa0073-0000-0000-0000-00000000000b';
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '1. Un revenue share pudo tener costo además'; end if;

  -- Ni un porcentaje colgado de un modelo que no lo usa.
  begin
    update proveedor_pais set revenue_share_pct = 10
     where proveedor_id = 'aaaa0073-0000-0000-0000-00000000000a';
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '1. Un modelo «costo» pudo llevar porcentaje'; end if;

  -- Y un porcentaje fuera de 0..100 no es un porcentaje.
  begin
    update proveedor_pais set revenue_share_pct = 140
     where proveedor_id = 'aaaa0073-0000-0000-0000-00000000000b';
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '1. Entró un revenue share del 140%%'; end if;
end $modelo$;

-- ═══ 2. El precio: el del proveedor gana ════════════════════════════════════
insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, precio_unitario, cantidad_incluida)
values ('aaaa0073-0000-0000-0000-000000000001', 'PY', 'USD', 'firma', 'avanzada', 20.0000, 100);
-- El caro tiene el suyo.
insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, precio_unitario, cantidad_incluida, proveedor_id)
values ('aaaa0073-0000-0000-0000-000000000001', 'PY', 'USD', 'firma', 'avanzada', 35.0000, 0,
        'aaaa0073-0000-0000-0000-00000000000a');
-- Y la firma simple, sin proveedor: cifra incluida y precio después.
insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, precio_unitario, cantidad_incluida)
values ('aaaa0073-0000-0000-0000-000000000001', 'PY', 'USD', 'firma', 'simple', 0.5000, 500);

reset role;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

do $precio$
declare r record;
begin
  -- Con el proveedor que tiene precio propio: gana el suyo.
  select * into r from app.precio_de_firma('aaaa0073-0000-0000-0000-000000000001','PY','USD','avanzada',
                                           'aaaa0073-0000-0000-0000-00000000000a');
  if r.precio_unitario is distinct from 35.0000 then
    raise exception '2. Con el proveedor caro salió % y su precio propio es 35 — ¿ganó el general?', r.precio_unitario;
  end if;
  if r.por_proveedor is distinct from true then raise exception '2. No se marcó que el precio era del proveedor'; end if;

  -- Con el otro, que no tiene precio propio: vale el general, con sus 100 incluidas.
  select * into r from app.precio_de_firma('aaaa0073-0000-0000-0000-000000000001','PY','USD','avanzada',
                                           'aaaa0073-0000-0000-0000-00000000000b');
  if r.precio_unitario is distinct from 20.0000 then
    raise exception '2. Sin precio propio salió % y el general es 20', r.precio_unitario;
  end if;
  if r.cantidad_incluida is distinct from 100.0000 then
    raise exception '2. La cantidad incluida vino % y es 100', r.cantidad_incluida;
  end if;
  if r.por_proveedor is distinct from false then raise exception '2. Se marcó como del proveedor un precio general'; end if;

  -- La firma simple no tiene proveedor.
  select * into r from app.precio_de_firma('aaaa0073-0000-0000-0000-000000000001','PY','USD','simple', null);
  if r.precio_unitario is distinct from 0.5000 then raise exception '2. Simple salió %', r.precio_unitario; end if;
  if r.cantidad_incluida is distinct from 500.0000 then raise exception '2. Simple incluidas: %', r.cantidad_incluida; end if;
end $precio$;

-- 2b. Y dos proveedores distintos pueden tener precio a la vez: es lo que el
--     índice único de la 019 no permitía.
reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
do $dos$
declare v_ok boolean;
begin
  insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, precio_unitario, proveedor_id)
  values ('aaaa0073-0000-0000-0000-000000000001', 'PY', 'USD', 'firma', 'avanzada', 28.0000,
          'aaaa0073-0000-0000-0000-00000000000b');

  -- Pero el mismo proveedor dos veces sigue sin poder.
  begin
    insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, precio_unitario, proveedor_id)
    values ('aaaa0073-0000-0000-0000-000000000001', 'PY', 'USD', 'firma', 'avanzada', 99.0000,
            'aaaa0073-0000-0000-0000-00000000000b');
    v_ok := true;
  exception when unique_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '2b. Se cargaron dos precios vigentes para el mismo proveedor'; end if;
end $dos$;

-- ═══ 3. La línea facturable ═════════════════════════════════════════════════
--
-- ⚠ Las participaciones del fixture tienen id generado, así que se buscan por
-- su identidad en vez de escribir un uuid a mano: un uuid inventado sólo prueba
-- que la clave foránea existe.
reset role;
set role app_rw;
do $ctx$ begin perform set_config('app.actor', 'sistema', true); end $ctx$;

do $linea$
declare v_ok boolean; v_id uuid; v_p1 uuid; v_p2 uuid; v_inst uuid;
begin
  select id, instancia_id into v_p1, v_inst from participacion
   where papel = 'firmante' order by creada_en limit 1;
  select id into v_p2 from participacion
   where papel = 'firmante' and id <> v_p1 order by creada_en limit 1;
  if v_p1 is null or v_p2 is null then raise exception '3. El fixture no tiene dos participaciones'; end if;
  -- Una firma avanzada con el proveedor de revenue share: se le deben 30% de 20.
  insert into firma_facturable (participacion_id, instancia_id, cuenta_id, periodo, pais, nivel_firma,
                                proveedor_id, plan_id, moneda, precio_unitario, cobrada,
                                modelo_economico, a_liquidar)
  values (v_p1, v_inst,
          '22222222-2222-2222-2222-222222222222', '2026-09', 'PY', 'avanzada',
          'aaaa0073-0000-0000-0000-00000000000b', 'aaaa0073-0000-0000-0000-000000000001',
          'USD', 20.0000, true, 'revenue_share', 6.0000)
  returning id into v_id;

  -- ⚠ Una firma avanzada SIN proveedor sería una firma que nadie hizo.
  begin
    insert into firma_facturable (participacion_id, instancia_id, cuenta_id, periodo, pais, nivel_firma,
                                  plan_id, moneda, precio_unitario, modelo_economico)
    values (v_p2, v_inst,
            '22222222-2222-2222-2222-222222222222', '2026-09', 'PY', 'avanzada',
            'aaaa0073-0000-0000-0000-000000000001', 'USD', 20, 'sin_costo');
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3. Entró una firma avanzada sin proveedor'; end if;

  -- Ni un revenue share sin decir cuánto se le debe.
  begin
    insert into firma_facturable (participacion_id, instancia_id, cuenta_id, periodo, pais, nivel_firma,
                                  proveedor_id, plan_id, moneda, precio_unitario, modelo_economico)
    values (v_p2, v_inst,
            '22222222-2222-2222-2222-222222222222', '2026-09', 'PY', 'avanzada',
            'aaaa0073-0000-0000-0000-00000000000b', 'aaaa0073-0000-0000-0000-000000000001',
            'USD', 20, 'revenue_share');
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3. Entró un revenue share sin a_liquidar'; end if;

  -- Y la misma firma no se factura dos veces.
  begin
    insert into firma_facturable (participacion_id, instancia_id, cuenta_id, periodo, pais, nivel_firma,
                                  proveedor_id, plan_id, moneda, precio_unitario, modelo_economico, a_liquidar)
    values (v_p1, v_inst,
            '22222222-2222-2222-2222-222222222222', '2026-09', 'PY', 'avanzada',
            'aaaa0073-0000-0000-0000-00000000000b', 'aaaa0073-0000-0000-0000-000000000001',
            'USD', 20, 'revenue_share', 6);
    v_ok := true;
  exception when unique_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3. La misma firma se facturó dos veces'; end if;

  -- ⚠⚠ Inmutable: el precio no se corrige.
  begin
    update firma_facturable set precio_unitario = 1 where id = v_id;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3. ⚠ Se pudo cambiar el precio de una línea ya emitida'; end if;

  -- Ni se borra. ⚠ Dos cinturones y gana el de afuera: `app_rw` no tiene GRANT
  -- de delete, así que ni llega al trigger. Se aceptan los dos errores a
  -- propósito — el trigger sigue siendo la red del día que alguien dé el grant.
  begin
    delete from firma_facturable where id = v_id;
    v_ok := true;
  exception when check_violation or insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3. ⚠ Se pudo borrar una línea facturable'; end if;

  -- Pero SÍ se marca la liquidación: es lo único que pasa después.
  begin
    update firma_facturable set liquidacion_id = gen_random_uuid() where id = v_id;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from true then
    raise exception '3. ⚠⚠ No se pudo marcar la liquidación — la línea quedaría impagable';
  end if;
end $linea$;

-- ═══ 4. Quién escribe esto ══════════════════════════════════════════════════
do $quien$
declare v_ok boolean; v_p2 uuid; v_inst uuid;
begin
  select id, instancia_id into v_p2, v_inst from participacion where papel = 'firmante' order by creada_en desc limit 1;
  -- La cuenta no se escribe su propia línea facturable: sería escribirse el precio.
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
  begin
    insert into firma_facturable (participacion_id, instancia_id, cuenta_id, periodo, pais, nivel_firma,
                                  plan_id, moneda, precio_unitario, modelo_economico)
    values (v_p2, v_inst,
            '22222222-2222-2222-2222-222222222222', '2026-09', 'PY', 'simple',
            'aaaa0073-0000-0000-0000-000000000001', 'USD', 0.5, 'sin_costo');
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then raise exception '4. Una cuenta pudo escribir su propia línea facturable'; end if;
end $quien$;

-- Y el operador tampoco: él parametriza, no factura.
-- ⚠ El operador no tiene grant sobre `participacion` —y está bien: no es su
-- tabla—, así que el id se deja anotado antes, como superusuario.
reset role;
create temporary table ej73_ids as
  select id as participacion_id, instancia_id from participacion
   where papel = 'firmante' order by creada_en desc limit 1;
grant select on ej73_ids to app_operador;

set role app_operador;
do $op$
declare v_ok boolean; v_p2 uuid; v_inst uuid;
begin
  select participacion_id, instancia_id into v_p2, v_inst from ej73_ids;
  perform set_config('app.actor', 'operador', true);
  begin
    insert into firma_facturable (participacion_id, instancia_id, cuenta_id, periodo, pais, nivel_firma,
                                  plan_id, moneda, precio_unitario, modelo_economico)
    values (v_p2, v_inst,
            '22222222-2222-2222-2222-222222222222', '2026-09', 'PY', 'simple',
            'aaaa0073-0000-0000-0000-000000000001', 'USD', 0.5, 'sin_costo');
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then raise exception '4. El operador pudo escribir una línea facturable'; end if;
  -- Pero las lee: son las suyas para cobrar y para liquidar.
  perform 1 from firma_facturable limit 1;
end $op$;

reset role;
rollback;
