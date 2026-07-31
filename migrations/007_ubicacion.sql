-- =============================================================================
-- MiFirma — 007_ubicacion.sql
-- Dónde está cada documento, en cada repositorio.
--
-- Un documento NO está en una carpeta: está en una carpeta POR CADA repositorio
-- que lo tiene. El contrato que la empresa A le manda a María está en
-- contratos/2026 de A y en la bandeja de entrada de María. Son dos ubicaciones
-- del mismo documento, y cada dueño lo organiza como quiere.
--
-- Una sola ubicación por cuenta: múltiples ubicaciones significan múltiples
-- caminos de permiso hacia el mismo documento, y ahí "¿quién puede ver esto?"
-- deja de tener respuesta corta.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create table ubicacion (
  id                uuid primary key default gen_random_uuid(),
  cuenta_id         uuid not null references cuenta(id),
  carpeta_id        uuid not null references carpeta(id),

  circuito_id       uuid references circuito(id),
  instancia_id      uuid references instancia(id),

  archivada         boolean not null default false,
  fijada            boolean not null default false,
  movida_en         timestamptz,
  movida_por        uuid references identidad(id),
  creada_en         timestamptz not null default now(),

  constraint ubicacion_objeto_unico check (num_nonnulls(circuito_id, instancia_id) = 1)
);

create unique index ubicacion_circuito_uq on ubicacion (cuenta_id, circuito_id)
  where circuito_id is not null;
create unique index ubicacion_instancia_uq on ubicacion (cuenta_id, instancia_id)
  where instancia_id is not null;
create index ubicacion_por_carpeta on ubicacion (carpeta_id) where not archivada;

-- La carpeta tiene que ser de la misma cuenta que la ubicación.
create or replace function ubicacion_carpeta_coherente() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from carpeta c where c.id = new.carpeta_id and c.cuenta_id = new.cuenta_id) then
    raise exception 'la carpeta % no pertenece a la cuenta %', new.carpeta_id, new.cuenta_id;
  end if;
  return new;
end $$;

create trigger ubicacion_coherente before insert or update on ubicacion
  for each row execute function ubicacion_carpeta_coherente();

commit;
