-- =============================================================================
-- MiFirma — test/migraciones/ejerce/057_migracion_aplicada.sql
--
-- La prueba de COMPORTAMIENTO de la 057. `probar.sh` la corre sola después de
-- las dos pasadas.
--
-- ═══ QUÉ DECIDE ═══
--
-- Correr la migración dos veces prueba que **entra**. Lo que importa de ésta es
-- otra cosa: que la tabla **nace cerrada**.
--
-- `migracion_aplicada` dice qué se corrió y cuándo sobre la base de un producto
-- de firma. No es información de cliente, pero sí es un mapa del sistema, y la
-- aplicación no tiene ninguna razón para poder leerlo. La decisión fue RLS
-- habilitada, cero políticas y cero `grant` — y eso no se ve en el catálogo de
-- columnas: se ve preguntando.
--
-- ⚠ El centinela de `009_rls.sql` comprueba que la tabla tenga RLS **prendida**.
-- No comprueba que no tenga grants, y una tabla con RLS y un `grant select` a
-- `app_rw` seguiría pasando aquel control. Por eso las dos preguntas se hacen
-- acá.
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ⚠ EL CINTURÓN. La base de producción también se llama `mifirma`, así que el
-- guard del nombre no alcanza: se exige la marca que sólo pone `base-minima.sql`.
-- Éste no escribe datos, pero la regla es la misma para todos los `ejerce`: si
-- un día se le agrega un insert, el cinturón ya está puesto.
do $guard$ begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = 'banco_de_pruebas') then
    raise exception 'ABORTADO: no encuentro la marca del banco. Si esto es la base real, MENOS MAL.';
  end if;
end $guard$;

-- ── 1. La tabla existe y tiene RLS prendida ─────────────────────────────────
do $rls$ begin
  if not exists (select 1 from pg_class where relname = 'migracion_aplicada' and relrowsecurity) then
    raise exception 'migracion_aplicada no tiene RLS. El centinela de la 009 va a fallar, y con razón.';
  end if;
end $rls$;

-- ── 2. Sin políticas: con RLS prendida, eso significa que nadie ve nada ─────
do $pol$
declare v_n int;
begin
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'migracion_aplicada';
  if v_n <> 0 then
    raise exception
      'migracion_aplicada tiene % política(s). Se diseñó sin ninguna: si hace falta una, hay que decidirlo, no que aparezca.', v_n;
  end if;
end $pol$;

-- ── 3. ⚠ Y ningún grant a los roles de la aplicación ────────────────────────
--
-- Ésta es la que de verdad protege. RLS sin grant es cinturón y tirantes; con
-- grant y sin política, el día que alguien agregue una política permisiva la
-- tabla queda abierta sin que nadie lo haya decidido.
do $grants$
declare v_quien text;
begin
  select string_agg(distinct grantee || ' (' || privilege_type || ')', ', ') into v_quien
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'migracion_aplicada'
     and grantee in ('app_rw', 'app_operador', 'mifirma_app', 'public');
  if v_quien is not null then
    raise exception
      'migracion_aplicada tiene privilegios concedidos a: %. La aplicación no tiene por qué verla.', v_quien;
  end if;
end $grants$;

-- ── 4. El relleno entró completo, sin agujeros del 001 al 056 ───────────────
--
-- Es el mismo control que hace la migración. Se repite acá a propósito: el de
-- la migración corre una sola vez, sobre la base que le toque; éste corre en el
-- banco cada vez que alguien la prueba, y es el que va a avisar si alguien edita
-- la lista más adelante.
do $relleno$
declare v_faltan text;
begin
  select string_agg(lpad(g::text, 3, '0'), ', ' order by g) into v_faltan
    from generate_series(1, 56) g
   where not exists (
     select 1 from migracion_aplicada m where m.nombre like lpad(g::text, 3, '0') || '\_%'
   );
  if v_faltan is not null then
    raise exception 'El relleno tiene agujeros: falta la migración %.', v_faltan;
  end if;
end $relleno$;

-- ── 5. Y se anotó a sí misma ────────────────────────────────────────────────
do $propia$ begin
  if not exists (select 1 from migracion_aplicada where nombre = '057_migracion_aplicada.sql') then
    raise exception 'La 057 no se anotó a sí misma: el que migra la va a querer aplicar de nuevo.';
  end if;
end $propia$;

\echo '   ✓ nace cerrada (RLS, sin políticas, sin grants) y el relleno está completo'
