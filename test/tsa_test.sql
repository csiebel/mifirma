-- =============================================================================
-- MiFirma — ¿el rol de la aplicación puede leer las autoridades de sellado?
--
-- ⚠ SE CORREN COMO app_rw, igual que rls_test.sql. Conectarse como postgres está
--   bien: el `set role` de abajo cambia de rol dentro de la sesión, y la guarda
--   comprueba que después de ese cambio la RLS efectivamente se aplique.
--
-- ═══ POR QUÉ EXISTE ESTE ARCHIVO ═══
--
-- Por un bug que casi entra en producción. `autoridades()` consultaba `tsa` sin
-- fijar contexto RLS. La consulta NO falla: devuelve cero filas, porque
-- `app.actor()` sin contexto es 'anonimo' y la política sólo admite 'operador' y
-- 'sistema'. El documento habría salido SIN SELLO sin que nada diera error.
--
-- Y el sello de una firma no se puede agregar después. Una lista vacía se
-- arregla mañana; esto se pierde para siempre.
-- =============================================================================

\set ON_ERROR_STOP on

set role app_rw;

do $guarda$ begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    raise exception 'ABORTADO: corriendo como % y el superusuario saltea RLS', current_user;
  end if;
  if not current_setting('row_security')::boolean then
    raise exception 'ABORTADO: row_security está apagado en esta sesión';
  end if;
  if exists (select 1 from pg_class c join pg_roles r on r.oid = c.relowner
              where c.relname = 'tsa' and r.rolname = current_user) then
    raise exception 'ABORTADO: % es dueño de las tablas y saltea RLS', current_user;
  end if;
  raise notice 'Corriendo como % — RLS activa', current_user;
end $guarda$;

do $t$
declare n int;
begin
  -- T1 · Sin contexto no se ve nada. Es lo correcto, y es exactamente lo que
  --      hacía el código con el bug: no fallaba, no veía.
  perform set_config('app.actor', '', true);
  select count(*) into n from tsa;
  if n <> 0 then raise exception 'T1 FALLA: sin contexto se ven % autoridades', n; end if;
  raise notice 'T1 OK  · sin contexto: 0 autoridades (correcto)';

  -- T2 · Como sistema sí. Es el camino que usa la firma, y el que estaba roto.
  perform set_config('app.actor', 'sistema', true);
  select count(*) into n from tsa where activa;
  if n = 0 then
    raise exception 'T2 FALLA: como sistema no se ve ninguna autoridad activa. '
                    'O no hay ninguna cargada, o la política las tapa.';
  end if;
  raise notice 'T2 OK  · como sistema: % autoridades activas', n;

  -- T3 · Una cuenta cliente no ve el catálogo, y menos las credenciales.
  perform set_config('app.actor', 'cuenta', true);
  select count(*) into n from tsa;
  if n <> 0 then raise exception 'T3 FALLA: una cuenta ve % autoridades', n; end if;
  raise notice 'T3 OK  · como cuenta: 0 autoridades (correcto)';

  -- T4 · El firmante externo puede consultar la regla de país. La necesita, y
  --      no pertenece a ninguna cuenta.
  perform set_config('app.actor', 'externo', true);
  if app.sello_obligatorio('UY', 'simple') is null then
    raise exception 'T4 FALLA: app.sello_obligatorio devolvió null';
  end if;
  raise notice 'T4 OK  · app.sello_obligatorio(UY,simple) = %', app.sello_obligatorio('UY','simple');
end $t$;

reset role;

select pais, nivel_firma, sello_obligatorio,
       coalesce(verificado_por, 'SIN VERIFICAR POR ABOGADO') as estado
  from pais_firma order by pais, nivel_firma;
