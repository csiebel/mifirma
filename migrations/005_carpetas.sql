-- =============================================================================
-- MiFirma — 005_carpetas.sql
-- Árbol de carpetas por cuenta y permisos por rol.
--
-- Va ANTES del dominio porque las políticas RLS de circuito e instancia usan
-- app.puede_en_carpeta(). Si se creara después, habría que escribir esas
-- políticas dos veces.
--
-- Herencia ADITIVA sin denegación explícita: un permiso otorgado en una carpeta
-- vale en todas sus descendientes. Si algo no se comparte, va fuera de la rama.
-- Ver repositorio-campos-y-envio-masivo.md §2.3.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create table carpeta (
  id                uuid primary key default gen_random_uuid(),
  cuenta_id         uuid not null references cuenta(id),
  padre_id          uuid references carpeta(id),

  nombre_i18n       jsonb not null,
  -- Camino materializado. Es lo que hace que la herencia se resuelva por índice
  -- y no con un CTE recursivo por cada fila evaluada.
  ruta              ltree not null,

  sistema           text check (sistema in ('raiz','entrada','borradores','papelera')),

  creada_por        uuid references identidad(id),
  creada_en         timestamptz not null default now(),

  unique (cuenta_id, ruta)
);

create index carpeta_ruta_gist on carpeta using gist (ruta);
create index carpeta_por_cuenta on carpeta (cuenta_id);
create unique index carpeta_sistema_uq on carpeta (cuenta_id, sistema) where sistema is not null;

-- La ruta se deriva del padre: nadie la escribe a mano.
create or replace function carpeta_calcular_ruta() returns trigger
language plpgsql as $$
declare v_ruta_padre ltree;
begin
  if new.padre_id is null then
    new.ruta := text2ltree(replace(new.id::text, '-', '_'));
  else
    select ruta into v_ruta_padre from carpeta where id = new.padre_id;
    if v_ruta_padre is null then
      raise exception 'carpeta padre inexistente';
    end if;
    new.ruta := v_ruta_padre || text2ltree(replace(new.id::text, '-', '_'));
  end if;
  return new;
end $$;

create trigger carpeta_ruta before insert on carpeta
  for each row execute function carpeta_calcular_ruta();

-- Mover una carpeta recalcula la rama entera. Operación peligrosa: le da
-- acceso a todo el que lo tenga en la rama destino. Ver R2 del documento.
create or replace function carpeta_mover_rama() returns trigger
language plpgsql as $$
declare v_ruta_padre ltree; v_ruta_nueva ltree;
begin
  if new.padre_id is distinct from old.padre_id then
    if new.padre_id is null then
      v_ruta_nueva := text2ltree(replace(new.id::text, '-', '_'));
    else
      select ruta into v_ruta_padre from carpeta where id = new.padre_id;
      if v_ruta_padre <@ old.ruta then
        raise exception 'no se puede mover una carpeta dentro de sí misma';
      end if;
      v_ruta_nueva := v_ruta_padre || text2ltree(replace(new.id::text, '-', '_'));
    end if;
    update carpeta
       set ruta = v_ruta_nueva || subpath(ruta, nlevel(old.ruta))
     where ruta <@ old.ruta and id <> new.id;
    new.ruta := v_ruta_nueva;
  end if;
  return new;
end $$;

create trigger carpeta_mover before update on carpeta
  for each row execute function carpeta_mover_rama();

-- -----------------------------------------------------------------------------
-- Permisos: se asignan a ROLES, no a personas
-- -----------------------------------------------------------------------------
create table carpeta_permiso (
  id                uuid primary key default gen_random_uuid(),
  carpeta_id        uuid not null references carpeta(id),
  cuenta_id         uuid not null references cuenta(id),
  rol_id            uuid not null references rol(id),

  acciones          text[] not null,
  -- 'ver'       : que los documentos existen y su estado
  -- 'leer'      : abrir el contenido
  -- 'crear'     : subir documentos y armar circuitos acá
  -- 'enviar'    : despachar
  -- 'mover'     : mover o archivar documentos
  -- 'organizar' : crear, renombrar y borrar subcarpetas
  -- 'permisos'  : administrar los permisos de esta rama

  otorgado_por      uuid references identidad(id),
  creado_en         timestamptz not null default now(),

  unique (carpeta_id, rol_id),
  constraint carpeta_permiso_acciones_validas check (
    acciones <@ array['ver','leer','crear','enviar','mover','organizar','permisos']::text[]
    and cardinality(acciones) > 0)
);

create index carpeta_permiso_por_rol on carpeta_permiso (rol_id, cuenta_id);
create index carpeta_permiso_por_carpeta on carpeta_permiso (carpeta_id);

-- -----------------------------------------------------------------------------
-- La función más caliente del sistema: se evalúa una vez por documento en cada
-- listado. El operador @> de ltree con índice GiST es lo que la hace viable.
-- -----------------------------------------------------------------------------
create or replace function app.puede_en_carpeta(p_carpeta uuid, p_accion text)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.carpeta c_obj
    join public.carpeta c_anc
      on c_anc.cuenta_id = c_obj.cuenta_id
     and c_anc.ruta @> c_obj.ruta          -- ancestro (o ella misma)
    join public.carpeta_permiso cp on cp.carpeta_id = c_anc.id
    join public.usuario_rol ur on ur.rol_id = cp.rol_id
    where c_obj.id = p_carpeta
      and c_obj.cuenta_id = app.cuenta_actual()
      and ur.identidad_id = app.identidad_actual()
      and ur.cuenta_id    = app.cuenta_actual()
      and p_accion = any (cp.acciones)
  )
$$;

commit;
