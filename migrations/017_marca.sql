-- =============================================================================
-- MiFirma — 017_marca.sql
-- La marca de la cuenta: logo y colores.
--
-- En payroll esto vivía como columnas de `empresa`. Acá `empresa` es sólo el
-- detalle fiscal de una cuenta de tipo empresa, y la marca la puede tener
-- también una cuenta de tipo persona — un escribano, un profesional
-- independiente— así que cuelga de `cuenta`.
--
-- Va en tabla aparte y no en columnas de `cuenta` por una razón concreta: el
-- logo es un blob de cientos de kilobytes, y `cuenta` se lee en cada request
-- para resolver el contexto. Una columna `bytea` ahí obliga a Postgres a tocar
-- TOAST en consultas que sólo querían el nombre.
--
-- Y el logo importa más que en payroll: es lo que ve un firmante externo al
-- abrir el documento, muchas veces sin haber oído hablar de nosotros. Es la
-- prueba visual de que el correo no es una estafa.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create table marca (
  cuenta_id       uuid primary key references cuenta(id) on delete cascade,

  logo            bytea,
  logo_mime       text check (logo_mime in ('image/png','image/jpeg','image/webp','image/svg+xml')),
  logo_bytes      int,

  color_primario  text check (color_primario ~ '^#[0-9a-fA-F]{6}$'),
  color_texto     text check (color_texto ~ '^#[0-9a-fA-F]{6}$'),

  actualizada_en  timestamptz not null default now(),

  -- Si hay logo, hay mime. Un blob sin tipo no se puede servir.
  constraint marca_logo_coherente check ((logo is null) = (logo_mime is null))
);

-- =============================================================================
-- RLS
--
-- Lectura amplia a propósito: el firmante externo TIENE que ver el logo de la
-- empresa que le manda el documento, y en ese momento no es miembro de nada.
-- Que la marca sea pública dentro del producto es la intención — es marca, no
-- es dato. Escribir, en cambio, es sólo del administrador de la cuenta.
-- =============================================================================
alter table marca enable row level security;

create policy marca_select on marca for select using (
  app.actor() in ('cuenta','externo','operador','sistema')
);
create policy marca_insert on marca for insert with check (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('cuenta','administrar'))
);
create policy marca_update on marca for update using (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('cuenta','administrar'))
);
create policy marca_delete on marca for delete using (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('cuenta','administrar'))
);

grant select, insert, update, delete on marca to app_rw;
-- El operador ve la marca: es lo que aparece en su consola al listar cuentas.
-- No es contenido de cliente.
grant select on marca to app_operador;

commit;
