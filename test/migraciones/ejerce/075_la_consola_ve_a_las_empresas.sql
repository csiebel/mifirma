-- =============================================================================
-- ejerce/075_la_consola_ve_a_las_empresas.sql
--
-- Lo que hay que probar:
--
--   1. Que el operador pueda CONTAR usuarios y documentos de una empresa…
--   2. …y que siga SIN poder listarlos. Es media migración si esto no se cumple.
--   3. Que el operador pueda contratarle un plan a una empresa (y cancelarlo),
--      porque hasta la 075 nada en el producto creaba suscripciones.
--   4. Que la cuenta siga sin poder cambiarse el plan sola.
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

-- ── 0. Una empresa con dos personas, una de ellas con dos roles ──────────────
-- La de dos roles es la que delata un `count(*)` sin `distinct`: son 3 filas en
-- `usuario_rol` y 2 usuarios.
-- ⚠ `rol` no lo siembra ninguna migración (los roles nacen con la cuenta), así
-- que el ejerce se los crea.
insert into rol (id, cuenta_id, codigo, nombre_i18n, sistema) values
  ('e7500000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'ej75_admin', '{"es":"Administrador"}'::jsonb, false),
  ('e7500000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'ej75_firmante', '{"es":"Firmante"}'::jsonb, false)
on conflict do nothing;

insert into usuario_rol (identidad_id, cuenta_id, rol_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'e7500000-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'e7500000-0000-0000-0000-000000000002'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'e7500000-0000-0000-0000-000000000001')
on conflict do nothing;

do $sembrado$
declare v_filas int; v_pers int;
begin
  select count(*), count(distinct identidad_id) into v_filas, v_pers
    from usuario_rol where cuenta_id = '22222222-2222-2222-2222-222222222222';
  if v_filas < 3 or v_pers < 2 then
    raise exception '0. El sembrado no quedó: % filas, % personas (hacen falta 3 y 2)', v_filas, v_pers;
  end if;
end $sembrado$;

-- Un plan para contratar. Tampoco lo siembra ninguna migración; el trigger
-- `plan_nace_usable` (072) le pone la firma simple solo.
insert into plan (id, codigo, nombre_i18n) values
  ('e7500000-0000-0000-0000-0000000000f1', 'ej75_plan', '{"es":"Plan del ejerce 75"}'::jsonb),
  ('e7500000-0000-0000-0000-0000000000f2', 'ej75_viejo', '{"es":"Plan viejo"}'::jsonb)
on conflict do nothing;

-- Y una suscripción vigente al plan viejo: sin ella, el punto 3 no puede probar
-- que la anterior se CANCELA en vez de desaparecer.
insert into suscripcion (cuenta_id, plan_id, moneda)
values ('22222222-2222-2222-2222-222222222222',
        'e7500000-0000-0000-0000-0000000000f2', 'UYU')
on conflict do nothing;

-- ⚠ El número real hay que sacarlo ANTES de ponerse el traje de operador: bajo
-- ese rol la tabla no se puede leer, que es justamente lo que prueba el punto 2.
-- Se lo pasa por una temporal con grant (truco del ejerce 073).
create temporary table esperado_75 as
  select count(distinct identidad_id) as personas
    from usuario_rol where cuenta_id = '22222222-2222-2222-2222-222222222222';
grant select on esperado_75 to app_operador, app_rw;

set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;

-- ═══ 1. Contar sí ═══════════════════════════════════════════════════════════
do $contar$
declare v_u bigint; v_d bigint; v_reales bigint;
begin
  v_u := app.usuarios_de_cuenta('22222222-2222-2222-2222-222222222222');
  if v_u is null then raise exception '1. El conteo de usuarios vino nulo'; end if;
  if v_u is distinct from 2::bigint then
    raise exception '1. La empresa tiene 2 personas (3 roles) y el conteo dijo %', v_u;
  end if;

  -- ⚠ `distinct`: la identidad con dos roles cuenta una sola vez.
  select personas into v_reales from esperado_75;
  if v_u is distinct from v_reales then
    raise exception '1. ⚠ Cuenta roles y no personas: dijo % y son %', v_u, v_reales;
  end if;

  select documentos into v_d from app.custodia_usada('22222222-2222-2222-2222-222222222222');
  if v_d is null then raise exception '1. El conteo de documentos vino nulo'; end if;
end $contar$;

-- ═══ 2. Listar no ═══════════════════════════════════════════════════════════
do $listar$
declare v_ok boolean;
begin
  begin
    perform 1 from usuario_rol limit 1;
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then
    raise exception '2. ⚠⚠ El operador puede listar `usuario_rol`: ve a las personas de todos los clientes';
  end if;

  begin
    perform 1 from archivo limit 1;
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then
    raise exception '2. ⚠⚠ El operador puede listar `archivo`: ve los documentos de todos los clientes';
  end if;
end $listar$;

-- ═══ 3. Contratarle un plan a una empresa ═══════════════════════════════════
do $contratar$
declare v_plan uuid; v_id uuid; v_n int;
begin
  select id into v_plan from plan order by codigo limit 1;

  update suscripcion set estado = 'cancelada', fin = current_date
   where cuenta_id = '22222222-2222-2222-2222-222222222222' and estado = 'activa';

  insert into suscripcion (cuenta_id, plan_id, moneda, medio_cobro)
  values ('22222222-2222-2222-2222-222222222222', v_plan, 'UYU', 'tarjeta')
  returning id into v_id;
  if v_id is null then raise exception '3. ⚠ El operador no pudo contratar un plan'; end if;

  -- Y la anterior sigue estando: es lo que contesta «en qué plan estaba en marzo».
  select count(*) into v_n from suscripcion
   where cuenta_id = '22222222-2222-2222-2222-222222222222';
  if v_n < 2 then
    raise exception '3. Quedó % suscripción: la anterior se perdió en vez de cancelarse', v_n;
  end if;

  -- Borrarla no.
  begin
    delete from suscripcion where id = v_id;
    v_n := 1;
  exception when insufficient_privilege then v_n := 0; end;
  if v_n is distinct from 0 then
    raise exception '3. ⚠ El operador pudo BORRAR una suscripción: se pierde el historial de facturación';
  end if;
end $contratar$;

-- ═══ 4. La cuenta sigue sin poder cambiarse el plan sola ════════════════════
reset role;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $sola$
declare v_ok boolean; v_plan uuid;
begin
  select id into v_plan from plan order by codigo desc limit 1;
  begin
    insert into suscripcion (cuenta_id, plan_id, moneda)
    values ('22222222-2222-2222-2222-222222222222', v_plan, 'UYU');
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then
    raise exception '4. ⚠⚠ Una cuenta se contrató un plan sola';
  end if;
end $sola$;

reset role;
rollback;
