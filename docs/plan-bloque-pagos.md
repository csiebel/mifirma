# Diseño — Bloque de pagos (pasarela unificada + facturación al cliente)

> Estado: **diseño, sin implementar.** Documento base para construir después por fases
> (con Claude Code). Cubre cómo el SaaS **cobra** a sus clientes: empresas (suscripción) y
> oferentes (comisiones/pauta). NO cubre el mifirma (empresa→empleado) ni el repago de
> préstamos del empleado (que va por descuento en recibo, sin pasarela).

## 1. Objetivo y principios

- Cobrar los **dos flujos que entran al SaaS**:
  - **A) Empresa → SaaS**: suscripción del servicio (monto predecible, recurrente).
  - **B) Oferente → SaaS**: comisiones de venta/préstamo + pauta publicitaria (monto
    **variable** por período, sale del *resumen de facturación a oferentes* que ya existe).
- **Tercer flujo que NO usa pasarela**: repago del préstamo del empleado → descuento en el
  recibo. Queda fuera de este bloque (regla de oro: separación estricta de flujos de dinero).
- **Multi-pasarela**: una **interfaz común** + **adaptadores** por proveedor. Catálogo
  administrable por el operador. Credenciales **cifradas** (`GATEWAY_ENC_KEY`).
- **Diseñar las 4, arrancar con PayPal** (piloto en sandbox). Los adaptadores locales se
  suman después sin tocar el núcleo.

## 2. Moneda de cobro (definido)

- **Configurable por factura**, resuelta por el país del cliente (empresa u oferente), con
  override manual del operador:
  - Cliente de **Uruguay** → **UYU**.
  - Cliente de **Paraguay** → **PYG**.
  - **Resto del mundo** (fuera de UY/PY) → **USD** (solo dólares).
- La moneda se **congela en la factura** al emitirla (no se recalcula después).

## 3. Arquitectura de la pasarela

**Interfaz común** (todas las pasarelas la implementan):
- `iniciarCobro(factura)` → devuelve un link/checkout o una intención de pago.
- `confirmarPorWebhook(evento)` → marca la factura pagada (idempotente).
- `consultarEstado(referencia)` → estado real en el proveedor.
- `reembolsar(referencia, monto?)`.
- Para recurrente (suscripción de empresa): `crearAcuerdo`, `cobrarAcuerdo`, `cancelarAcuerdo`.

**Adaptadores por proveedor** (desarrollo puntual cada uno):
- `PayPalAdapter` (primero, piloto), `MercadoPagoAdapter` (UY), `BancardAdapter` (PY).

**Catálogo `pasarela_pago`** (ya existe la base en el proyecto): proveedor, `activo`,
país/moneda aplicable, **preferida**, credenciales **cifradas**. La **selección** de pasarela
para una factura sale de: país/moneda de la factura → pasarelas activas que la soportan →
la preferida del operador.

## 4. Los dos flujos

### A. Empresa → SaaS (suscripción) — monto recurrente

- **El método de cobro se configura en el PLAN** (definido). Cada plan define cómo cobran sus
  suscriptores:
  - **`tarjeta`** → **débito automático recurrente** (PayPal billing agreement / tarjeta
    guardada); el sistema cobra solo cada período. **Universal** (cualquier país).
  - **`giro`** → **transferencia bancaria manual**: se emite la factura, el cliente transfiere,
    y el operador (o un webhook bancario, si existe) confirma el pago. **Solo UY/PY.**
- La suscripción de la empresa **toma el método de su plan**. Hoy `medio_cobro` vive en la
  suscripción; pasa a configurarse en el **plan** (`plan.medio_cobro`), y la suscripción lo
  hereda. Así un "plan local UY" puede ser por giro y un "plan internacional" por tarjeta.
- **Onboarding self-service con pago** (planes por tarjeta): al alta con pago, el **webhook**
  confirma el cobro → dispara `provisionarEmpresa`. En **planes por giro**, el alta queda
  pendiente hasta confirmar la primera transferencia.

### B. Oferente → SaaS (comisiones/pauta) — monto variable

- **Modelo de cobro:** **factura + el oferente paga** (transferencia, factura/link de PayPal,
  o tarjeta). **No** pull automático, porque el monto cambia cada período.
- **Cierre de período** (conecta con lo ya construido):
  1. Tomar el **resumen de facturación a oferentes** (eventos confirmados: ventas/préstamos +
     pauta publicitaria por impresiones) → total por oferente y por moneda.
  2. **Generar la factura** por oferente/moneda.
  3. Emitir **link de pago** (PayPal) o registrar la **transferencia**; el operador puede
     cargar el pago manual (transferencia) o confirmarlo por **webhook** (PayPal).
  4. Marcar la factura **pagada**; lo confirmado alimenta la contabilidad.

## 5. Ciclo de facturación (modelo de datos propuesto)

Tabla `factura_saas` (interna del operador, deny-by-default):
- `id`, `tipo` (`empresa_suscripcion` | `oferente_comision`), `sujeto_id`
  (cuenta_id **o** oferente_id según tipo), `periodo` (`YYYY-MM`), `moneda`, `monto`,
  `estado` (`borrador` | `emitida` | `pagada` | `vencida` | `anulada`), `pasarela_id`,
  `referencia_externa` (id de la transacción en la pasarela), `link_pago`,
  `emitida_at`, `pagada_at`, timestamps.
- **Líneas** (`factura_saas_linea`): desglose. Para oferentes, una línea por concepto
  (ventas / préstamos / pauta) con su cargo; para empresas, la línea del plan (+ IA si aplica).
- **Idempotencia de webhooks**: cada `referencia_externa` se procesa una sola vez (no
  doble-pagar ni doble-emitir).

## 6. Seguridad y cumplimiento

- Credenciales de pasarela **cifradas** con `GATEWAY_ENC_KEY`; nunca viajan al frontend.
- **Webhooks**: verificar la **firma** del proveedor + idempotencia; endpoint público
  dedicado, sin sesión, validado por firma.
- **No** guardar datos de tarjeta: tokenización del lado de la pasarela (PCI fuera de alcance).
- **Separación de flujos** (regla de oro): la factura del SaaS nunca se mezcla con el mifirma.
- **Facturación fiscal (definido)**: el **comprobante fiscal** (DGI/DNIT, vía Nodum en UY) se
  emite **al momento del cobro efectivo**:
  - **tarjeta** → al concretarse el cobro (cuando el webhook confirma el pago).
  - **giro** → al confirmarse la transferencia (carga del operador o webhook bancario).
  Es decir: **cobro primero, comprobante al confirmarse el cobro** (no al emitir la factura
  interna). La factura interna (`factura_saas`) puede existir en `emitida` antes; el
  comprobante fiscal se dispara recién con el pago confirmado.

## 7. Estrategia de implementación por fases

1. **Interfaz común + catálogo + `PayPalAdapter`** en **sandbox** (piloto). Sin cobrar de
   verdad todavía.
2. **Flujo oferente** (B): factura desde el *resumen* ya existente → link de pago PayPal +
   confirmación (webhook) y/o carga manual de transferencia. *(Es el que más aprovecha lo ya
   construido.)*
3. **Flujo empresa** (A): suscripción recurrente / onboarding self-service con pago (webhook
   → `provisionarEmpresa`).
4. **Adaptadores locales**: Mercado Pago/dLocal (UY), Bancard (PY).
5. **Webhooks robustos + reconciliación** (reintentos, estados, conciliación con el proveedor).

## 8. Decisiones

**Resueltas:**
- **Método de cobro a empresas**: se configura en el **plan** — `tarjeta` (débito automático
  recurrente, universal) o `giro` (transferencia manual, solo UY/PY). La suscripción hereda el
  método del plan (`plan.medio_cobro`).
- **Comprobante fiscal**: se emite **al cobro efectivo** (tarjeta: al confirmar el pago por
  webhook; giro: al confirmar la transferencia). Cobro primero, comprobante al confirmarse.
- **Moneda**: UYU (UY), PYG (PY), USD (resto) — ver §2.
- **Adaptadores**: PayPal (piloto, primero) · **Mercado Pago** (UY) · Bancard (PY).
- **Piloto**: las 4 pasarelas en el diseño; se construye primero **PayPal en sandbox**.

**Prerrequisito de negocio (no es decisión, es gate):**
- NO se cobra de verdad hasta cerrar **validaciones fiscales + pen test** (según la hoja de
  ruta). El piloto de PayPal va en **sandbox**, sin mover plata.
