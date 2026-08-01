-- =============================================================================
-- MiFirma — 013_billing_chasis.sql
-- La parte del billing que se hereda del chasis: suscripción al plan, ciclo de
-- facturación mensual, integración con la facturación electrónica y el costeo
-- del asistente de IA.
--
-- Lo que MiFirma agrega encima —medidor, wallet, tarifas de costo externo,
-- precios por métrica y tipo de cambio— va DESPUÉS de las migraciones del
-- dominio de firma y de proveedores, porque referencia `circuito`,
-- `instancia`, `participacion` y `proveedor_firma`.
-- Ver `claude billing-diseno.md` §8.
--
-- ⚠ NO se trae `plan_tramo` de payroll. Allá el precio escalaba por cantidad de
--   funcionarios; acá la unidad es la firma, el documento o el circuito, y el
--   precio vive en `precio_metrica` (migración de billing propio). Copiarlo
--   sería arrastrar un modelo de precio que no es el nuestro.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Estado de cobranza de la cuenta.
--
-- Distinto de `cuenta.estado`, que es el ciclo de vida (activa/suspendida/
-- cerrada). Este es el semáforo del billing: al_dia → en_mora → suspendida.
--
-- Regla D3, que la tabla de billing-diseno §6 fija y acá se refleja: la mora
-- corta la capacidad de DESPACHAR, jamás la de leer o descargar lo firmado.
-- Por eso este campo no aparece en ninguna policy de lectura de `instancia`.
-- -----------------------------------------------------------------------------
alter table cuenta
  add column estado_cobranza text not null default 'al_dia'
    check (estado_cobranza in ('al_dia','en_mora','suspendida')),
  add column en_mora_desde   date,
  add column suspendida_cobranza_desde date;

-- -----------------------------------------------------------------------------
-- Suscripción: qué plan tiene la cuenta y desde cuándo.
-- -----------------------------------------------------------------------------
create table suscripcion (
  id                uuid primary key default gen_random_uuid(),
  cuenta_id         uuid not null references cuenta(id),
  plan_id           uuid not null references plan(id),

  estado            text not null default 'activa'
                      check (estado in ('activa','pausada','cancelada')),
  medio_cobro       text not null default 'tarjeta'
                      check (medio_cobro in ('tarjeta','transferencia','debito_bancario','manual')),
  moneda            char(3) not null,

  inicio            date not null default current_date,
  fin               date,

  -- Override por cuenta del asistente de IA. NULL = hereda del plan.
  asistente_ia      boolean,
  ia_cobra          boolean,
  ia_margen_pct     numeric(6,3),
  ia_incluido       numeric(14,4),

  creada_en         timestamptz not null default now(),
  actualizada_en    timestamptz not null default now()
);

-- Una sola suscripción vigente por cuenta.
create unique index suscripcion_vigente_unica on suscripcion (cuenta_id)
  where estado = 'activa';

-- Valores por defecto del asistente para el plan, que la suscripción sobreescribe.
alter table plan
  add column asistente_ia  boolean       not null default false,
  add column ia_cobra      boolean       not null default true,
  add column ia_margen_pct numeric(6,3)  not null default 0,
  add column ia_incluido   numeric(14,4) not null default 0;

-- -----------------------------------------------------------------------------
-- Factura de la plataforma: cabezal + líneas.
--
-- Cambia respecto de payroll, donde la factura era una sola fila con
-- `funcionarios_contados` y un monto. Acá el desglose por concepto va en el
-- cuerpo (billing-diseno §5, decisión 3 del 30/7): unidades por nivel de firma,
-- costos externos por proveedor, comisión propia y SMS por segmentos.
-- El detalle circuito por circuito es anexo descargable, no fila de factura.
--
-- Inmutable una vez emitida, como todo lo que sale del sistema con valor
-- probatorio.
-- -----------------------------------------------------------------------------
create table factura_plataforma (
  id                    uuid primary key default gen_random_uuid(),
  cuenta_id             uuid not null references cuenta(id),
  periodo               char(7) not null,             -- 'YYYY-MM'
  plan_id               uuid references plan(id),

  moneda                char(3) not null,
  monto_neto            numeric(14,2) not null default 0,
  monto_impuestos       numeric(14,2) not null default 0,
  monto_total           numeric(14,2) not null default 0,

  -- Tipo de cambio congelado al emitir (D5). La factura registra qué cotización
  -- usó, de qué fuente y de qué fecha: es parte del documento, no un cálculo
  -- que se reproduce después.
  tc_fuente             text,
  tc_fecha              date,
  tc_venta_usd          numeric(14,6),

  -- Comprobante fiscal: tipo resuelto por país del cliente + foto del receptor
  -- al momento de emitir. Si la empresa después cambia de razón social, la
  -- factura vieja sigue diciendo lo que decía.
  tipo_comprobante      text,
  receptor_pais         char(2),
  receptor_razon_social text,
  receptor_id_fiscal    text,

  estado                text not null default 'borrador'
                          check (estado in ('borrador','emitida','pagada','vencida','anulada')),
  vence_en              date,
  emitida_en            timestamptz,
  pagada_en             timestamptz,

  -- Comprobante electrónico devuelto por la integración de facturación.
  comprobante_externo_id text,
  comprobante_url        text,

  creada_en             timestamptz not null default now(),

  unique (cuenta_id, periodo)
);

create index factura_por_estado on factura_plataforma (estado, vence_en)
  where estado in ('emitida','vencida');

create table factura_linea (
  id                uuid primary key default gen_random_uuid(),
  factura_id        uuid not null references factura_plataforma(id) on delete cascade,
  orden             int not null,

  concepto          text not null check (concepto in
                      ('plan','firma','documento','circuito','sms','sello_tsa',
                       'firma_proveedor','comision','asistente_ia','ajuste')),
  detalle_i18n      jsonb not null,
  nivel_firma       text check (nivel_firma in ('simple','avanzada')),
  proveedor         text,                         -- nombre congelado, no FK

  cantidad          numeric(14,4) not null default 1,
  precio_unitario   numeric(14,4) not null default 0,
  monto             numeric(14,2) not null,

  unique (factura_id, orden)
);

-- Una factura emitida no se toca. El error se corrige anulando y emitiendo otra.
create or replace function factura_emitida_inmutable() returns trigger
language plpgsql as $$
begin
  if old.estado in ('emitida','pagada','anulada')
     and new.estado is not distinct from old.estado then
    raise exception 'la factura % ya fue emitida: no se modifica', old.id;
  end if;
  if old.estado = 'anulada' then
    raise exception 'la factura % está anulada', old.id;
  end if;
  return new;
end $$;

create trigger factura_inmutable before update on factura_plataforma
  for each row execute function factura_emitida_inmutable();

create or replace function factura_linea_inmutable() returns trigger
language plpgsql as $$
declare v_estado text;
begin
  select estado into v_estado from factura_plataforma
    where id = coalesce(new.factura_id, old.factura_id);
  if v_estado <> 'borrador' then
    raise exception 'la factura ya fue emitida: sus líneas no se modifican';
  end if;
  return coalesce(new, old);
end $$;

create trigger factura_linea_solo_borrador
  before insert or update or delete on factura_linea
  for each row execute function factura_linea_inmutable();

-- -----------------------------------------------------------------------------
-- Integración con la facturación electrónica.
--
-- Configuración del operador, uno por país: cada uno tiene su régimen (DGI en
-- UY, SET en PY, NF-e/NFS-e en BR) y su proveedor homologado.
-- -----------------------------------------------------------------------------
create table integracion_facturacion (
  id                     uuid primary key default gen_random_uuid(),
  pais                   char(2) not null,
  proveedor              text not null,
  modo                   text not null default 'sandbox' check (modo in ('sandbox','produccion')),

  api_url                text,
  api_credencial_cifrada text,
  archivo_formato        text,

  activa                 boolean not null default true,
  creada_en              timestamptz not null default now(),
  actualizada_en         timestamptz not null default now(),

  unique (pais, proveedor, modo)
);

-- -----------------------------------------------------------------------------
-- Costeo del asistente de IA.
--
-- Se conserva tal cual del chasis: tarifa por modelo versionada por fecha, y
-- consumo acumulado por cuenta y período. Nótese que `consumo_ia` guarda
-- tokens y costo, nunca el contenido de las conversaciones.
-- -----------------------------------------------------------------------------
create table tarifa_ia (
  id                    uuid primary key default gen_random_uuid(),
  modelo                text not null,
  moneda                char(3) not null default 'USD',
  precio_input_millon   numeric(14,6) not null,
  precio_output_millon  numeric(14,6) not null,
  vigente_desde         date not null default current_date,
  vigente_hasta         date,
  creada_en             timestamptz not null default now()
);

create index tarifa_ia_vigente on tarifa_ia (modelo, vigente_desde desc);

create table consumo_ia (
  id                uuid primary key default gen_random_uuid(),
  cuenta_id         uuid not null references cuenta(id),
  periodo           char(7) not null,
  modelo            text not null,
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  costo_base        numeric(14,6) not null default 0,
  moneda            char(3) not null default 'USD',
  actualizado_en    timestamptz not null default now(),

  unique (cuenta_id, periodo, modelo)
);

-- =============================================================================
-- RLS
--
-- Tenant duro en todo: la plata no cruza cuentas ni por otorgamiento
-- (billing-diseno §7). El firmante externo no ve nada de esto.
-- =============================================================================
alter table suscripcion enable row level security;
create policy suscripcion_select on suscripcion for select using (
     app.actor() in ('sistema','operador')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('facturacion','leer'))
);
-- La cuenta no se cambia el plan sola: pasa por el flujo de contratación, que
-- corre como 'sistema'. Evita que un bug de endpoint regale un plan.
create policy suscripcion_escritura on suscripcion for all using (
  app.actor() = 'sistema') with check (app.actor() = 'sistema');

alter table factura_plataforma enable row level security;
create policy factura_select on factura_plataforma for select using (
     app.actor() in ('sistema','operador')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('facturacion','leer'))
);
create policy factura_escritura on factura_plataforma for all using (
  app.actor() = 'sistema') with check (app.actor() = 'sistema');

alter table factura_linea enable row level security;
create policy factura_linea_select on factura_linea for select using (
     app.actor() in ('sistema','operador')
  or exists (select 1 from factura_plataforma f
              where f.id = factura_linea.factura_id
                and f.cuenta_id = app.cuenta_actual()
                and app.tiene_capacidad('facturacion','leer'))
);
create policy factura_linea_escritura on factura_linea for all using (
  app.actor() = 'sistema') with check (app.actor() = 'sistema');

alter table consumo_ia enable row level security;
create policy consumo_ia_select on consumo_ia for select using (
     app.actor() in ('sistema','operador')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('facturacion','leer'))
);
create policy consumo_ia_escritura on consumo_ia for all using (
  app.actor() = 'sistema') with check (app.actor() = 'sistema');

-- Catálogos del operador: sin RLS, protegidos por GRANT.
revoke all on integracion_facturacion, tarifa_ia from public;
grant select, insert, update, delete on integracion_facturacion, tarifa_ia to app_operador;
grant select on integracion_facturacion, tarifa_ia to app_rw;

grant select, insert, update on suscripcion, factura_plataforma, factura_linea, consumo_ia to app_rw;

-- El operador ve el billing de todas las cuentas: es su consola de cobranza.
-- Ve montos y unidades, jamás contenido de documentos.
grant select on suscripcion, factura_plataforma, factura_linea, consumo_ia to app_operador;

commit;
