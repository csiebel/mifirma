-- =============================================================================
-- MiFirma — 079_medir_todo_lo_que_se_consume.sql
-- Una sola lista donde se anota todo lo que un cliente consume.
--
-- ═══ EL AGUJERO QUE CIERRA ═══
--
-- El diseño del 30/7 (`claude billing-diseno.md` §2 y §3) especificaba
-- `evento_medible` y `tarifa_costo`: una línea por cada cosa consumible, se
-- facture o no. La implementación de septiembre tomó otro camino y construyó
-- `firma_facturable` (073) con `app.medir_firma()` (076), que hace exactamente
-- eso pero SÓLO PARA FIRMAS.
--
-- Resultado: el producto mide firmas y no mide nada más. Cada SMS, cada sello de
-- tiempo, cada verificación de identidad con un proveedor y cada MB guardado
-- cuestan plata de verdad y no dejan rastro en ningún lado. Y los cuatro límites
-- por plan que pidió Claudio el 14/9 son imposibles de aplicar sobre algo que no
-- se cuenta.
--
-- ═══ LAS TRES DECISIONES DE CLAUDIO (14/9/2026) ═══
--
--   1. UNA SOLA LISTA para todo, con lo de firmas mudado adentro, y una VISTA
--      con el nombre viejo para que las pantallas que ya andan no se enteren.
--   2. LA IA SE MUDA AHORA, no más adelante.
--   3. EL DISCO se anota como UNA FOTO POR MES, no evento por evento.
--
-- ═══ ⚠⚠ POR QUÉ ESTO NO ES TERRITORIO DE FIRMA ═══
--
-- `src/firma/` está sellado y su periferia va con fable. Nada de eso se toca:
--
--   · La llamada `select app.medir_firma(...)` que `firmar()` hace desde el
--     tramo autorizado el 7/9 QUEDA IGUAL. Lo que cambia es lo que la función
--     hace por dentro, que es SQL y vive acá.
--   · El sello de tiempo se mide con un trigger sobre `sello_tiempo`, que la
--     028 ya escribe. No se toca `services/tsa.ts` ni `src/firma/tsa.ts`.
--
-- ═══ ⚠⚠ MEDIR NUNCA PUEDE TUMBAR LO QUE SE ESTÁ MIDIENDO ═══
--
-- La regla de la 076, ahora general: una firma es un hecho jurídico y un SMS ya
-- salió. Si el medidor falla, se pierde una línea de facturación —que se puede
-- reconstruir— y no el hecho. Por eso `app.medir()` atrapa todo, avisa por
-- `raise warning` y devuelve null.
--
-- ⚠ Y por eso mismo los sabotajes de esta migración se prueban mirando EL
-- CONTENIDO DE LA FILA, nunca si la función tiró error: una función que atrapa
-- todo hace invisible cualquier sabotaje que se apoye en la excepción (lección
-- del sexto sabotaje de la 076).
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- =============================================================================
-- 1. LA LISTA
--
-- Generaliza `firma_facturable` sin perder una sola de sus columnas. Lo que era
-- "qué firma" pasa a ser "qué consumo", y lo que era "cuál participación" pasa a
-- ser una clave de idempotencia que cada tipo arma a su manera.
-- =============================================================================
create table if not exists evento_medible (
  id                 uuid primary key default gen_random_uuid(),

  -- ⚠ Quién paga es SIEMPRE el emisor, nunca el firmante. Un uruguayo que firma
  -- un documento de una empresa brasileña genera un consumo de la brasileña, en
  -- su país y en su moneda. Es la regla que la 076 ya aplicaba a las firmas.
  cuenta_id          uuid not null references cuenta(id),
  ocurrido_en        timestamptz not null default now(),
  periodo            char(7) not null,              -- 'YYYY-MM'

  tipo               text not null check (tipo in (
                       'firma', 'circuito_despachado', 'documento_completado',
                       'sms', 'sello_tsa', 'verificacion_identidad',
                       'almacenamiento', 'asistente_ia')),

  -- Una firma es 1. Un SMS al portugués son 2 o 3 SEGMENTOS, y cada segmento se
  -- paga. El disco son MB. La IA son tokens. Sin esto, el SMS en portugués se
  -- cobraría al precio del castellano, que cuesta de verdad menos.
  cantidad           numeric(14,4) not null default 1 check (cantidad >= 0),
  unidad             text not null default 'unidad'
                       check (unidad in ('unidad','segmento','mb','token')),

  -- A qué se refiere. Todos opcionales: cada tipo llena los suyos.
  participacion_id   uuid references participacion(id),
  instancia_id       uuid references instancia(id),
  circuito_id        uuid references circuito(id),
  proveedor_id       uuid references proveedor_firma(id),
  nivel_firma        text check (nivel_firma in ('simple','avanzada')),
  -- El modelo de IA, la autoridad de sellado, el país de destino del SMS. Lo que
  -- sirve para explicar una línea de factura sin abrir el dominio.
  detalle            jsonb,

  pais               char(2) not null,
  plan_id            uuid references plan(id),

  -- ── Lo que se le cobra al cliente
  moneda             char(3) not null,
  precio_unitario    numeric(14,4) not null default 0 check (precio_unitario >= 0),
  -- Si cayó dentro de lo incluido se registra igual con `cobrada = false`: se
  -- mide todo y se cobra lo que corresponde. Sin esto no se puede contestar
  -- "¿cuántas de mis 500 usé?", que es justamente la pregunta de los topes.
  cobrada            boolean not null default true,

  -- ── Lo que nos cuesta, y a quién
  modelo_economico   text not null default 'sin_costo'
                       check (modelo_economico in ('costo','revenue_share','sin_costo')),
  costo_externo      numeric(14,4) check (costo_externo is null or costo_externo >= 0),
  moneda_costo       char(3),
  a_liquidar         numeric(14,4) check (a_liquidar is null or a_liquidar >= 0),
  liquidacion_id     uuid,

  -- ⚠ Reemplaza al `unique (participacion_id)` de la 073 y da la MISMA garantía:
  -- la segunda escritura es un reintento, no un consumo nuevo. Para una firma es
  -- 'firma:'||participacion; para un SMS el id del mensaje de Twilio; para el
  -- disco 'almacenamiento:'||cuenta||':'||periodo, que es lo que impide medir
  -- dos veces el mismo mes.
  clave_idempotencia text not null unique,

  creado_en          timestamptz not null default now(),

  -- Los dos checks de coherencia de la 073, acotados a las firmas: "una avanzada
  -- sin proveedor sería una firma avanzada que nadie hizo" sigue siendo cierto
  -- para firmas. Un SMS sin proveedor es lo normal.
  constraint medible_costo_coherente check (
    tipo <> 'firma' or (
         (modelo_economico = 'costo' and proveedor_id is not null)
      or (modelo_economico = 'revenue_share' and proveedor_id is not null and a_liquidar is not null)
      or (modelo_economico = 'sin_costo' and costo_externo is null and a_liquidar is null))
  ),
  constraint medible_nivel_coherente check (
    tipo <> 'firma' or (
         (nivel_firma = 'avanzada' and proveedor_id is not null)
      or (nivel_firma = 'simple' and proveedor_id is null))
  ),
  -- Una firma sin nivel no se puede cobrar ni contar contra un tope.
  constraint medible_firma_con_nivel check (tipo <> 'firma' or nivel_firma is not null)
);

create index if not exists medible_por_cuenta on evento_medible (cuenta_id, periodo, tipo);
create index if not exists medible_por_tipo on evento_medible (tipo, periodo);
create index if not exists medible_por_proveedor on evento_medible (proveedor_id, periodo)
  where proveedor_id is not null;
create index if not exists medible_a_liquidar on evento_medible (proveedor_id, periodo)
  where proveedor_id is not null and liquidacion_id is null;

comment on table evento_medible is
  'Una línea por cada cosa que un cliente consume: firmas, circuitos, documentos, SMS, '
  'sellos de tiempo, verificaciones de identidad, disco y asistente de IA. Con lo que se '
  'le cobra y lo que se le debe al proveedor, a los valores VIGENTES ESE DÍA. Inmutable, '
  'como el expediente. Diseño del 30/7 §2; generaliza firma_facturable (073). Migración 079.';

-- =============================================================================
-- 2. LO QUE CADA COSA CUESTA POR FUERA — `tarifa_costo`
--
-- Diseño del 30/7 §3. Versionado por fecha, por la misma razón que los precios
-- de venta: la factura de marzo tiene que costear con las tarifas de marzo. Si
-- el histórico se pisa, no hay forma de reconstruir una factura vieja y
-- cualquier reclamo se vuelve indefendible.
--
-- ⚠ NO DUPLICA `proveedor_pais.costo_por_firma` (073): para el concepto
-- `firma_proveedor` manda lo que ya existe ahí, y esta tabla cubre los conceptos
-- que hoy no tienen dónde vivir. Está dicho acá para que nadie lo vuelva a
-- partir en dos — es la deuda 116 con otra cara.
-- =============================================================================
create table if not exists tarifa_costo (
  id              uuid primary key default gen_random_uuid(),
  concepto        text not null check (concepto in
                    ('firma_proveedor','sello_plataforma','sello_tsa','sms',
                     'verificacion_identidad','almacenamiento','asistente_ia')),
  proveedor_id    uuid references proveedor_firma(id),   -- null cuando no aplica
  pais            char(2),                               -- null = global
  moneda          char(3) not null,
  costo_unitario  numeric(14,6) not null check (costo_unitario >= 0),
  vigente_desde   date not null default current_date,
  vigente_hasta   date,
  creado_en       timestamptz not null default now(),
  creado_por      uuid,
  constraint tarifa_vigencia_coherente check (vigente_hasta is null or vigente_hasta >= vigente_desde)
);

-- Una sola tarifa vigente por combinación. `coalesce` porque en SQL dos NULL no
-- son iguales, y sin eso se podrían cargar cinco tarifas "globales" sin que nada
-- proteste — la misma trampa que la 019 ya había encontrado en los precios.
create unique index if not exists tarifa_vigente_uq
  on tarifa_costo (concepto, coalesce(proveedor_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   coalesce(pais, '--'), moneda)
  where vigente_hasta is null;

comment on table tarifa_costo is
  'Lo que nos cuesta por fuera cada concepto, versionado por fecha. Diseño del 30/7 §3. '
  'Para firma_proveedor manda proveedor_pais (073): acá viven los conceptos que no tenían dónde.';

-- El check de `precio_metrica.metrica` no conoce el sello de tiempo. Se lo busca
-- por texto porque su nombre fue generado y la 071 ya tuvo que hacer lo mismo.
-- ⚠⚠ La búsqueda del candado viejo se hace por la LISTA que enumera, no por
-- palabras sueltas. El primer intento buscaba un check que nombrara «metrica» y
-- «abono»… y `precio_abono_sin_nivel` cumple las dos: el drop se llevó puesto el
-- candado equivocado, el add falló por duplicado, el bloque se revirtió entero y
-- todo quedó como estaba — en silencio. Es la misma familia que la lección del
-- 6/9: tapar es una lista negra; acá, buscar por dos palabras sueltas también.
do $metrica$
declare v_nombre text;
begin
  for v_nombre in
    select conname from pg_constraint
     where conrelid = 'precio_metrica'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%''circuito''::text%'
       and pg_get_constraintdef(oid) like '%''sms''::text%'
  loop
    execute format('alter table precio_metrica drop constraint %I', v_nombre);
  end loop;

  alter table precio_metrica add constraint precio_metrica_metrica_valida
    check (metrica in ('abono','firma','documento','circuito','sms','sello_tsa',
                       'asistente_ia','dispositivo_propio','identidad_digital','almacenamiento'));
end $metrica$;

-- =============================================================================
-- 3. LA MUDANZA
--
-- Las filas que ya existen pasan a la lista nueva, y `firma_facturable` deja de
-- ser tabla para ser una vista con el mismo nombre y las mismas columnas.
--
-- ⚠ Es el momento más barato de la historia para hacerlo: en producción hay 5
-- filas, no 50.000.
--
-- Todo condicionado a que todavía sea TABLA, porque esta migración corre dos
-- veces y la segunda se encuentra con la vista.
-- =============================================================================
do $mudanza$
declare v_antes bigint; v_despues bigint;
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where c.relname = 'firma_facturable' and n.nspname = 'public'
                    and c.relkind = 'r') then
    return;   -- ya se mudó
  end if;

  select count(*) into v_antes from public.firma_facturable;

  -- El trigger de inmutabilidad de la 073 mira los UPDATE y DELETE, no los
  -- INSERT: la copia entra sin pelear.
  insert into evento_medible (
    id, cuenta_id, ocurrido_en, periodo, tipo, cantidad, unidad,
    participacion_id, instancia_id, proveedor_id, nivel_firma,
    pais, plan_id, moneda, precio_unitario, cobrada,
    modelo_economico, costo_externo, moneda_costo, a_liquidar, liquidacion_id,
    clave_idempotencia, creado_en)
  select f.id, f.cuenta_id, f.ocurrido_en, f.periodo, 'firma', 1, 'unidad',
         f.participacion_id, f.instancia_id, f.proveedor_id, f.nivel_firma,
         f.pais, f.plan_id, f.moneda, f.precio_unitario, f.cobrada,
         f.modelo_economico, f.costo_proveedor, f.moneda_costo, f.a_liquidar, f.liquidacion_id,
         'firma:' || f.participacion_id::text, f.creado_en
    from public.firma_facturable f;

  select count(*) into v_despues from evento_medible where tipo = 'firma';
  if v_despues <> v_antes then
    raise exception 'La mudanza perdió filas: había % y quedaron %', v_antes, v_despues;
  end if;

  -- ⚠ `movimiento_saldo.firma_facturable_id` apunta por clave foránea a la tabla
  -- que estamos por tirar. Si no se repunta, el `drop` falla o —peor— se lleva
  -- puesta la referencia del ledger, que es plata.
  alter table movimiento_saldo drop constraint if exists movimiento_saldo_firma_facturable_id_fkey;
  alter table movimiento_saldo rename column firma_facturable_id to evento_medible_id;
  alter table movimiento_saldo
    add constraint movimiento_saldo_evento_medible_id_fkey
    foreign key (evento_medible_id) references evento_medible(id);

  drop trigger if exists firma_facturable_inmutable on public.firma_facturable;
  drop trigger if exists wallet_consumir on public.firma_facturable;
  drop table public.firma_facturable;

  raise notice 'Mudadas % línea(s) de firma a evento_medible', v_antes;
end $mudanza$;

-- -----------------------------------------------------------------------------
-- La ventana: el nombre viejo sigue existiendo y devolviendo lo mismo.
--
-- Con esto siguen andando SIN TOCARSE `src/services/consumos.ts`, la liquidación
-- a proveedores (074) y las tres pantallas de la consola.
-- -----------------------------------------------------------------------------
create or replace view firma_facturable as
  select id, participacion_id, instancia_id, cuenta_id, ocurrido_en, periodo,
         pais, nivel_firma, proveedor_id, plan_id, moneda, precio_unitario,
         cobrada, modelo_economico,
         costo_externo as costo_proveedor,
         moneda_costo, a_liquidar, liquidacion_id, creado_en
    from evento_medible
   where tipo = 'firma';

comment on view firma_facturable is
  'Ventana a evento_medible (079) con el nombre y las columnas que tenía la tabla de la 073. '
  'Existe para que la liquidación, consumos.ts y las pantallas no se enteren de la mudanza. '
  'Lo único que deja escribir es liquidacion_id.';

-- La 074 hace `update firma_facturable set liquidacion_id = ...`. Una vista no
-- acepta un update sola. Esto lo permite, y SÓLO eso: cualquier otra columna se
-- rechaza, que es exactamente lo que el trigger de la 073 ya hacía.
create or replace function app.firma_facturable_update()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if new.participacion_id is distinct from old.participacion_id
     or new.cuenta_id      is distinct from old.cuenta_id
     or new.periodo        is distinct from old.periodo
     or new.precio_unitario is distinct from old.precio_unitario
     or new.cobrada        is distinct from old.cobrada
     or new.modelo_economico is distinct from old.modelo_economico
     or new.costo_proveedor is distinct from old.costo_proveedor
     or new.a_liquidar     is distinct from old.a_liquidar
     or new.proveedor_id   is distinct from old.proveedor_id then
    raise exception 'Una línea medida no se corrige: se emite otra. Sólo se puede marcar la liquidación'
      using errcode = '23514';
  end if;
  update public.evento_medible set liquidacion_id = new.liquidacion_id where id = old.id;
  return new;
end $$;

drop trigger if exists firma_facturable_solo_liquidacion on firma_facturable;
create trigger firma_facturable_solo_liquidacion
  instead of update on firma_facturable
  for each row execute function app.firma_facturable_update();

-- =============================================================================
-- 4. INMUTABILIDAD Y WALLET, MUDADOS A LA TABLA REAL
-- =============================================================================

-- Misma regla de la 073, ahora para todos los tipos: lo único que se deja
-- cambiar es `liquidacion_id`, el sello de "esto ya se le pagó al proveedor".
create or replace function app.evento_medible_inmutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una línea medida no se borra: es lo que sostiene una factura ya emitida'
      using errcode = '23514';
  end if;
  if new.liquidacion_id is not distinct from old.liquidacion_id
     and row(new.*) is distinct from row(old.*) then
    raise exception 'Una línea medida no se corrige: se emite otra'
      using errcode = '23514';
  end if;
  if new.cuenta_id is distinct from old.cuenta_id
     or new.tipo is distinct from old.tipo
     or new.periodo is distinct from old.periodo
     or new.cantidad is distinct from old.cantidad
     or new.precio_unitario is distinct from old.precio_unitario
     or new.cobrada is distinct from old.cobrada
     or new.modelo_economico is distinct from old.modelo_economico
     or new.costo_externo is distinct from old.costo_externo
     or new.a_liquidar is distinct from old.a_liquidar
     or new.proveedor_id is distinct from old.proveedor_id
     or new.clave_idempotencia is distinct from old.clave_idempotencia then
    raise exception 'Una línea medida no se corrige: se emite otra. Sólo se puede marcar la liquidación'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists evento_medible_inmutable on evento_medible;
create trigger evento_medible_inmutable
  before update or delete on evento_medible
  for each row execute function app.evento_medible_inmutable();

-- El consumo del saldo, generalizado.
--
-- ⚠⚠ Con esto se cierra sola la deuda 126: hasta hoy el saldo sólo se movía por
-- firmas. Ahora el SMS, el sello y la identidad también descuentan.
--
-- ⚠ Y la condición que ya estaba y ahora importa más: SÓLO descuenta lo que
-- tiene `cobrada = true` y precio mayor que cero. Si no, el sello del lote
-- diario —que por decisión del 30/7 no se le cobra al cliente— le estaría
-- comiendo el saldo.
create or replace function app.wallet_consumir()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare m record; v_reserva uuid; v_monto numeric(14,4);
begin
  if not new.cobrada or new.precio_unitario <= 0 then return new; end if;
  begin
    select * into m from app.modalidad_de_cuenta(new.cuenta_id);
    if m.modalidad <> 'prepago' then return new; end if;

    -- ⚠ El total es precio × cantidad, no el precio. Con las firmas daba igual
    -- porque la cantidad era siempre 1; con tres segmentos de SMS, no.
    v_monto := new.precio_unitario * new.cantidad;

    -- La reserva se busca por el circuito, que es lo que se reservó. Se llega
    -- por la instancia o directo, según qué traiga la línea. Un consumo sin
    -- circuito —el disco, la IA— simplemente no tiene reserva contra la cual ir.
    select r.id into v_reserva
      from public.reserva_saldo r
     where r.estado = 'activa'
       and (r.circuito_id = new.circuito_id
            or r.circuito_id = (select i.circuito_id from public.instancia i
                                 where i.id = new.instancia_id))
     limit 1;

    insert into public.movimiento_saldo (cuenta_id, moneda, tipo, monto, reserva_id, evento_medible_id, creado_por)
    values (new.cuenta_id, new.moneda, 'consumo', -v_monto, v_reserva, new.id, new.tipo);

    -- Si había reserva, lo consumido ya no está reservado: se devuelve esa parte
    -- en el mismo acto, así el saldo no baja dos veces.
    if v_reserva is not null then
      insert into public.movimiento_saldo (cuenta_id, moneda, tipo, monto, reserva_id, evento_medible_id, creado_por)
      values (new.cuenta_id, new.moneda, 'liberacion', v_monto, v_reserva, new.id, new.tipo);
    end if;
  exception when others then
    raise warning 'wallet_consumir: no se pudo registrar el consumo de la línea % (%): %', new.id, sqlstate, sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists wallet_consumir on evento_medible;
create trigger wallet_consumir
  after insert on evento_medible
  for each row execute function app.wallet_consumir();

-- =============================================================================
-- 5. EL PRECIO DE CUALQUIER MÉTRICA
--
-- `app.precio_de_firma()` (073) resuelve el precio de una firma con su nivel y
-- su proveedor. Esto hace lo mismo para las demás métricas, con la misma regla:
-- el precio específico gana sobre el general.
-- =============================================================================
create or replace function app.precio_de_metrica(
  p_plan uuid, p_pais char(2), p_moneda char(3), p_metrica text)
returns numeric
language sql stable security definer set search_path = pg_catalog, public
as $$
  select pm.precio_unitario
    from public.precio_metrica pm
   where pm.plan_id = p_plan and pm.pais = p_pais and pm.moneda = p_moneda
     and pm.metrica = p_metrica and pm.vigente_hasta is null
   order by pm.nivel_firma nulls last
   limit 1;
$$;
revoke all on function app.precio_de_metrica(uuid, char, char, text) from public;
grant execute on function app.precio_de_metrica(uuid, char, char, text) to app_rw, app_operador;

-- Lo que un concepto nos cuesta hoy, del más específico al más general.
create or replace function app.costo_de_concepto(
  p_concepto text, p_proveedor uuid, p_pais char(2))
returns table (costo numeric, moneda char(3))
language sql stable security definer set search_path = pg_catalog, public
as $$
  select t.costo_unitario, t.moneda
    from public.tarifa_costo t
   where t.concepto = p_concepto
     and t.vigente_hasta is null
     and (t.proveedor_id is not distinct from p_proveedor or t.proveedor_id is null)
     and (t.pais = p_pais or t.pais is null)
   order by (t.proveedor_id is not null) desc, (t.pais is not null) desc
   limit 1;
$$;
revoke all on function app.costo_de_concepto(text, uuid, char) from public;
grant execute on function app.costo_de_concepto(text, uuid, char) to app_rw, app_operador;

-- =============================================================================
-- 6. LA FUNCIÓN ÚNICA DE MEDIR
--
-- Una sola puerta, `security definer`, que NUNCA LANZA. Todo lo que mide entra
-- por acá: la firma, el SMS, el sello, la identidad, el disco y la IA.
--
-- ⚠ Es `security definer` por la misma razón que la 076: la política de
-- escritura exige actor 'sistema' a propósito —una cuenta que pudiera escribir
-- su propia línea podría escribirse el precio— pero quien consume es una cuenta,
-- o un firmante externo sin cuenta.
-- =============================================================================
create or replace function app.medir(
  p_tipo            text,
  p_cuenta          uuid,
  p_clave           text,
  p_cantidad        numeric   default 1,
  p_unidad          text      default 'unidad',
  p_metrica_precio  text      default null,   -- null = se deduce del tipo
  p_concepto_costo  text      default null,   -- null = se deduce del tipo
  p_proveedor       uuid      default null,
  p_nivel_firma     text      default null,
  p_participacion   uuid      default null,
  p_instancia       uuid      default null,
  p_circuito        uuid      default null,
  p_detalle         jsonb     default null
)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_cuenta   record;
  v_plan     uuid;
  v_moneda   char(3);
  v_pais     char(2);
  v_periodo  char(7) := to_char(now(), 'YYYY-MM');
  v_metrica  text;
  v_concepto text;
  v_precio   numeric(14,4) := 0;
  v_incluida numeric(14,4) := 0;
  v_ya       numeric(14,4);
  v_cobrada  boolean := true;
  v_costo    numeric(14,4);
  v_mon_c    char(3);
  v_id       uuid;
begin
  -- País, moneda y plan del que PAGA.
  select c.pais into v_pais from public.cuenta c where c.id = p_cuenta;
  if not found then
    raise warning 'medir: no existe la cuenta %', p_cuenta;
    return null;
  end if;

  select s.plan_id, s.moneda into v_plan, v_moneda
    from public.suscripcion s
   where s.cuenta_id = p_cuenta and s.estado = 'activa'
   order by s.inicio desc limit 1;
  v_moneda := coalesce(v_moneda, 'USD');

  v_metrica  := coalesce(p_metrica_precio, case p_tipo
                   when 'firma' then 'firma'
                   when 'circuito_despachado' then 'circuito'
                   when 'documento_completado' then 'documento'
                   when 'sms' then 'sms'
                   when 'sello_tsa' then 'sello_tsa'
                   when 'verificacion_identidad' then 'identidad_digital'
                   when 'almacenamiento' then 'almacenamiento'
                   when 'asistente_ia' then 'asistente_ia' end);
  v_concepto := coalesce(p_concepto_costo, case p_tipo
                   when 'sms' then 'sms'
                   when 'sello_tsa' then 'sello_tsa'
                   when 'verificacion_identidad' then 'verificacion_identidad'
                   when 'almacenamiento' then 'almacenamiento'
                   when 'asistente_ia' then 'asistente_ia' end);

  -- ── El precio, si hay plan. Sin plan se mide igual con precio 0: el hecho de
  -- que hubo consumo es el dato que no se puede perder.
  if v_plan is not null then
    v_precio := coalesce(app.precio_de_metrica(v_plan, v_pais, v_moneda, v_metrica), 0);

    select coalesce(pm.cantidad_incluida, 0) into v_incluida
      from public.precio_metrica pm
     where pm.plan_id = v_plan and pm.pais = v_pais and pm.moneda = v_moneda
       and pm.metrica = v_metrica and pm.vigente_hasta is null
     limit 1;

    -- ⚠⚠ Se cuentan TODAS las del período, no sólo las cobradas. Contar sólo las
    -- cobradas deja el contador en cero para siempre y nunca se llega a cobrar
    -- la primera. Lo agarró el ejerce de la 076 y vale igual acá.
    if coalesce(v_incluida, 0) > 0 then
      select coalesce(sum(e.cantidad), 0) into v_ya
        from public.evento_medible e
       where e.cuenta_id = p_cuenta and e.periodo = v_periodo and e.tipo = p_tipo;
      if v_ya + p_cantidad <= v_incluida then
        v_cobrada := false;
      end if;
    end if;
  end if;

  -- ── El costo externo
  if v_concepto is not null then
    select c.costo, c.moneda into v_costo, v_mon_c
      from app.costo_de_concepto(v_concepto, p_proveedor, v_pais) c;
  end if;

  insert into public.evento_medible (
    cuenta_id, periodo, tipo, cantidad, unidad,
    participacion_id, instancia_id, circuito_id, proveedor_id, nivel_firma, detalle,
    pais, plan_id, moneda, precio_unitario, cobrada,
    modelo_economico, costo_externo, moneda_costo, clave_idempotencia)
  values (
    p_cuenta, v_periodo, p_tipo, p_cantidad, p_unidad,
    p_participacion, p_instancia, p_circuito, p_proveedor, p_nivel_firma, p_detalle,
    v_pais, v_plan, v_moneda, v_precio, v_cobrada,
    case when v_costo is not null then 'costo' else 'sin_costo' end,
    v_costo, v_mon_c, p_clave)
  on conflict (clave_idempotencia) do nothing
  returning id into v_id;

  return v_id;

exception when others then
  -- ⚠ Lo que se pierde es una línea de facturación, que se reconstruye. Lo que
  -- NO se puede perder es el hecho: la firma ya se aplicó, el SMS ya salió.
  raise warning 'medir(%): no se pudo medir para la cuenta % (%): %', p_tipo, p_cuenta, sqlstate, sqlerrm;
  return null;
end $$;

revoke all on function app.medir(text, uuid, text, numeric, text, text, text, uuid, text, uuid, uuid, uuid, jsonb) from public;
grant execute on function app.medir(text, uuid, text, numeric, text, text, text, uuid, text, uuid, uuid, uuid, jsonb) to app_rw;

comment on function app.medir(text, uuid, text, numeric, text, text, text, uuid, text, uuid, uuid, uuid, jsonb) is
  'La única puerta para anotar un consumo. Resuelve precio, cantidades incluidas y costo '
  'externo con lo vigente hoy, y NUNCA LANZA: si falla, avisa por warning y devuelve null. '
  'Migración 079.';

-- =============================================================================
-- 7. LA FIRMA SIGUE MIDIÉNDOSE IGUAL DESDE AFUERA
--
-- ⚠⚠ `app.medir_firma(participacion, nivel, proveedor)` conserva EXACTAMENTE su
-- firma de llamada, porque la línea que la invoca vive en `firmar()`, dentro del
-- tramo de firma autorizado el 7/9. Esa línea NO SE TOCA.
--
-- Lo que cambia es adonde escribe. El cálculo del revenue share se conserva tal
-- como lo dejó la 076, porque es lo único que esta función hace y la general no.
-- =============================================================================
create or replace function app.medir_firma(
  p_participacion uuid,
  p_nivel         text,
  p_proveedor_codigo text
)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_part     record;
  v_prov     uuid;
  v_pais     char(2);
  v_modelo   text := 'sin_costo';
  v_costo    numeric(14,4);
  v_mon_c    char(3);
  v_pct      numeric(6,3);
  v_id       uuid;
begin
  select p.id, p.instancia_id, p.cuenta_propietaria_id
    into v_part
    from public.participacion p
   where p.id = p_participacion;
  if not found then
    raise warning 'medir_firma: no existe la participación %', p_participacion;
    return null;
  end if;

  select c.pais into v_pais from public.cuenta c where c.id = v_part.cuenta_propietaria_id;

  -- El sello de la plataforma no es un proveedor ajeno: es firma simple.
  if p_proveedor_codigo is not null and p_proveedor_codigo not like 'sello_plataforma%' then
    select pf.id into v_prov from public.proveedor_firma pf where pf.codigo = p_proveedor_codigo;
  end if;

  v_id := app.medir(
    p_tipo          => 'firma',
    p_cuenta        => v_part.cuenta_propietaria_id,
    p_clave         => 'firma:' || p_participacion::text,
    p_cantidad      => 1,
    p_unidad        => 'unidad',
    p_proveedor     => v_prov,
    p_nivel_firma   => p_nivel,
    p_participacion => p_participacion,
    p_instancia     => v_part.instancia_id);

  if v_id is null then return null; end if;

  -- El modelo económico del proveedor para ese país, y lo que hay que liquidarle
  -- por ESTA firma, con el porcentaje vigente hoy. Es lo propio de la firma y
  -- por eso no vive en la función general.
  if v_prov is not null then
    select pp.modelo_economico, pp.costo_por_firma, pp.moneda_costo, pp.revenue_share_pct
      into v_modelo, v_costo, v_mon_c, v_pct
      from public.proveedor_pais pp
     where pp.proveedor_id = v_prov and pp.pais = v_pais;

    if v_modelo is not null and v_modelo <> 'sin_costo' then
      update public.evento_medible e
         set modelo_economico = v_modelo,
             costo_externo    = v_costo,
             moneda_costo     = coalesce(v_mon_c, e.moneda),
             a_liquidar       = case
               when v_modelo = 'revenue_share'
                 then round(e.precio_unitario * coalesce(v_pct, 0) / 100.0, 4)
               else null end
       where e.id = v_id;
    end if;
  end if;

  return v_id;
exception when others then
  raise warning 'medir_firma: no se pudo medir la participación % (%): %', p_participacion, sqlstate, sqlerrm;
  return null;
end $$;

revoke all on function app.medir_firma(uuid, text, text) from public;
grant execute on function app.medir_firma(uuid, text, text) to app_rw;

-- =============================================================================
-- 8. LOS GANCHOS QUE SALEN DE LA BASE
--
-- La regla: lo que la base ya sabe, se mide en la base. Sólo el SMS y la IA
-- necesitan que el código avise, porque el dato —los segmentos, los tokens— lo
-- tiene el proveedor y no la base.
-- =============================================================================

-- ── El sello de tiempo. La 028 ya escribe una fila por sello con su autoridad.
--
-- ⚠ Sólo el sellado de una FIRMA o un DOCUMENTO. El de alcance 'lote' es el
-- sello diario de la cadena de evidencias, y por decisión del 30/7 no se le
-- cobra al cliente: es costo nuestro de tener la cadena, no un consumo suyo.
create or replace function app.medir_sello_tiempo()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_cuenta uuid;
begin
  if new.estado <> 'sellado' or new.alcance not in ('firma','documento') then return new; end if;
  if new.instancia_id is null then return new; end if;
  begin
    select c.cuenta_propietaria_id into v_cuenta
      from public.instancia i join public.circuito c on c.id = i.circuito_id
     where i.id = new.instancia_id;
    if v_cuenta is null then return new; end if;

    perform app.medir(
      p_tipo      => 'sello_tsa',
      p_cuenta    => v_cuenta,
      p_clave     => 'sello:' || new.id::text,
      p_instancia => new.instancia_id,
      p_detalle   => jsonb_build_object('autoridad', new.autoridad, 'alcance', new.alcance));
  exception when others then
    raise warning 'medir_sello_tiempo: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end $$;

drop trigger if exists medir_sello_tiempo on sello_tiempo;
create trigger medir_sello_tiempo
  after insert or update of estado on sello_tiempo
  for each row execute function app.medir_sello_tiempo();

-- ── El documento terminado. `instancia.estado = 'firmada'` es el fin del camino.
create or replace function app.medir_documento_completado()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_cuenta uuid;
begin
  if new.estado <> 'firmada' or old.estado = 'firmada' then return new; end if;
  begin
    select c.cuenta_propietaria_id into v_cuenta
      from public.circuito c where c.id = new.circuito_id;
    if v_cuenta is null then return new; end if;
    perform app.medir(
      p_tipo      => 'documento_completado',
      p_cuenta    => v_cuenta,
      p_clave     => 'documento:' || new.id::text,
      p_instancia => new.id,
      p_circuito  => new.circuito_id);
  exception when others then
    raise warning 'medir_documento_completado: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end $$;

drop trigger if exists medir_documento on instancia;
create trigger medir_documento
  after update of estado on instancia
  for each row execute function app.medir_documento_completado();

-- ── El circuito despachado. 'enviado' es el estado del despacho (lección del
-- 1/9: 'en_curso' es de instancia, no de circuito).
create or replace function app.medir_circuito_despachado()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if new.estado <> 'enviado' or old.estado = 'enviado' then return new; end if;
  begin
    perform app.medir(
      p_tipo     => 'circuito_despachado',
      p_cuenta   => new.cuenta_propietaria_id,
      p_clave    => 'circuito:' || new.id::text,
      p_circuito => new.id);
  exception when others then
    raise warning 'medir_circuito_despachado: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end $$;

drop trigger if exists medir_circuito on circuito;
create trigger medir_circuito
  after update of estado on circuito
  for each row execute function app.medir_circuito_despachado();

-- ── La verificación de identidad con un proveedor externo. Cada una nos cuesta.
--
-- ⚠ Sólo las que pasan por un proveedor (`tipo = 'idp'`): verificar un correo o
-- un teléfono es nuestro y no se le cobra a nadie.
--
-- ⚠⚠ Quién paga: la cuenta que EMITE el documento que se está por firmar no se
-- conoce desde acá —un anclaje es de una identidad, no de un circuito—, así que
-- se le cobra a la cuenta de la propia identidad cuando la tiene. Si no tiene
-- (un firmante externo sin cuenta), no se mide: no hay a quién cobrarle, y
-- cobrárselo al emisor exigiría un dato que este trigger no tiene.
create or replace function app.medir_verificacion_identidad()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_cuenta uuid; v_prov uuid;
begin
  if new.tipo <> 'idp' then return new; end if;
  begin
    select m.cuenta_id into v_cuenta
      from public.membresia m where m.identidad_id = new.identidad_id limit 1;
    if v_cuenta is null then return new; end if;

    select pf.id into v_prov from public.proveedor_firma pf where pf.codigo = new.idp;

    perform app.medir(
      p_tipo      => 'verificacion_identidad',
      p_cuenta    => v_cuenta,
      p_clave     => 'identidad:' || new.id::text,
      p_proveedor => v_prov,
      p_detalle   => jsonb_build_object('idp', new.idp, 'nivel', new.nivel_garantia));
  exception when others then
    raise warning 'medir_verificacion_identidad: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end $$;

drop trigger if exists medir_identidad on anclaje_identidad;
create trigger medir_identidad
  after insert on anclaje_identidad
  for each row execute function app.medir_verificacion_identidad();

-- =============================================================================
-- 9. EL DISCO — UNA FOTO POR MES (decisión de Claudio, 14/9)
--
-- El disco no es algo que pasa: es algo que está. Quien subió 500 documentos en
-- marzo los sigue ocupando en abril sin hacer nada nuevo. Por eso no hay trigger
-- que lo dispare: hay una función que se corre una vez por período.
--
-- ⚠ La clave de idempotencia es (cuenta, período): correrla dos veces el mismo
-- mes no duplica nada. Es a propósito y es lo que la hace segura de reintentar.
-- =============================================================================
create or replace function app.medir_almacenamiento(p_periodo char(7) default null)
returns int
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_periodo char(7) := coalesce(p_periodo, to_char(now(), 'YYYY-MM'));
  v_n int := 0;
  r record;
  v_id uuid;
begin
  for r in
    select c.id as cuenta_id, u.bytes
      from public.cuenta c
      cross join lateral app.custodia_usada(c.id) u
     where u.bytes > 0
  loop
    v_id := app.medir(
      p_tipo     => 'almacenamiento',
      p_cuenta   => r.cuenta_id,
      p_clave    => 'almacenamiento:' || r.cuenta_id::text || ':' || v_periodo,
      p_cantidad => round(r.bytes / 1048576.0, 4),   -- MB
      p_unidad   => 'mb',
      p_detalle  => jsonb_build_object('bytes', r.bytes, 'periodo', v_periodo));
    if v_id is not null then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;

revoke all on function app.medir_almacenamiento(char) from public;
grant execute on function app.medir_almacenamiento(char) to app_rw, app_operador;

comment on function app.medir_almacenamiento(char) is
  'Anota cuánto disco tenía guardado cada cuenta en el período. Se corre una vez por mes. '
  'Repetirla el mismo mes no duplica: la clave de idempotencia es (cuenta, período). 079.';

-- =============================================================================
-- 10. LA IA SE MUDA (decisión de Claudio, 14/9)
--
-- `consumo_ia` (013) era un ACUMULADOR por (cuenta, período, modelo). Pasa a ser
-- una VISTA agregada sobre la lista única, así `consumos.ts`, `operador.ts`,
-- `borrar_empresa.ts` y la pantalla siguen leyendo lo mismo.
--
-- ⚠⚠ Y con esto las columnas muertas de IA en `plan` y `suscripcion` (013) y su
-- trigger espejo (071) dejan de tener a quién sostener — deuda 99. No se tiran
-- acá: primero tiene que dejar de leerlas `consumo_ia.ts`, que es código.
-- =============================================================================
do $mudanza_ia$
declare v_n bigint;
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where c.relname = 'consumo_ia' and n.nspname = 'public' and c.relkind = 'r') then
    return;
  end if;

  insert into evento_medible (
    cuenta_id, ocurrido_en, periodo, tipo, cantidad, unidad, detalle,
    pais, moneda, precio_unitario, cobrada, modelo_economico, costo_externo, moneda_costo,
    clave_idempotencia)
  select ci.cuenta_id, ci.actualizado_en, ci.periodo, 'asistente_ia',
         ci.input_tokens + ci.output_tokens, 'token',
         jsonb_build_object('modelo', ci.modelo,
                            'input_tokens', ci.input_tokens,
                            'output_tokens', ci.output_tokens),
         coalesce(c.pais, 'UY'), ci.moneda, 0, true,
         case when ci.costo_base > 0 then 'costo' else 'sin_costo' end,
         nullif(ci.costo_base, 0), ci.moneda,
         'ia:' || ci.cuenta_id::text || ':' || ci.periodo || ':' || ci.modelo
    from public.consumo_ia ci
    join public.cuenta c on c.id = ci.cuenta_id
  on conflict (clave_idempotencia) do nothing;

  get diagnostics v_n = row_count;
  drop table public.consumo_ia;
  raise notice 'Mudadas % fila(s) de consumo de IA', v_n;
end $mudanza_ia$;

create or replace view consumo_ia as
  -- ⚠ No hay `min(uuid)` en Postgres: el id representativo del grupo se toma
  -- del más viejo, con array_agg. La vista necesita una columna `id` porque la
  -- tabla la tenía y el código la lee.
  select (array_agg(e.id order by e.ocurrido_en))[1]      as id,
         e.cuenta_id,
         e.periodo,
         e.detalle ->> 'modelo'                           as modelo,
         coalesce(sum((e.detalle ->> 'input_tokens')::bigint), 0)  as input_tokens,
         coalesce(sum((e.detalle ->> 'output_tokens')::bigint), 0) as output_tokens,
         coalesce(sum(e.costo_externo), 0)::numeric(14,6) as costo_base,
         min(e.moneda_costo)                              as moneda,
         max(e.ocurrido_en)                               as actualizado_en
    from evento_medible e
   where e.tipo = 'asistente_ia'
   group by e.cuenta_id, e.periodo, e.detalle ->> 'modelo';

comment on view consumo_ia is
  'Ventana agregada a evento_medible (079) con las columnas que tenía la tabla de la 013. '
  'La IA ahora se anota por llamada; esto la suma por cuenta, período y modelo.';

-- La puerta para anotar una llamada al modelo. La llama `consumo_ia.ts`.
create or replace function app.medir_ia(
  p_cuenta uuid, p_modelo text, p_input bigint, p_output bigint,
  p_costo numeric, p_moneda char(3), p_clave text)
returns uuid
language sql security definer set search_path = pg_catalog, public
as $$
  select app.medir(
    p_tipo     => 'asistente_ia',
    p_cuenta   => p_cuenta,
    p_clave    => p_clave,
    p_cantidad => p_input + p_output,
    p_unidad   => 'token',
    p_detalle  => jsonb_build_object('modelo', p_modelo,
                                     'input_tokens', p_input,
                                     'output_tokens', p_output,
                                     'costo_declarado', p_costo,
                                     'moneda_declarada', p_moneda));
$$;
revoke all on function app.medir_ia(uuid, text, bigint, bigint, numeric, char, text) from public;
grant execute on function app.medir_ia(uuid, text, bigint, bigint, numeric, char, text) to app_rw;

-- La puerta del SMS. La llama `twilio.ts` con los segmentos que Twilio devuelve.
create or replace function app.medir_sms(
  p_cuenta uuid, p_segmentos int, p_pais_destino char(2), p_clave text)
returns uuid
language sql security definer set search_path = pg_catalog, public
as $$
  select app.medir(
    p_tipo     => 'sms',
    p_cuenta   => p_cuenta,
    p_clave    => p_clave,
    p_cantidad => greatest(p_segmentos, 1),
    p_unidad   => 'segmento',
    p_detalle  => jsonb_build_object('pais_destino', p_pais_destino, 'segmentos', p_segmentos));
$$;
revoke all on function app.medir_sms(uuid, int, char, text) from public;
grant execute on function app.medir_sms(uuid, int, char, text) to app_rw;

-- =============================================================================
-- 11. RLS
--
-- Tenant duro, como todo el billing (013): la plata no cruza cuentas ni por
-- otorgamiento. El firmante externo no ve nada de esto.
--
-- ⚠ La escribe el SISTEMA, no la cuenta. Una cuenta que pudiera escribir su
-- propia línea podría escribirse el precio.
--
-- ⚠ El operador VE los agregados —"40 firmas avanzadas con tuID en marzo"— pero
-- la tabla referencia circuitos e instancias, nunca contenido: no puede ver qué
-- se firmó (diseño del 30/7 §7).
-- =============================================================================
alter table evento_medible enable row level security;
drop policy if exists medible_select on evento_medible;
drop policy if exists medible_escritura on evento_medible;
create policy medible_select on evento_medible for select using (
     app.actor() in ('sistema','operador')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('facturacion','leer'))
);
create policy medible_escritura on evento_medible for all
  using (app.actor() = 'sistema') with check (app.actor() = 'sistema');

grant select, insert, update on evento_medible to app_rw;
grant select on evento_medible to app_operador;
grant select, update on firma_facturable to app_rw;
grant select on firma_facturable to app_operador;
grant select on consumo_ia to app_rw, app_operador;

-- `tarifa_costo` es administración del operador, como los precios. Pero a
-- diferencia de `precio_metrica` NO es pública: lo que nos cuesta un proveedor
-- no se publica en la página de precios.
alter table tarifa_costo enable row level security;
drop policy if exists tarifa_select on tarifa_costo;
drop policy if exists tarifa_escritura on tarifa_costo;
create policy tarifa_select on tarifa_costo for select
  using (app.actor() in ('operador','sistema'));
create policy tarifa_escritura on tarifa_costo for all
  using (app.actor() = 'operador') with check (app.actor() = 'operador');
grant select on tarifa_costo to app_rw;
grant select, insert, update, delete on tarifa_costo to app_operador;

-- =============================================================================
-- 12. CENTINELAS
-- =============================================================================
do $centinela$
declare v_mal int; v_firmas bigint;
begin
  -- La ventana tiene que existir y tener que ver con las firmas.
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where c.relname = 'firma_facturable' and n.nspname = 'public' and c.relkind = 'v') then
    raise exception 'firma_facturable tiene que haber quedado como vista';
  end if;

  -- El operador no escribe líneas medidas: las escribe el medidor.
  if exists (select 1 from information_schema.role_table_grants
              where table_name = 'evento_medible' and grantee = 'app_operador'
                and privilege_type in ('INSERT','UPDATE','DELETE')) then
    raise exception 'El operador no escribe líneas medidas: las escribe el medidor';
  end if;

  -- El ledger tiene que seguir apuntando a algo que exista.
  if not exists (select 1 from information_schema.columns
                  where table_name = 'movimiento_saldo' and column_name = 'evento_medible_id') then
    raise exception 'movimiento_saldo quedó sin la referencia a la línea medida';
  end if;

  -- Ninguna firma puede haber quedado sin nivel: no se podría cobrar ni contar.
  select count(*) into v_mal from evento_medible where tipo = 'firma' and nivel_firma is null;
  if v_mal > 0 then
    raise exception '% línea(s) de firma sin nivel', v_mal;
  end if;

  -- Y la mudanza no pudo perder nada: si había firmas, tienen que seguir estando.
  select count(*) into v_firmas from firma_facturable;
  raise notice 'evento_medible: % línea(s) de firma visibles por la ventana', v_firmas;
end $centinela$;

commit;
