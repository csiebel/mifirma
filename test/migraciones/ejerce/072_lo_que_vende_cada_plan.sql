-- =============================================================================
-- ejerce/072_lo_que_vende_cada_plan.sql
--
-- ═══ LO QUE HAY QUE PROBAR, Y POR QUÉ ═══
--
-- Cuatro cosas, y la primera es la que puede dejar a un firmante sin poder
-- firmar si está mal:
--
--   1. Que el filtro de proveedores del plan FILTRE, y que MANDE — también
--      sobre la exclusividad (decisión de Claudio del 7/9 de noche). Y que la
--      consecuencia quede escrita en una prueba: en un país con acuerdo, un
--      plan que no liste al socio se queda sin proveedores ahí.
--   2. Que NINGÚN PLAN pueda quedar sin forma de firmar, y que la tranca sea
--      DIFERIDA — si saltara en el estado intermedio, la consola no podría
--      cambiar la firma simple por la avanzada en un solo guardado.
--   3. Que la firma simple quede incluida en todos los planes que ya existían.
--   4. Que la custodia devuelva SIEMPRE una fila, y que sin plan diga «guarda».
--   5. Que app_rw no pueda escribir ni los proveedores del plan ni la custodia.
--
-- Todo con `is distinct from` (nota de método del ejerce 070: en SQL una
-- comparación con NULL no es falsa, es NULL, y un `if NULL then` no entra —
-- una función rota que devuelva NULL pasaría todas las pruebas escritas al
-- revés).
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas. Falta la marca banco_de_pruebas.';
  end if;
end $cinturon$;

begin;

-- ── 0. El escenario, como superusuario ───────────────────────────────────────
--
-- Tres proveedores encendidos y habilitados en UY para 'firma': el socio de un
-- acuerdo, uno que el plan lista, y uno que el plan NO lista. Con eso se puede
-- distinguir «filtra» de «no filtra» y de «filtra de más».
insert into proveedor_firma (id, codigo, nombre_mostrado, activo_global, entorno, endpoints, parametros)
values ('aaaa0072-0000-0000-0000-00000000000a', 'ej72_socio', 'Socio del acuerdo', true, 'integracion', '{}'::jsonb, '{}'::jsonb),
       ('aaaa0072-0000-0000-0000-00000000000b', 'ej72_listado', 'Listado por el plan', true, 'integracion', '{}'::jsonb, '{}'::jsonb),
       ('aaaa0072-0000-0000-0000-00000000000c', 'ej72_fuera', 'Fuera del plan', true, 'integracion', '{}'::jsonb, '{}'::jsonb);

insert into proveedor_capacidad (proveedor_id, firma_hash, identifica_titular, formatos_devueltos)
values ('aaaa0072-0000-0000-0000-00000000000a', true, true, '{pkcs7}'),
       ('aaaa0072-0000-0000-0000-00000000000b', true, true, '{pkcs7}'),
       ('aaaa0072-0000-0000-0000-00000000000c', true, true, '{pkcs7}');

insert into proveedor_pais (proveedor_id, pais, capacidades, niveles)
values ('aaaa0072-0000-0000-0000-00000000000a', 'PY', '{firma,identidad}', '{avanzada}'),
       ('aaaa0072-0000-0000-0000-00000000000b', 'PY', '{firma,identidad}', '{avanzada}'),
       ('aaaa0072-0000-0000-0000-00000000000c', 'PY', '{firma,identidad}', '{avanzada}');

insert into plan (id, codigo, nombre_i18n) values
  ('aaaa0072-0000-0000-0000-000000000001', 'ej72_abierto', '{"es":"Abierto"}'::jsonb),
  ('aaaa0072-0000-0000-0000-000000000002', 'ej72_cerrado', '{"es":"Cerrado"}'::jsonb);

-- El plan cerrado vende sólo uno de los tres.
update plan set proveedores_modo = 'lista' where id = 'aaaa0072-0000-0000-0000-000000000002';
insert into plan_proveedor (plan_id, proveedor_id)
values ('aaaa0072-0000-0000-0000-000000000002', 'aaaa0072-0000-0000-0000-00000000000b');

insert into suscripcion (id, cuenta_id, plan_id, moneda)
values ('aaaa0072-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222',
        'aaaa0072-0000-0000-0000-000000000002', 'UYU');

-- ═══ 1. Los proveedores del plan ════════════════════════════════════════════
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('app.identidad_id', '11111111-1111-1111-1111-111111111111', true);
end $ctx$;

-- 1a. Sin acuerdo todavía: «todos» ve tres, «lista» ve uno.
do $filtra$
declare v_n int; v_cod text;
begin
  select count(*) into v_n from app.proveedores_del_plan('aaaa0072-0000-0000-0000-000000000001','PY','firma');
  if v_n is distinct from 3 then raise exception '1a. El plan abierto ve % proveedores y hay 3', v_n; end if;

  select count(*) into v_n from app.proveedores_del_plan('aaaa0072-0000-0000-0000-000000000002','PY','firma');
  if v_n is distinct from 1 then raise exception '1a. El plan cerrado ve % proveedores y lista 1', v_n; end if;

  select codigo into v_cod from app.proveedores_del_plan('aaaa0072-0000-0000-0000-000000000002','PY','firma');
  if v_cod is distinct from 'ej72_listado' then raise exception '1a. El plan cerrado ve «%» y lista otro', v_cod; end if;

  -- Un plan que no existe se trata como «todos»: nadie se queda sin firmar
  -- porque falte una fila.
  select count(*) into v_n from app.proveedores_del_plan(null,'PY','firma');
  if v_n is distinct from 3 then raise exception '1a. Sin plan se ven % y tendrían que verse los 3', v_n; end if;
end $filtra$;

-- 1b. ⚠⚠ Con acuerdo de exclusividad, el filtro del plan SIGUE MANDANDO.
--     `proveedores_habilitados` ya dejó sólo al socio; si el plan no lo lista,
--     el plan se queda sin nada en ese país. Es la decisión del 7/9 de noche, y
--     se prueba para que nadie la «arregle» sin querer.
reset role;
insert into acuerdo_exclusividad (pais, proveedor_id, socio_nombre, vigente_desde, capacidades)
values ('PY', 'aaaa0072-0000-0000-0000-00000000000a', 'Socio', current_date - 1, '{firma}');

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

do $excl$
declare v_n int; r record;
begin
  -- El plan cerrado lista a `ej72_listado`, al que la exclusividad ya sacó.
  -- Resultado: cero. Es lo esperado, no un defecto.
  select count(*) into v_n from app.proveedores_del_plan('aaaa0072-0000-0000-0000-000000000002','PY','firma');
  if v_n is distinct from 0 then
    raise exception '1b. El plan cerrado ve % en un país con acuerdo que no lo incluye — el filtro del plan tiene que mandar', v_n;
  end if;

  -- El plan abierto ve al socio y sólo al socio, y viene marcado.
  select count(*) into v_n from app.proveedores_del_plan('aaaa0072-0000-0000-0000-000000000001','PY','firma');
  if v_n is distinct from 1 then raise exception '1b. Con acuerdo, el plan abierto ve % proveedores', v_n; end if;
  select * into r from app.proveedores_del_plan('aaaa0072-0000-0000-0000-000000000001','PY','firma');
  if r.codigo is distinct from 'ej72_socio' then raise exception '1b. El plan abierto ve «%» y no al socio', r.codigo; end if;
  if r.por_exclusividad is distinct from true then
    raise exception '1b. El socio no viene marcado como por_exclusividad — la consola no podría explicar por qué no hay otros';
  end if;

  -- La capacidad importa: el acuerdo es sólo de 'firma'. En 'identidad' no hay
  -- exclusividad y vuelve a verse lo que el plan lista.
  select count(*) into v_n from app.proveedores_del_plan('aaaa0072-0000-0000-0000-000000000002','PY','identidad');
  if v_n is distinct from 1 then raise exception '1b. En identidad el plan cerrado ve %', v_n; end if;
  select * into r from app.proveedores_del_plan('aaaa0072-0000-0000-0000-000000000002','PY','identidad');
  if r.codigo is distinct from 'ej72_listado' then
    raise exception '1b. En identidad (sin acuerdo) tendría que mandar el plan, y vino «%»', r.codigo;
  end if;
  if r.por_exclusividad is distinct from false then
    raise exception '1b. Sin acuerdo para esa capacidad, por_exclusividad tendría que ser false';
  end if;
end $excl$;

-- 1c. Por cuenta: sale de su suscripción activa.
do $cuenta$
declare v_cod text; v_n int;
begin
  select codigo into v_cod from app.proveedores_de_cuenta('22222222-2222-2222-2222-222222222222','PY','identidad');
  if v_cod is distinct from 'ej72_listado' then
    raise exception '1c. Por cuenta se resolvió «%» y su plan lista otro', v_cod;
  end if;
  -- Una cuenta sin suscripción no se queda sin proveedores.
  select count(*) into v_n from app.proveedores_de_cuenta('99999999-9999-9999-9999-999999999999','PY','identidad');
  if v_n is distinct from 3 then raise exception '1c. Cuenta sin suscripción ve % y tendría que ver 3', v_n; end if;
end $cuenta$;

-- ═══ 1d. LA TRANCA: ningún plan sin forma de firmar ════════════════════════
reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;

-- ⚠⚠ NOTA DE MÉTODO: CÓMO SE PRUEBA UN TRIGGER DIFERIDO
--
-- Un `constraint trigger ... deferrable initially deferred` no se dispara al
-- hacer el update: se dispara al COMMIT. Y el bloque `begin/exception` de
-- PL/pgSQL es un savepoint, no un commit — así que la primera versión de esta
-- prueba daba «se pudo dejar un plan sin firma» con la tranca funcionando
-- perfectamente. El error era de la prueba, no de la migración.
--
-- La forma de forzar la comprobación en el momento es `set constraints all
-- immediate`. Y sirve para las dos mitades: con él se prueba que la tranca
-- TRANCA, y sin él —volviendo a `deferred`— se prueba que el estado intermedio
-- inválido NO molesta, que es lo que la consola necesita para cambiar la firma
-- simple por la avanzada en un solo guardado.
do $tranca$
declare v_ok boolean;
begin
  -- (a) Dejar un plan sin ninguna forma de firmar: no se puede.
  begin
    update plan_prestacion set incluida = false
     where plan_id = 'aaaa0072-0000-0000-0000-000000000001' and prestacion = 'firma_simple';
    set constraints all immediate;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then
    raise exception '1d(a). ⚠ Se pudo dejar un plan sin ninguna forma de firmar';
  end if;

  -- (b) Pero apagar la simple y encender la avanzada EN EL MISMO guardado sí:
  --     es el plan «sólo firma avanzada» que Claudio pidió. Si la tranca no
  --     fuera diferida, el primer update de los dos ya habría saltado.
  set constraints all deferred;
  begin
    update plan_prestacion set incluida = false
     where plan_id = 'aaaa0072-0000-0000-0000-000000000001' and prestacion = 'firma_simple';
    insert into plan_prestacion (plan_id, prestacion, incluida)
    values ('aaaa0072-0000-0000-0000-000000000001', 'firma_avanzada', true)
    on conflict (plan_id, prestacion) do update set incluida = true;
    set constraints all immediate;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from true then
    raise exception '1d(b). ⚠⚠ No se pudo armar un plan de SÓLO firma avanzada — la tranca no es diferida';
  end if;

  -- (c) Avanzada sin ningún proveedor no cuenta como forma de firmar.
  set constraints all deferred;
  begin
    update plan set proveedores_modo = 'lista' where id = 'aaaa0072-0000-0000-0000-000000000001';
    set constraints all immediate;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then
    raise exception '1d(c). ⚠ «Avanzada» sin ningún proveedor pasó como forma de firmar';
  end if;

  -- (d) El dispositivo propio alcanza solo, sin proveedores en la nube.
  set constraints all deferred;
  begin
    insert into plan_prestacion (plan_id, prestacion, incluida)
    values ('aaaa0072-0000-0000-0000-000000000001', 'dispositivo_propio', true)
    on conflict (plan_id, prestacion) do update set incluida = true;
    update plan set proveedores_modo = 'lista' where id = 'aaaa0072-0000-0000-0000-000000000001';
    set constraints all immediate;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from true then
    raise exception '1d(d). El dispositivo propio tendría que alcanzar como forma de firmar';
  end if;

  -- Se deja el plan como estaba, para no ensuciar lo que sigue.
  set constraints all deferred;
  update plan set proveedores_modo = 'todos' where id = 'aaaa0072-0000-0000-0000-000000000001';
  update plan_prestacion set incluida = true
   where plan_id = 'aaaa0072-0000-0000-0000-000000000001' and prestacion = 'firma_simple';
  update plan_prestacion set incluida = false
   where plan_id = 'aaaa0072-0000-0000-0000-000000000001' and prestacion in ('firma_avanzada','dispositivo_propio');
  set constraints all immediate;
end $tranca$;

-- ═══ 2. La firma simple y la custodia, sembradas ════════════════════════════
do $siembra$
declare v_n int;
begin
  select count(*) into v_n from plan p
   where not exists (select 1 from plan_prestacion x
                      where x.plan_id = p.id and x.prestacion = 'firma_simple' and x.incluida);
  if v_n is distinct from 0 then raise exception '2. % plan(es) quedaron sin firma_simple incluida', v_n; end if;

  select count(*) into v_n from plan p
   where not exists (select 1 from plan_custodia c where c.plan_id = p.id);
  if v_n is distinct from 0 then raise exception '2. % plan(es) quedaron sin custodia', v_n; end if;

  -- Y las prestaciones nuevas son válidas para el check.
  select count(*) into v_n from unnest(app.prestaciones_conocidas()) x
   where x in ('firma_simple','custodia');
  if v_n is distinct from 2 then raise exception '2. Las prestaciones nuevas no están en la lista cerrada'; end if;
end $siembra$;

-- ═══ 3. La custodia ═════════════════════════════════════════════════════════

-- 3a. Los topes incoherentes no entran.
reset role;
do $topes$
declare v_ok boolean;
begin
  begin
    insert into plan_custodia (plan_id, modo, tope_documentos)
    values ('aaaa0072-0000-0000-0000-000000000001', 'sin_tope', 100)
    on conflict (plan_id) do update set modo = 'sin_tope', tope_documentos = 100;
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3a. Entró un tope con modo «sin_tope»'; end if;

  begin
    update plan_custodia set modo = 'con_tope', tope_documentos = null, tope_bytes = null
     where plan_id = 'aaaa0072-0000-0000-0000-000000000001';
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3a. Entró «con_tope» sin ningún tope'; end if;
end $topes$;

-- 3b. El plan del ejercicio guarda 50 documentos y borra a los 30 días; la copia
--     del firmante vive 90 — que es un derecho suyo y no muere con el plan.
update plan_custodia
   set modo = 'con_tope', tope_documentos = 50, tope_bytes = null,
       dias_emisor = 30, dias_firmante = 90
 where plan_id = 'aaaa0072-0000-0000-0000-000000000002';

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

do $cust$
declare r record;
begin
  select * into r from app.custodia_de_cuenta('22222222-2222-2222-2222-222222222222');
  if r.modo is distinct from 'con_tope' then raise exception '3b. modo = %', r.modo; end if;
  if r.tope_documentos is distinct from 50 then raise exception '3b. tope = %', r.tope_documentos; end if;
  if r.dias_emisor is distinct from 30 then raise exception '3b. dias_emisor = %', r.dias_emisor; end if;
  if r.dias_firmante is distinct from 90 then raise exception '3b. dias_firmante = %', r.dias_firmante; end if;
  if r.origen is distinct from 'plan' then raise exception '3b. origen = %', r.origen; end if;

  -- ⚠ Sin suscripción devuelve fila igual, y del lado seguro: guarda todo.
  select * into r from app.custodia_de_cuenta('99999999-9999-9999-9999-999999999999');
  if r.modo is distinct from 'sin_tope' then
    raise exception '3b. Una cuenta sin plan tendría que guardar todo, y dio «%»', r.modo;
  end if;
  if r.origen is distinct from 'sin_suscripcion' then raise exception '3b. origen sin plan = %', r.origen; end if;
end $cust$;

-- 3c. Lo usado cuenta el base y el firmado, no la evidencia: la evidencia no se
--     puede dejar de guardar, así que no ocupa cupo del cliente.
reset role;
insert into archivo (id, sha256, bytes, mime, clase, cuenta_custodia_id, region, clave_almacenamiento)
values ('aaaa0072-1111-0000-0000-000000000001', '\x01'::bytea, 1000, 'application/pdf', 'firmado',
        '22222222-2222-2222-2222-222222222222', 'local', 'ej72/firmado.pdf'),
       ('aaaa0072-1111-0000-0000-000000000002', '\x02'::bytea, 5000, 'application/pdf', 'evidencia',
        '22222222-2222-2222-2222-222222222222', 'local', 'ej72/evidencia.pdf');

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

do $usada$
declare r record;
begin
  select * into r from app.custodia_usada('22222222-2222-2222-2222-222222222222');
  -- El fixture trae un 'base' (1 byte) y acá se agregó un 'firmado' de 1000.
  -- La evidencia de 5000 NO tiene que contarse.
  if r.bytes is distinct from 1001::bigint then
    raise exception '3c. bytes = % — ¿se coló la evidencia (5000) o falta el base?', r.bytes;
  end if;
  if r.documentos is distinct from 2::bigint then raise exception '3c. documentos = %', r.documentos; end if;
end $usada$;

-- ═══ 4. Los precios ═════════════════════════════════════════════════════════
reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;

do $precios$
declare v_ok boolean;
begin
  -- 500 firmas simples incluidas y después $0,50: dos números, una fila.
  insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, precio_unitario, cantidad_incluida)
  values ('aaaa0072-0000-0000-0000-000000000002', 'UY', 'UYU', 'firma', 'simple', 0.5, 500);

  insert into precio_metrica (plan_id, pais, moneda, metrica, precio_unitario, cantidad_incluida)
  values ('aaaa0072-0000-0000-0000-000000000002', 'UY', 'UYU', 'almacenamiento', 1.2, 10);

  begin
    insert into precio_metrica (plan_id, pais, moneda, metrica, precio_unitario, cantidad_incluida)
    values ('aaaa0072-0000-0000-0000-000000000002', 'UY', 'UYU', 'documento', 1, -5);
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '4. Entró una cantidad incluida negativa'; end if;

  -- Y el check viejo de la 019 sigue en pie.
  begin
    insert into precio_metrica (plan_id, pais, moneda, metrica, precio_unitario, nivel_firma)
    values ('aaaa0072-0000-0000-0000-000000000002', 'UY', 'UYU', 'abono', 1, 'avanzada');
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '4. El check del abono sin nivel (019) se perdió'; end if;
end $precios$;

-- ═══ 5. Quién puede escribir esto ═══════════════════════════════════════════
reset role;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

do $rls$
declare v_ok boolean;
begin
  -- Una cuenta no se agrega proveedores a su plan.
  begin
    insert into plan_proveedor (plan_id, proveedor_id)
    values ('aaaa0072-0000-0000-0000-000000000002', 'aaaa0072-0000-0000-0000-00000000000c');
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then raise exception '5. app_rw pudo escribir plan_proveedor'; end if;

  -- Ni se cambia su propia custodia.
  begin
    update plan_custodia set modo = 'sin_tope', tope_documentos = null
     where plan_id = 'aaaa0072-0000-0000-0000-000000000002';
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then raise exception '5. app_rw pudo cambiar la custodia de su plan'; end if;

  -- Pero los lee: la pantalla tiene que poder decir qué trae el plan.
  perform 1 from plan_proveedor limit 1;
  perform 1 from plan_custodia limit 1;
end $rls$;

reset role;
rollback;
