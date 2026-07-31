-- =============================================================================
-- MiFirma — 009_rls.sql
-- Todas las políticas RLS del núcleo y del dominio, más los GRANT por rol.
--
-- Va junta y no repartida porque estas tablas se referencian entre sí y
-- app.tiene_otorgamiento() recién existe en 008. De 010 en adelante, cada
-- migración trae sus propias políticas.
--
-- LA REGLA QUE ORDENA TODO:
--
--   acceso = (soy de la cuenta dueña AND tengo permiso en la carpeta)
--            OR (tengo un otorgamiento vigente)
--
-- Es un OR, no un AND. Si fuera AND, mandar a firmar a un compañero que no
-- tiene permiso en esa carpeta sería imposible: le llegaría la invitación y no
-- podría abrir el documento. El otorgamiento es un camino paralelo que NO pasa
-- por las carpetas.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- =============================================================================
-- CUENTA Y EMPRESA
-- =============================================================================

-- Helper security definer: sin esto, la política de `cuenta` referencia
-- `membresia` directamente y cualquier rol que quiera leer `cuenta` necesita
-- también GRANT sobre `membresia` — el permiso de tabla se verifica al
-- planificar, no al ejecutar, así que ninguna rama del OR lo evita.
-- El operador terminaría necesitando ver quién trabaja en cada cliente solo
-- para listar cuentas, que es exactamente lo que no queremos.
create or replace function app.es_miembro(p_cuenta uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.membresia m
    where m.cuenta_id = p_cuenta
      and m.identidad_id = app.identidad_actual()
      and m.estado = 'activa'
      and m.hasta is null
  )
$$;
grant execute on function app.es_miembro(uuid) to app_rw, app_operador;

alter table cuenta enable row level security;

create policy cuenta_select on cuenta for select using (
     id = app.cuenta_actual()
  or app.actor() in ('operador','sistema')   -- el operador ve cuentas, no contenido
  or app.es_miembro(id)                      -- para el selector de acceso
);
create policy cuenta_insert on cuenta for insert with check (app.actor() in ('sistema','operador'));
create policy cuenta_update on cuenta for update using (
     (app.actor() = 'cuenta' and id = app.cuenta_actual() and app.tiene_capacidad('cuenta','administrar'))
  or app.actor() in ('sistema','operador')
);
create policy cuenta_delete on cuenta for delete using (false);

alter table empresa enable row level security;
create policy empresa_select on empresa for select using (
     cuenta_id = app.cuenta_actual()
  or app.actor() in ('operador','sistema')
);
create policy empresa_upsert on empresa for insert with check (
  cuenta_id = app.cuenta_actual() or app.actor() in ('sistema','operador'));
create policy empresa_update on empresa for update using (
     (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('cuenta','administrar'))
  or app.actor() in ('sistema','operador'));
create policy empresa_delete on empresa for delete using (false);

-- =============================================================================
-- IDENTIDAD
--
-- Si fuera legible, cualquier cuenta podría enumerar todos los mails del
-- sistema. Y como las identidades latentes se crean al invitar a firmar, la
-- superficie de enumeración sería enorme.
-- =============================================================================
alter table identidad enable row level security;

create policy identidad_select on identidad for select using (
     id = any (app.identidades_del_actor())
  -- gente de mi cuenta
  or exists (select 1 from membresia m
             where m.identidad_id = identidad.id
               and m.cuenta_id = app.cuenta_actual()
               and m.estado = 'activa')
  -- contrapartes en circuitos que sí puedo ver
  or exists (select 1 from participacion p
             where p.identidad_id = identidad.id
               and (
                    (app.actor() = 'cuenta' and p.cuenta_propietaria_id = app.cuenta_actual())
                 or app.tiene_otorgamiento(p.circuito_id, p.instancia_id, 'leer')
                 or app.tiene_otorgamiento(p.circuito_id, p.instancia_id, 'metadatos')
               ))
  or app.actor() = 'sistema'
);
create policy identidad_insert on identidad for insert with check (app.actor() in ('cuenta','sistema'));
create policy identidad_update on identidad for update using (
     id = app.identidad_actual()
  or app.actor() = 'sistema'
);
create policy identidad_delete on identidad for delete using (false);

alter table anclaje_identidad enable row level security;
create policy anclaje_select on anclaje_identidad for select using (
     identidad_id = any (app.identidades_del_actor())
  or app.actor() = 'sistema'
  -- el emisor ve con qué se identificó quien firmó sus documentos
  or exists (select 1 from participacion p
             where p.anclaje_usado_id = anclaje_identidad.id
               and (p.cuenta_propietaria_id = app.cuenta_actual()
                    or app.tiene_otorgamiento(p.circuito_id, p.instancia_id, 'evidencia')))
);
create policy anclaje_insert on anclaje_identidad for insert with check (app.actor() in ('cuenta','sistema','externo'));
create policy anclaje_update on anclaje_identidad for update using (app.actor() = 'sistema');
create policy anclaje_delete on anclaje_identidad for delete using (false);

alter table credencial enable row level security;
create policy credencial_select on credencial for select using (
  identidad_id = app.identidad_actual() or app.actor() = 'sistema');
create policy credencial_insert on credencial for insert with check (app.actor() = 'sistema');
create policy credencial_update on credencial for update using (
  identidad_id = app.identidad_actual() or app.actor() = 'sistema');
create policy credencial_delete on credencial for delete using (false);

alter table persona enable row level security;
create policy persona_select on persona for select using (cuenta_id = app.cuenta_actual());
create policy persona_insert on persona for insert with check (
  cuenta_id = app.cuenta_actual() and app.tiene_capacidad('usuario','administrar'));
create policy persona_update on persona for update using (
  cuenta_id = app.cuenta_actual() and app.tiene_capacidad('usuario','administrar'));
create policy persona_delete on persona for delete using (false);

alter table membresia enable row level security;
create policy membresia_select on membresia for select using (
     cuenta_id = app.cuenta_actual()
  or identidad_id = any (app.identidades_del_actor())
  or app.actor() = 'sistema'
);
create policy membresia_insert on membresia for insert with check (
     (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('usuario','administrar'))
  or app.actor() = 'sistema');
create policy membresia_update on membresia for update using (
     (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('usuario','administrar'))
  or app.actor() = 'sistema');
create policy membresia_delete on membresia for delete using (false);

-- =============================================================================
-- ROLES
-- =============================================================================
alter table rol enable row level security;
create policy rol_select on rol for select using (
  cuenta_id = app.cuenta_actual() or cuenta_id is null);
create policy rol_insert on rol for insert with check (
  cuenta_id = app.cuenta_actual() and app.tiene_capacidad('usuario','administrar'));
create policy rol_update on rol for update using (
  cuenta_id = app.cuenta_actual() and not sistema and app.tiene_capacidad('usuario','administrar'));
create policy rol_delete on rol for delete using (
  cuenta_id = app.cuenta_actual() and not sistema and app.tiene_capacidad('usuario','administrar'));

alter table rol_capacidad enable row level security;
create policy rol_capacidad_all on rol_capacidad for all using (
  exists (select 1 from rol r where r.id = rol_capacidad.rol_id
            and (r.cuenta_id = app.cuenta_actual() or r.cuenta_id is null)));

alter table usuario_rol enable row level security;
create policy usuario_rol_select on usuario_rol for select using (
     cuenta_id = app.cuenta_actual()
  or identidad_id = any (app.identidades_del_actor()));
create policy usuario_rol_insert on usuario_rol for insert with check (
  cuenta_id = app.cuenta_actual() and app.tiene_capacidad('usuario','administrar'));
create policy usuario_rol_delete on usuario_rol for delete using (
  cuenta_id = app.cuenta_actual() and app.tiene_capacidad('usuario','administrar'));

-- =============================================================================
-- CARPETAS
-- =============================================================================
alter table carpeta enable row level security;
create policy carpeta_select on carpeta for select using (
  cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(id, 'ver'));
create policy carpeta_insert on carpeta for insert with check (
     cuenta_id = app.cuenta_actual()
  and (padre_id is null and app.actor() = 'sistema'
       or app.puede_en_carpeta(padre_id, 'organizar')));
create policy carpeta_update on carpeta for update using (
  cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(id, 'organizar'));
create policy carpeta_delete on carpeta for delete using (
  cuenta_id = app.cuenta_actual() and sistema is null and app.puede_en_carpeta(id, 'organizar'));

alter table carpeta_permiso enable row level security;
create policy carpeta_permiso_select on carpeta_permiso for select using (
  cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(carpeta_id, 'ver'));
create policy carpeta_permiso_write on carpeta_permiso for insert with check (
  cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(carpeta_id, 'permisos'));
create policy carpeta_permiso_update on carpeta_permiso for update using (
  cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(carpeta_id, 'permisos'));
create policy carpeta_permiso_delete on carpeta_permiso for delete using (
  cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(carpeta_id, 'permisos'));

-- =============================================================================
-- DOMINIO: la regla del OR
-- =============================================================================
alter table circuito enable row level security;

create policy circuito_select on circuito for select using (
     (cuenta_propietaria_id = app.cuenta_actual()
      and exists (select 1 from ubicacion u
                  where u.circuito_id = circuito.id
                    and u.cuenta_id = app.cuenta_actual()
                    and app.puede_en_carpeta(u.carpeta_id, 'ver')))
  or app.tiene_otorgamiento(id, null, 'metadatos')
  or app.tiene_otorgamiento(id, null, 'leer')
);

create policy circuito_insert on circuito for insert with check (
      app.actor() = 'cuenta'
  and cuenta_propietaria_id = app.cuenta_actual()
  and creado_por_identidad_id = app.identidad_actual()
  and app.tiene_capacidad('circuito','crear')
);

create policy circuito_update on circuito for update using (
     app.actor() = 'sistema'
  or (app.actor() = 'cuenta' and cuenta_propietaria_id = app.cuenta_actual())
) with check (cuenta_propietaria_id = app.cuenta_actual() or app.actor() = 'sistema');

create policy circuito_delete on circuito for delete using (false);

-- -----------------------------------------------------------------------------
alter table instancia enable row level security;

create policy instancia_select on instancia for select using (
     (cuenta_propietaria_id = app.cuenta_actual()
      and exists (select 1 from ubicacion u
                  where (u.instancia_id = instancia.id or u.circuito_id = instancia.circuito_id)
                    and u.cuenta_id = app.cuenta_actual()
                    and app.puede_en_carpeta(u.carpeta_id, 'ver')))
  or app.tiene_otorgamiento(circuito_id, id, 'metadatos')
  or app.tiene_otorgamiento(circuito_id, id, 'leer')
);

create policy instancia_insert on instancia for insert with check (
      app.actor() in ('cuenta','sistema')
  and (app.actor() = 'sistema' or cuenta_propietaria_id = app.cuenta_actual())
);

create policy instancia_update on instancia for update using (
     app.actor() = 'sistema'
  or (app.actor() = 'cuenta' and cuenta_propietaria_id = app.cuenta_actual())
  or app.tiene_otorgamiento(circuito_id, id, 'firmar')
);

create policy instancia_delete on instancia for delete using (false);

-- -----------------------------------------------------------------------------
alter table participacion enable row level security;

-- Nótese la segunda rama: el firmante ve SU participación aunque su
-- otorgamiento haya vencido. Tiene que poder saber que en tal fecha le pidieron
-- firmar algo, aunque ya no pueda abrirlo. Separar "ver que existe" de "ver el
-- contenido" es lo que hace que el vencimiento no borre la historia de nadie.
create policy participacion_select on participacion for select using (
     (cuenta_propietaria_id = app.cuenta_actual()
      and exists (select 1 from ubicacion u
                  where (u.instancia_id = participacion.instancia_id
                         or u.circuito_id = participacion.circuito_id)
                    and u.cuenta_id = app.cuenta_actual()
                    and app.puede_en_carpeta(u.carpeta_id, 'ver')))
  or (identidad_id = any (app.identidades_del_actor()) and app.identidad_probada())
  or app.tiene_otorgamiento(circuito_id, instancia_id, 'leer')
  or app.tiene_otorgamiento(circuito_id, instancia_id, 'metadatos')
);

create policy participacion_insert on participacion for insert with check (
      app.actor() in ('cuenta','sistema')
  and (app.actor() = 'sistema' or cuenta_propietaria_id = app.cuenta_actual())
);

create policy participacion_update on participacion for update using (
     app.actor() = 'sistema'
  or (identidad_id = any (app.identidades_del_actor())
      and app.tiene_otorgamiento(circuito_id, instancia_id, 'firmar'))
  or (app.actor() = 'cuenta' and cuenta_propietaria_id = app.cuenta_actual())
);

create policy participacion_delete on participacion for delete using (false);

-- -----------------------------------------------------------------------------
-- ARCHIVO. La política más cara del esquema; de ahí los índices de 008.
-- update/delete en false sin excepciones: un blob referenciado por una firma
-- criptográfica no se modifica jamás.
-- -----------------------------------------------------------------------------
alter table archivo enable row level security;

create policy archivo_select on archivo for select using (
     (cuenta_custodia_id = app.cuenta_actual()
      and exists (
        select 1 from instancia i
        join ubicacion u on (u.instancia_id = i.id or u.circuito_id = i.circuito_id)
        where i.archivo_firmado_id = archivo.id
          and u.cuenta_id = app.cuenta_actual()
          and app.puede_en_carpeta(u.carpeta_id, 'leer')))
  or (cuenta_custodia_id = app.cuenta_actual()
      and exists (
        select 1 from circuito c
        join ubicacion u on u.circuito_id = c.id
        where c.archivo_base_id = archivo.id
          and u.cuenta_id = app.cuenta_actual()
          and app.puede_en_carpeta(u.carpeta_id, 'leer')))
  or exists (select 1 from instancia i
             where i.archivo_firmado_id = archivo.id
               and app.tiene_otorgamiento(i.circuito_id, i.id, 'leer'))
  or exists (select 1 from circuito c
             where c.archivo_base_id = archivo.id
               and app.tiene_otorgamiento(c.id, null, 'leer'))
);

create policy archivo_insert on archivo for insert with check (
      app.actor() in ('cuenta','sistema')
  and (app.actor() = 'sistema' or cuenta_custodia_id = app.cuenta_actual())
);
create policy archivo_update on archivo for update using (false);
create policy archivo_delete on archivo for delete using (false);

-- -----------------------------------------------------------------------------
alter table ubicacion enable row level security;
create policy ubicacion_select on ubicacion for select using (
  cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(carpeta_id, 'ver'));
create policy ubicacion_insert on ubicacion for insert with check (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(carpeta_id, 'crear')));
create policy ubicacion_update on ubicacion for update using (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(carpeta_id, 'mover')));
create policy ubicacion_delete on ubicacion for delete using (false);

-- =============================================================================
-- OTORGAMIENTO
--
-- ⚠ NO poner FORCE ROW LEVEL SECURITY acá: rompe app.tiene_otorgamiento().
--
-- La política de esta tabla NO puede llamar a app.tiene_otorgamiento():
-- sería recursión. Se resuelve con condiciones planas.
-- =============================================================================
alter table otorgamiento enable row level security;

create policy otorgamiento_select on otorgamiento for select using (
     (app.actor() = 'cuenta' and cuenta_otorgante_id = app.cuenta_actual())
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual())
  or (identidad_id = any (app.identidades_del_actor()) and app.identidad_probada())
  or (app.actor() = 'externo' and id = app.otorgamiento_externo())
  or app.actor() = 'sistema'
);

create policy otorgamiento_insert on otorgamiento for insert with check (
      app.actor() in ('cuenta','sistema')
  and (
       app.actor() = 'sistema'
    or (
         cuenta_otorgante_id = app.cuenta_actual()
         and (
              exists (select 1 from circuito c
                      where c.id = coalesce(circuito_id,
                            (select i.circuito_id from instancia i where i.id = instancia_id))
                        and c.cuenta_propietaria_id = app.cuenta_actual())
           or app.tiene_otorgamiento(circuito_id, instancia_id, 'administrar')
         )
       )
  )
);

-- Solo revocación; el trigger de 008 hace cumplir qué columnas.
create policy otorgamiento_update on otorgamiento for update using (
      app.actor() in ('cuenta','sistema')
  and (app.actor() = 'sistema' or cuenta_otorgante_id = app.cuenta_actual())
  and not irrevocable
);

create policy otorgamiento_delete on otorgamiento for delete using (false);

-- =============================================================================
-- CATÁLOGOS PÚBLICOS: sin RLS, sin datos de cliente
-- =============================================================================
grant select on plan, industria, capacidad to app_rw, app_operador;

-- =============================================================================
-- GRANTS
--
-- app_operador NO recibe SELECT sobre archivo, ni sobre el contenido de
-- circuitos, instancias, participaciones ni ubicaciones. La ausencia de GRANT
-- es el control: lo que no está concedido no se puede pedir, y no depende de
-- que una política esté bien escrita.
-- Ver iso-27001.md §2 — un auditor pregunta esto explícitamente.
-- =============================================================================
grant select, insert, update on
  cuenta, empresa, identidad, anclaje_identidad, credencial, persona, membresia,
  rol, rol_capacidad, usuario_rol, carpeta, carpeta_permiso,
  circuito, instancia, participacion, archivo, ubicacion, otorgamiento
to app_rw;

-- El operador: cuentas y facturación, nunca contenido.
grant select on cuenta, empresa to app_operador;

-- =============================================================================
-- VERIFICACIÓN DE COBERTURA
--
-- Falla si quedó alguna tabla con datos de cliente sin RLS. Este mismo bloque
-- va como test en CI: si alguien agrega una tabla y olvida su política, se
-- rompe el build.
-- =============================================================================
do $cobertura$
declare v_faltantes text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_faltantes
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity
    and c.relname not in ('plan','industria','capacidad');
  if v_faltantes is not null then
    raise exception 'tablas sin RLS: %', v_faltantes;
  end if;
end $cobertura$;

commit;
