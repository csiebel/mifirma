-- =============================================================================
-- MiFirma — 015_bitacora.sql
-- La bitácora de plataforma: quién hizo qué en la aplicación.
--
-- No confundir con la evidencia de firma. Son cosas distintas y conviene que
-- vivan en tablas distintas:
--
--   · La EVIDENCIA (migración posterior) es lo que ocurrió alrededor de un
--     documento. Es inmutable, encadenada, sellada, y forma parte del
--     expediente que se entrega en un juicio.
--   · La BITÁCORA es lo que hizo un usuario en la aplicación: asignó un rol,
--     cambió una plantilla, revocó un otorgamiento, exportó datos. Es
--     administrativa. Se retiene por política, no para siempre.
--
-- Mezclarlas obliga a purgar la evidencia junto con los logs administrativos,
-- que es exactamente lo que no se puede hacer.
--
-- Reemplaza la tabla `auditoria` de payroll, que tenía la misma idea pero
-- colgaba de `empresa_id` y `usuario_id`. Ver auditoria-y-evidencias.md §6.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- Particionada por mes: la bitácora crece sin techo y la retención se aplica
-- soltando particiones viejas, que es instantáneo, en vez de un DELETE de
-- millones de filas que bloquea la tabla.
create table bitacora_plataforma (
  id            uuid not null default gen_random_uuid(),
  cuenta_id     uuid not null references cuenta(id),
  identidad_id  uuid references identidad(id),
  actor_tipo    text not null check (actor_tipo in ('usuario','operador','sistema','api')),

  accion        text not null,       -- 'rol.asignado', 'documento.exportado', ...
  recurso_tipo  text not null,
  recurso_id    uuid,

  -- Estado antes y después. Acá NO van datos personales del firmante ni
  -- contenido de documentos: van los campos que cambiaron de una configuración.
  antes         jsonb,
  despues       jsonb,

  ip            inet,
  user_agent    text,
  ocurrido_en   timestamptz not null default now(),

  primary key (id, ocurrido_en)
) partition by range (ocurrido_en);

create index bitacora_por_cuenta on bitacora_plataforma (cuenta_id, ocurrido_en desc);
create index bitacora_por_recurso on bitacora_plataforma (recurso_tipo, recurso_id);

-- Partición de respaldo: si el job mensual falla, los inserts no se caen.
-- Sin esto, el primer día del mes que nadie creó la partición se cae el login.
create table bitacora_plataforma_default
  partition of bitacora_plataforma default;

-- Las particiones llevan RLS propia y NINGÚN grant.
--
-- No es redundante: PostgreSQL aplica las políticas de la tabla nombrada en la
-- consulta. Consultar `bitacora_plataforma_2026_08` directamente esquiva las
-- políticas del padre. Sin grant no hay forma de nombrarla, y con RLS propia
-- sin políticas tampoco devolvería nada si alguien la otorgara por error.
-- El enrutamiento del INSERT a través del padre no necesita permisos sobre la
-- partición, así que esto no rompe nada.
alter table bitacora_plataforma_default enable row level security;

-- Crea la partición del mes indicado si no existe. La llama un job mensual y
-- también el arranque de la aplicación, que es más barato que descubrir el
-- problema por un error en producción.
create or replace function app.asegurar_particion_bitacora(p_mes date default current_date)
returns text language plpgsql as $$
declare
  v_inicio date := date_trunc('month', p_mes)::date;
  v_fin    date := (date_trunc('month', p_mes) + interval '1 month')::date;
  v_nombre text := 'bitacora_plataforma_' || to_char(v_inicio, 'YYYY_MM');
begin
  if exists (select 1 from pg_class where relname = v_nombre) then
    return v_nombre;
  end if;
  execute format(
    'create table %I partition of bitacora_plataforma for values from (%L) to (%L)',
    v_nombre, v_inicio, v_fin);
  execute format('alter table %I enable row level security', v_nombre);
  return v_nombre;
end $$;

select app.asegurar_particion_bitacora(current_date);
select app.asegurar_particion_bitacora((current_date + interval '1 month')::date);

-- =============================================================================
-- RLS
--
-- Se escribe y no se toca más: sin update ni delete para nadie. Una bitácora
-- que la aplicación puede editar no sirve para responder qué pasó.
-- =============================================================================
alter table bitacora_plataforma enable row level security;

create policy bitacora_select on bitacora_plataforma for select using (
     app.actor() = 'operador'
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('bitacora','leer'))
);
create policy bitacora_insert on bitacora_plataforma for insert with check (
  app.actor() in ('cuenta','sistema','operador','externo')
);
create policy bitacora_update on bitacora_plataforma for update using (false);
create policy bitacora_delete on bitacora_plataforma for delete using (false);

-- El firmante externo genera eventos (abrió el documento, lo descargó) pero no
-- lee la bitácora de nadie: no hay rama 'externo' en el select.

grant select, insert on bitacora_plataforma to app_rw;
grant select on bitacora_plataforma to app_operador;

commit;
