-- =============================================================================
-- MiFirma — 043_certificado_visible.sql
--
-- El botón «Certificado» no podía descargar el certificado. Es el MISMO defecto
-- que arregló la 039, en otro archivo: una consulta con INNER JOIN contra
-- `archivo`, y `archivo_select` sin ninguna rama que alcance esa fila.
--
-- ═══ LAS CUATRO FORMAS DE SER UN ARCHIVO ═══
--
-- `archivo` recibe cuatro claves foráneas, y hasta hoy la política cubría tres:
--
--   circuito.archivo_base_id                el PDF original          ✓
--   instancia.archivo_vigente_id            el que se está firmando  ✓ (039)
--   instancia.archivo_firmado_id            el definitivo            ✓
--   certificado_finalizacion.archivo_id     el certificado           ✗ ← acá
--
-- El certificado se emitía bien, se guardaba bien, y era invisible. La consulta
-- que lo baja hace `join archivo a on a.id = cf.archivo_id`: sin rama en la
-- política, la fila entera desaparece y el servicio contesta que no existe.
--
-- ⚠ Y quedaba peor que un error: como no lo encontraba, lo volvía a emitir, no
-- lo encontraba de nuevo, y contestaba «no pudimos emitirlo». Un mensaje que
-- acusa al paso equivocado. El certificado ya estaba emitido desde la primera
-- vez — el `on conflict (instancia_id) do nothing` evitó que se duplicara, que
-- es lo único que salió bien de esa cadena.
--
-- ═══ QUIÉN LO PUEDE VER ═══
--
-- Exactamente los mismos que ya pueden ver la FILA del certificado, según
-- `cert_select` de la migración 035: la cuenta emisora y quien tenga
-- otorgamiento de metadatos —o sea, cada firmante—. Que se pudiera leer el
-- registro y no el archivo era la incoherencia; se elimina usando el mismo
-- predicado, no uno parecido.
--
-- ⚠ El operador NO entra, aunque `cert_select` lo nombre. Ahí se le permite ver
-- que el certificado existe, para soporte; el archivo es contenido del cliente
-- y no le está otorgado `archivo`. Sigue sin estarlo.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create or replace function app.puede_ver_certificado(p_archivo uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.certificado_finalizacion cf
     where cf.archivo_id = p_archivo
       and (
         (cf.cuenta_propietaria_id = app.cuenta_actual()
          and app.es_miembro(cf.cuenta_propietaria_id))
         or app.tiene_otorgamiento(cf.circuito_id, cf.instancia_id, 'metadatos')
       )
  )
$$;

revoke all on function app.puede_ver_certificado(uuid) from public;
grant execute on function app.puede_ver_certificado(uuid) to app_rw;

comment on function app.puede_ver_certificado(uuid) is
  'Si ese archivo es un certificado de finalización que el actor puede leer. '
  'Mismo predicado que cert_select, a propósito. Ver migración 043.';

drop policy archivo_select on archivo;

create policy archivo_select on archivo for select using (
  app.actor() = 'sistema'

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

  -- El certificado de finalización. Sin carpeta y sin ubicación: no es un
  -- documento del repositorio, es la prueba de uno.
  or app.puede_ver_certificado(archivo.id)
);

commit;

-- -----------------------------------------------------------------------------
-- CENTINELA DEL ARCHIVO INVISIBLE
--
-- Dos veces el mismo error en un día: se agrega una tabla que apunta a
-- `archivo`, se la consulta con INNER JOIN, y nadie se acuerda de la política.
-- El síntoma nunca dice «falta una política»: dice «ese documento no existe».
--
-- Esto no arregla nada — avisa. Cada clave foránea nueva contra `archivo` tiene
-- que aparecer nombrada en la política o en alguna función que la política
-- llame. Si aparece una que no, la migración que la agregó falla acá y no seis
-- semanas después con un usuario mirando un error que acusa al paso equivocado.
-- -----------------------------------------------------------------------------
do $centinela_archivo$
declare
  v_texto  text;
  v_previo text := '';
  v_col    text;
  v_tabla  text;
  v_mal    text := '';
  v_vuelta int := 0;
begin
  select pg_get_expr(p.polqual, p.polrelid) into v_texto
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'archivo' and p.polname = 'archivo_select';

  -- ⚠ SÓLO las funciones que la política REALMENTE llama, y las que ésas
  -- llaman. La primera versión de esto concatenaba todo el esquema app y no
  -- servía para nada: `es_version_de_instancia` nombra las dos columnas de
  -- instancia, así que la comprobación pasaba aunque la política estuviera
  -- vacía. Se probó vaciándola a propósito, que es la única forma de saber si
  -- un centinela centinela algo.
  while v_texto <> v_previo and v_vuelta < 4 loop
    v_previo := v_texto;
    v_vuelta := v_vuelta + 1;
    select v_texto || ' ' || coalesce(string_agg(pg_get_functiondef(pr.oid), ' '), '')
      into v_texto
      from pg_proc pr
     where pr.pronamespace = 'app'::regnamespace
       and position('app.' || pr.proname || '(' in v_previo) > 0;
  end loop;

  for v_tabla, v_col in
    select con.conrelid::regclass::text, a.attname
      from pg_constraint con
      join unnest(con.conkey) k on true
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
     where con.contype = 'f' and con.confrelid = 'public.archivo'::regclass
  loop
    if position(v_col in v_texto) = 0 then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_col);
    end if;
  end loop;

  if v_mal <> '' then
    raise exception
      E'Columnas que apuntan a archivo y que archivo_select no alcanza:%s\n'
      'Un archivo sin rama en la política existe, se guarda y es invisible: la '
      'consulta que lo trae con INNER JOIN pierde la fila entera y el usuario '
      'lee "ese documento no existe". Agregá la rama o la función que la cubra.',
      v_mal;
  end if;
end $centinela_archivo$;

-- Centinela de la 026.
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento|marca_firma|firma_visual|certificado_finalizacion|registro_pendiente|campo|valor_campo)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;
