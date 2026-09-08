-- =============================================================================
-- ejerce/076_el_medidor.sql
--
-- Lo que hay que probar, y todo es plata o es una firma:
--
--   1. Que una firma sin plan se MIDA IGUAL (precio 0, sin cobrar): el hecho de
--      que hubo una firma es lo que no se puede perder.
--   2. Que con plan y precio se cobre lo que dice la lista.
--   3. Que las incluidas del mes no se cobren, y la siguiente sí.
--   4. Que un proveedor con revenue share deje su `a_liquidar`, y que una firma
--      NO cobrada no le genere participación.
--   5. Que medir dos veces la misma firma no la cobre dos veces.
--   6. ⚠⚠ Que el medidor NUNCA lance: una firma no se pierde porque no se haya
--      podido medir.
--   7. Que el operador no pueda escribir líneas facturables.
--
-- ═══ NOTA DE MÉTODO ═══
--
-- ⚠ Bajo `app_rw` con actor 'cuenta' NO se pueden LEER las líneas escritas: la
-- policy de `firma_facturable` (073) pide la capacidad 'facturacion/leer', que la
-- cuenta de prueba no tiene. El primer intento de este ejerce comprobaba leyendo
-- como app_rw: no veía nada, todos los campos daban NULL, y `is distinct from`
-- lo delató en el primer caso. Un ejerce que lee con el rol equivocado se
-- engaña solo.
--
-- Así que el medidor corre como `app_rw` (que es quien lo va a llamar de verdad)
-- y las comprobaciones se hacen con el rol dueño. El id de cada línea viaja
-- entre los dos por una tabla temporal.
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

-- ── 0. Un plan, su precio, y un proveedor con revenue share ─────────────────
insert into plan (id, codigo, nombre_i18n) values
  ('e7600000-0000-0000-0000-0000000000f1', 'ej76_plan', '{"es":"Plan del ejerce 76"}'::jsonb)
on conflict do nothing;

insert into proveedor_firma (id, codigo, nombre_mostrado, activo_global, entorno, endpoints, parametros)
values ('e7600000-0000-0000-0000-00000000000a', 'ej76_share', 'Socio 76', true, 'integracion', '{}'::jsonb, '{}'::jsonb)
on conflict do nothing;
insert into proveedor_capacidad (proveedor_id, firma_hash, identifica_titular, formatos_devueltos)
values ('e7600000-0000-0000-0000-00000000000a', true, true, '{pkcs7}') on conflict do nothing;
insert into proveedor_pais (proveedor_id, pais, capacidades, niveles, modelo_economico, revenue_share_pct)
values ('e7600000-0000-0000-0000-00000000000a', 'UY', '{firma}', '{avanzada}', 'revenue_share', 30.000)
on conflict do nothing;

-- Las participaciones firmables del banco, numeradas para tomarlas de a una.
create temporary table firmas_76 as
  select row_number() over (order by p.creada_en, p.id) as n, p.id
    from participacion p where p.papel = 'firmante';
grant select on firmas_76 to app_rw, app_operador;

-- Por dónde viaja el id de cada línea desde app_rw hasta las comprobaciones.
create temporary table medido_76 (caso text primary key, id uuid);
grant select, insert, delete on medido_76 to app_rw, app_operador;

do $hay$
declare v_n int;
begin
  select count(*) into v_n from firmas_76;
  if v_n < 5 then raise exception '0. El banco tiene % participaciones firmables y hacen falta 5', v_n; end if;
end $hay$;

-- ═══ 1. Sin plan se mide igual ══════════════════════════════════════════════
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
insert into medido_76 (caso, id)
select 'sin_plan', app.medir_firma((select id from firmas_76 where n = 1), 'simple', null);

reset role;
do $sinplan$
declare r record; v_id uuid;
begin
  select id into v_id from medido_76 where caso = 'sin_plan';
  if v_id is null then
    raise exception '1. ⚠⚠ Una firma sin plan no dejó línea: se perdió el hecho de que se firmó';
  end if;
  select * into r from firma_facturable where id = v_id;
  if r.precio_unitario is distinct from 0::numeric then raise exception '1. Precio % sin plan', r.precio_unitario; end if;
  if r.cobrada is distinct from false then raise exception '1. ⚠ Se cobró una firma de una empresa sin plan'; end if;
  if r.plan_id is not null then raise exception '1. Salió con plan y no hay plan'; end if;
  if r.nivel_firma is distinct from 'simple' then raise exception '1. Nivel %', r.nivel_firma; end if;
  if r.proveedor_id is not null then raise exception '1. La firma simple salió con proveedor'; end if;
  if r.periodo is distinct from to_char(now(), 'YYYY-MM')::char(7) then
    raise exception '1. Período % y estamos en %', r.periodo, to_char(now(), 'YYYY-MM');
  end if;
end $sinplan$;

-- ═══ 2. Con plan y precio, se cobra lo que dice la lista ════════════════════
insert into suscripcion (cuenta_id, plan_id, moneda)
values ('22222222-2222-2222-2222-222222222222', 'e7600000-0000-0000-0000-0000000000f1', 'UYU')
on conflict do nothing;
insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, precio_unitario)
values ('e7600000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'firma', 'simple', 12.5000);

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
insert into medido_76 (caso, id)
select 'con_plan', app.medir_firma((select id from firmas_76 where n = 2), 'simple', null);

reset role;
do $conplan$
declare r record;
begin
  select * into r from firma_facturable
   where id = (select id from medido_76 where caso = 'con_plan');
  if r.precio_unitario is distinct from 12.5000 then raise exception '2. Cobró % y el precio es 12.50', r.precio_unitario; end if;
  if r.cobrada is distinct from true then raise exception '2. No cobró una firma que sí se cobra'; end if;
  if r.moneda is distinct from 'UYU'::char(3) then raise exception '2. Moneda %', r.moneda; end if;
  if r.pais is distinct from 'UY'::char(2) then raise exception '2. País % (tiene que ser el del emisor)', r.pais; end if;
  if r.plan_id is null then raise exception '2. La línea salió sin plan y la empresa tiene uno'; end if;
end $conplan$;

-- ═══ 3. Las incluidas del mes no se cobran ══════════════════════════════════
update precio_metrica set cantidad_incluida = 3
 where plan_id = 'e7600000-0000-0000-0000-0000000000f1' and metrica = 'firma';
-- Se limpia lo medido hasta acá para contar desde cero.
--
-- ⚠ Hay que apagarle el trigger de inmutabilidad (073) para poder borrar: una
-- línea facturable no se borra nunca, y está bien que no se pueda. Esto es el
-- laboratorio y el trigger tiene su propio ejerce; acá sólo se vacía la mesa.
alter table firma_facturable disable trigger firma_facturable_inmutable;
delete from firma_facturable;
alter table firma_facturable enable trigger firma_facturable_inmutable;
delete from medido_76;

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $medir4$
declare i int; v_id uuid;
begin
  for i in 1..4 loop
    select app.medir_firma((select id from firmas_76 where n = i), 'simple', null) into v_id;
    if v_id is null then raise exception '3. La firma % no dejó línea', i; end if;
  end loop;
end $medir4$;

reset role;
do $incluidas$
declare v_cobradas int; v_total int;
begin
  select count(*), count(*) filter (where cobrada) into v_total, v_cobradas from firma_facturable;
  if v_total is distinct from 4 then raise exception '3. Se midieron % firmas y fueron 4', v_total; end if;
  -- ⚠ Tres incluidas: las tres primeras no se cobran, la cuarta sí.
  if v_cobradas is distinct from 1 then
    raise exception '3. Con 3 incluidas y 4 firmas se cobraron %, y tiene que ser 1', v_cobradas;
  end if;
end $incluidas$;

-- ═══ 4. Revenue share ═══════════════════════════════════════════════════════
alter table firma_facturable disable trigger firma_facturable_inmutable;
delete from firma_facturable;
alter table firma_facturable enable trigger firma_facturable_inmutable;
delete from medido_76;
update precio_metrica set cantidad_incluida = 0
 where plan_id = 'e7600000-0000-0000-0000-0000000000f1' and metrica = 'firma';
insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, precio_unitario)
values ('e7600000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'firma', 'avanzada', 100.0000);

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
insert into medido_76 (caso, id)
select 'share', app.medir_firma((select id from firmas_76 where n = 1), 'avanzada', 'ej76_share');

reset role;
do $share$
declare r record;
begin
  select * into r from firma_facturable where id = (select id from medido_76 where caso = 'share');
  if r.modelo_economico is distinct from 'revenue_share' then raise exception '4. Modelo %', r.modelo_economico; end if;
  if r.precio_unitario is distinct from 100.0000 then raise exception '4. Precio %', r.precio_unitario; end if;
  -- 30% de 100.
  if r.a_liquidar is distinct from 30.0000 then raise exception '4. A liquidar % y son 30', r.a_liquidar; end if;
  if r.costo_proveedor is not null then raise exception '4. Un revenue share no tiene costo por firma'; end if;
  if r.proveedor_id is null then raise exception '4. La firma avanzada salió sin proveedor'; end if;
end $share$;

-- 4b. Una firma INCLUIDA no le genera participación al proveedor: no hubo ingreso.
update precio_metrica set cantidad_incluida = 10
 where plan_id = 'e7600000-0000-0000-0000-0000000000f1' and metrica = 'firma' and nivel_firma = 'avanzada';

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
insert into medido_76 (caso, id)
select 'share_incluida', app.medir_firma((select id from firmas_76 where n = 2), 'avanzada', 'ej76_share');

reset role;
do $share_incluida$
declare r record;
begin
  select * into r from firma_facturable
   where id = (select id from medido_76 where caso = 'share_incluida');
  if r.cobrada is distinct from false then raise exception '4b. Se cobró una firma incluida'; end if;
  if r.a_liquidar is distinct from 0::numeric then
    raise exception '4b. ⚠ Se le liquidan % al proveedor por una firma que no se cobró', r.a_liquidar;
  end if;
end $share_incluida$;

-- ═══ 5. Medir dos veces no cobra dos veces ══════════════════════════════════
--
-- ⚠ LO QUE ESTE CASO NO PRUEBA. Sacarle el `on conflict do nothing` a la
-- migración lo deja igual de verde: sin él, el insert repetido choca contra el
-- `unique (participacion_id)` de la 073, la excepción la atrapa el propio
-- medidor y devuelve null lo mismo. O sea que la idempotencia la sostiene el
-- UNIQUE, no el `on conflict`; el `on conflict` está para que un reintento
-- legítimo no ensucie el log con un error que no es un error.
-- Se deja escrito acá porque un sabotaje que no se detecta es una nota, no un
-- descuido.
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
insert into medido_76 (caso, id)
select 'repetida', app.medir_firma((select id from firmas_76 where n = 1), 'avanzada', 'ej76_share');

reset role;
do $dosveces$
declare v_n int;
begin
  if (select id from medido_76 where caso = 'repetida') is not null then
    raise exception '5. La segunda medición creó una línea nueva';
  end if;
  select count(*) into v_n from firma_facturable
   where participacion_id = (select id from firmas_76 where n = 1);
  if v_n is distinct from 1 then raise exception '5. ⚠ La misma firma quedó con % líneas', v_n; end if;
end $dosveces$;

-- ═══ 6. ⚠⚠ El medidor no lanza NUNCA ════════════════════════════════════════
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $nolanza$
declare v_id uuid;
begin
  -- Participación que no existe.
  begin
    select app.medir_firma('00000000-0000-0000-0000-000000000000', 'simple', null) into v_id;
  exception when others then
    raise exception '6. ⚠⚠ El medidor lanzó con una participación inexistente: eso tumba la firma';
  end;
  if v_id is not null then raise exception '6. Midió una participación que no existe'; end if;

  -- Nivel inventado. (Cae antes, en la rama de «avanzada sin proveedor»; el
  -- punto es el mismo: sale por warning y no por excepción.)
  begin
    select app.medir_firma((select id from firmas_76 where n = 3), 'garabato', null) into v_id;
  exception when others then
    raise exception '6. ⚠⚠ El medidor lanzó con un nivel inválido: eso tumba la firma';
  end;
  if v_id is not null then raise exception '6. Escribió una línea con un nivel inválido'; end if;

  -- Firma avanzada con un proveedor que no está en el catálogo.
  begin
    select app.medir_firma((select id from firmas_76 where n = 4), 'avanzada', 'no_existe_76') into v_id;
  exception when others then
    raise exception '6. ⚠⚠ El medidor lanzó con un proveedor desconocido: eso tumba la firma';
  end;
  if v_id is not null then raise exception '6. Escribió una línea con un proveedor que no existe'; end if;
end $nolanza$;

-- ═══ 7. El operador no mide ═════════════════════════════════════════════════
reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
do $operador$
declare v_ok boolean; v_id uuid;
begin
  begin
    select app.medir_firma((select id from firmas_76 where n = 5), 'simple', null) into v_id;
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then
    raise exception '7. ⚠ El operador pudo escribir una línea facturable';
  end if;
end $operador$;

reset role;
rollback;
