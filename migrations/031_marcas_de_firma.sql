-- =============================================================================
-- MiFirma — 031_marcas_de_firma.sql
-- Dónde va la firma y la rúbrica de cada firmante, hoja por hoja.
--
-- ⚠ REGLA DE ORO Nº1, otra vez. Una marca no es una firma: es una imagen
-- ubicada. La tabla se llama `marca_firma` y no `firma_en_pagina` por eso. Un
-- documento sin ninguna marca está firmado igual; uno lleno de marcas y sin
-- PAdES no está firmado.
--
-- ═══ CUELGA DE LA PARTICIPACIÓN ═══
--
-- Una marca es de UNA persona en UN documento: la firma de Ana en la hoja 3.
-- La participación es exactamente eso —quién firma qué— así que es su lugar
-- natural. De paso hereda su ciclo de vida: si se saca a un firmante del
-- circuito, sus marcas se van con él.
--
-- ⚠ En modo `copias` esto multiplica: 3.000 instancias × 2 marcas son 6.000
-- filas. Es aceptable —la evidencia de ese mismo circuito son ~36.000— y es
-- preferible a una tabla de plantillas más otra de excepciones, que es donde
-- termina cualquier intento de "definirlas una sola vez". Cada firmante puede
-- mover las suyas, y para poder moverlas tienen que existir.
--
-- ═══ COORDENADAS EN PUNTOS PDF, ORIGEN ABAJO A LA IZQUIERDA ═══
--
-- Como manda el formato, no como manda el navegador. La conversión se hace en
-- la interfaz, una vez, y la base guarda lo que el PDF va a entender. Guardar
-- coordenadas de pantalla obligaría a saber con qué zoom y con qué tamaño de
-- visor se dibujaron, y eso no se puede reconstruir tres años después.
--
-- ═══ SE GUARDA LO PROPUESTO Y LO FINAL ═══
--
-- El emisor propone, el firmante puede mover (decisión del 1/8/2026). Mover
-- cambia lo que MUESTRA el documento, así que hay que poder responder por qué
-- la firma quedó en otro lugar del que se pidió. Se conservan las dos
-- posiciones y el evento del movimiento va al expediente.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create table marca_firma (
  id                    uuid primary key default gen_random_uuid(),
  participacion_id      uuid not null references participacion(id) on delete cascade,
  instancia_id          uuid not null references instancia(id),
  circuito_id           uuid not null references circuito(id),
  cuenta_propietaria_id uuid not null references cuenta(id),

  tipo                  text not null check (tipo in ('firma','rubrica')),

  -- Base 0, como el índice de páginas del PDF.
  pagina                int not null check (pagina >= 0),

  -- Rectángulo en puntos PDF. `x`,`y` es la esquina inferior izquierda.
  x                     numeric(9,3) not null,
  y                     numeric(9,3) not null,
  ancho                 numeric(9,3) not null check (ancho > 0),
  alto                  numeric(9,3) not null check (alto > 0),

  -- Lo que propuso el emisor. Si el firmante no la movió, coincide.
  x_propuesta           numeric(9,3) not null,
  y_propuesta           numeric(9,3) not null,

  movida_en             timestamptz,
  movida_por            uuid references identidad(id),

  creada_en             timestamptz not null default now(),
  creada_por            uuid references identidad(id),

  -- Dos marcas del mismo tipo en la misma hoja para el mismo firmante es un
  -- error de la interfaz, no una función. Que lo diga la base.
  unique (participacion_id, tipo, pagina)
);

create index marca_por_participacion on marca_firma (participacion_id);
create index marca_por_instancia on marca_firma (instancia_id, pagina);

comment on table marca_firma is
  'Dónde se estampa la representación VISUAL de la firma. No es la firma: el '
  'valor legal lo da el PAdES. Ver claude/representacion-visual.md.';

-- -----------------------------------------------------------------------------
-- Cuándo se pueden tocar
--
-- Se separa en dos funciones porque son dos permisos distintos que la gente
-- confunde: definir las marcas es del EMISOR mientras el circuito está en
-- borrador; moverlas es del FIRMANTE mientras no haya firmado.
-- -----------------------------------------------------------------------------
create or replace function app.puede_definir_marcas(p_circuito uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.circuito c
      join public.ubicacion u on u.circuito_id = c.id and u.cuenta_id = app.cuenta_actual()
     where c.id = p_circuito
       and c.cuenta_propietaria_id = app.cuenta_actual()
       -- Después del despacho no se mueven: el firmante ya vio dónde iban.
       and c.estado = 'borrador'
       and app.puede_en_carpeta(u.carpeta_id, 'enviar')
  );
$$;
revoke all on function app.puede_definir_marcas(uuid) from public;
grant execute on function app.puede_definir_marcas(uuid) to app_rw;

create or replace function app.puede_mover_marca(p_circuito uuid, p_instancia uuid, p_participacion uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select app.tiene_otorgamiento(p_circuito, p_instancia, 'firmar')
     and exists (
       select 1 from public.participacion p
        where p.id = p_participacion
          and p.estado not in ('firmada','rechazada','no_requerida','delegada')
     );
$$;
revoke all on function app.puede_mover_marca(uuid, uuid, uuid) from public;
grant execute on function app.puede_mover_marca(uuid, uuid, uuid) to app_rw;

-- -----------------------------------------------------------------------------
-- RLS
--
-- ⚠ Ninguna política nombra tablas: todas llaman funciones. Lección de la 026 —
-- una política que nombra tablas le impone esas tablas a TODO el que consulte,
-- aunque su rama ni se evalúe.
-- -----------------------------------------------------------------------------
alter table marca_firma enable row level security;

create policy marca_select on marca_firma for select using (
     app.actor() = 'sistema'
  or (cuenta_propietaria_id = app.cuenta_actual() and app.es_miembro(cuenta_propietaria_id))
  -- El firmante ve las suyas y las de los demás en el mismo documento: va a
  -- verlas estampadas de todos modos cuando el documento esté completo.
  or app.tiene_otorgamiento(circuito_id, instancia_id, 'metadatos')
  or app.tiene_otorgamiento(circuito_id, instancia_id, 'leer')
);

create policy marca_insert on marca_firma for insert with check (
  app.actor() = 'sistema' or app.puede_definir_marcas(circuito_id)
);

create policy marca_update on marca_firma for update using (
     app.actor() = 'sistema'
  or app.puede_definir_marcas(circuito_id)
  or app.puede_mover_marca(circuito_id, instancia_id, participacion_id)
);

-- Borrar una marca es sacarla del documento, y eso sólo tiene sentido mientras
-- se está armando. Después del despacho, no.
create policy marca_delete on marca_firma for delete using (
  app.puede_definir_marcas(circuito_id)
);

grant select, insert, update, delete on marca_firma to app_rw;
-- El operador no recibe GRANT: es contenido del cliente. Test C4.

-- -----------------------------------------------------------------------------
-- El evento del movimiento
-- -----------------------------------------------------------------------------
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('firma.marca_movida', 'firma', 'normal', 68,
   '{"es":"El firmante movió dónde se estampa su firma","pt":"O signatário moveu onde sua assinatura é aplicada","en":"The signer moved where their signature is stamped"}')
on conflict (codigo) do nothing;

commit;

-- Centinela de la 026, otra vez: se agregaron políticas nuevas.
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento|marca_firma)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio de firmas y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;
