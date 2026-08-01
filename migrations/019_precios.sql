-- =============================================================================
-- MiFirma — 019_precios.sql
-- Precios y configuración comercial de los planes.
--
-- Todo esto es parametría del operador: ni un monto, ni una métrica, ni un
-- margen viven en el código. La página pública y la consola muestran lo que
-- haya en estas tablas, y un plan sin precio cargado para un país simplemente
-- no se ofrece ahí — ese es el mecanismo para habilitar planes por país, y no
-- hace falta ninguna columna extra.
--
-- Implementa `claude billing-diseno.md` §1, con dos agregados que el diseño no
-- contemplaba y que aparecieron al escribir la página de precios:
--
--   1. La métrica `abono`. El diseño cubría el precio por unidad —firma,
--      documento, circuito— pero un SaaS se vende como "X por mes más Y por
--      firma". Sin un lugar para el abono, la página no puede mostrar un plan.
--      Va en `precio_metrica` como una métrica más y no como columna de `plan`,
--      porque el abono también cambia por país y por moneda.
--
--   2. `plan.descripcion_i18n` y `plan.publico`. La página necesita contar qué
--      incluye cada plan, y eso lo escribe el operador, no el código.
--
-- Lo que NO entra todavía: `tarifa_costo`, `evento_medible`, `movimiento_saldo`,
-- `reserva_saldo` y `tipo_cambio`. Los tres primeros referencian `circuito`,
-- `participacion` y `proveedor_firma`, que llegan con el dominio de firma.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Lo que el plan le cuenta al visitante
-- -----------------------------------------------------------------------------
alter table plan
  add column descripcion_i18n jsonb,
  -- Viñetas de "qué incluye", por idioma: {"es": ["...", "..."], "pt": [...]}.
  add column incluye_i18n     jsonb,
  -- Si aparece en la página pública. Un plan a medida existe en la base para
  -- facturarlo, pero no se anuncia.
  add column publico          boolean not null default false,
  -- El que se muestra resaltado. Único por diseño, no por restricción: si hay
  -- dos, la página toma el de menor `orden` y no se rompe nada.
  add column destacado        boolean not null default false;

-- -----------------------------------------------------------------------------
-- Precios de venta
--
-- La clave es (plan, país, moneda, métrica, nivel de firma) y todo versionado
-- por fecha. Versionado porque la factura de marzo tiene que costear con los
-- precios de marzo: si el histórico se pisa, no hay forma de reconstruir una
-- factura vieja y cualquier reclamo se vuelve indefendible.
-- -----------------------------------------------------------------------------
create table precio_metrica (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references plan(id) on delete cascade,
  pais            char(2) not null,
  moneda          char(3) not null,                    -- ISO 4217

  metrica         text not null check (metrica in ('abono','firma','documento','circuito','sms')),

  -- Sólo para métricas de firma. NULL = vale para cualquier nivel.
  nivel_firma     text check (nivel_firma in ('simple','avanzada')),

  precio_unitario numeric(14,4) not null check (precio_unitario >= 0),

  vigente_desde   date not null default current_date,
  vigente_hasta   date,

  creado_en       timestamptz not null default now(),
  creado_por      uuid,                                -- operador que lo cargó

  constraint precio_vigencia_coherente check (vigente_hasta is null or vigente_hasta >= vigente_desde),
  -- El abono no distingue nivel de firma: es el abono del plan.
  constraint precio_abono_sin_nivel check (metrica <> 'abono' or nivel_firma is null)
);

-- Un solo precio vigente por combinación. El índice usa coalesce porque en SQL
-- dos NULL no son iguales, y sin eso se podrían cargar cinco precios "para
-- cualquier nivel" sin que nada proteste.
create unique index precio_vigente_uq
  on precio_metrica (plan_id, pais, moneda, metrica, coalesce(nivel_firma, ''))
  where vigente_hasta is null;

create index precio_por_pais on precio_metrica (pais, plan_id);

-- -----------------------------------------------------------------------------
-- Configuración comercial: cómo se cobra, no cuánto
--
-- Cascada de `billing-diseno.md` §1: la fila más específica gana.
--   (plan, pais)        → el nivel base que define el operador
--   cuenta_id no nulo   → override para un cliente puntual
-- "Volver a heredar" es borrar la fila de override.
-- -----------------------------------------------------------------------------
create table billing_config (
  id                 uuid primary key default gen_random_uuid(),

  plan_id            uuid references plan(id) on delete cascade,
  pais               char(2),
  cuenta_id          uuid references cuenta(id) on delete cascade,

  modalidad          text not null check (modalidad in ('prepago','pospago')),
  -- Qué unidad se cuenta para el plan. Los tres se MIDEN siempre; este campo
  -- decide cuál se cobra. Cambiar de métrica es cambiar configuración, no
  -- migrar datos ni perder historia.
  metrica            text not null check (metrica in ('firma','documento','circuito')),

  modelo_comision    text not null check (modelo_comision in ('margen_pct','precio_fijo')),
  margen_pct         numeric(6,3),

  incluido_mensual   int,           -- unidades incluidas en el abono (pospago)
  -- Tope de excedente por mes. NULL = sin tope. Protege al cliente de sus
  -- propios errores —una planilla con 30.000 filas en vez de 3.000— sin
  -- impedirle el volumen a quien sí lo quiere.
  tope_excedente     int,
  umbral_aviso_saldo numeric(14,2), -- prepago: avisar antes de que se quede sin saldo

  vigente_desde      date not null default current_date,
  vigente_hasta      date,
  creado_en          timestamptz not null default now(),

  constraint comision_coherente check ((modelo_comision = 'margen_pct') = (margen_pct is not null)),
  -- O es configuración del operador (plan/país) o es override de una cuenta.
  -- Mezclar las dos cosas en una fila haría ambigua la cascada.
  constraint config_nivel_coherente check (
    (cuenta_id is null and plan_id is not null) or (cuenta_id is not null))
);

create unique index billing_config_base_uq
  on billing_config (plan_id, coalesce(pais, '--'))
  where cuenta_id is null and vigente_hasta is null;
create unique index billing_config_override_uq
  on billing_config (cuenta_id)
  where cuenta_id is not null and vigente_hasta is null;

-- =============================================================================
-- RLS
--
-- `precio_metrica` es lista de precios pública: la página comercial la lee sin
-- token. No hay nada que proteger en un precio que se publica; esconderlo sólo
-- impediría mostrarlo.
--
-- `billing_config` NO: contiene el margen que le cobramos a cada cliente y los
-- overrides que le dimos a uno y no a otro. Eso es del operador, y cada cuenta
-- ve como mucho la suya.
-- =============================================================================
alter table precio_metrica enable row level security;
create policy precio_select on precio_metrica for select using (true);
create policy precio_insert on precio_metrica for insert with check (app.actor() = 'operador');
create policy precio_update on precio_metrica for update using (app.actor() = 'operador');
create policy precio_delete on precio_metrica for delete using (app.actor() = 'operador');

alter table billing_config enable row level security;
create policy billing_config_select on billing_config for select using (
     app.actor() in ('operador','sistema')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual()
      and app.tiene_capacidad('facturacion','leer'))
);
create policy billing_config_insert on billing_config for insert with check (app.actor() = 'operador');
create policy billing_config_update on billing_config for update using (app.actor() = 'operador');
create policy billing_config_delete on billing_config for delete using (app.actor() = 'operador');

-- -----------------------------------------------------------------------------
-- Permisos que faltaban sobre los catálogos que administra el operador
--
-- `plan` e `industria` tenían SELECT para todos y ninguna escritura para nadie:
-- la consola del operador fallaba al guardar. No se había notado porque nadie
-- había creado todavía un plan ni una industria desde la aplicación.
--
-- Siguen sin RLS a propósito —son catálogos globales, no pertenecen a ninguna
-- cuenta— y el control es el GRANT: `app_rw` lee, `app_operador` escribe. El
-- test C3 verifica justamente que app_rw NO pueda escribirlos.
-- -----------------------------------------------------------------------------
grant insert, update, delete on plan, industria to app_operador;

grant select on precio_metrica to app_rw;
grant select, insert, update, delete on precio_metrica to app_operador;
grant select on billing_config to app_rw;
grant select, insert, update, delete on billing_config to app_operador;

commit;
