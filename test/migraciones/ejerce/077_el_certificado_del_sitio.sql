-- =============================================================================
-- ejerce/077_el_certificado_del_sitio.sql
--
-- Lo que hay que probar:
--
--   1. Sin ningún certificado cargado, `sello_para` no devuelve nada (y el
--      adaptador usa el del entorno).
--   2. Cargado el global, TODOS los países lo usan.
--   3. Cargado el de Uruguay, Uruguay usa el suyo y Brasil sigue con el global.
--   4. Apagado el de Uruguay en su país, Uruguay vuelve al global.
--   5. ⚠⚠ Ningún sello aparece como opción de firma AVANZADA para el firmante,
--      y no se puede convertir en una desde la consola.
--   6. `app_rw` (quien firma) puede resolver el sello y leer su credencial por
--      la función de la 067, y NO puede leer `credenciales_cif` directo.
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

-- Los ids, para no repetir el select.
create temporary table sellos_77 as
  select codigo, id from proveedor_firma where parametros->>'rol' = 'sello';
grant select on sellos_77 to app_rw, app_operador;

-- ═══ 1. Sin nada cargado ════════════════════════════════════════════════════
do $nada$ begin
  if exists (select 1 from app.sello_para('UY')) then raise exception '1. Devolvió un sello sin credencial'; end if;
  if exists (select 1 from app.sello_para('BR')) then raise exception '1. Devolvió un sello sin credencial (BR)'; end if;
end $nada$;

-- ═══ 2. El global cargado: todos lo usan ════════════════════════════════════
-- «Cargar» es lo que hace la consola: credencial cifrada + fecha + quién. Acá
-- el cifrado es de mentira (el ejerce no tiene la clave), el dato que decide es
-- `credencial_puesta_en`.
update proveedor_firma
   set credenciales_cif = 'cifrado-de-mentira-global', credencial_puesta_en = now(), credencial_puesta_por = 'ejerce'
 where codigo = 'sello_plataforma';

do $global$
declare r record;
begin
  select * into r from app.sello_para('UY');
  if r.codigo is distinct from 'sello_plataforma' then raise exception '2. UY usa % y tiene que usar el global', r.codigo; end if;
  if r.ambito is distinct from 'global' then raise exception '2. Ámbito % y es global', r.ambito; end if;
  select * into r from app.sello_para('BR');
  if r.codigo is distinct from 'sello_plataforma' then raise exception '2. BR usa % y tiene que usar el global', r.codigo; end if;
  -- Un país que no tiene fila propia (Argentina) también cae al global.
  select * into r from app.sello_para('AR');
  if r.codigo is distinct from 'sello_plataforma' then raise exception '2. AR usa % y tiene que usar el global', r.codigo; end if;
end $global$;

-- ═══ 3. El de Uruguay cargado: Uruguay el suyo, Brasil el global ════════════
update proveedor_firma
   set credenciales_cif = 'cifrado-de-mentira-uy', credencial_puesta_en = now(), credencial_puesta_por = 'ejerce'
 where codigo = 'sello_plataforma_uy';

do $uy$
declare r record;
begin
  select * into r from app.sello_para('UY');
  if r.codigo is distinct from 'sello_plataforma_uy' then raise exception '3. ⚠ UY usa % y tiene el suyo', r.codigo; end if;
  if r.ambito is distinct from 'UY' then raise exception '3. Ámbito %', r.ambito; end if;
  select * into r from app.sello_para('BR');
  if r.codigo is distinct from 'sello_plataforma' then raise exception '3. BR usa % y tiene que seguir con el global', r.codigo; end if;
  -- Minúsculas: el país llega como lo escriba quien llame.
  select * into r from app.sello_para('uy');
  if r.codigo is distinct from 'sello_plataforma_uy' then raise exception '3. Con «uy» en minúscula devolvió %', r.codigo; end if;
end $uy$;

-- ═══ 4. Apagado en su país, vuelve al global ════════════════════════════════
update proveedor_pais set activo = false
 where proveedor_id = (select id from sellos_77 where codigo = 'sello_plataforma_uy');
do $apagado$
declare r record;
begin
  select * into r from app.sello_para('UY');
  if r.codigo is distinct from 'sello_plataforma' then
    raise exception '4. ⚠ UY sigue usando % con el país apagado', r.codigo;
  end if;
end $apagado$;
update proveedor_pais set activo = true
 where proveedor_id = (select id from sellos_77 where codigo = 'sello_plataforma_uy');

-- ═══ 5. ⚠⚠ Nunca es una opción de firma avanzada ═══════════════════════════
do $nofirma$
declare v_n int; v_ok boolean;
begin
  -- Con credencial cargada y activo en UY, sigue sin aparecer para 'firma'.
  select count(*) into v_n
    from app.proveedores_habilitados('UY', 'firma') h
    join sellos_77 s on s.id = h.proveedor_id;
  if v_n is distinct from 0 then
    raise exception '5. ⚠⚠ El certificado del sitio aparece como proveedor de firma avanzada';
  end if;
  select count(*) into v_n
    from app.proveedores_habilitados('UY', 'identidad') h
    join sellos_77 s on s.id = h.proveedor_id;
  if v_n is distinct from 0 then
    raise exception '5. ⚠⚠ El certificado del sitio aparece como proveedor de identidad';
  end if;

  -- Y no se lo puede convertir en uno: la consola tiene el control de
  -- capacidades por país (el día que exista) y esto es lo que la frena.
  begin
    update proveedor_pais set capacidades = '{sello,firma}'
     where proveedor_id = (select id from sellos_77 where codigo = 'sello_plataforma_uy');
    v_ok := true;
  exception when check_violation then v_ok := false; end;
  if v_ok is distinct from false then
    raise exception '5. ⚠⚠ Se pudo habilitar el certificado del sitio como proveedor de FIRMA en un país';
  end if;
end $nofirma$;

-- ═══ 6. Quien firma resuelve el sello y lee la credencial por la puerta ══════
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
end $ctx$;
do $rw$
declare r record; v_cred text; v_ok boolean;
begin
  select * into r from app.sello_para('UY');
  if r.codigo is distinct from 'sello_plataforma_uy' then
    raise exception '6. app_rw no resolvió el sello de UY (vino %)', r.codigo;
  end if;

  -- La credencial, por la función de la 067: es la que va a usar el adaptador.
  select app.credencial_de_proveedor(r.proveedor_id) into v_cred;
  if v_cred is distinct from 'cifrado-de-mentira-uy' then
    raise exception '6. app_rw no pudo leer la credencial del sello por la función (vino %)', coalesce(v_cred, '<null>');
  end if;

  -- Y directo, no.
  begin
    perform credenciales_cif from proveedor_firma where id = r.proveedor_id;
    v_ok := true;
  exception when insufficient_privilege then v_ok := false; end;
  if v_ok is distinct from false then
    raise exception '6. ⚠⚠ app_rw leyó credenciales_cif directo: el grano fino de la 067 se perdió';
  end if;
end $rw$;

-- Y el firmante externo, que no tiene cuenta, también firma simple.
do $ctx$ begin
  perform set_config('app.actor', 'externo', true);
  perform set_config('app.cuenta_id', '', true);
end $ctx$;
do $externo$
declare r record;
begin
  select * into r from app.sello_para('UY');
  if r.codigo is distinct from 'sello_plataforma_uy' then
    raise exception '6. El firmante externo no resolvió el sello (vino %)', coalesce(r.codigo, '<null>');
  end if;
end $externo$;

reset role;
rollback;
