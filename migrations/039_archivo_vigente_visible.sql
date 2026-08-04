-- =============================================================================
-- MiFirma — 039_archivo_vigente_visible.sql
--
-- Arregla el motivo por el que **ningún circuito de más de un firmante podía
-- completarse**: el segundo firmante recibía «Este enlace ya no está
-- disponible.» al apretar Firmar, con el enlace perfectamente vivo.
--
-- ═══ QUÉ PASABA ═══
--
-- Una instancia tiene tres punteros a archivo:
--
--   circuito.archivo_base_id     el PDF original, antes de toda firma
--   instancia.archivo_vigente_id el PDF tal como está AHORA, con las firmas
--                                que ya se aplicaron
--   instancia.archivo_firmado_id el definitivo — se escribe SÓLO cuando firma
--                                el último, y ya no se puede volver a tocar
--
-- `firmar()` firma sobre el vigente, no sobre el base: hacerlo sobre el
-- original borraría las firmas anteriores. Por eso su primera consulta hace
--
--     join archivo a on a.id = coalesce(i2.archivo_vigente_id, c.archivo_base_id)
--
-- y la política `archivo_select` tenía ramas para `archivo_base_id` y para
-- `archivo_firmado_id` — **y ninguna para `archivo_vigente_id`**.
--
-- Con un solo firmante no se nota: `archivo_vigente_id` está en null hasta que
-- firma, el `coalesce` cae en el base, y el base sí es visible. Con dos, el
-- primero deja el vigente apuntando al PDF intermedio, y para el segundo ese
-- archivo no existe. El `join` es INNER, así que la fila entera desaparece y el
-- servicio, que no puede distinguir «no tenés permiso» de «no está», contesta
-- lo único que sabe decir: que el enlace ya no está disponible.
--
-- Es exactamente la trampa que está anotada en `abrirParaFirmar`, donde los
-- joins son LEFT a propósito para que la falta se vea como un campo vacío y no
-- como una fila ausente. La consulta de firmar no tenía esa protección.
--
-- ═══ POR QUÉ SE ARREGLA ACÁ Y NO EN LA CONSULTA ═══
--
-- Porque no es un problema de esa consulta: el archivo vigente **es** parte del
-- documento y quien tiene otorgamiento de lectura sobre la instancia tiene que
-- poder verlo. Con el agujero abierto también fallan `verificarFirmas` (404 en
-- un documento a medio firmar) y cualquier cosa que se escriba mañana contra el
-- vigente. Taparlo en cada consulta sería contestar tres veces la misma
-- pregunta y dejar la cuarta sin contestar.
--
-- Y hay una razón de fondo: el segundo firmante tiene que poder ver lo que
-- firma, que incluye lo que firmó el primero. Negarle ese archivo no era una
-- protección, era un error.
--
-- ⚠ Lo que NO cambia: el alcance sigue siendo por INSTANCIA. En modo copias
-- cada firmante tiene la suya, y su otorgamiento no alcanza la instancia del
-- otro — así que nadie pasa a ver el documento a medio firmar de un tercero.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Una sola idea, nombrada una sola vez: qué archivos son VERSIONES de una
-- instancia. Antes estaba escrita dos veces y a medias.
--
-- `security definer` para que el predicado no arrastre la RLS de `instancia`
-- adentro de la política de `archivo`, que sería recursivo.
-- -----------------------------------------------------------------------------
create or replace function app.es_version_de_instancia(p_archivo uuid, p_instancia uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.instancia i
     where i.id = p_instancia
       and (i.archivo_firmado_id = p_archivo or i.archivo_vigente_id = p_archivo)
  )
$$;

revoke all on function app.es_version_de_instancia(uuid, uuid) from public;
grant execute on function app.es_version_de_instancia(uuid, uuid) to app_rw;

comment on function app.es_version_de_instancia(uuid, uuid) is
  'Si ese archivo es una versión de esa instancia: el definitivo o el vigente. '
  'El vigente es sobre el que firma el próximo. Ver migración 039.';

-- -----------------------------------------------------------------------------
-- La política, con las dos ramas de instancia ampliadas.
--
-- Se reescribe entera —y no con un `alter`— porque una política no se parchea:
-- o queda escrita completa donde se pueda leer de una sola vez, o dentro de dos
-- migraciones nadie sabe qué dice de verdad.
--
-- Las cinco ramas, en orden:
--   1. el sistema
--   2. custodia + una versión de la instancia, ubicada en carpeta que puede leer
--   3. custodia + el archivo base del circuito, ídem
--   4. otorgamiento sobre la instancia, para sus versiones
--   5. otorgamiento sobre el circuito (o sobre una instancia suya), para el base
-- -----------------------------------------------------------------------------
drop policy archivo_select on archivo;

create policy archivo_select on archivo for select using (
  app.actor() = 'sistema'

  -- 2. El dueño del archivo, si el documento está en una carpeta que puede leer.
  --    ⚠ Acá estaba la mitad del agujero: con sólo `archivo_firmado_id`, el
  --    emisor tampoco podía abrir su propio documento a medio firmar.
  or (cuenta_custodia_id = app.cuenta_actual() and exists (
        select 1 from instancia i
          join ubicacion u on (u.instancia_id = i.id or u.circuito_id = i.circuito_id)
         where app.es_version_de_instancia(archivo.id, i.id)
           and u.cuenta_id = app.cuenta_actual()
           and app.puede_en_carpeta(u.carpeta_id, 'leer')))

  or (cuenta_custodia_id = app.cuenta_actual() and exists (
        select 1 from circuito c
          join ubicacion u on u.circuito_id = c.id
         where c.archivo_base_id = archivo.id
           and u.cuenta_id = app.cuenta_actual()
           and app.puede_en_carpeta(u.carpeta_id, 'leer')))

  -- 4. El firmante externo. Su otorgamiento es de INSTANCIA, así que ve las
  --    versiones de SU instancia y de ninguna otra.
  or exists (
        select 1 from instancia i
         where app.es_version_de_instancia(archivo.id, i.id)
           and app.tiene_otorgamiento(i.circuito_id, i.id, 'leer'))

  or exists (
        select 1 from circuito c
         where c.archivo_base_id = archivo.id
           and app.tiene_otorgamiento(c.id, null::uuid, 'leer'))

  or exists (
        select 1 from circuito c join instancia i on i.circuito_id = c.id
         where c.archivo_base_id = archivo.id
           and app.tiene_otorgamiento(c.id, i.id, 'leer'))
);

commit;

-- Centinela de la 026: ninguna política legible por `app_operador` puede nombrar
-- tablas del dominio. `archivo` no le está otorgada, así que las ramas de arriba
-- no le cobran nada — pero se comprueba, no se supone.
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento|marca_firma|certificado_finalizacion|registro_pendiente|campo|valor_campo)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;
