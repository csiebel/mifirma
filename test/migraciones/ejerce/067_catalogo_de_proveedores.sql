-- =============================================================================
-- ejerce/067_catalogo_de_proveedores.sql
--
-- ═══ ROL: MIXTO, DECLARADO ═══
--
--   app_operador  — para las escrituras del catálogo (realm 'operador')
--   app_rw        — para todo lo que hace la aplicación (realm 'cuenta')
--   postgres      — sólo para el cinturón y para armar el escenario que NINGÚN
--                   rol de la aplicación puede armar: la fila de `pais` no hace
--                   falta (viene de la 032) y no se crean cuentas acá.
--
-- ⚠ POR QUÉ ESTO IMPORTA, Y ES LA DEUDA 77(a) EN CHIQUITO
--
-- Los diez ejerce que existen hoy corren como `postgres`, que **saltea todas las
-- políticas RLS**. El banco tiene 153 políticas y no ejercita ninguna: las
-- pruebas dicen que la aplicación puede hacer algo, sin haber usado nunca el rol
-- con el que la aplicación se conecta.
--
-- Éste nace del otro lado. Cada afirmación se hace parada en los zapatos del rol
-- que la va a hacer en producción, y las importantes son las NEGATIVAS: que el
-- que no debe, no puede. «Verde como app_rw» sólo prueba que el producto
-- funciona; lo que prueba que la RLS muerde es que el otro no puede.
--
-- ⚠ Lo que este ejerce NO cubre, dicho para que nadie se confíe: la política de
-- `proveedor_cuenta` (tenant duro + capacidad `proveedores/administrar`). Armar
-- ese escenario necesita empresa, membresía, rol y usuario_rol, y en el banco
-- `base-fixtures.sql` tiene una sola empresa y CERO membresías. Es el trabajo
-- habilitante de la deuda 77(a); cuando esté, se agrega acá.
-- =============================================================================

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- El cinturón. Con `to_regclass` y no con `information_schema`.
--
-- ⚠ La diferencia no es de estilo: `information_schema` FILTRA POR PRIVILEGIOS.
-- Desde app_rw no muestra las tablas sin grant, así que la marca del banco
-- —que app_rw no puede leer— se vería como inexistente y el cinturón abortaría
-- las corridas legítimas. `to_regclass` mira el catálogo real y no filtra.
-- Medido el 4/9: desde app_rw, `select count(*) from banco_de_pruebas` da
-- «permission denied» y `to_regclass` lo encuentra igual.
-- -----------------------------------------------------------------------------
do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas. Falta la marca banco_de_pruebas.';
  end if;
end $cinturon$;

begin;

-- =============================================================================
-- 1. El operador da de alta un proveedor. La aplicación NO.
-- =============================================================================

-- ── 1a. Como app_rw, con contexto de una empresa: no puede ────────────────────
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

do $no_puede$
declare v_error text := '';
begin
  begin
    insert into proveedor_firma (codigo, nombre_mostrado) values ('colado', 'Colado S.A.');
    v_error := 'la aplicación pudo dar de alta un proveedor';
  exception
    when insufficient_privilege then null;   -- correcto: la política lo rechazó
  end;
  if v_error <> '' then
    raise exception '⚠ %', v_error;
  end if;
end $no_puede$;

reset role;

-- ── 1b. Como app_operador, en el realm operador: sí puede ─────────────────────
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;

insert into proveedor_firma (id, codigo, nombre_mostrado, activo_global, entorno, endpoints, parametros)
values
  ('aaaa0067-0000-0000-0000-000000000001', 'ejerce_socio',  'Socio Exclusivo',  true, 'integracion',
   '{"integracion":{"auth":"https://ejemplo.invalid/auth"}}'::jsonb, '{"client_id":"no-secreto"}'::jsonb),
  ('aaaa0067-0000-0000-0000-000000000002', 'ejerce_rival',  'Otro Acreditado',  true, 'integracion',
   '{"integracion":{"auth":"https://ejemplo.invalid/auth"}}'::jsonb, '{}'::jsonb),
  ('aaaa0067-0000-0000-0000-000000000003', 'ejerce_papel',  'Sólo en el Papel', true, 'integracion',
   '{}'::jsonb, '{}'::jsonb);

update proveedor_firma
   set credenciales_cif = decode('deadbeef', 'hex'),
       credencial_puesta_en = now(), credencial_puesta_por = 'ejerce 067'
 where id = 'aaaa0067-0000-0000-0000-000000000001';

insert into proveedor_capacidad (proveedor_id, firma_hash, identifica_titular, sellado_tiempo, formatos_devueltos)
values
  ('aaaa0067-0000-0000-0000-000000000001', true,  true,  true,  '{pkcs7}'),
  ('aaaa0067-0000-0000-0000-000000000002', true,  false, false, '{pkcs7}'),
  ('aaaa0067-0000-0000-0000-000000000003', false, false, false, '{}');

insert into proveedor_pais (proveedor_id, pais, capacidades, niveles, activo) values
  ('aaaa0067-0000-0000-0000-000000000001', 'UY', '{firma,identidad,sellado_tiempo}', '{avanzada}', true),
  ('aaaa0067-0000-0000-0000-000000000002', 'UY', '{firma}',                          '{avanzada}', true);

-- =============================================================================
-- 2. No se habilita una capacidad que el proveedor no tiene
--
-- `ejerce_papel` declara firma_hash = false: pide el documento entero. Es el
-- punto 1 del checklist del 30/7 y motivo suficiente para descartar a un
-- proveedor. Habilitarlo para firmar tiene que ser IMPOSIBLE, no improbable:
-- un dato así no falla al cargarlo, falla el día que un firmante intenta usarlo.
-- =============================================================================
do $incoherente$
declare v_error text := '';
begin
  begin
    insert into proveedor_pais (proveedor_id, pais, capacidades)
    values ('aaaa0067-0000-0000-0000-000000000003', 'UY', '{firma}');
    v_error := 'se habilitó para firmar un proveedor que no firma por hash';
  exception
    when check_violation then null;
  end;
  if v_error <> '' then
    raise exception '⚠ %', v_error;
  end if;
end $incoherente$;

reset role;

-- =============================================================================
-- 3. El secreto: ni el operador ni la aplicación pueden leerlo
--
-- Ésta es la afirmación más fuerte del archivo. «Se carga y no vuelve a
-- mostrarse» deja de ser una promesa de la pantalla y pasa a ser una propiedad
-- de la base: la consola NO PUEDE mostrarlo aunque alguien lo programe por error.
-- =============================================================================
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

do $secreto$
declare v_error text := ''; v_dummy bytea; v_n int;
begin
  -- 3a. Leer la columna del secreto: prohibido.
  begin
    select credenciales_cif into v_dummy
      from proveedor_firma where codigo = 'ejerce_socio';
    v_error := 'la aplicación pudo leer credenciales_cif con un select directo';
  exception
    when insufficient_privilege then null;
  end;
  if v_error <> '' then raise exception '⚠ %', v_error; end if;

  -- 3b. Y `select *` también, que es como se filtra de verdad: nadie escribe
  --     «dame el secreto», escriben «dame el proveedor» y lo vuelcan a un log.
  begin
    perform * from proveedor_firma where codigo = 'ejerce_socio';
    v_error := 'un select * sobre proveedor_firma trajo la columna del secreto';
  exception
    when insufficient_privilege then null;
  end;
  if v_error <> '' then raise exception '⚠ %', v_error; end if;

  -- 3c. Pero el resto del proveedor se lee sin problema: la aplicación necesita
  --     el ambiente, los endpoints y el client_id para trabajar.
  select count(*) into v_n
    from proveedor_firma where codigo = 'ejerce_socio' and entorno = 'integracion';
  if v_n <> 1 then
    raise exception '⚠ la aplicación no puede leer la configuración del proveedor';
  end if;

  -- 3d. Y el adaptador obtiene el cifrado por la puerta declarada.
  if app.credencial_de_proveedor('aaaa0067-0000-0000-0000-000000000001') is null then
    raise exception '⚠ el adaptador no pudo obtener la credencial por la función';
  end if;
end $secreto$;

-- =============================================================================
-- 4. La regla del acuerdo de exclusividad
--
-- Es la razón de ser de la tabla, y se prueba en los tres tiempos: sin acuerdo,
-- con acuerdo vigente, y después de vencido. Que se apague solo al vencer es lo
-- que hace que nadie tenga que acordarse de sacar un logo.
-- =============================================================================
do $sin_acuerdo$
declare v_n int;
begin
  select count(*) into v_n from app.proveedores_habilitados('UY', 'firma')
   where codigo like 'ejerce_%';
  if v_n <> 2 then
    raise exception '⚠ sin acuerdo, Uruguay debería ofrecer los dos proveedores y ofrece %', v_n;
  end if;
end $sin_acuerdo$;

reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;

insert into acuerdo_exclusividad
  (id, pais, proveedor_id, socio_nombre, vigente_desde, vigente_hasta, capacidades,
   logo_producto_url, logo_socio_url, autorizacion_marca, creado_por)
values
  ('bbbb0067-0000-0000-0000-000000000001', 'UY', 'aaaa0067-0000-0000-0000-000000000001',
   'Socio Exclusivo S.A.', current_date - 10, current_date + 30, '{firma}',
   'https://ejemplo.invalid/mifirma.svg', 'https://ejemplo.invalid/socio.svg', true, 'ejerce 067');

-- ── 4b. Dos acuerdos que se pisan en el mismo país: imposible ─────────────────
-- No alcanza con «uno vigente hoy»: dos acuerdos FUTUROS solapados entrarían sin
-- protestar y el conflicto aparecería el día que empiezan, cuando ya hay logos
-- prometidos por contrato a dos socios distintos.
do $solape$
declare v_error text := '';
begin
  begin
    insert into acuerdo_exclusividad (pais, proveedor_id, socio_nombre, vigente_desde, vigente_hasta)
    values ('UY', 'aaaa0067-0000-0000-0000-000000000002', 'Otro Socio', current_date, current_date + 5);
    v_error := 'entraron dos acuerdos de exclusividad solapados en el mismo país';
  exception
    when exclusion_violation then null;
  end;
  if v_error <> '' then raise exception '⚠ %', v_error; end if;
end $solape$;

reset role;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

-- ── 4c. Con el acuerdo vigente, sólo el socio ─────────────────────────────────
do $con_acuerdo$
declare v_n int; v_cod text;
begin
  select count(*), min(codigo) into v_n, v_cod
    from app.proveedores_habilitados('UY', 'firma') where codigo like 'ejerce_%';
  if v_n <> 1 or v_cod <> 'ejerce_socio' then
    raise exception '⚠ con acuerdo vigente Uruguay debería ofrecer sólo al socio, y ofrece % (%)', v_n, v_cod;
  end if;

  -- ⚠ El acuerdo es de `firma`. El sellado de tiempo NO se toca: el socio lo
  -- sigue ofreciendo porque lo declara, no porque sea exclusivo. Si la regla se
  -- aplicara al proveedor entero en vez de por capacidad, esto no se notaría.
  select count(*) into v_n
    from app.proveedores_habilitados('UY', 'sellado_tiempo') where codigo like 'ejerce_%';
  if v_n <> 1 then
    raise exception '⚠ el acuerdo de firma se comió el sellado de tiempo';
  end if;

  -- Y el co-branding aparece.
  if not exists (select 1 from app.exclusividad_vigente('UY') where socio_nombre = 'Socio Exclusivo S.A.') then
    raise exception '⚠ el acuerdo vigente no devuelve el co-branding';
  end if;
end $con_acuerdo$;

-- ── 4d. Sin autorización de marca, no se muestra ningún logo ──────────────────
reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
update acuerdo_exclusividad set autorizacion_marca = false
 where id = 'bbbb0067-0000-0000-0000-000000000001';
reset role;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

do $sin_marca$ begin
  if exists (select 1 from app.exclusividad_vigente('UY')) then
    raise exception '⚠ se muestra la marca del socio sin autorización registrada';
  end if;
  -- Pero la exclusividad comercial sigue en pie: la marca es otra cosa.
  if (select count(*) from app.proveedores_habilitados('UY','firma') where codigo like 'ejerce_%') <> 1 then
    raise exception '⚠ la falta de autorización de marca apagó la exclusividad comercial';
  end if;
end $sin_marca$;

-- ── 4e. Vencido el acuerdo, vuelven todos, sin que nadie toque nada ───────────
reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
update acuerdo_exclusividad
   set vigente_desde = current_date - 40, vigente_hasta = current_date - 1
 where id = 'bbbb0067-0000-0000-0000-000000000001';
reset role;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

do $vencido$
declare v_n int;
begin
  select count(*) into v_n
    from app.proveedores_habilitados('UY', 'firma') where codigo like 'ejerce_%';
  if v_n <> 2 then
    raise exception '⚠ vencido el acuerdo, Uruguay debería volver a ofrecer los dos y ofrece %', v_n;
  end if;
end $vencido$;

-- =============================================================================
-- 5. El proveedor caído sale de la lista antes de que alguien lo elija
--
-- Cuando un proveedor se cae NO se reintenta solo: el titular ya consumió un
-- token de un solo uso, y volver a intentar significa otro mail. Ofrecerle al
-- firmante algo que va a fallar es la peor versión de ese costo.
-- =============================================================================
reset role;
set role app_operador;
do $ctx$ begin perform set_config('app.actor', 'operador', true); end $ctx$;
insert into proveedor_salud (proveedor_id, estado, fallos_seguidos)
values ('aaaa0067-0000-0000-0000-000000000002', 'caido', 7)
on conflict (proveedor_id) do update set estado = 'caido';
reset role;
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;

do $caido$
declare v_n int;
begin
  select count(*) into v_n
    from app.proveedores_habilitados('UY', 'firma') where codigo like 'ejerce_%';
  if v_n <> 1 then
    raise exception '⚠ el proveedor caído sigue en la lista de opciones (quedan %)', v_n;
  end if;
end $caido$;

-- =============================================================================
-- 6. El país que manda es el del firmante
--
-- Un firmante brasileño no puede recibir proveedores uruguayos. Resolver la
-- lista por el país del emisor es el error obvio del módulo y deja al firmante
-- sin ninguna opción usable.
-- =============================================================================
do $otro_pais$
declare v_n int;
begin
  select count(*) into v_n
    from app.proveedores_habilitados('BR', 'firma') where codigo like 'ejerce_%';
  if v_n <> 0 then
    raise exception '⚠ un firmante de Brasil recibe % proveedores habilitados sólo en Uruguay', v_n;
  end if;
end $otro_pais$;

reset role;
rollback;

do $ok$ begin
  raise notice '✓ 067: el catálogo se administra desde el operador, la aplicación no lo escribe, el secreto no se lee y la exclusividad se apaga sola.';
end $ok$;
