-- =============================================================================
-- MiFirma — cobertura de la capa de autorización
--
-- Se corre como dueño, DESPUÉS de todas las migraciones. Es el test que hay que
-- correr en CI antes de cada despliegue: no prueba un caso, prueba que no haya
-- quedado una tabla afuera.
--
-- La migración 009 trae una verificación equivalente, pero se ejecuta una sola
-- vez, en su propio momento. Una tabla creada en la 015 sin RLS pasaría sin que
-- nadie se entere. Este archivo cierra ese agujero.
-- =============================================================================

\set ON_ERROR_STOP on

-- ---------- C1: toda tabla tiene RLS, salvo la lista blanca -----------------
--
-- La lista blanca son tablas que NO pertenecen a ninguna cuenta: catálogos que
-- todo el mundo lee y configuración que solo el operador toca. Se protegen por
-- GRANT, no por política. Agregar una tabla acá es una decisión de seguridad:
-- si no está clarísimo por qué no lleva RLS, es que lleva RLS.
do $c1$
declare v text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    and c.relname not in (
      -- Catálogos de lectura pública dentro del producto
      'plan','industria','capacidad','banco','tipo_cuenta_bancaria',
      -- Realm del operador
      'operador','operador_capacidad',
      -- Configuración global que administra el operador
      'pasarela_pago','pasarela_pais','integracion_facturacion','tarifa_ia',
      'correo_config','twilio_config','plantilla_mensaje','traduccion_override'
    );
  if v is not null then
    raise exception 'FALLA C1 — tablas sin RLS y fuera de la lista blanca: %', v;
  end if;
  raise notice 'OK C1 — toda tabla nueva tiene RLS o está declarada como global';
end $c1$;

-- ---------- C2: ninguna tabla con RLS quedó sin políticas -------------------
--
-- `enable row level security` sin políticas no falla: simplemente no devuelve
-- nada. Es el error silencioso más caro de este modelo, porque parece que la
-- funcionalidad se rompió y no que la seguridad falta.
do $c2$
declare v text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    -- Las particiones se excluyen a propósito: llevan RLS sin políticas, que es
    -- deny-all, y las políticas que valen son las del padre (ver C6).
    and not c.relispartition
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if v is not null then
    raise exception 'FALLA C2 — RLS activa sin ninguna política: %', v;
  end if;
  raise notice 'OK C2 — toda tabla con RLS tiene al menos una política';
end $c2$;

-- ---------- C3: la lista blanca no está expuesta a app_rw para escribir -----
--
-- Una tabla sin RLS a la que app_rw pueda escribir es una tabla global editable
-- desde una request de usuario. Los catálogos y la configuración del operador
-- se leen desde la aplicación; se escriben desde la consola.
do $c3$
declare v text;
begin
  select string_agg(distinct c.relname, ', ') into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    and c.relname not in ('plan','industria','capacidad')   -- ni siquiera estos
    and (has_table_privilege('app_rw', c.oid, 'INSERT')
      or has_table_privilege('app_rw', c.oid, 'UPDATE')
      or has_table_privilege('app_rw', c.oid, 'DELETE'));
  if v is not null then
    raise exception 'FALLA C3 — app_rw puede escribir tablas globales: %', v;
  end if;
  raise notice 'OK C3 — app_rw no escribe catálogos ni configuración global';
end $c3$;

-- ---------- C4: el operador no ve contenido de documentos -------------------
--
-- El límite del realm operador no es una política sino un GRANT ausente. Es
-- fácil de romper sin darse cuenta con un `grant select on all tables`.
do $c4$
declare v text;
begin
  select string_agg(t, ', ') into v from unnest(array[
    'archivo','instancia','participacion','circuito','carpeta','otorgamiento',
    'persona','credencial','anclaje_identidad','medio_pago'
  ]) t
  where has_table_privilege('app_operador', ('public.' || t)::regclass, 'SELECT');
  if v is not null then
    raise exception 'FALLA C4 — el operador tiene SELECT sobre contenido: %', v;
  end if;
  raise notice 'OK C4 — el operador no tiene acceso al contenido de los clientes';
end $c4$;

-- ---------- C5: nada quedó accesible a PUBLIC ------------------------------
do $c5$
declare v text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and has_table_privilege('public', c.oid, 'SELECT');
  if v is not null then
    raise exception 'FALLA C5 — tablas legibles por PUBLIC: %', v;
  end if;
  raise notice 'OK C5 — ninguna tabla es legible por PUBLIC';
end $c5$;

-- ---------- C6: las particiones no son puerta trasera ----------------------
--
-- PostgreSQL aplica las políticas de la tabla NOMBRADA en la consulta. Leer
-- `bitacora_plataforma_2026_08` directamente esquiva las políticas del padre.
-- La defensa es doble: RLS propia sin políticas (deny-all) y cero grants.
do $c6$
declare v text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relispartition
    and (not c.relrowsecurity
      or has_table_privilege('app_rw', c.oid, 'SELECT')
      or has_table_privilege('app_operador', c.oid, 'SELECT'));
  if v is not null then
    raise exception 'FALLA C6 — particiones alcanzables sin pasar por el padre: %', v;
  end if;
  raise notice 'OK C6 — las particiones no se pueden consultar directamente';
end $c6$;
