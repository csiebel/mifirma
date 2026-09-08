-- =============================================================================
-- MiFirma — 073_precio_y_costo_por_proveedor.sql
-- Con qué relación económica trabajamos con cada proveedor, y cuánto vale
-- firmar con cada uno. Pedido de Claudio la noche del 7/9, después de la 072.
--
-- ═══ LOS CUATRO MODELOS, DICHOS COMO ÉL LOS DIJO ═══
--
--   · La FIRMA SIMPLE es nuestra: no hay proveedor ni costo. Se vende a precio
--     de venta puro — cifra fija con un máximo de firmas, y después precio por
--     firma. Eso ya lo hace `precio_metrica` (abono + firma con `cantidad_incluida`).
--   · Un proveedor que nos COBRA: su costo por firma, y encima nuestro margen.
--   · Un proveedor con REVENUE SHARE: no nos cobra — repartimos el ingreso, y
--     hay que LIQUIDARLE lo que le toca. ⚠ La liquidación no está acá (decisión
--     de Claudio: «el dato ahora, la liquidación después»); lo que sí queda es
--     el dato para poder calcularla, y el registro de qué se le debe a quién.
--   · La IA: costo por millón de tokens (`tarifa_ia`) más margen. Ya estaba.
--
-- Y una distinción que cambia una tabla: **el precio y el costo dependen del
-- PROVEEDOR**, no sólo del nivel de firma. Firmar con tuID no tiene por qué
-- costar lo mismo que firmar con SERPRO, ni venderse al mismo precio.
--
-- ═══ POR QUÉ EL MODELO VA EN `proveedor_pais` Y NO EN `proveedor_firma` ═══
--
-- La relación comercial es POR PAÍS, igual que el costo que ya vivía ahí desde
-- la 067. El mismo proveedor puede cobrarnos en un país y repartir en otro, y
-- un acuerdo se renegocia país por país. Ponerlo en `proveedor_firma` obligaría
-- a partir el proveedor en dos el día que eso pase.
--
-- ═══ ⚠⚠ LO QUE ESTA MIGRACIÓN NO HACE, Y HAY QUE SABERLO ═══
--
-- **Nadie está midiendo nada.** Los precios existen desde la 019 (7 de agosto),
-- las prestaciones desde la 071 y la custodia desde la 072, y NO HAY CÓDIGO QUE
-- CUENTE FIRMAS PARA FACTURAR. Todo esto es parametría que hoy nadie lee para
-- cobrar. Confirmado por Claudio el 7/9: «no, y hay que hacerlo».
--
-- Por eso esta migración agrega `firma_facturable`: la línea que el medidor va a
-- necesitar el día que exista, escrita en el momento de firmar, con el precio y
-- el costo VIGENTES ESE DÍA. No se calcula después mirando la tabla de precios:
-- un precio que cambió en marzo no puede cambiar lo que se cobró en febrero. Es
-- la misma razón por la que un precio no se pisa sino que se cierra y se abre
-- otro (019).
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. Con qué relación económica trabajamos con cada proveedor, en cada país
-- -----------------------------------------------------------------------------
alter table proveedor_pais
  add column if not exists modelo_economico text not null default 'costo',
  -- El porcentaje del ingreso que le toca AL PROVEEDOR. Sólo con revenue share.
  add column if not exists revenue_share_pct numeric(6,3);

alter table proveedor_pais drop constraint if exists proveedor_modelo_economico_valido;
alter table proveedor_pais add constraint proveedor_modelo_economico_valido
  check (modelo_economico in ('costo', 'revenue_share', 'sin_costo'));

-- Cada modelo necesita su número y no el del otro. Un revenue share sin
-- porcentaje no se puede liquidar, y un porcentaje colgado de un modelo que no
-- lo usa es un número que alguien va a leer mal algún día.
alter table proveedor_pais drop constraint if exists proveedor_economia_coherente;
alter table proveedor_pais add constraint proveedor_economia_coherente check (
  (modelo_economico = 'revenue_share'
     and revenue_share_pct is not null and revenue_share_pct >= 0 and revenue_share_pct <= 100
     and costo_por_firma is null)
  or (modelo_economico = 'costo' and revenue_share_pct is null)
  or (modelo_economico = 'sin_costo' and revenue_share_pct is null and costo_por_firma is null)
);

comment on column proveedor_pais.modelo_economico is
  '«costo» = nos cobra costo_por_firma y le sumamos margen. «revenue_share» = no nos cobra: '
  'le toca revenue_share_pct del ingreso y hay que liquidárselo. «sin_costo» = no cuesta '
  '(el dispositivo propio del firmante, o un acuerdo sin contraprestación). Migración 073.';
comment on column proveedor_pais.revenue_share_pct is
  'Porcentaje del INGRESO que le toca al proveedor. No es un margen nuestro: es una deuda con él.';

-- -----------------------------------------------------------------------------
-- 2. El precio, por proveedor
--
-- `proveedor_id` NULL = «vale para cualquier proveedor», que es lo que valen
-- todos los precios cargados hasta hoy y lo que seguirá valiendo para la firma
-- simple (que no tiene proveedor). Una fila con proveedor gana sobre la general.
-- -----------------------------------------------------------------------------
alter table precio_metrica
  add column if not exists proveedor_id uuid references proveedor_firma(id) on delete cascade;

comment on column precio_metrica.proveedor_id is
  'Precio para ese proveedor. NULL = para cualquiera (y es lo único que tiene sentido en '
  'la firma simple, que no tiene proveedor). El específico gana sobre el general. Migración 073.';

-- ⚠ El índice único de la 019 no conocía el proveedor: sin esto, dos precios
-- para el mismo nivel con proveedores distintos chocarían entre sí, y la lista
-- de precios de un país con dos proveedores sería imposible de cargar.
drop index if exists precio_vigente_uq;
create unique index precio_vigente_uq
  on precio_metrica (plan_id, pais, moneda, metrica,
                     coalesce(nivel_firma, ''), coalesce(proveedor_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where vigente_hasta is null;

-- El precio que corresponde a una firma concreta: el del proveedor si lo hay, y
-- si no el general. Devuelve también la cantidad incluida, porque son la misma
-- oferta (072) y quien cobra necesita los dos números juntos.
create or replace function app.precio_de_firma(
  p_plan uuid, p_pais char(2), p_moneda char(3), p_nivel text, p_proveedor uuid
)
returns table (
  precio_unitario   numeric(14,4),
  cantidad_incluida numeric(14,4),
  por_proveedor     boolean,
  precio_id         uuid
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select pm.precio_unitario, pm.cantidad_incluida, pm.proveedor_id is not null, pm.id
    from public.precio_metrica pm
   where pm.plan_id = p_plan
     and pm.pais = upper(p_pais)
     and pm.moneda = upper(p_moneda)
     and pm.metrica = 'firma'
     and (pm.nivel_firma is null or pm.nivel_firma = p_nivel)
     and (pm.proveedor_id = p_proveedor or pm.proveedor_id is null)
     and pm.vigente_hasta is null
   -- El más específico primero: proveedor, después nivel.
   order by (pm.proveedor_id is not null) desc, (pm.nivel_firma is not null) desc
   limit 1;
$$;
revoke all on function app.precio_de_firma(uuid, char(2), char(3), text, uuid) from public;
grant execute on function app.precio_de_firma(uuid, char(2), char(3), text, uuid) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- 3. La línea facturable de cada firma
--
-- ⚠⚠ Esta tabla es el puente hacia el medidor que todavía no existe. Se escribe
-- AL FIRMAR, con los números vigentes ese día, y no se toca nunca más: es la
-- misma disciplina que el expediente. Un precio que cambia en marzo no puede
-- cambiar lo que se cobró en febrero, y un revenue share renegociado no puede
-- cambiar lo que ya se le debe al proveedor.
--
-- Guarda las dos mitades del negocio en la misma fila —lo que se le cobra al
-- cliente y lo que se le debe al proveedor— porque separarlas obliga a
-- reconstruir la relación después, y ahí es donde los números dejan de cerrar.
-- -----------------------------------------------------------------------------
create table if not exists firma_facturable (
  id                 uuid primary key default gen_random_uuid(),

  -- Qué se firmó. `participacion_id` es la firma concreta; el resto es para
  -- poder agrupar sin recorrer el dominio entero.
  participacion_id   uuid not null references participacion(id),
  instancia_id       uuid not null references instancia(id),
  cuenta_id          uuid not null references cuenta(id),

  ocurrido_en        timestamptz not null default now(),
  periodo            char(7) not null,          -- 'YYYY-MM', el del cierre

  pais               char(2) not null,
  nivel_firma        text not null check (nivel_firma in ('simple','avanzada')),

  -- Con qué se firmó. NULL = el sello de la plataforma (firma simple).
  proveedor_id       uuid references proveedor_firma(id),

  -- ── Lo que se le cobra al cliente
  plan_id            uuid references plan(id),
  moneda             char(3) not null,
  precio_unitario    numeric(14,4) not null default 0 check (precio_unitario >= 0),
  -- Si esta firma cayó dentro de las incluidas, se registra igual con
  -- `cobrada = false`: se mide todo y se cobra lo que corresponde. Sin esto no
  -- se puede contestar «¿cuántas de mis 500 usé?».
  cobrada            boolean not null default true,

  -- ── Lo que nos cuesta, y a quién
  modelo_economico   text not null default 'sin_costo'
                       check (modelo_economico in ('costo','revenue_share','sin_costo')),
  costo_proveedor    numeric(14,4) check (costo_proveedor is null or costo_proveedor >= 0),
  moneda_costo       char(3),
  -- Lo que hay que liquidarle al proveedor por ESTA firma. Se calcula al
  -- escribir la fila, con el porcentaje vigente ese día.
  a_liquidar         numeric(14,4) check (a_liquidar is null or a_liquidar >= 0),
  liquidacion_id     uuid,                      -- se llena el día que exista la liquidación

  creado_en          timestamptz not null default now(),

  -- Una firma se factura una sola vez. La segunda escritura es un reintento, no
  -- una firma nueva.
  unique (participacion_id),

  constraint facturable_costo_coherente check (
    (modelo_economico = 'costo' and proveedor_id is not null)
    or (modelo_economico = 'revenue_share' and proveedor_id is not null and a_liquidar is not null)
    or (modelo_economico = 'sin_costo' and costo_proveedor is null and a_liquidar is null)
  ),
  -- La firma simple no tiene proveedor, y una avanzada sin proveedor sería una
  -- firma avanzada que nadie hizo.
  constraint facturable_nivel_coherente check (
    (nivel_firma = 'avanzada' and proveedor_id is not null)
    or (nivel_firma = 'simple' and proveedor_id is null)
  )
);

create index if not exists facturable_por_cuenta on firma_facturable (cuenta_id, periodo);
create index if not exists facturable_por_proveedor on firma_facturable (proveedor_id, periodo)
  where proveedor_id is not null;
-- Lo que falta liquidar, que es la consulta del día que exista la liquidación.
create index if not exists facturable_a_liquidar on firma_facturable (proveedor_id, periodo)
  where liquidacion_id is null and a_liquidar is not null;

comment on table firma_facturable is
  'Una línea por firma, con lo que se le cobra al cliente y lo que se le debe al proveedor, '
  'a los valores VIGENTES ESE DÍA. Inmutable, como el expediente. ⚠ Todavía no la escribe '
  'nadie: el medidor no existe (deuda). Migración 073.';

-- ⚠ Inmutable de verdad, no por costumbre: una línea facturable que se puede
-- editar no sirve para discutir una factura. Lo único que se deja cambiar es
-- `liquidacion_id`, que es el sello de «esto ya se le pagó al proveedor».
create or replace function app.firma_facturable_inmutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una línea facturable no se borra: es lo que sostiene una factura ya emitida'
      using errcode = '23514';
  end if;
  if row(new.*) is distinct from row(old.*) then
    if new.participacion_id is distinct from old.participacion_id
       or new.cuenta_id is distinct from old.cuenta_id
       or new.periodo is distinct from old.periodo
       or new.precio_unitario is distinct from old.precio_unitario
       or new.cobrada is distinct from old.cobrada
       or new.modelo_economico is distinct from old.modelo_economico
       or new.costo_proveedor is distinct from old.costo_proveedor
       or new.a_liquidar is distinct from old.a_liquidar
       or new.proveedor_id is distinct from old.proveedor_id then
      raise exception 'Una línea facturable no se corrige: se emite otra. Sólo se puede marcar la liquidación'
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists firma_facturable_inmutable on firma_facturable;
create trigger firma_facturable_inmutable
  before update or delete on firma_facturable
  for each row execute function app.firma_facturable_inmutable();

-- -----------------------------------------------------------------------------
-- RLS
--
-- Tenant duro, como todo el billing (013): la plata no cruza cuentas ni por
-- otorgamiento. El firmante externo no ve nada de esto.
--
-- ⚠ La escribe el SISTEMA (el medidor, cuando exista), no la cuenta: una cuenta
-- que pudiera escribir su propia línea facturable podría escribirse un precio.
-- -----------------------------------------------------------------------------
alter table firma_facturable enable row level security;
drop policy if exists facturable_select on firma_facturable;
drop policy if exists facturable_escritura on firma_facturable;
create policy facturable_select on firma_facturable for select using (
     app.actor() in ('sistema','operador')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('facturacion','leer'))
);
create policy facturable_escritura on firma_facturable for all
  using (app.actor() = 'sistema') with check (app.actor() = 'sistema');
grant select, insert, update on firma_facturable to app_rw;
grant select on firma_facturable to app_operador;

-- El modelo económico lo administra el operador, como el resto del catálogo: los
-- grants de `proveedor_pais` ya son suyos (067) y no hace falta tocarlos.

-- -----------------------------------------------------------------------------
-- Centinela
-- -----------------------------------------------------------------------------
do $centinela$
declare v_mal int;
begin
  -- Ningún proveedor puede quedar con un modelo que no cierra: el check lo
  -- impide para lo que venga, pero las filas viejas entraron antes del check.
  select count(*) into v_mal from proveedor_pais
   where modelo_economico = 'revenue_share' and revenue_share_pct is null;
  if v_mal > 0 then
    raise exception '% habilitación(es) con revenue share sin porcentaje', v_mal;
  end if;
  -- Y que la línea facturable no se pueda escribir desde una cuenta.
  if exists (select 1 from information_schema.role_table_grants
              where table_name = 'firma_facturable' and grantee = 'app_operador'
                and privilege_type in ('INSERT','UPDATE','DELETE')) then
    raise exception 'El operador no escribe líneas facturables: las escribe el medidor';
  end if;
end $centinela$;

commit;
