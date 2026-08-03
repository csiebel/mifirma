-- =============================================================================
-- MiFirma — 034_borrar_borrador.sql
-- Borrar de verdad un borrador que nunca se despachó, y sólo eso.
--
-- ═══ EL PROBLEMA ═══
--
-- No había forma de sacar nada del repositorio. Todo el dominio tiene la
-- política de borrado en `false` —circuito, instancia, participación, archivo,
-- ubicación, otorgamiento— y eso es correcto para casi todo: los bytes de un
-- documento firmado no se borran, el otorgamiento del firmante es irrevocable,
-- y hay plazos legales de conservación.
--
-- Pero convertía un PDF subido por error en algo permanente. Un archivo que
-- nadie recibió, nadie abrió y nadie firmó no es prueba de nada: es un error de
-- dedo, y obligar a arrastrarlo para siempre es acumular basura con aire de
-- solemnidad.
--
-- ═══ LA REGLA, Y DÓNDE VIVE ═══
--
-- Las políticas SIGUEN en `false`. No se aflojan. La única puerta es esta
-- función `security definer`, que comprueba la condición que hace que borrar
-- sea inocuo:
--
--   · el circuito está en `borrador`, y
--   · NO existe ni un otorgamiento emitido sobre ninguna de sus instancias.
--
-- ⚠ La segunda es la que importa, y no es redundante con la primera. El estado
-- es una columna que alguien podría cambiar; el otorgamiento es el hecho de que
-- alguien de afuera recibió acceso. **Si una sola persona pudo abrir el
-- documento, ya no es un borrador**, diga lo que diga la columna. Que la
-- condición sea «no hay otorgamientos» y no «el estado dice borrador» es lo que
-- hace que esto no se pueda usar para borrar algo que ya salió.
--
-- Y va en la base y no en la aplicación por la regla de oro nº2: un `if` en
-- TypeScript se puede saltear con otra ruta; esto no.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create or replace function app.borrar_borrador(p_circuito uuid)
returns table (archivo_id uuid, clave text, huerfano boolean)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_cuenta   uuid;
  v_archivo  uuid;
  v_carpeta  uuid;
begin
  -- 1) ¿Existe, es de mi cuenta y está en borrador?
  select c.cuenta_propietaria_id, c.archivo_base_id
    into v_cuenta, v_archivo
    from public.circuito c
   where c.id = p_circuito and c.estado = 'borrador'
     and c.cuenta_propietaria_id = app.cuenta_actual();
  if v_cuenta is null then
    raise exception 'ese documento no existe, no es tuyo, o ya se despachó'
      using errcode = '42501';
  end if;

  -- 2) ⚠ LA CONDICIÓN QUE IMPORTA. Un solo otorgamiento y esto se termina acá.
  if exists (
    select 1 from public.otorgamiento o
      join public.instancia i on i.id = o.instancia_id
     where i.circuito_id = p_circuito
  ) then
    raise exception 'ese documento ya salió: alguien tiene acceso y no se puede borrar'
      using errcode = '42501';
  end if;

  -- 3) ¿Tengo permiso en la carpeta donde está?
  --
  -- Borrar es organizar. Quien puede crear en una carpeta pero no organizarla
  -- puede subir documentos y no sacarlos, que es exactamente lo que se espera
  -- de un permiso de sólo agregar.
  select u.carpeta_id into v_carpeta
    from public.ubicacion u
   where u.circuito_id = p_circuito and u.cuenta_id = v_cuenta;
  if v_carpeta is not null and not app.puede_en_carpeta(v_carpeta, 'organizar') then
    raise exception 'no tenés permiso para sacar documentos de esa carpeta'
      using errcode = '42501';
  end if;

  -- 4) Abajo hacia arriba. `marca_firma` y `participacion` cuelgan con
  --    ON DELETE CASCADE de participación, pero la evidencia y la ubicación no.
  delete from public.evidencia e
   using public.instancia i
   where e.instancia_id = i.id and i.circuito_id = p_circuito;

  delete from public.marca_firma where circuito_id = p_circuito;
  delete from public.participacion where circuito_id = p_circuito;
  delete from public.ubicacion where circuito_id = p_circuito;
  delete from public.ubicacion u
   using public.instancia i
   where u.instancia_id = i.id and i.circuito_id = p_circuito;
  delete from public.instancia where circuito_id = p_circuito;
  delete from public.circuito where id = p_circuito;

  -- 5) El archivo se borra sólo si no quedó nadie usándolo.
  --
  -- ⚠ `subirDocumento` REUSA la fila cuando la misma cuenta sube dos veces el
  -- mismo contenido: el mismo `archivo` puede sostener tres circuitos. Borrarlo
  -- sin mirar dejaría a los otros dos apuntando a un blob que ya no está, y eso
  -- se descubre el día que alguien intenta firmar.
  return query
    with quedan as (
      select exists (select 1 from public.circuito c where c.archivo_base_id = v_archivo)
          or exists (select 1 from public.instancia i where i.archivo_vigente_id = v_archivo
                                                        or i.archivo_firmado_id = v_archivo) as usado
    ),
    borrado as (
      delete from public.archivo a
       where a.id = v_archivo and not (select usado from quedan)
      returning a.id, a.clave_almacenamiento
    )
    select v_archivo, b.clave_almacenamiento, true from borrado b
    union all
    select v_archivo, null::text, false where (select usado from quedan);
end $$;

revoke all on function app.borrar_borrador(uuid) from public;
grant execute on function app.borrar_borrador(uuid) to app_rw;

comment on function app.borrar_borrador(uuid) is
  'Única puerta para borrar un documento. Exige borrador SIN NINGÚN otorgamiento '
  'emitido: si alguien pudo abrirlo, ya no es un borrador. Ver migración 034.';

commit;

-- Control: las políticas de borrado siguen cerradas. Si alguna se aflojó junto
-- con esto, la puerta dejó de ser una.
do $control$
declare v_mal text := '';
begin
  select string_agg(format(E'\n  %s.%s', c.relname, p.polname), '')
    into v_mal
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where p.polcmd = 'd'
     and c.relname in ('circuito','instancia','participacion','archivo','ubicacion','otorgamiento','evidencia')
     and pg_get_expr(p.polqual, p.polrelid) <> 'false';
  if v_mal is not null then
    raise exception E'Hay políticas de borrado abiertas en el dominio:%s', v_mal;
  end if;
end $control$;
