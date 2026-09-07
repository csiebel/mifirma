-- =============================================================================
-- ejerce/071_prestaciones_del_plan_y_marca_del_pais.sql
--
-- ═══ ROLES: app_operador para escribir el catálogo, app_rw para leerlo ═══
--
-- Cuarto ejerce con el patrón de la deuda 77(a). Tres cosas se prueban, y las
-- tres son de las que dan verde con la función rota si se comparan mal:
--
--   · Que la IMAGEN del logo sale sólo por la puerta, sólo con acuerdo vigente
--     y autorización de marca — y que la base rechaza lo que no es imagen.
--   · Que el DISPOSITIVO PROPIO está en el catálogo, apagado, y que no aparece
--     entre los proveedores habilitados de ningún país.
--   · Que la PRESTACIÓN de una cuenta se resuelve suscripción → plan → «no», que
--     SIEMPRE devuelve una fila, y que una cuenta no ve el override de otra.
--
-- Todo se compara con `is distinct from` (nota de método del ejerce 070).
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas. Falta la marca banco_de_pruebas.';
  end if;
end $cinturon$;

begin;

-- ── 0. Como superusuario: un plan y una suscripción para la cuenta del fixture ─
insert into plan (id, codigo, nombre_i18n)
values ('aaaa0071-0000-0000-0000-000000000001', 'ejerce_plan', '{"es":"Plan de prueba"}'::jsonb)
on conflict (codigo) do nothing;

insert into suscripcion (id, cuenta_id, plan_id, moneda)
values ('aaaa0071-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
        'aaaa0071-0000-0000-0000-000000000001', 'UYU');

-- Un socio para colgar el acuerdo.
insert into proveedor_firma (id, codigo, nombre_mostrado, activo_global, entorno, endpoints, parametros)
values ('aaaa0071-0000-0000-0000-000000000003', 'ejerce_socio_071', 'Socio 071', true, 'integracion',
        '{"integracion":{"auth":"https://ejemplo.invalid/auth"}}'::jsonb, '{}'::jsonb);
insert into proveedor_capacidad (proveedor_id, firma_hash, identifica_titular, formatos_devueltos)
values ('aaaa0071-0000-0000-0000-000000000003', true, true, '{pkcs7}');

-- ═══ 1. La marca del país ═══════════════════════════════════════════════════
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;

-- 1a. Lo que NO entra: tipo que no es imagen, imagen sin tipo, imagen gorda,
--     texto que no es objeto.
do $no$
declare v_ok boolean;
begin
  begin
    insert into acuerdo_exclusividad (pais, proveedor_id, socio_nombre, vigente_desde,
                                      logo_socio_img, logo_socio_mime)
    values ('PY', 'aaaa0071-0000-0000-0000-000000000003', 'Socio', current_date,
            '\x89504e47'::bytea, 'text/html');
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '1a. Entró un logo con mime text/html'; end if;

  begin
    insert into acuerdo_exclusividad (pais, proveedor_id, socio_nombre, vigente_desde, logo_socio_img)
    values ('PY', 'aaaa0071-0000-0000-0000-000000000003', 'Socio', current_date, '\x89504e47'::bytea);
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '1a. Entró una imagen sin mime'; end if;

  begin
    insert into acuerdo_exclusividad (pais, proveedor_id, socio_nombre, vigente_desde,
                                      logo_producto_img, logo_producto_mime)
    values ('PY', 'aaaa0071-0000-0000-0000-000000000003', 'Socio', current_date,
            decode(repeat('00', 300 * 1024 + 1), 'hex'), 'image/png');
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '1a. Entró un logo de más de 300 KB'; end if;

  begin
    insert into acuerdo_exclusividad (pais, proveedor_id, socio_nombre, vigente_desde, texto_i18n)
    values ('PY', 'aaaa0071-0000-0000-0000-000000000003', 'Socio', current_date, '"hola"'::jsonb);
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '1a. Entró un texto_i18n que no es objeto'; end if;
end $no$;

-- 1b. Lo que sí: un acuerdo con logo del socio subido, enlace y texto — pero
--     SIN autorización de marca todavía.
insert into acuerdo_exclusividad (id, pais, proveedor_id, socio_nombre, vigente_desde,
                                  logo_socio_img, logo_socio_mime, logo_socio_enlace,
                                  logo_producto_url, texto_i18n, autorizacion_marca)
values ('aaaa0071-0000-0000-0000-000000000004', 'UY', 'aaaa0071-0000-0000-0000-000000000003',
        'Socio 071', current_date - 1,
        '\x89504e470d0a1a0a'::bytea, 'image/png', 'https://socio.invalid',
        'https://socio.invalid/producto.png',
        '{"es":"Firma con respaldo del Socio","pt":"Assinatura com o Sócio"}'::jsonb,
        false);

reset role;
set role app_rw;
do $ctx$ begin perform set_config('app.actor', 'sistema', true); end $ctx$;

-- 1c. Sin autorización de marca: ni la marca ni la imagen salen.
do $sin$
declare v_n int;
begin
  select count(*) into v_n from app.exclusividad_vigente('UY');
  if v_n is distinct from 0 then raise exception '1c. exclusividad_vigente devolvió % sin autorización de marca', v_n; end if;
  select count(*) into v_n from app.marca_imagen('UY', 'socio');
  if v_n is distinct from 0 then raise exception '1c. marca_imagen devolvió imagen sin autorización de marca'; end if;
end $sin$;

-- 1d. app_rw no puede leer los bytes por la tabla ni escribir el acuerdo.
do $tabla$
declare v_ok boolean;
begin
  begin
    update acuerdo_exclusividad set autorizacion_marca = true
     where id = 'aaaa0071-0000-0000-0000-000000000004';
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then raise exception '1d. app_rw pudo escribir el acuerdo'; end if;
end $tabla$;

reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
update acuerdo_exclusividad set autorizacion_marca = true
 where id = 'aaaa0071-0000-0000-0000-000000000004';

reset role;
set role app_rw;
do $ctx$ begin perform set_config('app.actor', 'sistema', true); end $ctx$;

-- 1e. Con autorización: la marca dice qué hay, la puerta da la imagen, y sólo
--     la que existe.
do $con$
declare r record; v_img bytea; v_mime text; v_n int;
begin
  select * into r from app.exclusividad_vigente('UY');
  if r.socio_nombre is distinct from 'Socio 071' then raise exception '1e. socio_nombre = %', r.socio_nombre; end if;
  if r.logo_socio_img_hay is distinct from true then raise exception '1e. logo_socio_img_hay tendría que ser true'; end if;
  if r.logo_producto_img_hay is distinct from false then raise exception '1e. logo_producto_img_hay tendría que ser false'; end if;
  if r.logo_socio_enlace is distinct from 'https://socio.invalid' then raise exception '1e. enlace = %', r.logo_socio_enlace; end if;
  if r.logo_producto_url is distinct from 'https://socio.invalid/producto.png' then raise exception '1e. la URL vieja se perdió'; end if;
  if (r.texto_i18n->>'es') is distinct from 'Firma con respaldo del Socio' then raise exception '1e. texto es = %', r.texto_i18n->>'es'; end if;

  select img, mime into v_img, v_mime from app.marca_imagen('UY', 'socio');
  if v_img is distinct from '\x89504e470d0a1a0a'::bytea then raise exception '1e. marca_imagen devolvió otros bytes'; end if;
  if v_mime is distinct from 'image/png' then raise exception '1e. mime = %', v_mime; end if;

  select count(*) into v_n from app.marca_imagen('UY', 'producto');
  if v_n is distinct from 0 then raise exception '1e. hay imagen del producto y no se cargó ninguna'; end if;
  select count(*) into v_n from app.marca_imagen('UY', 'cualquiera');
  if v_n is distinct from 0 then raise exception '1e. marca_imagen aceptó un «cual» inventado'; end if;
  select count(*) into v_n from app.marca_imagen('PY', 'socio');
  if v_n is distinct from 0 then raise exception '1e. marca_imagen devolvió el logo de UY para PY'; end if;
end $con$;

-- ═══ 2. El dispositivo propio en el catálogo, apagado ═══════════════════════
do $disp$
declare v_id uuid; v_activo boolean; v_n int; v_ok boolean;
begin
  select id, activo_global into v_id, v_activo from proveedor_firma where codigo = 'dispositivo_propio';
  if v_id is null then raise exception '2. No está dispositivo_propio en el catálogo'; end if;
  if v_activo is distinct from false then raise exception '2. dispositivo_propio nació encendido'; end if;
  select count(*) into v_n from proveedor_capacidad where proveedor_id = v_id and requiere_presencia and not soporta_lote and not identifica_titular;
  if v_n is distinct from 1 then raise exception '2. Las capacidades del dispositivo no son las declaradas'; end if;
  select count(*) into v_n from app.proveedores_habilitados('UY', 'firma') where codigo = 'dispositivo_propio';
  if v_n is distinct from 0 then raise exception '2. dispositivo_propio aparece habilitado en UY sin país ni encendido'; end if;
end $disp$;

-- 2b. Como operador: se puede habilitar en un país PARA FIRMA, y no para
--     identidad, porque no la declara.
reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
do $pais$
declare v_id uuid; v_ok boolean;
begin
  select id into v_id from proveedor_firma where codigo = 'dispositivo_propio';
  begin
    insert into proveedor_pais (proveedor_id, pais, capacidades, niveles)
    values (v_id, 'PY', '{identidad}', '{avanzada}');
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '2b. Se habilitó dispositivo_propio para identidad'; end if;
  insert into proveedor_pais (proveedor_id, pais, capacidades, niveles)
  values (v_id, 'PY', '{firma}', '{avanzada}');
end $pais$;

-- ═══ 3. Las prestaciones del plan ═══════════════════════════════════════════

-- 3a. Como operador: una prestación desconocida no entra; la IA entra y se
--     espeja en las columnas viejas.
do $plan$
declare v_ok boolean; r record;
begin
  begin
    insert into plan_prestacion (plan_id, prestacion, incluida)
    values ('aaaa0071-0000-0000-0000-000000000001', 'sellado_tiempo', true);
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3a. Entró una prestación desconocida'; end if;

  insert into plan_prestacion (plan_id, prestacion, incluida, cobra, cantidad_incluida, margen_pct)
  values ('aaaa0071-0000-0000-0000-000000000001', 'asistente_ia', true, false, 10, 0),
         ('aaaa0071-0000-0000-0000-000000000001', 'firma_avanzada', true, true, 0, 15);

  select asistente_ia, ia_cobra, ia_incluido into r from plan where id = 'aaaa0071-0000-0000-0000-000000000001';
  if r.asistente_ia is distinct from true then raise exception '3a. plan.asistente_ia no se espejó'; end if;
  if r.ia_cobra is distinct from false then raise exception '3a. plan.ia_cobra no se espejó'; end if;
  if r.ia_incluido is distinct from 10::numeric then raise exception '3a. plan.ia_incluido = %', r.ia_incluido; end if;
end $plan$;

-- 3b. La lista de precios acepta la métrica nueva y rechaza una inventada.
do $precio$
declare v_ok boolean;
begin
  insert into precio_metrica (plan_id, pais, moneda, metrica, precio_unitario)
  values ('aaaa0071-0000-0000-0000-000000000001', 'UY', 'USD', 'dispositivo_propio', 0.5);
  begin
    insert into precio_metrica (plan_id, pais, moneda, metrica, precio_unitario)
    values ('aaaa0071-0000-0000-0000-000000000001', 'UY', 'USD', 'zzz', 1);
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3b. Entró una métrica inventada'; end if;
  begin
    insert into precio_metrica (plan_id, pais, moneda, metrica, precio_unitario, nivel_firma)
    values ('aaaa0071-0000-0000-0000-000000000001', 'UY', 'USD', 'abono', 1, 'avanzada');
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3b. El check del abono sin nivel (019) se perdió'; end if;
end $precio$;

-- 3c. Como la cuenta: la resolución suscripción → plan → «no», SIEMPRE una fila.
reset role;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('app.identidad_id', '11111111-1111-1111-1111-111111111111', true);
end $ctx$;

do $cuenta$
declare r record; v_n int; v_ok boolean;
begin
  select * into r from app.prestacion_de_cuenta('22222222-2222-2222-2222-222222222222', 'asistente_ia');
  if r.incluida is distinct from true or r.cobra is distinct from false or r.origen is distinct from 'plan' then
    raise exception '3c. IA por plan: incluida=% cobra=% origen=%', r.incluida, r.cobra, r.origen;
  end if;

  select * into r from app.prestacion_de_cuenta('22222222-2222-2222-2222-222222222222', 'dispositivo_propio');
  if r.incluida is distinct from false or r.origen is distinct from 'plan_sin_fila' then
    raise exception '3c. Sin fila en el plan: incluida=% origen=%', r.incluida, r.origen;
  end if;

  select * into r from app.prestacion_de_cuenta('99999999-9999-9999-9999-999999999999', 'asistente_ia');
  if r.incluida is distinct from false or r.origen is distinct from 'sin_suscripcion' then
    raise exception '3c. Cuenta sin suscripción: incluida=% origen=%', r.incluida, r.origen;
  end if;

  select count(*) into v_n from app.prestaciones_de_cuenta('22222222-2222-2222-2222-222222222222');
  if v_n is distinct from 4 then raise exception '3c. prestaciones_de_cuenta devolvió % filas y son 4', v_n; end if;

  -- La cuenta no se regala prestaciones.
  begin
    insert into plan_prestacion (plan_id, prestacion, incluida)
    values ('aaaa0071-0000-0000-0000-000000000001', 'dispositivo_propio', true);
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3c. La cuenta pudo escribir plan_prestacion'; end if;
  begin
    insert into suscripcion_prestacion (suscripcion_id, prestacion, incluida)
    values ('aaaa0071-0000-0000-0000-000000000002', 'dispositivo_propio', true);
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then raise exception '3c. La cuenta pudo escribir suscripcion_prestacion'; end if;
end $cuenta$;

-- 3d. Como operador: el override por cuenta manda sobre el plan y se espeja.
reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
insert into suscripcion_prestacion (suscripcion_id, prestacion, incluida, cobra)
values ('aaaa0071-0000-0000-0000-000000000002', 'dispositivo_propio', true, true),
       ('aaaa0071-0000-0000-0000-000000000002', 'asistente_ia', null, true);

do $over$
declare r record; v_cobra boolean;
begin
  select * into r from app.prestacion_de_cuenta('22222222-2222-2222-2222-222222222222', 'dispositivo_propio');
  if r.incluida is distinct from true or r.origen is distinct from 'suscripcion' then
    raise exception '3d. Override: incluida=% origen=%', r.incluida, r.origen;
  end if;
  -- IA: incluida hereda del plan (true), cobra viene del override (true).
  select * into r from app.prestacion_de_cuenta('22222222-2222-2222-2222-222222222222', 'asistente_ia');
  if r.incluida is distinct from true or r.cobra is distinct from true then
    raise exception '3d. Herencia por columna: incluida=% cobra=%', r.incluida, r.cobra;
  end if;
  select ia_cobra into v_cobra from suscripcion where id = 'aaaa0071-0000-0000-0000-000000000002';
  if v_cobra is distinct from true then raise exception '3d. suscripcion.ia_cobra no se espejó'; end if;
end $over$;

-- 3e. Otra cuenta no ve el override de ésta.
reset role;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '99999999-9999-9999-9999-999999999999', true);
  perform set_config('app.identidad_id', '11111111-1111-1111-1111-111111111111', true);
end $ctx$;
do $otra$
declare v_n int;
begin
  select count(*) into v_n from suscripcion_prestacion;
  if v_n is distinct from 0 then raise exception '3e. Otra cuenta ve % override(s) ajeno(s)', v_n; end if;
end $otra$;

reset role;
rollback;
