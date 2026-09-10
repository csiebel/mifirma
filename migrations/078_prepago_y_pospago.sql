-- =============================================================================
-- MiFirma — 078_prepago_y_pospago.sql
-- Cómo paga cada empresa: por adelantado con saldo, o a mes vencido con tope.
--
-- ═══ LO QUE DECIDIÓ CLAUDIO EL 10/9 ═══
--
--   · La modalidad la fija el PLAN, con override por empresa. (Es la cascada de
--     `billing_config`, 019, que hasta hoy nadie leía.)
--   · En prepago se recarga con PAQUETES que arma el operador (100 firmas por X,
--     500 por Y) y también con MONTO LIBRE. El saldo se lleva en plata.
--   · El sistema AVISA cuando la empresa está cerca del límite; AL LÍMITE frena el
--     despacho; y el OPERADOR puede levantar el freno para una empresa.
--   · Al despachar se RESERVA lo estimado, cada firma CONSUME al precio congelado
--     ese día, y al cerrar el circuito lo que sobró VUELVE al saldo.
--
-- ═══ LA PLATA ES UN LEDGER ═══
--
-- No hay columna «saldo» que se actualice: el saldo ES la suma de movimientos
-- inmutables (`movimiento_saldo`). Mismo espíritu que el expediente de
-- evidencias: en un producto que cobra por firma, la trazabilidad del dinero
-- es tan auditable como la de las firmas. Principio 3 de `billing-diseno.md`.
--
-- ═══ ⚠ LO QUE NUNCA SE FRENA ═══
--
-- Sin saldo o pasado el tope, lo que se frena es DESPACHAR. Un circuito ya
-- despachado sigue hasta terminar: el firmante externo no tiene la culpa de la
-- cuenta del emisor (D3, y los otorgamientos irrevocables de la RLS). Y una
-- firma nunca se pierde por un problema de plata: el gancho del wallet sobre
-- `firma_facturable` atrapa sus propios errores, igual que el medidor (076).
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. Qué modalidad rige para una cuenta (la cascada de billing_config, leída)
--
-- cuenta → (plan de la suscripción activa, país de la cuenta) → (plan, sin país)
-- → pospago sin tope. Siempre devuelve una fila (lección del ejerce 070).
-- -----------------------------------------------------------------------------
create or replace function app.modalidad_de_cuenta(p_cuenta uuid)
returns table (
  modalidad          text,
  incluido_mensual   int,
  tope_excedente     int,
  umbral_aviso_saldo numeric,
  origen             text
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  with c as (
    select cu.id, cu.pais, s.plan_id
      from public.cuenta cu
      left join public.suscripcion s on s.cuenta_id = cu.id and s.estado = 'activa'
     where cu.id = p_cuenta
  ),
  candidatas as (
    select bc.modalidad, bc.incluido_mensual, bc.tope_excedente, bc.umbral_aviso_saldo,
           case when bc.cuenta_id is not null then 'cuenta'
                when bc.pais is not null then 'plan_pais'
                else 'plan' end as origen,
           case when bc.cuenta_id is not null then 0
                when bc.pais is not null then 1
                else 2 end as prioridad
      from public.billing_config bc, c
     where bc.vigente_desde <= current_date
       and (bc.vigente_hasta is null or bc.vigente_hasta >= current_date)
       and (   bc.cuenta_id = c.id
            or (bc.cuenta_id is null and bc.plan_id = c.plan_id
                and (bc.pais is null or bc.pais = c.pais)))
  ),
  elegida as (
    select modalidad, incluido_mensual, tope_excedente, umbral_aviso_saldo, origen
      from candidatas order by prioridad limit 1
  )
  select * from elegida
  union all
  select 'pospago', null::int, null::int, null::numeric, 'por_omision'
   where not exists (select 1 from elegida);
$$;
revoke all on function app.modalidad_de_cuenta(uuid) from public;
grant execute on function app.modalidad_de_cuenta(uuid) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- 2. Los paquetes de recarga que arma el operador
-- -----------------------------------------------------------------------------
create table if not exists paquete_recarga (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null unique,
  nombre_i18n   jsonb not null,
  pais          char(2),                         -- null = para todos
  moneda        char(3) not null,
  monto         numeric(14,2) not null check (monto > 0),      -- lo que paga
  bono          numeric(14,2) not null default 0 check (bono >= 0), -- lo que se le acredita de más
  activo        boolean not null default true,
  orden         int not null default 100,
  creado_en     timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
comment on table paquete_recarga is
  'Paquetes de recarga prepago: se paga `monto` y se acredita `monto + bono`. El descuento '
  'por volumen es el bono. Migración 078.';

alter table paquete_recarga enable row level security;
drop policy if exists paquete_select on paquete_recarga;
drop policy if exists paquete_escritura on paquete_recarga;
create policy paquete_select on paquete_recarga for select using (true);
create policy paquete_escritura on paquete_recarga for all
  using (app.actor() = 'operador') with check (app.actor() = 'operador');
grant select on paquete_recarga to app_rw, app_operador;
grant insert, update, delete on paquete_recarga to app_operador;

-- -----------------------------------------------------------------------------
-- 3. El ledger, las recargas y las reservas
-- -----------------------------------------------------------------------------
create table if not exists recarga (
  id               uuid primary key default gen_random_uuid(),
  cuenta_id        uuid not null references cuenta(id),
  moneda           char(3) not null,
  monto_pagado     numeric(14,2) not null check (monto_pagado > 0),
  monto_acreditado numeric(14,2) not null check (monto_acreditado > 0),
  paquete_id       uuid references paquete_recarga(id),
  -- Cómo entró la plata: por la pasarela (pago_id), o la acreditó el operador
  -- a mano (transferencia recibida), con motivo.
  pago_id          uuid,
  medio            text not null default 'manual' check (medio in ('pasarela','manual')),
  estado           text not null default 'pendiente'
                     check (estado in ('pendiente','acreditada','fallida','anulada')),
  motivo           text,
  creada_por       text,
  creada_en        timestamptz not null default now(),
  acreditada_en    timestamptz
);
create index if not exists recarga_por_cuenta on recarga (cuenta_id, creada_en desc);

create table if not exists reserva_saldo (
  id              uuid primary key default gen_random_uuid(),
  cuenta_id       uuid not null references cuenta(id),
  circuito_id     uuid not null unique references circuito(id),
  moneda          char(3) not null,
  monto_estimado  numeric(14,4) not null check (monto_estimado >= 0),
  desglose        jsonb not null default '{}'::jsonb,
  estado          text not null default 'activa'
                    check (estado in ('activa','liquidada')),
  creada_en       timestamptz not null default now(),
  liquidada_en    timestamptz
);
create index if not exists reserva_activa_por_cuenta on reserva_saldo (cuenta_id) where estado = 'activa';

create table if not exists movimiento_saldo (
  id                  uuid primary key default gen_random_uuid(),
  cuenta_id           uuid not null references cuenta(id),
  moneda              char(3) not null,
  tipo                text not null check (tipo in
                        ('recarga','reserva','consumo','liberacion','ajuste_operador','reintegro')),
  -- Signo: recarga / liberacion / reintegro suman; reserva / consumo restan;
  -- ajuste_operador lleva el signo que corresponda, con motivo obligatorio.
  monto               numeric(14,4) not null,
  reserva_id          uuid references reserva_saldo(id),
  recarga_id          uuid references recarga(id),
  firma_facturable_id uuid references firma_facturable(id),
  circuito_id         uuid references circuito(id),
  motivo              text,
  creado_por          text,
  creado_en           timestamptz not null default now(),
  constraint movimiento_signo_coherente check (
    (tipo in ('recarga','liberacion','reintegro') and monto >= 0)
    or (tipo in ('reserva','consumo') and monto <= 0)
    or (tipo = 'ajuste_operador' and motivo is not null)
  )
);
create index if not exists movimiento_por_cuenta on movimiento_saldo (cuenta_id, moneda, creado_en);

-- Un movimiento no se toca. Nunca. Corregir es escribir otro movimiento.
create or replace function app.movimiento_inmutable()
returns trigger language plpgsql as $$
begin
  raise exception 'Un movimiento de saldo no se modifica ni se borra: se corrige con otro movimiento'
    using errcode = '23514';
end $$;
drop trigger if exists movimiento_inmutable on movimiento_saldo;
create trigger movimiento_inmutable
  before update or delete on movimiento_saldo
  for each row execute function app.movimiento_inmutable();

-- El freno levantado por el operador para una empresa.
create table if not exists levante_de_limite (
  id           uuid primary key default gen_random_uuid(),
  cuenta_id    uuid not null references cuenta(id),
  hasta        timestamptz not null,
  -- Cuánto más se le deja despachar por encima del saldo o del tope. NULL =
  -- sin límite mientras dure.
  monto_extra  numeric(14,2) check (monto_extra is null or monto_extra > 0),
  motivo       text not null,
  por          text not null,
  creado_en    timestamptz not null default now(),
  revocado_en  timestamptz
);
create index if not exists levante_vigente_por_cuenta on levante_de_limite (cuenta_id) where revocado_en is null;

-- ── RLS: la plata es tenant duro. No cruza cuentas ni por otorgamiento.
alter table recarga enable row level security;
alter table reserva_saldo enable row level security;
alter table movimiento_saldo enable row level security;
alter table levante_de_limite enable row level security;

drop policy if exists recarga_select on recarga;
drop policy if exists recarga_escritura on recarga;
create policy recarga_select on recarga for select using (
     app.actor() in ('sistema','operador')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('facturacion','leer'))
);
create policy recarga_escritura on recarga for all
  using (app.actor() in ('sistema','operador')) with check (app.actor() in ('sistema','operador'));

drop policy if exists reserva_select on reserva_saldo;
drop policy if exists reserva_escritura on reserva_saldo;
create policy reserva_select on reserva_saldo for select using (
     app.actor() in ('sistema','operador')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('facturacion','leer'))
);
-- Las reservas las escribe la base (funciones security definer), nadie más.
create policy reserva_escritura on reserva_saldo for all
  using (app.actor() = 'sistema') with check (app.actor() = 'sistema');

drop policy if exists movimiento_select on movimiento_saldo;
drop policy if exists movimiento_escritura on movimiento_saldo;
create policy movimiento_select on movimiento_saldo for select using (
     app.actor() in ('sistema','operador')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('facturacion','leer'))
);
create policy movimiento_escritura on movimiento_saldo for insert
  with check (app.actor() in ('sistema','operador'));

drop policy if exists levante_select on levante_de_limite;
drop policy if exists levante_escritura on levante_de_limite;
create policy levante_select on levante_de_limite for select using (
     app.actor() in ('sistema','operador')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()));
create policy levante_escritura on levante_de_limite for all
  using (app.actor() = 'operador') with check (app.actor() = 'operador');

grant select on recarga, reserva_saldo, movimiento_saldo, levante_de_limite to app_rw, app_operador;
grant insert, update on recarga to app_operador;
grant insert on movimiento_saldo to app_operador;
grant insert, update on levante_de_limite to app_operador;
-- ⚠ app_rw NO escribe plata directo: reserva, consume y libera por las
-- funciones de abajo, que son security definer.

-- -----------------------------------------------------------------------------
-- 4. Saldo, reservado y estado
-- -----------------------------------------------------------------------------
create or replace function app.saldo_disponible(p_cuenta uuid, p_moneda char(3))
returns numeric
language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce(sum(monto), 0)::numeric(14,4)
    from public.movimiento_saldo
   where cuenta_id = p_cuenta and moneda = upper(p_moneda);
$$;
revoke all on function app.saldo_disponible(uuid, char(3)) from public;
grant execute on function app.saldo_disponible(uuid, char(3)) to app_rw, app_operador;

create or replace function app.levante_vigente(p_cuenta uuid)
returns table (id uuid, hasta timestamptz, monto_extra numeric, motivo text)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select l.id, l.hasta, l.monto_extra, l.motivo
    from public.levante_de_limite l
   where l.cuenta_id = p_cuenta and l.revocado_en is null and l.hasta > now()
   order by l.creado_en desc limit 1;
$$;
revoke all on function app.levante_vigente(uuid) from public;
grant execute on function app.levante_vigente(uuid) to app_rw, app_operador;

-- La foto completa, para la consola y para la pantalla del emisor: qué
-- modalidad, cuánto hay, cuánto está reservado, qué se consumió este mes, si
-- está cerca del límite o frenada, y si hay un levante.
create or replace function app.estado_de_saldo(p_cuenta uuid)
returns table (
  modalidad          text,
  moneda             char(3),
  saldo              numeric,
  reservado          numeric,
  consumidas_mes     bigint,
  incluido_mensual   int,
  tope_excedente     int,
  umbral_aviso_saldo numeric,
  cerca_del_limite   boolean,
  frenada            boolean,
  levante_hasta      timestamptz,
  levante_monto      numeric
)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare
  m record; v_moneda char(3); v_saldo numeric; v_res numeric; v_cons bigint; lv record;
  v_cerca boolean := false; v_frenada boolean := false;
begin
  select * into m from app.modalidad_de_cuenta(p_cuenta);
  select coalesce(s.moneda, c.moneda) into v_moneda
    from public.cuenta c
    left join public.suscripcion s on s.cuenta_id = c.id and s.estado = 'activa'
   where c.id = p_cuenta;
  v_saldo := app.saldo_disponible(p_cuenta, v_moneda);
  select coalesce(sum(monto_estimado), 0) into v_res
    from public.reserva_saldo where cuenta_id = p_cuenta and estado = 'activa';
  select count(*) into v_cons
    from public.firma_facturable
   where cuenta_id = p_cuenta and periodo = to_char(now(), 'YYYY-MM') and cobrada;
  select * into lv from app.levante_vigente(p_cuenta);

  if m.modalidad = 'prepago' then
    v_frenada := v_saldo <= 0;
    v_cerca := m.umbral_aviso_saldo is not null and v_saldo <= m.umbral_aviso_saldo;
  else
    if m.tope_excedente is not null then
      v_frenada := v_cons >= coalesce(m.incluido_mensual, 0) + m.tope_excedente;
      v_cerca := v_cons >= (coalesce(m.incluido_mensual, 0) + m.tope_excedente) * 0.8;
    end if;
  end if;
  if lv.id is not null then v_frenada := false; end if;

  return query select m.modalidad, v_moneda, v_saldo, v_res, v_cons,
                      m.incluido_mensual, m.tope_excedente, m.umbral_aviso_saldo,
                      v_cerca, v_frenada, lv.hasta, lv.monto_extra;
end $$;
revoke all on function app.estado_de_saldo(uuid) from public;
grant execute on function app.estado_de_saldo(uuid) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- 5. Reservar al despachar
--
-- Se estima con lo que se sabe al despachar: cada firmante pendiente × el
-- precio de una firma del nivel que PIDE el circuito (lo que cada uno produzca
-- se cobra al firmar, al precio congelado ese día). Si no alcanza, lanza con
-- el faltante, y el despacho no sale — salvo levante vigente del operador.
-- -----------------------------------------------------------------------------
create or replace function app.reservar_despacho(p_circuito uuid)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  c record; m record; lv record;
  v_moneda char(3); v_plan uuid; v_pais char(2);
  v_firmantes int; v_precio numeric := 0; v_incluidas numeric := 0;
  v_estimado numeric; v_saldo numeric; v_res numeric; v_cons bigint; v_extra numeric;
  v_id uuid;
begin
  select ci.id, ci.cuenta_propietaria_id, ci.nivel_firma
    into c from public.circuito ci where ci.id = p_circuito;
  if not found then raise exception 'No existe el circuito %', p_circuito; end if;

  -- Una reserva por circuito: reintentar el despacho no reserva dos veces.
  select id into v_id from public.reserva_saldo where circuito_id = p_circuito;
  if v_id is not null then return v_id; end if;

  select cu.pais, coalesce(s.moneda, cu.moneda), s.plan_id
    into v_pais, v_moneda, v_plan
    from public.cuenta cu
    left join public.suscripcion s on s.cuenta_id = cu.id and s.estado = 'activa'
   where cu.id = c.cuenta_propietaria_id;

  select count(*) into v_firmantes
    from public.participacion p
   where p.circuito_id = p_circuito and p.papel = 'firmante'
     and p.estado not in ('firmada','no_requerida','delegada','rechazada');

  select f.precio_unitario, f.cantidad_incluida into v_precio, v_incluidas
    from app.precio_de_firma(v_plan, v_pais, v_moneda, coalesce(c.nivel_firma, 'simple'), null) f;
  v_precio := coalesce(v_precio, 0);
  v_estimado := round(v_firmantes * v_precio, 4);

  select * into m from app.modalidad_de_cuenta(c.cuenta_propietaria_id);
  select * into lv from app.levante_vigente(c.cuenta_propietaria_id);
  v_extra := case when lv.id is null then 0
                  when lv.monto_extra is null then 1e12
                  else lv.monto_extra end;

  if m.modalidad = 'prepago' then
    v_saldo := app.saldo_disponible(c.cuenta_propietaria_id, v_moneda);
    if v_estimado > 0 and v_saldo + v_extra < v_estimado then
      raise exception 'SIN_SALDO: faltan % % para enviar este documento (saldo %, estimado %)',
        to_char(v_estimado - v_saldo, 'FM999999990.00'), v_moneda,
        to_char(v_saldo, 'FM999999990.00'), to_char(v_estimado, 'FM999999990.00')
        using errcode = 'P0402';
    end if;
  else
    if m.tope_excedente is not null then
      select count(*) into v_cons from public.firma_facturable
       where cuenta_id = c.cuenta_propietaria_id and periodo = to_char(now(), 'YYYY-MM') and cobrada;
      select coalesce(sum((desglose->>'firmantes')::int), 0) into v_res
        from public.reserva_saldo where cuenta_id = c.cuenta_propietaria_id and estado = 'activa';
      if v_cons + v_res + v_firmantes > coalesce(m.incluido_mensual, 0) + m.tope_excedente
         and lv.id is null then
        raise exception 'TOPE_ALCANZADO: este mes ya se usaron % firmas de % (incluidas % + tope %)',
          v_cons + v_res, coalesce(m.incluido_mensual, 0) + m.tope_excedente,
          coalesce(m.incluido_mensual, 0), m.tope_excedente
          using errcode = 'P0402';
      end if;
    end if;
  end if;

  insert into public.reserva_saldo (cuenta_id, circuito_id, moneda, monto_estimado, desglose)
  values (c.cuenta_propietaria_id, p_circuito, v_moneda, v_estimado,
          jsonb_build_object('firmantes', v_firmantes, 'precio_unitario', v_precio,
                             'nivel', coalesce(c.nivel_firma, 'simple'), 'modalidad', m.modalidad,
                             'levante', lv.id))
  returning id into v_id;

  if m.modalidad = 'prepago' and v_estimado > 0 then
    insert into public.movimiento_saldo (cuenta_id, moneda, tipo, monto, reserva_id, circuito_id, creado_por)
    values (c.cuenta_propietaria_id, v_moneda, 'reserva', -v_estimado, v_id, p_circuito, 'despacho');
  end if;
  return v_id;
end $$;
revoke all on function app.reservar_despacho(uuid) from public;
grant execute on function app.reservar_despacho(uuid) to app_rw;

-- -----------------------------------------------------------------------------
-- 6. Consumir al firmar — gancho sobre la línea facturable (076)
--
-- Cada línea COBRADA de una cuenta prepago resta del saldo, contra la reserva
-- del circuito si la hay. ⚠ Atrapa sus errores: la línea facturable y la firma
-- no se pierden porque el wallet falle.
-- -----------------------------------------------------------------------------
create or replace function app.wallet_consumir()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare m record; v_reserva uuid;
begin
  if not new.cobrada or new.precio_unitario <= 0 then return new; end if;
  begin
    select * into m from app.modalidad_de_cuenta(new.cuenta_id);
    if m.modalidad <> 'prepago' then return new; end if;
    select r.id into v_reserva
      from public.reserva_saldo r
      join public.instancia i on i.circuito_id = r.circuito_id
     where i.id = new.instancia_id and r.estado = 'activa';
    insert into public.movimiento_saldo (cuenta_id, moneda, tipo, monto, reserva_id, firma_facturable_id, creado_por)
    values (new.cuenta_id, new.moneda, 'consumo', -new.precio_unitario, v_reserva, new.id, 'firma');
    -- Si había reserva, lo consumido ya no está reservado: se devuelve esa parte
    -- de la reserva en el mismo acto, así el saldo no baja dos veces.
    if v_reserva is not null then
      insert into public.movimiento_saldo (cuenta_id, moneda, tipo, monto, reserva_id, firma_facturable_id, creado_por)
      values (new.cuenta_id, new.moneda, 'liberacion', new.precio_unitario, v_reserva, new.id, 'firma');
    end if;
  exception when others then
    raise warning 'wallet_consumir: no se pudo registrar el consumo de la línea % (%): %', new.id, sqlstate, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists wallet_consumir on firma_facturable;
create trigger wallet_consumir
  after insert on firma_facturable
  for each row execute function app.wallet_consumir();

-- -----------------------------------------------------------------------------
-- 7. Liberar al cerrar el circuito
--
-- Completo, cancelado o vencido: la reserva se liquida y lo que quedó reservado
-- (rechazos, vencidos, quórum) vuelve al saldo. Es un trigger sobre el estado
-- del circuito: no depende de que algún código se acuerde de llamarlo.
-- -----------------------------------------------------------------------------
create or replace function app.wallet_liberar()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare r record; v_pendiente numeric;
begin
  if new.estado not in ('completo','cancelado','vencido') or old.estado = new.estado then return new; end if;
  begin
    select * into r from public.reserva_saldo where circuito_id = new.id and estado = 'activa';
    if r.id is null then return new; end if;
    -- Lo que sigue reservado = lo reservado menos lo ya liberado (consumo a consumo).
    select -coalesce(sum(monto), 0) into v_pendiente
      from public.movimiento_saldo where reserva_id = r.id and tipo in ('reserva','liberacion');
    if v_pendiente > 0 then
      insert into public.movimiento_saldo (cuenta_id, moneda, tipo, monto, reserva_id, circuito_id, creado_por)
      values (r.cuenta_id, r.moneda, 'liberacion', v_pendiente, r.id, new.id, 'cierre:' || new.estado);
    end if;
    update public.reserva_saldo set estado = 'liquidada', liquidada_en = now() where id = r.id;
  exception when others then
    raise warning 'wallet_liberar: no se pudo liberar la reserva del circuito % (%): %', new.id, sqlstate, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists wallet_liberar on circuito;
create trigger wallet_liberar
  after update of estado on circuito
  for each row execute function app.wallet_liberar();

-- -----------------------------------------------------------------------------
-- 8. Acreditar una recarga (el operador a mano, o la pasarela por sistema)
-- -----------------------------------------------------------------------------
create or replace function app.acreditar_recarga(p_recarga uuid)
returns void
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare r record;
begin
  if app.actor() not in ('operador','sistema') then
    raise exception 'Sólo el operador o el sistema acreditan recargas' using errcode = '42501';
  end if;
  select * into r from public.recarga where id = p_recarga for update;
  if not found then raise exception 'No existe la recarga %', p_recarga; end if;
  if r.estado = 'acreditada' then return; end if;   -- idempotente
  if r.estado <> 'pendiente' then
    raise exception 'La recarga está %: no se acredita', r.estado using errcode = '23514';
  end if;
  insert into public.movimiento_saldo (cuenta_id, moneda, tipo, monto, recarga_id, motivo, creado_por)
  values (r.cuenta_id, r.moneda, 'recarga', r.monto_acreditado, r.id, r.motivo, r.creada_por);
  update public.recarga set estado = 'acreditada', acreditada_en = now() where id = r.id;
end $$;
revoke all on function app.acreditar_recarga(uuid) from public;
grant execute on function app.acreditar_recarga(uuid) to app_operador, app_rw;

-- -----------------------------------------------------------------------------
-- Centinelas
-- -----------------------------------------------------------------------------
do $centinela$ begin
  -- Sin billing_config, toda cuenta es pospago sin tope: nada cambia para nadie
  -- hasta que el operador configure un plan.
  if (select modalidad from app.modalidad_de_cuenta('00000000-0000-0000-0000-000000000000')) is distinct from 'pospago' then
    raise exception 'Una cuenta sin configuración tiene que ser pospago por omisión';
  end if;
  if has_table_privilege('app_rw', 'movimiento_saldo', 'insert') then
    raise exception 'app_rw no escribe plata directo: reserva, consume y libera por las funciones';
  end if;
end $centinela$;

commit;
