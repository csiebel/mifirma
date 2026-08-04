-- =============================================================================
-- MiFirma — 040_firmante_pone_su_rubrica.sql
--
-- Quien pone su rúbrica en un documento es EL FIRMANTE, en el acto de firmar.
-- No el emisor, y no en el armado del envío.
--
-- Eso ya estaba respetado en lo esencial: `firma_visual` cuelga de la
-- IDENTIDAD —«una persona tiene UNA firma, no una por empresa donde trabaja»— y
-- al firmar, `marcasDelFirmante` va a buscar la imagen al perfil del firmante.
-- El emisor nunca aporta la imagen de nadie.
--
-- Lo que faltaba eran las dos puertas de quien NO tiene cuenta:
--
--   1. No podía cargar su firma. Las tres políticas de `firma_visual` exigen
--      `app.identidad_probada()`, que pide un anclaje probado EN ESTA SESIÓN, y
--      `withExterno` no declara ninguno a propósito: abrir un enlace no prueba
--      identidad. Resultado: el externo firmaba siempre sin nada estampado y el
--      expediente anotaba «el firmante no tiene cargada su firma».
--
--   2. No podía COLOCAR una marca, sólo mover una existente. El INSERT lo
--      gobierna `app.puede_definir_marcas` —el emisor, en borrador—. Si el
--      emisor no dejaba caja, no había forma de que apareciera su rúbrica.
--
-- ═══ LA REGLA QUE SE IMPLEMENTA ═══
--
-- **El emisor propone, el firmante ajusta.** El emisor reserva el lugar
-- mientras el circuito está en borrador —la línea de firma del contrato—, y el
-- firmante puede moverla, y además agregar rúbricas propias donde le sirva.
--
-- El esquema ya lo tenía previsto y sin usar: `x_propuesta` / `y_propuesta`
-- guardan lo que pidió el emisor y `x` / `y` dónde quedó. Faltaba el permiso.
--
-- ⚠ Lo que el firmante NO puede es borrar la marca que propuso el emisor. Mover
-- una firma que tapa un párrafo es acomodar; hacerla desaparecer es firmar en
-- otro lado del que se pidió. Se distingue por `creada_por`.
--
-- ═══ Y DE PASO SE CIERRA UN AGUJERO ═══
--
-- `app.puede_mover_marca` pedía otorgamiento de firma sobre la instancia y que
-- la participación estuviera abierta — **pero no que la participación fuera del
-- que la mueve**. En un circuito en serie todos los firmantes comparten la
-- misma instancia y todos tienen ese otorgamiento, así que cualquiera podía
-- correr la rúbrica de otro. Nunca se notó porque la pantalla sólo muestra las
-- propias; la pantalla no es el permiso.
--
-- Molesta hoy y sería grave a partir de esta migración, porque el mismo
-- predicado va a gobernar el alta y la baja.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. La marca es coherente con su participación, siempre
--
-- `marca_firma` repite `instancia_id`, `circuito_id` y `cuenta_propietaria_id`,
-- que son derivables de `participacion_id`. Mientras las escribía sólo el
-- emisor eso era denormalización para no hacer joins. Desde acá las escribe
-- también el firmante, y tres columnas que el cliente elige y la política
-- después consulta son tres columnas que el cliente puede mentir: una marca con
-- `participacion_id` propio y `cuenta_propietaria_id` ajeno se le aparecería a
-- los miembros de esa otra cuenta, porque `marca_select` mira esa columna.
--
-- Se resuelve no dejando que sean un dato de entrada. El trigger es BEFORE, así
-- que la política evalúa los valores YA derivados: no hay ventana.
-- -----------------------------------------------------------------------------
create or replace function marca_coherente() returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_circuito uuid; v_instancia uuid; v_cuenta uuid;
begin
  select p.circuito_id, p.instancia_id, p.cuenta_propietaria_id
    into v_circuito, v_instancia, v_cuenta
    from public.participacion p where p.id = new.participacion_id;

  if v_circuito is null then
    raise exception 'esa participación no existe' using errcode = '23503';
  end if;

  new.circuito_id           := v_circuito;
  new.instancia_id          := v_instancia;
  new.cuenta_propietaria_id := v_cuenta;
  return new;
end $$;

create trigger marca_coherente_trg before insert or update on marca_firma
  for each row execute function marca_coherente();

comment on function marca_coherente() is
  'Deriva circuito, instancia y cuenta de la participación. No son un dato de '
  'entrada: la política los consulta, así que el cliente no los elige. Ver 040.';

-- -----------------------------------------------------------------------------
-- 2. Mover, agregar y quitar: el mismo permiso, y ahora sí acotado a UNO
--
-- Cambia respecto de la versión anterior:
--   · la participación tiene que ser DEL ACTOR (era el agujero)
--   · tiene que ser de firmante, no de copia informativa
--   · el trío participación/circuito/instancia tiene que ser coherente
--   · se suman 'vencida' y 'cancelada' a los estados cerrados — la 037 agregó
--     el segundo y este predicado se había quedado sin enterarse
-- -----------------------------------------------------------------------------
create or replace function app.puede_mover_marca(
  p_circuito uuid, p_instancia uuid, p_participacion uuid
) returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select app.tiene_otorgamiento(p_circuito, p_instancia, 'firmar')
     and exists (
       select 1 from public.participacion p
        where p.id = p_participacion
          and p.circuito_id  = p_circuito
          and p.instancia_id = p_instancia
          and p.identidad_id = app.identidad_actual()
          and p.papel = 'firmante'
          and p.estado not in ('firmada','rechazada','no_requerida',
                               'delegada','vencida','cancelada')
     )
$$;

comment on function app.puede_mover_marca(uuid, uuid, uuid) is
  'El firmante sobre SU propia participación, mientras no la haya cerrado. '
  'Gobierna mover, agregar y quitar su rúbrica. Ver migración 040.';

-- -----------------------------------------------------------------------------
-- 3. La marca propia: el firmante la crea
--
-- El tope de cuántas no vive acá: el índice único (participacion_id, tipo,
-- pagina) ya deja una firma y una rúbrica por hoja y por firmante. No hace
-- falta contar nada.
-- -----------------------------------------------------------------------------
drop policy marca_insert on marca_firma;

create policy marca_insert on marca_firma for insert with check (
  app.actor() = 'sistema'
  or app.puede_definir_marcas(circuito_id)
  or app.puede_mover_marca(circuito_id, instancia_id, participacion_id)
);

-- -----------------------------------------------------------------------------
-- 4. Quitar: sólo la propia, nunca la que propuso el emisor
--
-- `creada_por` es quien la insertó. Si es el firmante, es suya y la saca. Si es
-- el emisor, la puede mover pero no hacerla desaparecer: el contrato reservó
-- ese lugar y quitarlo es firmar en otro lado del que se pidió.
-- -----------------------------------------------------------------------------
drop policy marca_delete on marca_firma;

create policy marca_delete on marca_firma for delete using (
  app.puede_definir_marcas(circuito_id)
  or (creada_por = app.identidad_actual()
      and app.puede_mover_marca(circuito_id, instancia_id, participacion_id))
);

-- -----------------------------------------------------------------------------
-- 5. El firmante externo carga su firma autógrafa
--
-- ⚠ Por qué NO se resolvió declarando probado el anclaje de correo en la sesión
-- del externo: `app.identidad_probada()` gobierna varias cosas más, y ablandarla
-- para habilitar una habilitaría todas. Abrir un enlace sigue sin probar
-- identidad. Lo que se agrega es una puerta angosta y con nombre.
--
-- Requiere alcance 'firmar': a quien recibe una copia informativa no se le pide
-- ninguna rúbrica, así que tampoco se le pide que cargue una imagen suya.
--
-- Y es SU identidad y ninguna otra: el correo salió del otorgamiento, no de un
-- formulario. Nadie elige de quién carga la firma.
-- -----------------------------------------------------------------------------
create or replace function app.puede_gestionar_su_firma_visual(p_identidad uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select app.actor() = 'externo'
     and p_identidad is not null
     and p_identidad = app.identidad_actual()
     and exists (
       select 1 from public.otorgamiento o
        where o.id = app.otorgamiento_externo()
          and o.identidad_id = app.identidad_actual()
          and o.revocado_en is null
          and o.vigente_desde <= now()
          and (o.vigente_hasta is null or o.vigente_hasta > now())
          and 'firmar' = any (o.alcances)
     )
$$;

revoke all on function app.puede_gestionar_su_firma_visual(uuid) from public;
grant execute on function app.puede_gestionar_su_firma_visual(uuid) to app_rw;

comment on function app.puede_gestionar_su_firma_visual(uuid) is
  'El firmante sin cuenta, sobre SU propia firma autógrafa, mientras su enlace '
  'de firma esté vivo. Ver migración 040.';

drop policy firma_visual_select on firma_visual;
drop policy firma_visual_insert on firma_visual;
drop policy firma_visual_update on firma_visual;

create policy firma_visual_select on firma_visual for select using (
  app.actor() = 'sistema'
  or (identidad_id = any (app.identidades_del_actor()) and app.identidad_probada())
  or app.puede_gestionar_su_firma_visual(identidad_id)
);

create policy firma_visual_insert on firma_visual for insert with check (
  (identidad_id = any (app.identidades_del_actor()) and app.identidad_probada())
  or app.puede_gestionar_su_firma_visual(identidad_id)
);

-- El reemplazo es un UPDATE que apaga `vigente`: la imagen anterior no se
-- borra, se jubila. `firma_visual_delete` sigue en `false` para todos.
create policy firma_visual_update on firma_visual for update using (
  (identidad_id = any (app.identidades_del_actor()) and app.identidad_probada())
  or app.puede_gestionar_su_firma_visual(identidad_id)
);

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
