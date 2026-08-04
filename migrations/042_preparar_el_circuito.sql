-- =============================================================================
-- MiFirma — 042_preparar_el_circuito.sql
--
-- Dos cosas que la pantalla de preparación necesita y la base no permitía.
--
-- ═══ 1. QUITAR UN FIRMANTE NUNCA FUNCIONÓ ═══
--
-- `quitarFirmante` hace `delete from participacion` desde el 006. **`app_rw` no
-- tiene DELETE sobre esa tabla**, así que siempre falló con «permission denied
-- for table participacion». Lo mismo con `definirCampos`, que borra el juego de
-- campos antes de reescribirlo: `app_rw` tampoco tiene DELETE sobre `campo`, y
-- eso lo escribí yo hace unas horas en la 038.
--
-- ⚠ No es un olvido de GRANT nada más: la política `participacion_delete` decía
-- `using (false)`. Estaba prohibido dos veces, y ninguna de las dos veces se
-- notó, porque el camino no tiene prueba.
--
-- Se abre con el permiso más angosto que sirve: el dueño del circuito, mientras
-- esté en BORRADOR. Después del despacho una participación no se borra —hay
-- gente notificada y otorgamientos emitidos— y para eso está cancelar.
--
-- ═══ 2. EL ORDEN DE FIRMA NO SE PODÍA CAMBIAR ═══
--
-- `participacion.orden` se asigna al agregar (`parts.length + 1`) y no había
-- forma de tocarlo después: ni ruta, ni servicio, ni pantalla. Quien se
-- equivocaba al cargar tenía que borrar a todos y volver a empezar — y borrar
-- tampoco andaba.
--
-- Reordenar no necesita esquema nuevo: `participacion_update` ya deja al dueño
-- de la cuenta cambiar sus filas y no hay índice único sobre (instancia,
-- orden), así que la renumeración es un update y ya. Lo que sí hace falta es
-- que sólo se pueda en borrador, y eso lo pone este trigger — no el servicio,
-- porque el orden después del despacho ya se le comunicó a las personas y
-- moverlo es cambiarle el turno a alguien que ya recibió su correo.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. Un solo nombre para «el dueño, preparando, en borrador»
--
-- Es el predicado que ya usaba `app.puede_definir_marcas`, pero su nombre habla
-- de marcas y ahora gobierna tres cosas más. Se define una vez con el nombre
-- que corresponde y la vieja pasa a llamarla: mismo comportamiento, una sola
-- definición. Renombrarla a secas rompería la política de `marca_firma`.
-- -----------------------------------------------------------------------------
create or replace function app.puede_preparar_circuito(p_circuito uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.circuito c
      join public.ubicacion u on u.circuito_id = c.id and u.cuenta_id = app.cuenta_actual()
     where c.id = p_circuito
       and c.cuenta_propietaria_id = app.cuenta_actual()
       -- Después del despacho no se prepara más: hay gente notificada.
       and c.estado = 'borrador'
       and app.puede_en_carpeta(u.carpeta_id, 'enviar')
  )
$$;

create or replace function app.puede_definir_marcas(p_circuito uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$ select app.puede_preparar_circuito(p_circuito) $$;

revoke all on function app.puede_preparar_circuito(uuid) from public;
grant execute on function app.puede_preparar_circuito(uuid) to app_rw;

comment on function app.puede_preparar_circuito(uuid) is
  'El dueño del circuito, mientras esté en borrador, con permiso de enviar en '
  'su carpeta. Gobierna agregar y quitar firmantes, reordenarlos, definir '
  'campos y definir marcas. Ver migración 042.';

-- -----------------------------------------------------------------------------
-- 2. Quitar un firmante, y quitar un campo
--
-- El GRANT y la política, que son dos permisos distintos y hacían falta los
-- dos. Sin el GRANT, PostgreSQL ni llega a evaluar la política.
-- -----------------------------------------------------------------------------
grant delete on participacion to app_rw;
grant delete on campo to app_rw;

drop policy participacion_delete on participacion;

create policy participacion_delete on participacion for delete using (
  app.actor() = 'sistema'
  or app.puede_preparar_circuito(circuito_id)
);

-- `campo` ya tenía su política de escritura (038) y el trigger
-- `campo_solo_en_borrador` cubre el borrado; faltaba nada más el GRANT.

-- -----------------------------------------------------------------------------
-- 3. El orden sólo se toca en borrador
--
-- Va en un trigger y no en el servicio por la razón de siempre: es una regla
-- del dato, no de una pantalla. El día que el orden se cambie desde la API, un
-- lote o un script de soporte, la regla tiene que seguir puesta.
--
-- ⚠ Lo que NO se congela es `estado` ni las columnas del acto de firmar: una
-- participación despachada cambia de estado todo el tiempo, que es su trabajo.
-- -----------------------------------------------------------------------------
create or replace function participacion_orden_congelado() returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_estado text;
begin
  if new.orden is distinct from old.orden then
    select c.estado into v_estado from public.circuito c where c.id = new.circuito_id;
    if v_estado <> 'borrador' then
      raise exception
        'el documento ya se despachó: el orden de firma no se cambia, porque a los '
        'firmantes ya se les dijo cuándo les toca'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger participacion_orden_trg before update on participacion
  for each row execute function participacion_orden_congelado();

commit;

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
