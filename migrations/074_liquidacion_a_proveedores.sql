-- =============================================================================
-- MiFirma — 074_liquidacion_a_proveedores.sql
-- Lo que le debemos a cada proveedor, por país y por mes.
--
-- La otra mitad de la 073: si un proveedor trabaja con revenue share, cada firma
-- deja anotado en `firma_facturable.a_liquidar` lo que le toca. Esta migración
-- junta esas líneas en un documento por (proveedor, país, período, moneda), que
-- es lo que se le manda y lo que se le paga.
--
-- ═══ POR QUÉ UNA TABLA Y NO UNA CONSULTA ═══
--
-- Sumar `firma_facturable` cada vez daría el número correcto y sería inútil: lo
-- que hace falta es un documento que se EMITE, se manda, se discute y se paga.
-- Un número que se recalcula no se puede pagar — cambiaría entre que se lo
-- mandamos y que lo cobra.
--
-- Por eso la liquidación, una vez emitida, no cambia: las líneas que la
-- componen quedan marcadas con su `liquidacion_id` y no vuelven a entrar en
-- otra. Lo que llegue después va al mes siguiente, que es como funciona
-- cualquier cuenta corriente.
--
-- ═══ ⚠ ESTO ES UNA CUENTA POR PAGAR, NO UNA FACTURA NUESTRA ═══
--
-- `factura_plataforma` (013) es lo que le cobramos al cliente. Esto es lo
-- contrario: lo que le debemos a un tercero. No se mezclan ni comparten tabla,
-- aunque se parezcan, porque un error de signo entre las dos es de los que no
-- se ven hasta que alguien reclama.
--
-- Y no tiene RLS por cuenta: no es de ningún cliente. La ve el operador y nadie
-- más.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create table if not exists liquidacion_proveedor (
  id             uuid primary key default gen_random_uuid(),

  proveedor_id   uuid   not null references proveedor_firma(id),
  pais           char(2) not null,
  periodo        char(7) not null,               -- 'YYYY-MM'
  moneda         char(3) not null,

  -- Lo que dice el documento, congelado al emitirlo.
  firmas         bigint        not null default 0 check (firmas >= 0),
  ingreso        numeric(14,4) not null default 0 check (ingreso >= 0),
  a_liquidar     numeric(14,4) not null default 0 check (a_liquidar >= 0),

  estado         text not null default 'borrador'
                   check (estado in ('borrador','emitida','pagada')),
  emitida_en     timestamptz,
  pagada_en      timestamptz,
  referencia_pago text,
  nota           text,

  creada_en      timestamptz not null default now(),
  creada_por     text,

  -- Un documento por proveedor, país, período y moneda. Dos monedas del mismo
  -- proveedor en el mismo mes son dos liquidaciones: no se suman peras con
  -- dólares para poder pagarlas juntas.
  unique (proveedor_id, pais, periodo, moneda),

  constraint liquidacion_fechas_coherentes check (
    (estado = 'borrador' and emitida_en is null and pagada_en is null)
    or (estado = 'emitida' and emitida_en is not null and pagada_en is null)
    or (estado = 'pagada' and emitida_en is not null and pagada_en is not null)
  )
);

comment on table liquidacion_proveedor is
  'Lo que le debemos a un proveedor por (país, período, moneda). Se arma de firma_facturable '
  'y, una vez emitida, no cambia. ⚠ Es una cuenta POR PAGAR: no confundir con factura_plataforma, '
  'que es lo que le cobramos al cliente. Migración 074.';

create index if not exists liquidacion_por_estado on liquidacion_proveedor (estado, periodo);

-- La clave foránea de la 073, que nació sin apuntar a nada porque la tabla no
-- existía todavía.
alter table firma_facturable drop constraint if exists firma_facturable_liquidacion_id_fkey;
alter table firma_facturable
  add constraint firma_facturable_liquidacion_id_fkey
  foreign key (liquidacion_id) references liquidacion_proveedor(id);

-- -----------------------------------------------------------------------------
-- Lo que hay para liquidar, todavía sin liquidar
--
-- Es lo que la pantalla muestra ANTES de emitir: cuánto se le debe a cada
-- proveedor este mes. Después de emitir, esas líneas quedan marcadas y dejan de
-- aparecer acá.
-- -----------------------------------------------------------------------------
create or replace function app.liquidacion_pendiente(p_periodo char(7))
returns table (
  proveedor_id uuid,
  codigo       text,
  nombre       text,
  pais         char(2),
  moneda       char(3),
  firmas       bigint,
  ingreso      numeric,
  a_liquidar   numeric
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select f.proveedor_id, pf.codigo, pf.nombre_mostrado, f.pais, f.moneda,
         count(*)::bigint, sum(f.precio_unitario), sum(f.a_liquidar)
    from public.firma_facturable f
    join public.proveedor_firma pf on pf.id = f.proveedor_id
   where f.periodo = p_periodo
     and f.liquidacion_id is null
     and f.a_liquidar is not null
   group by f.proveedor_id, pf.codigo, pf.nombre_mostrado, f.pais, f.moneda
   order by pf.nombre_mostrado, f.pais;
$$;
revoke all on function app.liquidacion_pendiente(char(7)) from public;
grant execute on function app.liquidacion_pendiente(char(7)) to app_operador;

-- -----------------------------------------------------------------------------
-- Emitirla: se congela el número y se marcan las líneas que la componen
--
-- ⚠ En una transacción, y en este orden: se crea el documento, se marcan las
-- líneas con su id, y recién entonces se copian los totales DE LAS LÍNEAS
-- MARCADAS. Si se copiaran antes, una firma que entra en el medio quedaría
-- contada en el documento y sin marcar — o marcada y sin contar. Las dos formas
-- son plata que no cierra.
-- -----------------------------------------------------------------------------
create or replace function app.liquidacion_emitir(
  p_proveedor uuid, p_pais char(2), p_periodo char(7), p_moneda char(3), p_por text
)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_id uuid;
begin
  if app.actor() <> 'operador' then
    raise exception 'Sólo el operador emite liquidaciones' using errcode = '42501';
  end if;

  insert into public.liquidacion_proveedor (proveedor_id, pais, periodo, moneda, estado, creada_por)
  values (p_proveedor, upper(p_pais), p_periodo, upper(p_moneda), 'borrador', p_por)
  on conflict (proveedor_id, pais, periodo, moneda) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.liquidacion_proveedor
     where proveedor_id = p_proveedor and pais = upper(p_pais)
       and periodo = p_periodo and moneda = upper(p_moneda);
    if (select estado from public.liquidacion_proveedor where id = v_id) <> 'borrador' then
      raise exception 'Esa liquidación ya está emitida: lo que llegue después va al período siguiente'
        using errcode = '23514';
    end if;
  end if;

  update public.firma_facturable
     set liquidacion_id = v_id
   where periodo = p_periodo and pais = upper(p_pais) and moneda = upper(p_moneda)
     and proveedor_id = p_proveedor and liquidacion_id is null and a_liquidar is not null;

  update public.liquidacion_proveedor l
     set firmas = t.n, ingreso = t.ing, a_liquidar = t.liq,
         estado = 'emitida', emitida_en = now()
    from (select count(*)::bigint as n, coalesce(sum(precio_unitario),0) as ing,
                 coalesce(sum(a_liquidar),0) as liq
            from public.firma_facturable where liquidacion_id = v_id) t
   where l.id = v_id;

  return v_id;
end $$;
revoke all on function app.liquidacion_emitir(uuid, char(2), char(7), char(3), text) from public;
grant execute on function app.liquidacion_emitir(uuid, char(2), char(7), char(3), text) to app_operador;

-- -----------------------------------------------------------------------------
-- Una liquidación emitida no cambia de números
--
-- Lo único que pasa después de emitirla es que se paga. Cambiarle el importe a
-- un documento que el proveedor ya tiene en la mano es exactamente lo que hace
-- que una cuenta corriente deje de servir.
-- -----------------------------------------------------------------------------
create or replace function app.liquidacion_inmutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Una liquidación emitida no se borra' using errcode = '23514';
    end if;
    return old;
  end if;
  if old.estado <> 'borrador' then
    if new.firmas is distinct from old.firmas
       or new.ingreso is distinct from old.ingreso
       or new.a_liquidar is distinct from old.a_liquidar
       or new.proveedor_id is distinct from old.proveedor_id
       or new.pais is distinct from old.pais
       or new.periodo is distinct from old.periodo
       or new.moneda is distinct from old.moneda then
      raise exception 'Una liquidación emitida no cambia de números: se corrige en el período siguiente'
        using errcode = '23514';
    end if;
    -- Y no vuelve para atrás.
    if old.estado = 'pagada' and new.estado <> 'pagada' then
      raise exception 'Una liquidación pagada no vuelve a emitida' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists liquidacion_inmutable on liquidacion_proveedor;
create trigger liquidacion_inmutable
  before update or delete on liquidacion_proveedor
  for each row execute function app.liquidacion_inmutable();

-- -----------------------------------------------------------------------------
-- RLS: del operador y de nadie más
-- -----------------------------------------------------------------------------
alter table liquidacion_proveedor enable row level security;
drop policy if exists liquidacion_select on liquidacion_proveedor;
drop policy if exists liquidacion_escritura on liquidacion_proveedor;
create policy liquidacion_select on liquidacion_proveedor for select
  using (app.actor() in ('operador','sistema'));
create policy liquidacion_escritura on liquidacion_proveedor for all
  using (app.actor() = 'operador') with check (app.actor() = 'operador');
grant select, insert, update, delete on liquidacion_proveedor to app_operador;
-- ⚠ `app_rw` necesita el update de `firma_facturable.liquidacion_id`, que ya
-- tiene de la 073, pero NO ve las liquidaciones: no son de ningún cliente.

do $centinela$
begin
  if exists (select 1 from information_schema.role_table_grants
              where table_name = 'liquidacion_proveedor' and grantee = 'app_rw') then
    raise exception 'app_rw no tiene nada que hacer con las liquidaciones: no son de ningún cliente';
  end if;
end $centinela$;

commit;
