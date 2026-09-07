-- =============================================================================
-- MiFirma — 071_prestaciones_del_plan_y_marca_del_pais.sql
-- Tres cosas que el operador pidió el 6/9 y que viven juntas porque las tres
-- son «qué ofrece el producto en cada país y en cada plan»:
--
--   1. La MARCA DEL PAÍS: el acuerdo de exclusividad (067) guardaba dos URLs de
--      logo. Ahora guarda además la IMAGEN (subida desde la consola), el enlace
--      al que lleva cada logo, y un TEXTO por idioma para la página del país.
--   2. La FIRMA CON DISPOSITIVO PROPIO (token USB, tarjeta, cédula con chip)
--      entra al catálogo de proveedores como una fila más — apagada.
--   3. Las PRESTACIONES DEL PLAN: qué trae cada plan, con o sin costo. Hasta hoy
--      sólo el asistente de IA tenía eso, y lo tenía como cuatro columnas de
--      `plan` (013). Se generaliza a una tabla, y la IA pasa a ser una fila.
--
-- ═══ 1. POR QUÉ LA IMAGEN VA EN LA BASE Y NO EN UN DISCO ═══
--
-- Un logo pesa decenas de KB y se lee una vez por visita a la página del país.
-- Guardarlo en `bytea` al lado de su acuerdo hace que la marca tenga la misma
-- vigencia, la misma autorización (`autorizacion_marca`) y el mismo respaldo
-- que el acuerdo que la habilita: cuando el acuerdo vence, el logo deja de
-- salir sin que nadie tenga que borrar un archivo de algún lado. El tope de
-- 300 KB no es técnico: es para que nadie suba una foto de 8 MB «por las
-- dudas» y la página del país tarde tres segundos en cargar.
--
-- La URL NO se borra: sigue sirviendo cuando el socio prefiere que su logo se
-- sirva desde su propio dominio. La imagen manda si está; si no, la URL.
--
-- ═══ 2. POR QUÉ EL DISPOSITIVO PROPIO ES UNA FILA DEL CATÁLOGO ═══
--
-- `firma-con-token-externo.md` §2: «el token externo no es un camino nuevo: es
-- un adaptador más». Cambia UN paso de catorce (quién firma el hash). Todo lo
-- que el catálogo ya sabe hacer —habilitar por país, marcar preferido, decir
-- qué niveles alcanza— aplica igual. Lo que NO aplica se declara en
-- `proveedor_capacidad`: no identifica al titular, no sella tiempo, no soporta
-- lote (cada firma es un PIN), y no tiene salud que vigilar.
--
-- Se llama `dispositivo_propio` y no `token_externo`: decisión del 21/8 (§3 del
-- mismo documento). En este sistema `token` es la credencial de OAuth; el
-- aparato es el dispositivo. Dos cosas distintas con el mismo nombre en un
-- rótulo permanente son un hecho perdido esperando.
--
-- Nace APAGADO (`activo_global = false`) y sin país. El adaptador no existe
-- todavía —vive en `src/firma/`, sellado— y una fila encendida sin adaptador
-- sería una opción que el firmante ve y no funciona.
--
-- ═══ 3. POR QUÉ «PRESTACIÓN» Y NO «CAPACIDAD» ═══
--
-- Se había hablado de `plan_capacidad`. Se cambia el nombre antes de que exista
-- porque `capacidad` ya significa DOS cosas en esta base: el permiso del
-- esquema de roles (`capacidad`, `app.tiene_capacidad('facturacion','leer')`) y
-- lo que sabe hacer un proveedor (`proveedor_capacidad`, `proveedor_pais.
-- capacidades`). Una tercera acepción —lo que trae un plan— es la que lee el
-- comercial, y conviene que tenga su palabra: PRESTACIÓN.
--
-- Cuatro prestaciones, cerradas por una función inmutable y no por un check
-- literal, para que agregar la quinta sea un `create or replace` y no rehacer
-- tres constraints:
--
--   asistente_ia        el asistente de redacción (la que ya existía)
--   firma_avanzada      firmar con certificado de un proveedor en la nube
--   dispositivo_propio  firmar con el token o tarjeta del firmante
--   identidad_digital   verificar al firmante con su identidad digital
--
-- El sellado de tiempo NO es prestación: donde la ley lo exige (`pais_firma`,
-- 028) no hay plan que lo pueda quitar.
--
-- Cada fila dice cuatro cosas, las mismas cuatro que la IA decía en `plan`:
--   incluida           el plan la ofrece
--   cobra              el uso se factura (si no, va sin cargo)
--   cantidad_incluida  unidades sin cargo por período antes de cobrar
--   margen_pct         margen sobre el costo del proveedor
--
-- `suscripcion_prestacion` es el override por cuenta: NULL hereda del plan,
-- igual que las columnas de `suscripcion` de la 013.
--
-- ═══ LAS COLUMNAS VIEJAS DE LA IA NO SE BORRAN ═══
--
-- `plan.asistente_ia, ia_cobra, ia_margen_pct, ia_incluido` y sus hermanas en
-- `suscripcion` quedan MUERTAS: se copian a la tabla nueva acá, y un trigger
-- las mantiene iguales mientras el código que las lee migra. Borrarlas en la
-- misma migración que estrena el reemplazo es apostar dos cosas a una vuelta
-- (misma regla que `credencial.idp_externo` en la 070).
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. La marca del país, en el acuerdo
-- -----------------------------------------------------------------------------
alter table acuerdo_exclusividad
  add column if not exists logo_socio_img       bytea,
  add column if not exists logo_socio_mime      text,
  add column if not exists logo_socio_enlace    text,
  add column if not exists logo_producto_img    bytea,
  add column if not exists logo_producto_mime   text,
  add column if not exists logo_producto_enlace text,
  add column if not exists texto_i18n           jsonb;

comment on column acuerdo_exclusividad.logo_socio_img is
  'Logo del socio subido desde la consola. Si está, manda sobre logo_socio_url. '
  'Tope 300 KB. Sale por app.marca_imagen(pais, ''socio''), nunca por select.';
comment on column acuerdo_exclusividad.logo_producto_img is
  'Logo del producto co-brandeado subido desde la consola. Manda sobre logo_producto_url.';
comment on column acuerdo_exclusividad.texto_i18n is
  'Texto que aparece en la página del país, por idioma: {"es":…,"pt":…,"en":…}.';

-- Imagen y tipo van juntos o no van. Sólo tipos que un navegador muestra como
-- imagen, y el SVG entra porque es el formato en que los socios entregan
-- logos — la consola lo sanea antes de guardarlo; la base no puede.
alter table acuerdo_exclusividad drop constraint if exists acuerdo_logo_socio_coherente;
alter table acuerdo_exclusividad add constraint acuerdo_logo_socio_coherente check (
  (logo_socio_img is null) = (logo_socio_mime is null)
  and (logo_socio_mime is null or logo_socio_mime in ('image/png','image/jpeg','image/webp','image/svg+xml'))
  and (logo_socio_img is null or octet_length(logo_socio_img) <= 300 * 1024)
);
alter table acuerdo_exclusividad drop constraint if exists acuerdo_logo_producto_coherente;
alter table acuerdo_exclusividad add constraint acuerdo_logo_producto_coherente check (
  (logo_producto_img is null) = (logo_producto_mime is null)
  and (logo_producto_mime is null or logo_producto_mime in ('image/png','image/jpeg','image/webp','image/svg+xml'))
  and (logo_producto_img is null or octet_length(logo_producto_img) <= 300 * 1024)
);
alter table acuerdo_exclusividad drop constraint if exists acuerdo_texto_es_objeto;
alter table acuerdo_exclusividad add constraint acuerdo_texto_es_objeto check (
  texto_i18n is null or jsonb_typeof(texto_i18n) = 'object'
);

-- La función del co-branding devuelve más columnas. `create or replace` no
-- puede cambiar el tipo de retorno: hay que tirarla y crearla de nuevo. Las
-- columnas que ya devolvía quedan en el mismo orden; las nuevas van al final.
--
-- ⚠ Los BYTES no salen por acá: esta función la llama la página del país para
-- saber qué mostrar, y arrastrar 300 KB por consulta para decidir si hay logo
-- sería pagar la imagen dos veces. Devuelve un booleano por logo; la imagen se
-- pide aparte a `app.marca_imagen` y el navegador la cachea.
drop function if exists app.exclusividad_vigente(char(2));
create function app.exclusividad_vigente(p_pais char(2))
returns table (
  proveedor_id          uuid,
  socio_nombre          text,
  logo_producto_url     text,
  logo_socio_url        text,
  vigente_hasta         date,
  logo_producto_enlace  text,
  logo_socio_enlace     text,
  logo_producto_img_hay boolean,
  logo_socio_img_hay    boolean,
  texto_i18n            jsonb
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select a.proveedor_id, a.socio_nombre, a.logo_producto_url, a.logo_socio_url, a.vigente_hasta,
         a.logo_producto_enlace, a.logo_socio_enlace,
         a.logo_producto_img is not null,
         a.logo_socio_img is not null,
         a.texto_i18n
    from public.acuerdo_exclusividad a
   where a.pais = upper(p_pais)
     and a.autorizacion_marca
     and a.vigente_desde <= current_date
     and (a.vigente_hasta is null or a.vigente_hasta >= current_date);
$$;
revoke all on function app.exclusividad_vigente(char(2)) from public;
grant execute on function app.exclusividad_vigente(char(2)) to app_rw, app_operador;

-- La imagen, por una puerta con las mismas condiciones que el resto de la
-- marca: acuerdo vigente Y autorización de marca. Un logo cargado en un acuerdo
-- sin autorización, o vencido, no sale — aunque la fila lo tenga.
create or replace function app.marca_imagen(p_pais char(2), p_cual text)
returns table (img bytea, mime text)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select case p_cual when 'socio' then a.logo_socio_img else a.logo_producto_img end,
         case p_cual when 'socio' then a.logo_socio_mime else a.logo_producto_mime end
    from public.acuerdo_exclusividad a
   where a.pais = upper(p_pais)
     and p_cual in ('socio','producto')
     and a.autorizacion_marca
     and a.vigente_desde <= current_date
     and (a.vigente_hasta is null or a.vigente_hasta >= current_date)
     and (case p_cual when 'socio' then a.logo_socio_img else a.logo_producto_img end) is not null;
$$;
revoke all on function app.marca_imagen(char(2), text) from public;
grant execute on function app.marca_imagen(char(2), text) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- 2. El dispositivo propio, en el catálogo — apagado
-- -----------------------------------------------------------------------------
insert into proveedor_firma (codigo, nombre_mostrado, nombre_i18n, activo_global, entorno,
                             orden_preferencia, endpoints, parametros)
values ('dispositivo_propio',
        'Dispositivo propio del firmante',
        '{"es":"Dispositivo propio (token o tarjeta)",
          "pt":"Dispositivo próprio (token ou cartão)",
          "en":"Own device (token or smart card)"}'::jsonb,
        false, 'produccion', 900, '{}'::jsonb,
        '{"local": true, "nota": "El hash baja al navegador y el componente del firmante lo firma. No hay endpoint, credencial ni costo por firma."}'::jsonb)
on conflict (codigo) do nothing;

insert into proveedor_capacidad (proveedor_id, firma_hash, formatos_devueltos, identifica_titular,
                                 devuelve_documento_id, sellado_tiempo, ocsp_en_linea,
                                 alcance_por_firma, requiere_presencia, soporta_lote)
select id, true, '{pkcs7}', false, true, false, false, true, true, false
  from proveedor_firma where codigo = 'dispositivo_propio'
on conflict (proveedor_id) do nothing;

-- -----------------------------------------------------------------------------
-- 3. Las prestaciones del plan
-- -----------------------------------------------------------------------------

-- La lista cerrada. Inmutable para que los checks puedan usarla.
create or replace function app.prestaciones_conocidas()
returns text[]
language sql immutable parallel safe
as $$ select array['asistente_ia','firma_avanzada','dispositivo_propio','identidad_digital']::text[] $$;
revoke all on function app.prestaciones_conocidas() from public;
grant execute on function app.prestaciones_conocidas() to app_rw, app_operador;

create table if not exists plan_prestacion (
  plan_id            uuid    not null references plan(id) on delete cascade,
  prestacion         text    not null,
  incluida           boolean not null default false,
  cobra              boolean not null default true,
  cantidad_incluida  numeric(14,4) not null default 0 check (cantidad_incluida >= 0),
  margen_pct         numeric(6,3)  not null default 0 check (margen_pct >= 0),
  actualizado_en     timestamptz not null default now(),
  primary key (plan_id, prestacion),
  constraint plan_prestacion_conocida check (prestacion = any(app.prestaciones_conocidas()))
);
comment on table plan_prestacion is
  'Qué trae cada plan y cómo se cobra. Una fila por (plan, prestación); sin fila = no incluida. '
  'Reemplaza a plan.asistente_ia/ia_cobra/ia_margen_pct/ia_incluido (013, MUERTAS). Migración 071.';

create table if not exists suscripcion_prestacion (
  suscripcion_id     uuid    not null references suscripcion(id) on delete cascade,
  prestacion         text    not null,
  -- NULL = hereda del plan. Igual que las columnas de la 013.
  incluida           boolean,
  cobra              boolean,
  cantidad_incluida  numeric(14,4) check (cantidad_incluida is null or cantidad_incluida >= 0),
  margen_pct         numeric(6,3)  check (margen_pct is null or margen_pct >= 0),
  actualizado_en     timestamptz not null default now(),
  primary key (suscripcion_id, prestacion),
  constraint suscripcion_prestacion_conocida check (prestacion = any(app.prestaciones_conocidas()))
);
comment on table suscripcion_prestacion is
  'Override por cuenta de una prestación del plan. NULL hereda. '
  'Reemplaza a suscripcion.asistente_ia/ia_cobra/ia_margen_pct/ia_incluido (013, MUERTAS). Migración 071.';

-- La IA, que ya existía como columnas, pasa a ser una fila. Se copia lo que hay;
-- si ya se copió (segunda pasada), no se pisa lo que el operador haya tocado.
insert into plan_prestacion (plan_id, prestacion, incluida, cobra, cantidad_incluida, margen_pct)
select id, 'asistente_ia', asistente_ia, ia_cobra, ia_incluido, ia_margen_pct
  from plan
on conflict (plan_id, prestacion) do nothing;

insert into suscripcion_prestacion (suscripcion_id, prestacion, incluida, cobra, cantidad_incluida, margen_pct)
select id, 'asistente_ia', asistente_ia, ia_cobra, ia_incluido, ia_margen_pct
  from suscripcion
 where asistente_ia is not null or ia_cobra is not null
    or ia_incluido is not null or ia_margen_pct is not null
on conflict (suscripcion_id, prestacion) do nothing;

comment on column plan.asistente_ia is
  'MUERTA desde la 071: la fuente es plan_prestacion (''asistente_ia''). Un trigger la mantiene igual mientras el código migra.';
comment on column suscripcion.asistente_ia is
  'MUERTA desde la 071: la fuente es suscripcion_prestacion (''asistente_ia''). Un trigger la mantiene igual mientras el código migra.';

-- El espejo: lo que se escribe en la fila de la IA se refleja en las columnas
-- viejas, en una sola dirección. El día que ningún código las lea, se tira el
-- trigger y las columnas juntas.
create or replace function app.espejar_prestacion_ia()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if new.prestacion <> 'asistente_ia' then return new; end if;
  if tg_table_name = 'plan_prestacion' then
    update public.plan
       set asistente_ia = new.incluida, ia_cobra = new.cobra,
           ia_incluido = new.cantidad_incluida, ia_margen_pct = new.margen_pct
     where id = new.plan_id;
  else
    update public.suscripcion
       set asistente_ia = new.incluida, ia_cobra = new.cobra,
           ia_incluido = new.cantidad_incluida, ia_margen_pct = new.margen_pct
     where id = new.suscripcion_id;
  end if;
  return new;
end $$;

drop trigger if exists plan_prestacion_espejo on plan_prestacion;
create trigger plan_prestacion_espejo
  after insert or update on plan_prestacion
  for each row execute function app.espejar_prestacion_ia();
drop trigger if exists suscripcion_prestacion_espejo on suscripcion_prestacion;
create trigger suscripcion_prestacion_espejo
  after insert or update on suscripcion_prestacion
  for each row execute function app.espejar_prestacion_ia();

-- La regla, en una función: qué le toca a una cuenta de una prestación.
-- Suscripción activa → override de la suscripción → plan → «no incluida».
--
-- ⚠ Devuelve SIEMPRE una fila, con `origen` diciendo de dónde salió cada valor.
-- Una función que devuelve cero filas cuando la cuenta no tiene suscripción
-- obliga a cada llamador a tratar el caso, y el que lo olvida lee NULL como
-- «incluida» (lección del ejerce 070: NULL no es false).
create or replace function app.prestacion_de_cuenta(p_cuenta uuid, p_prestacion text)
returns table (
  incluida          boolean,
  cobra             boolean,
  cantidad_incluida numeric(14,4),
  margen_pct        numeric(6,3),
  origen            text
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce(sp.incluida,          pp.incluida,          false),
         coalesce(sp.cobra,             pp.cobra,             true),
         coalesce(sp.cantidad_incluida, pp.cantidad_incluida, 0),
         coalesce(sp.margen_pct,        pp.margen_pct,        0),
         case when sp.suscripcion_id is not null then 'suscripcion'
              when pp.plan_id is not null then 'plan'
              when s.id is not null then 'plan_sin_fila'
              else 'sin_suscripcion' end
    from (select 1) uno
    left join public.suscripcion s
           on s.cuenta_id = p_cuenta and s.estado = 'activa'
    left join public.plan_prestacion pp
           on pp.plan_id = s.plan_id and pp.prestacion = p_prestacion
    left join public.suscripcion_prestacion sp
           on sp.suscripcion_id = s.id and sp.prestacion = p_prestacion;
$$;
revoke all on function app.prestacion_de_cuenta(uuid, text) from public;
grant execute on function app.prestacion_de_cuenta(uuid, text) to app_rw, app_operador;

-- Todas juntas, para la pantalla de la cuenta y la de firma.
create or replace function app.prestaciones_de_cuenta(p_cuenta uuid)
returns table (
  prestacion        text,
  incluida          boolean,
  cobra             boolean,
  cantidad_incluida numeric(14,4),
  margen_pct        numeric(6,3),
  origen            text
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select p.nombre, r.incluida, r.cobra, r.cantidad_incluida, r.margen_pct, r.origen
    from unnest(app.prestaciones_conocidas()) as p(nombre)
   cross join lateral app.prestacion_de_cuenta(p_cuenta, p.nombre) r;
$$;
revoke all on function app.prestaciones_de_cuenta(uuid) from public;
grant execute on function app.prestaciones_de_cuenta(uuid) to app_rw, app_operador;

-- La lista de precios admite las prestaciones nuevas como métrica. El check de
-- la 019 tiene nombre generado; se lo busca por su texto y se lo reemplaza por
-- uno con nombre propio, una sola vez.
do $precio$
declare v_nombre text;
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'public.precio_metrica'::regclass
                and conname = 'precio_metrica_metrica_valida') then
    return;
  end if;
  select conname into v_nombre
    from pg_constraint
   where conrelid = 'public.precio_metrica'::regclass
     and contype = 'c'
     and conname <> 'precio_abono_sin_nivel'
     and pg_get_constraintdef(oid) ilike '%any (array[''abono''%';
  if v_nombre is null then
    raise exception 'No encuentro el check de precio_metrica.metrica de la 019';
  end if;
  execute format('alter table precio_metrica drop constraint %I', v_nombre);
  alter table precio_metrica add constraint precio_metrica_metrica_valida check (
    metrica in ('abono','firma','documento','circuito','sms',
                'asistente_ia','dispositivo_propio','identidad_digital')
  );
end $precio$;

-- -----------------------------------------------------------------------------
-- RLS y permisos
--
-- `plan_prestacion` es parte del plan: lista pública como `precio_metrica`
-- (019) — la página comercial dice qué trae cada plan — y la escribe sólo el
-- operador.
--
-- `suscripcion_prestacion` es de la cuenta: se ve como `suscripcion` (013) y
-- la escriben el sistema (flujo de contratación) y el operador (override desde
-- la consola, que es para lo que existe).
-- -----------------------------------------------------------------------------
alter table plan_prestacion enable row level security;
drop policy if exists plan_prestacion_select on plan_prestacion;
drop policy if exists plan_prestacion_insert on plan_prestacion;
drop policy if exists plan_prestacion_update on plan_prestacion;
drop policy if exists plan_prestacion_delete on plan_prestacion;
create policy plan_prestacion_select on plan_prestacion for select using (true);
create policy plan_prestacion_insert on plan_prestacion for insert with check (app.actor() = 'operador');
create policy plan_prestacion_update on plan_prestacion for update using (app.actor() = 'operador');
create policy plan_prestacion_delete on plan_prestacion for delete using (app.actor() = 'operador');
grant select on plan_prestacion to app_rw;
grant select, insert, update, delete on plan_prestacion to app_operador;

alter table suscripcion_prestacion enable row level security;
drop policy if exists suscripcion_prestacion_select on suscripcion_prestacion;
drop policy if exists suscripcion_prestacion_escritura on suscripcion_prestacion;
create policy suscripcion_prestacion_select on suscripcion_prestacion for select using (
     app.actor() in ('sistema','operador')
  or (app.actor() = 'cuenta'
      and app.tiene_capacidad('facturacion','leer')
      and exists (select 1 from suscripcion s
                   where s.id = suscripcion_id and s.cuenta_id = app.cuenta_actual()))
);
create policy suscripcion_prestacion_escritura on suscripcion_prestacion for all
  using (app.actor() in ('sistema','operador'))
  with check (app.actor() in ('sistema','operador'));
grant select, insert, update, delete on suscripcion_prestacion to app_rw;
grant select, insert, update, delete on suscripcion_prestacion to app_operador;

-- -----------------------------------------------------------------------------
-- Centinela: la imagen no sale por select para el operador ni para la app
--
-- No hay grant de columna que quitar —la tabla se lee entera—, así que el
-- centinela es distinto: comprueba que la puerta exista y sea security
-- definer. Si alguien la reescribe sin eso, la migración lo dice.
-- -----------------------------------------------------------------------------
do $centinela$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'app' and p.proname = 'marca_imagen' and p.prosecdef) then
    raise exception 'app.marca_imagen tiene que ser security definer';
  end if;
end $centinela$;

commit;
