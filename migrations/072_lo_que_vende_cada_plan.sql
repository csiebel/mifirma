-- =============================================================================
-- MiFirma — 072_lo_que_vende_cada_plan.sql
-- Lo que un plan puede vender, en cuatro dimensiones que hasta hoy no existían.
-- Pedido de Claudio la noche del 7/9, entero:
--
--   1. Un plan elige CON QUÉ PROVEEDORES se firma: todos, algunos, o uno.
--   2. Un plan puede APAGAR LA FIRMA SIMPLE y vender sólo firma avanzada.
--   3. Un plan dice qué trae y CÓMO SE COBRA, con cantidades incluidas por
--      métrica y precio por unidad después.
--   4. Un plan dice si GUARDA LOS DOCUMENTOS, con topes, y por cuánto tiempo.
--
-- ═══ 1. LOS PROVEEDORES DEL PLAN, Y POR QUÉ ESTO CAMBIA UNA DECISIÓN ═══
--
-- ⚠⚠ El 21/8 se decidió lo contrario, y está escrito: `firma-con-token-externo.md`
-- §8 decisión 2 — «el plan habilita por CAPACIDAD; el control fino por proveedor
-- ya existe en el catálogo global del operador, no se duplica en el plan».
-- Claudio lo cambió el 7/9 de noche. No se pisa en silencio: la decisión vieja
-- valía para el dispositivo propio, donde el cliente compra «puedo usar mis
-- tokens»; ésta vale para los proveedores en la nube, donde el cliente compra
-- «firmo con Antel» y el plan es el contrato comercial de eso.
--
-- La cascada del §1 de `proveedores-y-adaptadores.md` queda por fin completa:
--
--   Catálogo global (operador)  → qué existe, por país y por capacidad   (067)
--   PLAN COMERCIAL (operador)   → cuáles de ésos vende este plan         ← ACÁ
--   Política de la cuenta       → cuáles de ésos ofrece la empresa       (067)
--   Elección                    → con cuál firma el firmante
--
-- `modo` = 'todos' es el estado natural y el de todos los planes que ya existen:
-- sin filas en `plan_proveedor`, todo lo que el catálogo habilite se ofrece.
--
-- ⚠⚠ EL FILTRO DEL PLAN MANDA, TAMBIÉN SOBRE LA EXCLUSIVIDAD. La primera
-- versión de esta migración hacía pasar al socio del acuerdo aunque el plan no
-- lo listara; Claudio lo sacó el 7/9 de noche: «no es necesario que la
-- exclusividad mande». Lo que sí queda es la consecuencia, y hay que tenerla a
-- la vista: en un país con acuerdo vigente, `app.proveedores_habilitados` (067)
-- ya excluyó a los demás, así que un plan en modo «lista» que NO liste al socio
-- se queda SIN firma avanzada en ese país. Es legítimo —un plan barato de sólo
-- firma simple— pero es fácil llegar ahí sin querer. La tranca de abajo NO lo
-- cubre, porque es por plan y esto es por país: lo tiene que ver el operador en
-- la pantalla, país por país.
--
-- ═══ LA TRANCA: UN PLAN SIN NINGUNA FORMA DE FIRMAR NO SE GUARDA ═══
--
-- Con la firma simple apagable y los proveedores elegibles, se vuelve posible
-- armar un plan con el que NADIE puede firmar: sin firma simple, sin
-- dispositivo propio, y con firma avanzada pero ningún proveedor. No es un
-- estado raro al que se llega adrede: se llega desmarcando una casilla de más.
--
-- No se puede expresar con un `check` —el invariante mira tres tablas— así que
-- va en un CONSTRAINT TRIGGER DIFERIDO, y esa palabra importa: la consola
-- guarda las prestaciones de a una, y a mitad de camino el plan puede estar sin
-- ninguna. Lo que tiene que ser válido es el estado al CERRAR la transacción,
-- no cada paso intermedio. Un trigger normal haría imposible desmarcar la firma
-- simple para marcar la avanzada.
--
-- ═══ 2. LA FIRMA SIMPLE COMO PRESTACIÓN ═══
--
-- Hasta hoy la firma simple —el sello de la plataforma— era el piso: siempre
-- estaba. Un plan «sólo firma avanzada» necesita poder apagarla, así que pasa a
-- ser una prestación más, `firma_simple`, y se siembra INCLUIDA en todos los
-- planes que ya existen: apagarla es una decisión, no un efecto de esta
-- migración.
--
-- ⚠ Lo que esto NO decide, y va aparte con fable: qué ve el firmante que no
-- tiene certificado cuando el plan sólo vende avanzada. Decisión de Claudio:
-- no puede firmar y se le explica, con el enlace para obtener su identidad. Y
-- con las dos habilitadas, el emisor puede exigir avanzada por circuito
-- (`circuito.nivel_firma`, que ya existe y hoy no bloquea).
--
-- ═══ 3. LA CANTIDAD INCLUIDA VIVE CON EL PRECIO ═══
--
-- «500 firmas simples incluidas y después $X cada una» son dos números de la
-- misma oferta, y hasta hoy vivían separados: el precio en `precio_metrica`, la
-- cantidad en `plan_prestacion`. Separados no se pueden leer juntos —una
-- prestación no distingue nivel de firma y un precio sí—, así que la cantidad
-- baja a `precio_metrica`, donde ya están el país, la moneda y el nivel.
--
-- `cantidad_incluida` en `plan_prestacion` NO se borra: sigue siendo la del
-- asistente de IA, que se mide por consumo y no por métrica de firma.
--
-- ⚠ Es lista de precios pública (`precio_select using (true)`, 019). La
-- cantidad incluida también es pública, y está bien: es parte de la oferta.
--
-- ═══ 4. LA CUSTODIA: LO QUE SE PUEDE NO GUARDAR, Y LO QUE NO ═══
--
-- ⚠⚠⚠ La decisión de fondo, de Claudio, el 7/9: lo que un plan puede dejar de
-- guardar son LOS BYTES DEL PDF. El expediente de evidencias, los hashes y el
-- certificado de finalización quedan SIEMPRE. Sin eso, «documentos firmados y
-- expedientes de evidencias inmutables» —principio del proyecto— dejaría de ser
-- cierto, y el día que alguien discuta una firma no podríamos contestar nada.
-- Con el hash y el expediente podemos probar QUÉ se firmó, cuándo y quién,
-- aunque el archivo ya no esté en nuestro disco.
--
-- Y la copia del FIRMANTE no muere con el plan del emisor: la 008 y la 046 le
-- dan derecho a conservar prueba de lo que firmó, y ese derecho es suyo, no del
-- que contrató. Decisión de Claudio: se le manda el documento firmado por
-- correo y su copia vive `dias_firmante` días. El plan del emisor fija ese
-- número; no lo borra.
--
-- ⚠ Esta migración deja los DATOS. Ni borra un archivo ni manda un correo: eso
-- es el barrido, y va después, con lo que hoy no existe.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. Los proveedores que vende el plan
-- -----------------------------------------------------------------------------
alter table plan
  add column if not exists proveedores_modo text not null default 'todos';
alter table plan drop constraint if exists plan_proveedores_modo_valido;
alter table plan add constraint plan_proveedores_modo_valido
  check (proveedores_modo in ('todos', 'lista'));

comment on column plan.proveedores_modo is
  '«todos» = lo que el catálogo habilite en el país. «lista» = sólo los de plan_proveedor. '
  '⚠ En un país con acuerdo de exclusividad, el catálogo ya devuelve sólo al socio: un plan en '
  'modo «lista» que no lo liste se queda sin firma avanzada ahí. Migración 072.';

create table if not exists plan_proveedor (
  plan_id        uuid not null references plan(id) on delete cascade,
  proveedor_id   uuid not null references proveedor_firma(id) on delete cascade,
  agregado_en    timestamptz not null default now(),
  primary key (plan_id, proveedor_id)
);
comment on table plan_proveedor is
  'Con qué proveedores se firma en este plan, cuando plan.proveedores_modo = ''lista''. '
  'Vacío con modo «lista» = el plan no vende firma con proveedor. Migración 072.';

-- ⚠ Un plan en modo «lista» y sin ninguno es un plan que no vende firma con
-- proveedor. Es legítimo —un plan de sólo firma simple— pero es fácil llegar
-- ahí por descuido: se avisa cuando se lee, no se prohíbe.

-- La cascada, en una función. Recibe el plan y devuelve lo que ese plan ofrece
-- en ese país para esa capacidad.
--
-- ⚠ El orden importa y es el de arriba: primero lo que el catálogo habilita
-- (`app.proveedores_habilitados`, que ya resuelve activo global, país, vigencia,
-- salud y EXCLUSIVIDAD), y encima el filtro del plan, que manda.
--
-- `por_exclusividad` no cambia el resultado: dice si ese proveedor es el socio
-- del acuerdo vigente, para que la consola pueda mostrarlo y el operador sepa
-- por qué en ese país no aparece ningún otro.
create or replace function app.proveedores_del_plan(
  p_plan uuid, p_pais char(2), p_capacidad text
)
returns table (
  proveedor_id    uuid,
  codigo          text,
  nombre_mostrado text,
  logo_url        text,
  preferido       boolean,
  orden           int,
  por_exclusividad boolean
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  with exclusivo as (
    select a.proveedor_id
      from public.acuerdo_exclusividad a
     where a.pais = upper(p_pais)
       and a.vigente_desde <= current_date
       and (a.vigente_hasta is null or a.vigente_hasta >= current_date)
       and p_capacidad = any(a.capacidades)
  ),
  modo as (
    select coalesce((select pl.proveedores_modo from public.plan pl where pl.id = p_plan), 'todos') as m
  )
  select h.proveedor_id, h.codigo, h.nombre_mostrado, h.logo_url, h.preferido, h.orden,
         (h.proveedor_id in (select proveedor_id from exclusivo)) as por_exclusividad
    from app.proveedores_habilitados(p_pais, p_capacidad) h
   where (select m from modo) = 'todos'
      or exists (select 1 from public.plan_proveedor pp
                  where pp.plan_id = p_plan and pp.proveedor_id = h.proveedor_id)
   order by h.preferido desc, h.orden, h.nombre_mostrado;
$$;
revoke all on function app.proveedores_del_plan(uuid, char(2), text) from public;
grant execute on function app.proveedores_del_plan(uuid, char(2), text) to app_rw, app_operador;

-- Lo mismo pero por CUENTA, que es lo que la pantalla de firma tiene a mano: se
-- resuelve el plan de su suscripción activa y se aplica. Sin suscripción, «todos»
-- — una cuenta sin plan no se queda sin poder firmar por eso.
create or replace function app.proveedores_de_cuenta(
  p_cuenta uuid, p_pais char(2), p_capacidad text
)
returns table (
  proveedor_id    uuid,
  codigo          text,
  nombre_mostrado text,
  logo_url        text,
  preferido       boolean,
  orden           int,
  por_exclusividad boolean
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select * from app.proveedores_del_plan(
    (select s.plan_id from public.suscripcion s
      where s.cuenta_id = p_cuenta and s.estado = 'activa' limit 1),
    p_pais, p_capacidad);
$$;
revoke all on function app.proveedores_de_cuenta(uuid, char(2), text) from public;
grant execute on function app.proveedores_de_cuenta(uuid, char(2), text) to app_rw, app_operador;

alter table plan_proveedor enable row level security;
drop policy if exists plan_proveedor_select on plan_proveedor;
drop policy if exists plan_proveedor_escritura on plan_proveedor;
-- Lista pública, como `plan` y `precio_metrica`: con qué se firma en cada plan
-- es parte de la oferta.
create policy plan_proveedor_select on plan_proveedor for select using (true);
create policy plan_proveedor_escritura on plan_proveedor for all
  using (app.actor() = 'operador') with check (app.actor() = 'operador');
grant select on plan_proveedor to app_rw;
grant select, insert, update, delete on plan_proveedor to app_operador;

-- -----------------------------------------------------------------------------
-- 2. La firma simple, apagable
-- -----------------------------------------------------------------------------
create or replace function app.prestaciones_conocidas()
returns text[]
language sql immutable parallel safe
as $$ select array['asistente_ia','firma_simple','firma_avanzada',
                   'dispositivo_propio','identidad_digital','custodia']::text[] $$;

-- ⚠ Incluida en todos los planes que ya existen. Apagarla es una decisión del
-- operador; que esta migración la apagara sería dejar sin firmar a todo el
-- mundo el día que se aplica.
insert into plan_prestacion (plan_id, prestacion, incluida, cobra, cantidad_incluida, margen_pct)
select id, 'firma_simple', true, true, 0, 0 from plan
on conflict (plan_id, prestacion) do nothing;

-- La custodia también nace incluida: hoy todos los planes guardan.
insert into plan_prestacion (plan_id, prestacion, incluida, cobra, cantidad_incluida, margen_pct)
select id, 'custodia', true, false, 0, 0 from plan
on conflict (plan_id, prestacion) do nothing;

-- ⚠⚠ Y LOS PLANES QUE VENGAN DESPUÉS.
--
-- Sembrar los que existen hoy no alcanza: un plan creado mañana nacería sin
-- `firma_simple` —o sea, un plan con el que NADIE puede firmar— y sin fila de
-- custodia. Lo encontró el ejerce de esta misma migración al crear sus propios
-- planes, que es exactamente para lo que sirve el banco.
--
-- El default va en un trigger y no en el código de la consola a propósito: un
-- plan puede nacer desde la consola, desde un script de alta o desde un psql a
-- mano, y en los tres casos tiene que nacer usable. Lo que el operador decida
-- después lo pisa sin problema.
create or replace function app.plan_nace_usable()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  insert into public.plan_prestacion (plan_id, prestacion, incluida, cobra, cantidad_incluida, margen_pct)
  values (new.id, 'firma_simple', true, true, 0, 0)
  on conflict (plan_id, prestacion) do nothing;
  insert into public.plan_prestacion (plan_id, prestacion, incluida, cobra, cantidad_incluida, margen_pct)
  values (new.id, 'custodia', true, false, 0, 0)
  on conflict (plan_id, prestacion) do nothing;
  insert into public.plan_custodia (plan_id, modo) values (new.id, 'sin_tope')
  on conflict (plan_id) do nothing;
  return null;
end $$;

drop trigger if exists plan_nace_usable on plan;
create trigger plan_nace_usable
  after insert on plan
  for each row execute function app.plan_nace_usable();

-- ── La tranca: ningún plan sin forma de firmar ───────────────────────────────
--
-- Tres formas de firmar, y alcanza con una:
--   · firma simple (el sello de la plataforma),
--   · firma avanzada CON al menos un proveedor que ofrecer,
--   · dispositivo propio (el token del firmante).
--
-- ⚠ «Firma avanzada incluida» sin ningún proveedor no cuenta: es una promesa
-- sin con quién cumplirla. Por eso el invariante mira también `proveedores_modo`
-- y `plan_proveedor`.
create or replace function app.plan_tiene_firma(p_plan uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select
    exists (select 1 from public.plan_prestacion x
             where x.plan_id = p_plan and x.prestacion in ('firma_simple','dispositivo_propio') and x.incluida)
    or (
      exists (select 1 from public.plan_prestacion x
               where x.plan_id = p_plan and x.prestacion = 'firma_avanzada' and x.incluida)
      and (
        coalesce((select pl.proveedores_modo from public.plan pl where pl.id = p_plan), 'todos') = 'todos'
        or exists (select 1 from public.plan_proveedor pp where pp.plan_id = p_plan)
      )
    );
$$;
revoke all on function app.plan_tiene_firma(uuid) from public;
grant execute on function app.plan_tiene_firma(uuid) to app_rw, app_operador;

create or replace function app.exigir_plan_con_firma()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_plan uuid; v_cod text;
begin
  -- ⚠ Un `if` por tabla y no un `case` en una sola asignación: PL/pgSQL prepara
  -- la expresión ENTERA antes de ejecutarla, así que un `case` que menciona
  -- `old.id` revienta con «record "old" has no field "id"» cuando el trigger
  -- corre sobre `plan_prestacion` — aunque esa rama no se ejecute nunca.
  -- Medido el 7/9 escribiendo esta misma migración.
  if tg_table_name = 'plan' then
    v_plan := new.id;                       -- sólo hay trigger AFTER UPDATE
  elsif tg_op = 'DELETE' then
    v_plan := old.plan_id;
  else
    v_plan := new.plan_id;
  end if;
  if v_plan is null then return null; end if;
  -- Si el plan se borró (cascada), no hay nada que exigirle.
  select codigo into v_cod from public.plan where id = v_plan;
  if not found then return null; end if;
  if not app.plan_tiene_firma(v_plan) then
    raise exception
      'El plan «%» quedaría sin ninguna forma de firmar. Incluí la firma simple, o el dispositivo propio, o la firma avanzada con al menos un proveedor.',
      v_cod using errcode = '23514';
  end if;
  return null;
end $$;

-- ⚠⚠ DIFERIDOS. Ver la nota de la cabecera: la consola guarda las prestaciones
-- de a una y el estado intermedio puede ser inválido. Lo que importa es el
-- estado al commit.
drop trigger if exists plan_con_firma on plan_prestacion;
create constraint trigger plan_con_firma
  after insert or update or delete on plan_prestacion
  deferrable initially deferred
  for each row execute function app.exigir_plan_con_firma();

drop trigger if exists plan_con_firma on plan_proveedor;
create constraint trigger plan_con_firma
  after insert or update or delete on plan_proveedor
  deferrable initially deferred
  for each row execute function app.exigir_plan_con_firma();

drop trigger if exists plan_con_firma on plan;
create constraint trigger plan_con_firma
  after update on plan
  deferrable initially deferred
  for each row execute function app.exigir_plan_con_firma();

-- -----------------------------------------------------------------------------
-- 3. La cantidad incluida, al lado del precio
-- -----------------------------------------------------------------------------
alter table precio_metrica
  add column if not exists cantidad_incluida numeric(14,4) not null default 0;
alter table precio_metrica drop constraint if exists precio_cantidad_incluida_positiva;
alter table precio_metrica add constraint precio_cantidad_incluida_positiva
  check (cantidad_incluida >= 0);
comment on column precio_metrica.cantidad_incluida is
  'Unidades sin cargo por período antes de cobrar `precio_unitario`. 0 = se cobra desde la primera. '
  'Migración 072: «500 firmas simples incluidas y después $X» son dos números de la misma oferta.';

-- El almacenamiento se cobra como cualquier otra métrica. La unidad la fija el
-- operador al cargar el precio; el sistema no la interpreta todavía.
do $precio$
declare v_nombre text;
begin
  select conname into v_nombre
    from pg_constraint
   where conrelid = 'public.precio_metrica'::regclass
     and contype = 'c'
     and conname <> 'precio_abono_sin_nivel'
     and pg_get_constraintdef(oid) ilike '%any (array[''abono''%';
  if v_nombre is null then
    raise exception 'No encuentro el check de precio_metrica.metrica';
  end if;
  execute format('alter table precio_metrica drop constraint %I', v_nombre);
  alter table precio_metrica add constraint precio_metrica_metrica_valida check (
    metrica in ('abono','firma','documento','circuito','sms',
                'asistente_ia','dispositivo_propio','identidad_digital','almacenamiento')
  );
end $precio$;

-- -----------------------------------------------------------------------------
-- 4. La custodia
-- -----------------------------------------------------------------------------
create table if not exists plan_custodia (
  plan_id            uuid primary key references plan(id) on delete cascade,

  -- 'sin_custodia' → el PDF se entrega y no se guarda (el expediente sí).
  -- 'con_tope'     → se guarda hasta el tope de documentos y/o de bytes.
  -- 'sin_tope'     → se guarda sin límite.
  modo               text not null default 'sin_tope'
                       check (modo in ('sin_custodia','con_tope','sin_tope')),

  tope_documentos    int    check (tope_documentos is null or tope_documentos > 0),
  tope_bytes         bigint check (tope_bytes is null or tope_bytes > 0),

  -- Cuántos días vive el PDF del EMISOR. NULL = para siempre. En 'sin_custodia'
  -- es lo que tarda el barrido en pasar; 0 = apenas se entrega.
  dias_emisor        int check (dias_emisor is null or dias_emisor >= 0),

  -- Y cuántos vive la copia del FIRMANTE, que es un derecho suyo (008, 046) y
  -- no del que contrató el plan. NULL = para siempre.
  -- ⚠ Se le manda el documento firmado por correo: el plazo es hasta cuándo lo
  -- puede volver a bajar de acá, no si lo tiene.
  dias_firmante      int check (dias_firmante is null or dias_firmante >= 0),

  actualizado_en     timestamptz not null default now(),

  -- Un tope sin modo 'con_tope' es un número que no hace nada, y un 'con_tope'
  -- sin ningún tope es un plan sin límite disfrazado. Ni uno ni otro entran.
  constraint custodia_topes_coherentes check (
    (modo = 'con_tope' and (tope_documentos is not null or tope_bytes is not null))
    or (modo <> 'con_tope' and tope_documentos is null and tope_bytes is null)
  )
);
comment on table plan_custodia is
  'Si el plan guarda los documentos, con qué topes y por cuánto tiempo. '
  '⚠ Lo que se puede no guardar son los BYTES del PDF: el expediente, los hashes y el '
  'certificado quedan siempre. Migración 072.';

-- Todos los planes que ya existen guardan sin tope y para siempre: es lo que
-- venían haciendo, y una migración no cambia lo que un cliente contrató.
insert into plan_custodia (plan_id, modo) select id, 'sin_tope' from plan
on conflict (plan_id) do nothing;

alter table plan_custodia enable row level security;
drop policy if exists plan_custodia_select on plan_custodia;
drop policy if exists plan_custodia_escritura on plan_custodia;
create policy plan_custodia_select on plan_custodia for select using (true);
create policy plan_custodia_escritura on plan_custodia for all
  using (app.actor() = 'operador') with check (app.actor() = 'operador');
grant select on plan_custodia to app_rw;
grant select, insert, update, delete on plan_custodia to app_operador;

-- La custodia efectiva de una cuenta, resuelta como todo lo demás: su plan, o
-- el default si no tiene suscripción.
--
-- ⚠ Devuelve SIEMPRE una fila, y sin plan devuelve «guarda todo». Es el lado
-- seguro: una cuenta sin suscripción no puede perder documentos por eso.
create or replace function app.custodia_de_cuenta(p_cuenta uuid)
returns table (
  modo            text,
  tope_documentos int,
  tope_bytes      bigint,
  dias_emisor     int,
  dias_firmante   int,
  origen          text
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce(c.modo, 'sin_tope'), c.tope_documentos, c.tope_bytes,
         c.dias_emisor, c.dias_firmante,
         case when c.plan_id is not null then 'plan'
              when s.id is not null then 'plan_sin_fila'
              else 'sin_suscripcion' end
    from (select 1) uno
    left join public.suscripcion s on s.cuenta_id = p_cuenta and s.estado = 'activa'
    left join public.plan_custodia c on c.plan_id = s.plan_id;
$$;
revoke all on function app.custodia_de_cuenta(uuid) from public;
grant execute on function app.custodia_de_cuenta(uuid) to app_rw, app_operador;

-- Lo guardado hoy por una cuenta, para poder decir «te quedan N» y para que el
-- barrido sepa a quién mirar. Cuenta sólo lo que ocupa disco por decisión del
-- plan: el documento base y el firmado. La evidencia y los sellos no se cuentan
-- porque no se pueden dejar de guardar.
create or replace function app.custodia_usada(p_cuenta uuid)
returns table (documentos bigint, bytes bigint)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select count(*)::bigint, coalesce(sum(a.bytes), 0)::bigint
    from public.archivo a
   where a.cuenta_custodia_id = p_cuenta
     and a.clase in ('base','firmado');
$$;
revoke all on function app.custodia_usada(uuid) from public;
grant execute on function app.custodia_usada(uuid) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- Centinela: que las prestaciones nuevas no rompan las filas viejas
-- -----------------------------------------------------------------------------
do $centinela$
declare v_falta int;
begin
  select count(*) into v_falta
    from plan p
   where not exists (select 1 from plan_prestacion x
                      where x.plan_id = p.id and x.prestacion = 'firma_simple' and x.incluida);
  if v_falta > 0 then
    raise exception 'Quedaron % plan(es) sin firma_simple incluida: esta migración no puede dejar a nadie sin poder firmar', v_falta;
  end if;
  select count(*) into v_falta from plan p
   where not exists (select 1 from plan_custodia c where c.plan_id = p.id);
  if v_falta > 0 then
    raise exception 'Quedaron % plan(es) sin fila de custodia', v_falta;
  end if;
  select count(*) into v_falta from plan p where not app.plan_tiene_firma(p.id);
  if v_falta > 0 then
    raise exception 'Quedaron % plan(es) sin ninguna forma de firmar', v_falta;
  end if;
end $centinela$;

commit;
