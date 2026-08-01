import type {
  ColumnType,
  Generated,
  Insertable,
  Selectable,
  Updateable,
} from 'kysely';

// timestamptz gestionado por la DB (default now()) y el trigger touch_updated_at:
// opcional al insertar/actualizar, presente al seleccionar.
type Managed = Generated<Date>;

// `date` de Postgres: el parser de pg (ver pool.ts) lo devuelve como 'YYYY-MM-DD'.
type IsoDate = string;

// Columna anulable y opcional al insertar/actualizar.
type NullableOpt<T> = ColumnType<T | null, T | null | undefined, T | null | undefined>;

// Eje 1 — modalidad de remuneración (genérica, §9).
export type ModalidadRemuneracion =
  | 'mensual'
  | 'jornalero'
  | 'por_hora'
  | 'a_destajo'
  | 'mixto';

export interface EmpresaTable {
  id: Generated<string>;
  nombre: string;
  pais: string; // 'UY' | 'PY'
  moneda: string; // 'UYU' | 'PYG'
  razon_social: NullableOpt<string>;
  id_fiscal: NullableOpt<string>; // RUT (UY) / RUC (PY)
  num_seguridad_social: NullableOpt<string>; // aportante BPS (UY) / IPS (PY)
  domicilio: NullableOpt<string>;
  logo: NullableOpt<Buffer>; // PNG/JPG embebido para el recibo en PDF
  logo_mime: NullableOpt<string>; // 'image/png' | 'image/jpeg'
  ofertas_habilitado: Generated<boolean>; // §ofertas: el operador lo enciende por empresa
  firma_modalidad: Generated<string>; // §firma: 'ninguna' | 'simple' | 'avanzada'
  firma_proveedor_id: NullableOpt<string>; // §firma: proveedor elegido si modalidad avanzada
  industria_id: NullableOpt<string>; // §industria: rubro de la empresa (catálogo de plataforma)
  volcado_variable: Generated<string>; // §variable: 'rrhh' | 'nomina' — quién vuelca a la liquidación
  modo_franja: Generated<string>; // §franja: 'ninguno' | 'cargo' | 'nivel' — política de franjas salariales
  created_at: Managed;
  updated_at: Managed;
}

export interface EstablecimientoTable {
  id: Generated<string>;
  cuenta_id: string;
  nombre: string;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface PersonaTable {
  id: Generated<string>;
  cuenta_id: string;
  documento: string;
  nombre: string;
  fecha_nac: NullableOpt<IsoDate>;
  email: NullableOpt<string>; // contacto del empleado (para enviarle el recibo)
  celular: NullableOpt<string>; // contacto del empleado; siembra el telefono del login (OTP)
  foto: NullableOpt<Buffer>; // avatar opcional (PNG/JPG/WebP embebido), lo carga RRHH/Admin
  foto_mime: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface UnidadOrgTable {
  id: Generated<string>;
  cuenta_id: string;
  parent_id: NullableOpt<string>;
  responsable_relacion_id: NullableOpt<string>;
  nombre: string;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface CargoTable {
  id: Generated<string>;
  cuenta_id: string;
  unidad_org_id: string;
  nivel_id: NullableOpt<string>; // §franja: nivel/grado asignado (modo 'nivel'); hereda la franja del nivel
  nombre: string;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

// §franja: nivel/grado salarial (etapa 2). Catálogo opcional; la franja del nivel se
// guarda en franja_salarial con ambito='nivel'. Los cargos apuntan acá vía cargo.nivel_id.
export interface NivelSalarialTable {
  id: Generated<string>;
  cuenta_id: string;
  nombre: string;
  orden: Generated<number>;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

// §franja: banda salarial (mín/medio/máx) versionada por fecha. Polimórfica: cuelga de
// un cargo o de un nivel/grado, según empresa.modo_franja. No calcula; solo avisa.
export interface FranjaSalarialTable {
  id: Generated<string>;
  cuenta_id: string;
  ambito: string; // 'cargo' | 'nivel'
  ref_id: string; // cargo.id o nivel_salarial.id
  moneda: NullableOpt<string>;
  minimo: string;
  medio: NullableOpt<string>;
  maximo: string;
  vigente_desde: string;
  vigente_hasta: NullableOpt<string>;
  activo: Generated<boolean>;
  created_at: Managed;
}

export interface RelacionLaboralTable {
  id: Generated<string>;
  cuenta_id: string;
  persona_id: string;
  establecimiento_id: string;
  regimen_id: NullableOpt<string>; // Eje 2; NULL hasta seedear el paquete de país
  lleva_recibo: Generated<boolean>; // dependiente: siempre; unipersonal: opcional (su cobro va por factura)
  tiene_aguinaldo: Generated<boolean>; // dependiente: siempre; unipersonal: opcional
  tiene_vacacional: Generated<boolean>; // dependiente: siempre; unipersonal: opcional
  fecha_ingreso: IsoDate;
  fecha_egreso: NullableOpt<IsoDate>;
  saldo_licencia_inicial: Generated<string>; // días de licencia pendientes que la persona traía al alta (numeric)
  created_at: Managed;
  updated_at: Managed;
}

export interface RelacionLaboralVersionTable {
  id: Generated<string>;
  cuenta_id: string;
  relacion_id: string;
  cargo_id: string;
  modalidad: ModalidadRemuneracion;
  // numeric(18,4): pg lo devuelve como string para NO perder precisión.
  // Nunca usar `number` para dinero; el motor opera con decimales exactos.
  tarifa: string;
  vigente_desde: IsoDate;
  vigente_hasta: NullableOpt<IsoDate>; // inclusiva; NULL = versión vigente
  created_at: Managed;
  updated_at: Managed;
}

export interface UsuarioTable {
  id: Generated<string>;
  cuenta_id: string;
  persona_id: NullableOpt<string>;
  email: string;
  password_hash: NullableOpt<string>;
  password_actualizado: NullableOpt<Date>;
  telefono: NullableOpt<string>;
  canal_otp: Generated<string>;
  activo: Generated<boolean>;
  usuario_estudio_id: NullableOpt<string>; // si está, es un usuario "sombra" de ese contador
  created_at: Managed;
  updated_at: Managed;
}

// Código de acceso de un solo uso (login de dos pasos por equipo). Migración 022.
export interface OtpLoginTable {
  id: Generated<string>;
  cuenta_id: string;
  usuario_id: string;
  device_id: string;
  codigo_hash: string;
  expira_at: Date;
  intentos: Generated<number>;
  usado: Generated<boolean>;
  canal: Generated<string>;
  created_at: Managed;
}

// Equipo de confianza de un usuario (no pide OTP hasta que venza). Migración 022.
export interface DispositivoConfiableTable {
  id: Generated<string>;
  cuenta_id: string;
  usuario_id: string;
  device_id: string;
  etiqueta: NullableOpt<string>;
  confiado_at: Managed;
  ultimo_uso: Managed;
  expira_at: Date;
}

// Token de acceso por mail: recupero de contraseña / invitación. Migración 024.
export interface TokenAccesoTable {
  id: Generated<string>;
  cuenta_id: string;
  usuario_id: string;
  tipo: string; // 'reset' | 'invitacion'
  token_hash: string;
  expira_at: Date;
  usado: Generated<boolean>;
  created_at: Managed;
}

export interface RolTable {
  id: Generated<string>;
  cuenta_id: string;
  nombre: string;
  protegido: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface InvitacionPlantillaTable {
  cuenta_id: string;
  rol_id: string;
  asunto: string;
  cuerpo: string;
  updated_at: Managed;
}

// Config de país (compartida entre tenants, sin RLS).
export interface RegimenTable {
  id: Generated<string>;
  pais: string;
  codigo: string;
  nombre: string;
  created_at: Managed;
}

// ---- Módulo de liquidación + config de paquete de país (migración 002) ----

export type NaturalezaConcepto = 'devengo' | 'deduccion' | 'aporte_patronal' | 'informativo';
export type EstadoCorrida = 'borrador' | 'calculada' | 'emitida' | 'anulada';

export interface ConceptoTable {
  id: Generated<string>;
  pais: string;
  codigo: string;
  descripcion: string;
  tipo: NaturalezaConcepto;
  afecta_base: boolean;
  vigente_desde: IsoDate;
  vigente_hasta: NullableOpt<IsoDate>;
  created_at: Managed;
}

export interface PaisParametroTable {
  id: Generated<string>;
  pais: string;
  clave: string;
  valor: string; // numeric(18,6) -> string para no perder precisión
  vigente_desde: IsoDate;
  vigente_hasta: NullableOpt<IsoDate>;
  created_at: Managed;
}

export interface PaisTramoTable {
  id: Generated<string>;
  pais: string;
  grupo: string;
  orden: number;
  desde: string; // numeric -> string
  hasta: NullableOpt<string>;
  tasa: string;
  vigente_desde: IsoDate;
  vigente_hasta: NullableOpt<IsoDate>;
  created_at: Managed;
}

export interface DefinicionSalidaTable {
  id: Generated<string>;
  pais: string;
  organismo: string;
  formato: string;
  created_at: Managed;
}

export interface NovedadTable {
  id: Generated<string>;
  cuenta_id: string;
  relacion_id: string;
  periodo: string; // 'YYYY-MM'
  tipo: string;
  cantidad: string; // numeric -> string
  created_at: Managed;
}

export interface AusenciaLicenciaTable {
  id: Generated<string>;
  cuenta_id: string;
  relacion_id: string;
  tipo: string;
  desde: IsoDate;
  hasta: IsoDate;
  sin_goce: Generated<boolean>;
  created_at: Managed;
}

export interface ConceptoAusenciaTable {
  id: Generated<string>;
  cuenta_id: string;
  codigo: string;
  etiqueta: string;
  descuenta: Generated<boolean>;
  activo: Generated<boolean>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface ConceptoManualTable {
  id: Generated<string>;
  cuenta_id: string;
  codigo: string;
  nombre: string;
  naturaleza: string; // 'devengo' | 'deduccion'
  afecta_base: Generated<boolean>;
  activo: Generated<boolean>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

// Regla de mapeo contable por empresa: a qué cuenta y lado va cada parte del recibo.
// El asiento se genera agrupando recibos ya emitidos; estas reglas sólo dicen dónde.
export interface AsientoReglaTable {
  id: Generated<string>;
  cuenta_id: string;
  fuente: string; // 'concepto' | 'naturaleza' | 'neto'
  ref: NullableOpt<string>; // codigo de concepto o naturaleza; NULL si fuente='neto'
  cuenta_codigo: Generated<string>;
  cuenta_nombre: string;
  lado: string; // 'debe' | 'haber'
  orden: Generated<number>;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface LiquidacionConceptoTable {
  id: Generated<string>;
  cuenta_id: string;
  relacion_id: string;
  concepto_id: string;
  periodo: string;
  monto: string; // numeric -> string; siempre positivo
  nota: NullableOpt<string>;
  created_at: Managed;
}

// ── Remuneración variable (RRHH) — FASE 1: catálogo ──
// Esquema de incentivo por empresa. El resultado por período (FASE 2) se vuelca como
// un liquidacion_concepto; el motor sólo lo inyecta. Nombres con sufijo _variable: `plan`
// y `plan_tramo` ya están tomados por el dominio de billing (suscripción).
export interface PlanVariableTable {
  id: Generated<string>;
  cuenta_id: string;
  codigo: string;
  nombre: string;
  descripcion: NullableOpt<string>;
  activo: Generated<boolean>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

// Curva cumplimiento→pago (editable como dato). numeric -> string.
export interface PlanVariableTramoTable {
  id: Generated<string>;
  cuenta_id: string;
  plan_id: string;
  desde_pct: string; // porcentaje de cumplimiento (umbral inferior del tramo)
  hasta_pct: NullableOpt<string>; // NULL = sin tope superior
  factor_pago: string; // fracción del variable que se paga en el tramo (1 = 100%)
  orden: Generated<number>;
  created_at: Managed;
}

// Objetivo medible del plan. concepto_id = qué concepto de liquidación (devengo) genera.
export interface ObjetivoTable {
  id: Generated<string>;
  cuenta_id: string;
  plan_id: string;
  nombre: string;
  tipo: string; // 'cuantitativo' | 'cualitativo'
  metodo: string; // 'meta_curva' | 'tasa_directa'
  periodicidad: string; // 'mensual' | 'trimestral' | 'semestral' | 'anual'
  peso: Generated<string>; // ponderación dentro del plan (porcentaje)
  meta_valor: NullableOpt<string>; // meta numérica (cuantitativo por meta_curva)
  tasa: NullableOpt<string>; // porcentaje de comisión (tasa_directa)
  concepto_id: string;
  activo: Generated<boolean>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

// Ítems que componen un objetivo cualitativo.
export interface LogroTable {
  id: Generated<string>;
  cuenta_id: string;
  objetivo_id: string;
  descripcion: string;
  peso: Generated<string>;
  orden: Generated<number>;
  created_at: Managed;
}

// FASE 2a: asignación de un plan a un empleado (relacion_laboral), con el monto al
// 100% del variable y la vigencia. numeric -> string.
export interface AsignacionPlanTable {
  id: Generated<string>;
  cuenta_id: string;
  plan_id: string;
  relacion_id: string;
  variable_al_100: Generated<string>; // monto si cumple el 100% (0 en planes solo-comisión)
  vigente_desde: IsoDate;
  vigente_hasta: NullableOpt<IsoDate>;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

// FASE 2b: medición de un objetivo de una asignación en un mes. numeric -> string.
export interface ObjetivoPeriodoTable {
  id: Generated<string>;
  cuenta_id: string;
  asignacion_id: string;
  objetivo_id: string;
  periodo: string; // AAAA-MM
  meta: NullableOpt<string>;
  valor_real: NullableOpt<string>;
  cumplimiento_pct: NullableOpt<string>;
  monto: NullableOpt<string>;
  estado: Generated<string>; // 'abierto' | 'cerrado' | 'liquidado'
  liquidacion_concepto_id: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

// FASE 2b: qué logros se cumplieron en el período (objetivos cualitativos).
export interface LogroPeriodoTable {
  id: Generated<string>;
  cuenta_id: string;
  objetivo_periodo_id: string;
  logro_id: string;
  cumplido: Generated<boolean>;
  created_at: Managed;
}

// ───── Módulo Estudios Contables (paso 1: fundación) ─────
// estudio: organización paraguas. usuario_estudio: contadores (realm separado).
export interface EstudioTable {
  id: Generated<string>;
  nombre: string;
  pais: string;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface UsuarioEstudioTable {
  id: Generated<string>;
  estudio_id: string;
  email: string;
  password_hash: NullableOpt<string>;
  nombre: string;
  es_admin: Generated<boolean>;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

// Gobernanza: la empresa autoriza al estudio. Relación con estado, auditable.
export interface VinculoEstudioEmpresaTable {
  id: Generated<string>;
  estudio_id: string;
  cuenta_id: string;
  estado: Generated<string>; // solicitado | autorizado | rechazado | revocado
  origen: Generated<string>; // solicitud | alta_estudio
  solicitado_por: NullableOpt<string>;
  autorizado_por: NullableOpt<string>;
  solicitado_en: Managed;
  autorizado_en: NullableOpt<Date>;
  revocado_en: NullableOpt<Date>;
  created_at: Managed;
  updated_at: Managed;
}

// Operación: qué contador opera qué empresa, con qué rol (reparto interno del estudio).
export interface AccesoEmpresaTable {
  id: Generated<string>;
  estudio_id: string;
  usuario_estudio_id: string;
  cuenta_id: string;
  rol_id: string;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

// Billing de estudios: la unidad es la empresa-cliente gestionada. numeric -> string.
export interface PlanEstudioTable {
  id: Generated<string>;
  codigo: string;
  nombre: string;
  moneda: Generated<string>;
  precio_por_empresa: Generated<string>;
  empresas_gratis: Generated<number>;
  limite_empresas: NullableOpt<number>;
  periodo: Generated<string>;
  vigente_desde: Generated<IsoDate>;
  vigente_hasta: NullableOpt<IsoDate>;
  activo: Generated<boolean>;
  created_at: Managed;
}

export interface PlanEstudioTramoTable {
  id: Generated<string>;
  plan_codigo: string;
  desde: number;
  hasta: NullableOpt<number>;
  precio_por_empresa: Generated<string>;
}

export interface SuscripcionEstudioTable {
  id: Generated<string>;
  estudio_id: string;
  plan_codigo: string;
  estado: Generated<string>; // prueba | activa | suspendida | cancelada
  inicio: Generated<IsoDate>;
  fin: NullableOpt<IsoDate>;
  created_at: Managed;
  updated_at: Managed;
}

// Antesala del alta self-service de estudio: datos + OTP, hasta verificar el email.
export interface ResetEstudioTable {
  id: Generated<string>;
  usuario_estudio_id: string;
  token_hash: string;
  expira_at: Date;
  usado: Generated<boolean>;
  created_at: Managed;
}

export interface RegistroEstudioTable {
  id: Generated<string>;
  email: string;
  nombre_estudio: string;
  pais: string;
  nombre_admin: string;
  password_hash: string;
  codigo_hash: string;
  expira_at: string;
  intentos: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface CorridaLiquidacionTable {
  id: Generated<string>;
  cuenta_id: string;
  periodo: string;
  estado: Generated<EstadoCorrida>;
  tipo: Generated<string>;
  plantilla_snapshot: NullableOpt<string>;
  asiento_snapshot: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface RetencionTable {
  id: Generated<string>;
  cuenta_id: string;
  relacion_id: string;
  tipo: string; // 'judicial' | 'prestamo' | 'adelanto' | 'otra'
  descripcion: string;
  modo: string; // 'monto' | 'porcentaje'
  valor: string; // numeric -> string
  total: NullableOpt<string>;
  saldo: NullableOpt<string>;
  prioridad: Generated<number>;
  vigente_desde: IsoDate;
  vigente_hasta: NullableOpt<IsoDate>;
  activa: Generated<boolean>;
  prestamo_id: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface RetencionAplicadaTable {
  id: Generated<string>;
  cuenta_id: string;
  corrida_id: string;
  retencion_id: string;
  monto: string;
  created_at: Managed;
}

export interface ApiTokenTable {
  id: Generated<string>;
  cuenta_id: string;
  nombre: string;
  token_sha256: string;
  prefijo: string;
  activa: Generated<boolean>;
  created_at: Managed;
  last_used_at: NullableOpt<string>;
}

export interface PlanTable {
  id: Generated<string>;
  codigo: string;
  nombre: string;
  moneda: Generated<string>;
  modo_precio: Generated<string>;
  precio_fijo: Generated<string>;
  precio_por_funcionario: Generated<string>;
  funcionarios_gratis: Generated<number>;
  limite_funcionarios: NullableOpt<number>;
  periodo: Generated<string>;
  vigente_desde: Generated<IsoDate>;
  vigente_hasta: NullableOpt<IsoDate>;
  activo: Generated<boolean>;
  // §billing IA: valores por defecto del asistente para el plan
  asistente_ia: Generated<boolean>;
  ia_cobra: Generated<boolean>;
  ia_margen_pct: Generated<string>;
  ia_incluido: Generated<string>;
  created_at: Managed;
}

export interface SuscripcionTable {
  id: Generated<string>;
  cuenta_id: string;
  plan_codigo: string;
  estado: Generated<string>;
  medio_cobro: Generated<string>; // §billing: 'tarjeta' (universal) | 'giro' (sólo clientes UY)
  inicio: Generated<IsoDate>;
  fin: NullableOpt<IsoDate>;
  // §billing IA: override por empresa (NULL = hereda del plan)
  asistente_ia: NullableOpt<boolean>;
  ia_cobra: NullableOpt<boolean>;
  ia_margen_pct: NullableOpt<string>;
  ia_incluido: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface FacturaPlataformaTable {
  id: Generated<string>;
  cuenta_id: string;
  periodo: string;
  plan_codigo: string;
  moneda: string;
  funcionarios_contados: number;
  funcionarios_facturables: number;
  precio_unitario: string;
  monto: string;
  estado: Generated<string>;
  // §billing multi-país: tipo de comprobante resuelto por país del cliente
  // ('efactura' UY | 'efactura_exportacion' exterior) + snapshot de datos del receptor.
  tipo_comprobante: NullableOpt<string>;
  receptor_pais: NullableOpt<string>;
  receptor_razon_social: NullableOpt<string>;
  receptor_id_fiscal: NullableOpt<string>;
  // §billing IA: desglose plan + asistente
  monto_base: NullableOpt<string>;
  monto_ia: Generated<string>;
  emitida_at: Managed;
  created_at: Managed;
}

export interface TarifaIaTable {
  id: Generated<string>;
  modelo: string;
  moneda: Generated<string>;
  precio_input_millon: string;
  precio_output_millon: string;
  vigente_desde: Generated<IsoDate>;
  vigente_hasta: NullableOpt<IsoDate>;
  created_at: Managed;
}

export interface ConsumoIaTable {
  id: Generated<string>;
  cuenta_id: string;
  periodo: string;
  modelo: string;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  costo_base: Generated<string>;
  moneda: Generated<string>;
  created_at: Managed;
}

export interface OperadorTable {
  id: Generated<string>;
  usuario: string;
  nombre: string;
  password_hash: string;
  es_superadmin: Generated<boolean>;
  activo: Generated<boolean>;
  intentos_fallidos: Generated<number>;
  bloqueado_hasta: NullableOpt<Date>;
  created_at: Managed;
  updated_at: Managed;
}

export interface OperadorCapacidadTable {
  operador_id: string;
  capacidad: string;
}

export interface PlanTramoTable {
  id: Generated<string>;
  plan_codigo: string;
  desde: number;
  hasta: NullableOpt<number>;
  precio_por_funcionario: Generated<string>;
}

export interface PasarelaPagoTable {
  id: Generated<string>;
  proveedor: string;
  nombre: string;
  modo: Generated<string>;
  moneda: Generated<string>;
  client_id: NullableOpt<string>;
  client_secret_cifrado: NullableOpt<string>;
  webhook_secret_cifrado: NullableOpt<string>;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

// §billing: config del conector de facturación de la plataforma (Nodum). El operador
// elige el modo de entrega ('api' | 'archivo'). Config única de plataforma (rol owner).
export interface IntegracionFacturacionTable {
  id: Generated<string>;
  proveedor: Generated<string>;
  modo: Generated<string>;
  api_url: NullableOpt<string>;
  api_credencial_cifrada: NullableOpt<string>;
  archivo_formato: NullableOpt<string>;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface CorreoConfigTable {
  id: Generated<string>;
  proveedor: Generated<string>;
  host: string;
  puerto: Generated<number>;
  seguridad: Generated<string>;
  usuario: string;
  remitente_nombre: string;
  remitente_email: string;
  password_cifrado: NullableOpt<string>;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface ReciboTable {
  id: Generated<string>;
  cuenta_id: string;
  corrida_id: string;
  relacion_id: string;
  neto: string; // numeric -> string
  moneda: string;
  inmutable: Generated<boolean>;
  created_at: Managed;
}

export interface LineaReciboTable {
  id: Generated<string>;
  cuenta_id: string;
  recibo_id: string;
  concepto_codigo: string;
  descripcion: string;
  naturaleza: NaturalezaConcepto;
  cantidad: string;
  base: NullableOpt<string>;
  monto: string;
  orden: Generated<number>;
}

// Auditoría de envío de recibos por correo (migración 020).
export interface EnvioReciboTable {
  id: Generated<string>;
  cuenta_id: string;
  recibo_id: string;
  corrida_id: NullableOpt<string>;
  email: NullableOpt<string>;
  usuario_id: NullableOpt<string>;
  estado: string; // 'enviado' | 'error' | 'sin_email'
  detalle: NullableOpt<string>;
  enviado_at: Managed;
}

export type AlcanceDato = 'propio' | 'equipo' | 'area' | 'empresa';

export interface UsuarioRolTable {
  cuenta_id: string;
  usuario_id: string;
  rol_id: string;
}

export interface CapacidadTable {
  id: Generated<string>;
  cuenta_id: string;
  rol_id: string;
  recurso: string;
  accion: string;
  alcance: AlcanceDato;
}
export interface AuditoriaTable {
  id: Generated<string>;
  cuenta_id: string;
  usuario_id: string | null;
  accion: string;
  recurso: string | null;
  objeto_id: string | null;
  detalle: string | null;
  ip: string | null;
  user_agent: string | null;
  creado_at: Generated<Date>;
}

export interface LegajoDocTable {
  id: Generated<string>;
  cuenta_id: string;
  persona_id: string;
  tipo: string;
  tipo_documento_id: NullableOpt<string>;
  archivo_ref: NullableOpt<string>;
  archivo_bytes: NullableOpt<Buffer>;
  archivo_mime: NullableOpt<string>;
  vencimiento: NullableOpt<IsoDate>;
  subido_por: NullableOpt<string>;
  origen: Generated<string>;
  sensible: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface TipoDocumentoTable {
  id: Generated<string>;
  cuenta_id: string;
  nombre: string;
  obligatorio: Generated<boolean>;
  activo: Generated<boolean>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface EstudioCertTable {
  id: Generated<string>;
  cuenta_id: string;
  persona_id: string;
  titulo: string;
  institucion: NullableOpt<string>;
  vencimiento: NullableOpt<IsoDate>;
  created_at: Managed;
  updated_at: Managed;
}

export interface EvaluacionTable {
  id: Generated<string>;
  cuenta_id: string;
  relacion_id: string;
  ciclo: string;
  evaluador_relacion_id: NullableOpt<string>;
  resultado: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface CapacitacionTable {
  id: Generated<string>;
  cuenta_id: string;
  nombre: string;
  created_at: Managed;
  updated_at: Managed;
}

export interface InscripcionTable {
  id: Generated<string>;
  cuenta_id: string;
  capacitacion_id: string;
  relacion_id: string;
  estado: Generated<string>;
  fecha_completado: NullableOpt<IsoDate>;
  created_at: Managed;
  updated_at: Managed;
}

export interface TwilioConfigTable {
  id: Generated<string>;
  account_sid: string;
  auth_token_cifrado: NullableOpt<string>;
  from_sms: NullableOpt<string>;
  from_whatsapp: NullableOpt<string>;
  wa_content_sid: NullableOpt<string>;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface TraduccionOverrideTable {
  idioma: string;
  clave: string;
  valor: string;
  updated_at: Managed;
}

export interface ReciboPlantillaTable {
  cuenta_id: string;
  config: string;
  updated_at: Managed;
}

export interface ComunicadoTable {
  id: Generated<string>;
  cuenta_id: string;
  titulo: string;
  cuerpo: string;
  categoria: Generated<string>;
  publicado: Generated<boolean>;
  fijado: Generated<boolean>;
  publicado_at: Managed;
  created_at: Managed;
  updated_at: Managed;
}

export interface BeneficioTable {
  id: Generated<string>;
  cuenta_id: string;
  titulo: string;
  descripcion: NullableOpt<string>;
  categoria: Generated<string>;
  cta_texto: NullableOpt<string>;
  cta_url: NullableOpt<string>;
  imagen: NullableOpt<Buffer>; // banner opcional (PNG/JPG/WebP/SVG embebido)
  imagen_mime: NullableOpt<string>;
  activo: Generated<boolean>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface BeneficioSolicitudTable {
  id: Generated<string>;
  cuenta_id: string;
  beneficio_id: string;
  relacion_id: string;
  estado: Generated<string>;
  nota: NullableOpt<string>;
  decidido_por: NullableOpt<string>;
  decidido_at: NullableOpt<Date>;
  created_at: Managed;
  updated_at: Managed;
}

export interface ComunicadoCategoriaTable {
  id: Generated<string>;
  cuenta_id: string;
  nombre: string;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface SolicitudLicenciaTable {
  id: Generated<string>;
  cuenta_id: string;
  relacion_id: string;
  tipo: string;
  desde: IsoDate;
  hasta: IsoDate;
  motivo: NullableOpt<string>;
  estado: Generated<string>;
  decidido_por: NullableOpt<string>;
  decidido_at: NullableOpt<Date>;
  comentario: NullableOpt<string>;
  sin_goce: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface PushSuscripcionTable {
  id: Generated<string>;
  cuenta_id: string;
  usuario_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: NullableOpt<string>;
  created_at: Managed;
}

// §ofertas — catálogo de plataforma (sin cuenta_id; lo gestiona el operador).
export interface OferenteTable {
  id: Generated<string>;
  nombre: string;
  tipo: Generated<string>; // 'banco' | 'financiera' | 'comercio' | 'otro'
  pais: NullableOpt<string>; // null = todos
  activo: Generated<boolean>;
  // §oferentes: verificación (KYC), contacto y crédito habilitable
  razon_social: NullableOpt<string>;
  id_fiscal: NullableOpt<string>;
  email_contacto: NullableOpt<string>;
  telefono_contacto: NullableOpt<string>;
  estado_verificacion: Generated<string>; // 'pendiente' | 'verificado' | 'rechazado'
  verificacion_nota: NullableOpt<string>;
  credito_habilitado: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

export interface UsuarioOferenteTable {
  id: Generated<string>;
  oferente_id: string;
  email: string;
  password_hash: NullableOpt<string>;
  nombre: Generated<string>;
  es_admin: Generated<boolean>;
  activo: Generated<boolean>;
  created_at: Managed;
  updated_at: Managed;
}

// §oferentes Fase 2 — recuperación de contraseña del usuario de oferente: token de un
// solo uso con vencimiento (análogo a reset_estudio).
export interface ResetOferenteTable {
  id: Generated<string>;
  usuario_oferente_id: string;
  token_hash: string;
  expira_at: Date;
  usado: Generated<boolean>;
  created_at: Managed;
}

// §oferentes Fase 2 — antesala del alta self-service: datos + OTP, hasta verificar el
// email. Al confirmar se provisiona el oferente + su usuario admin y se borra la fila.
export interface RegistroOferenteTable {
  id: Generated<string>;
  email: string;
  nombre_oferente: string;
  tipo: string; // 'banco' | 'financiera' | 'comercio' | 'anunciante'
  pais: string;
  nombre_admin: string;
  password_hash: string;
  codigo_hash: string;
  expira_at: string;
  intentos: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface OfertaTable {
  id: Generated<string>;
  oferente_id: string;
  tipo: Generated<string>; // 'publicidad' | 'venta' | 'financiero'
  titulo: string;
  descripcion: NullableOpt<string>;
  cta_texto: NullableOpt<string>;
  cta_url: NullableOpt<string>;
  pais: NullableOpt<string>;
  requiere_consentimiento: Generated<boolean>;
  activo: Generated<boolean>;
  vigente_desde: NullableOpt<IsoDate>;
  vigente_hasta: NullableOpt<IsoDate>;
  orden: Generated<number>;
  imagen: NullableOpt<Buffer>; // banner opcional (PNG/JPG/WebP embebido)
  imagen_mime: NullableOpt<string>;
  salario_min: NullableOpt<string>; // numeric -> string; franja salarial (moneda de la empresa)
  salario_max: NullableOpt<string>;
  // §oferentes: estado de aprobación + condiciones estructuradas del crédito (tipo financiero)
  estado: Generated<string>; // 'borrador' | 'en_revision' | 'aprobada' | 'rechazada'
  revision_nota: NullableOpt<string>;
  cred_tna: NullableOpt<string>;
  cred_plazo_min_meses: NullableOpt<number>;
  cred_plazo_max_meses: NullableOpt<number>;
  cred_monto_min: NullableOpt<string>;
  cred_monto_max: NullableOpt<string>;
  cred_moneda: NullableOpt<string>;
  cred_comisiones: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

// §ofertas — consentimiento del empleado (tenant, con RLS).
export interface OfertaConsentimientoTable {
  id: Generated<string>;
  cuenta_id: string;
  usuario_id: string;
  oferente_id: string;
  otorgado: Generated<boolean>;
  otorgado_at: NullableOpt<Date>;
  revocado_at: NullableOpt<Date>;
  created_at: Managed;
  updated_at: Managed;
}

// §firma — catálogo de proveedores de firma avanzada por país (plataforma).
export interface FirmaProveedorTable {
  id: Generated<string>;
  pais: string;
  nombre: string;
  sitio_url: NullableOpt<string>;
  integrado: Generated<boolean>;
  activo: Generated<boolean>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

// §firma — firma de un recibo (tenant, con RLS). No modifica el recibo.
export interface ReciboFirmaTable {
  id: Generated<string>;
  cuenta_id: string;
  recibo_id: string;
  usuario_id: string;
  modalidad: Generated<string>;
  firmado_at: Generated<Date>;
  ip: NullableOpt<string>;
  user_agent: NullableOpt<string>;
  proveedor_id: NullableOpt<string>;
  evidencia: NullableOpt<string>;
  firma_bytes: NullableOpt<Buffer>;
  firma_mime: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface FirmaEmpleadoTable {
  id: Generated<string>;
  cuenta_id: string;
  persona_id: string;
  imagen_bytes: Buffer;
  imagen_mime: Generated<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface BancoTable {
  id: Generated<string>;
  pais: string;
  nombre: string;
  activo: Generated<boolean>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface TipoCuentaBancariaTable {
  id: Generated<string>;
  pais: string;
  nombre: string;
  activo: Generated<boolean>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface MedioPagoTable {
  id: Generated<string>;
  cuenta_id: string;
  relacion_id: string;
  tipo: Generated<string>; // 'efectivo' | 'cheque' | 'cuenta_bancaria'
  banco_id: NullableOpt<string>;
  tipo_cuenta_id: NullableOpt<string>;
  numero_cuenta: NullableOpt<string>;
  moneda: NullableOpt<string>;
  titular: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

// Situación de aportes por PERSONA (motor, país-agnóstico): bolsa clave→valor que el paquete
// de país interpreta (UY: fonasa_conyuge / fonasa_hijos / jubilatorio_con_tope, como 'true'/'false').
export interface PersonaSituacionAporteTable {
  cuenta_id: string;
  persona_id: string;
  clave: string;
  valor: string;
  created_at: Managed;
  updated_at: Managed;
}

// §industria — catálogo de rubros de empresa (plataforma; lo gestiona el operador).
export interface IndustriaTable {
  id: Generated<string>;
  nombre: string;
  activo: Generated<boolean>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface OfertaIndustriaTable {
  oferta_id: string;
  industria_id: string;
}

export interface OfertaFormularioTable {
  id: Generated<string>;
  oferta_id: string;
  nombre: string;
  archivo_bytes: Buffer;
  archivo_mime: string;
  archivo_ref: NullableOpt<string>;
  metodo_firma: Generated<string>;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface OfertaRequisitoDocTable {
  id: Generated<string>;
  oferta_id: string;
  nombre: string;
  orden: Generated<number>;
  created_at: Managed;
  updated_at: Managed;
}

export interface OfertaComercialTable {
  oferta_id: string;
  modelo: string; // 'pauta' | 'comision_venta' | 'comision_prestamo'
  unidad: NullableOpt<string>;
  tarifa: NullableOpt<string>;
  porcentaje: NullableOpt<string>;
  monto_fijo: NullableOpt<string>;
  solicitud_modo: NullableOpt<string>; // 'fijo' | 'porcentaje' — cargo por solicitud (financiera)
  solicitud_valor: NullableOpt<string>;
  moneda: NullableOpt<string>;
  notas: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

// §oferentes Fase 5 — eventos comerciales facturables (medición). Ventas/préstamos que
// carga el oferente y confirma el operador; a futuro, publicidad automática. Deny-by-default.
export interface EventoComercialTable {
  id: Generated<string>;
  oferente_id: string;
  oferta_id: string;
  tipo: string; // 'venta' | 'prestamo' | 'impresion' | 'click'
  periodo: string; // 'YYYY-MM'
  cantidad: Generated<number>;
  monto: NullableOpt<string>;
  moneda: NullableOpt<string>;
  referencia: NullableOpt<string>;
  nota: NullableOpt<string>;
  estado: Generated<string>; // 'pendiente' | 'confirmado' | 'rechazado'
  origen: Generated<string>; // 'oferente' | 'auto'
  revision_nota: NullableOpt<string>;
  confirmado_at: NullableOpt<Date>;
  created_at: Managed;
  updated_at: Managed;
}

// §oferentes Fase 5 — interacciones de publicidad (reach único por persona/oferta/período/tipo).
// La escribe el backend con owner desde la app del empleado. Deny-by-default.
export interface InteraccionOfertaTable {
  id: Generated<string>;
  cuenta_id: string;
  usuario_id: string;
  oferente_id: string;
  oferta_id: string;
  periodo: string; // 'YYYY-MM'
  tipo: string; // 'impresion' | 'click'
  created_at: Managed;
}

// §oferentes Fase 5 — condición comercial por defecto a nivel oferente (billing). La
// oferta hereda esto si no tiene su propia oferta_comercial. Deny-by-default (solo operador).
export interface OferenteComercialTable {
  oferente_id: string;
  modelo: string; // 'pauta' | 'comision_venta' | 'comision_prestamo'
  unidad: NullableOpt<string>;
  tarifa: NullableOpt<string>;
  porcentaje: NullableOpt<string>;
  monto_fijo: NullableOpt<string>;
  solicitud_modo: NullableOpt<string>; // 'fijo' | 'porcentaje' — cargo por solicitud (financiera)
  solicitud_valor: NullableOpt<string>;
  moneda: NullableOpt<string>;
  notas: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface OferenteFacturacionTable {
  oferente_id: string;
  razon_social: NullableOpt<string>;
  id_fiscal: NullableOpt<string>;
  domicilio: NullableOpt<string>;
  email: NullableOpt<string>;
  contacto: NullableOpt<string>;
  moneda: NullableOpt<string>;
  medio_pago: NullableOpt<string>; // 'transferencia' | 'tarjeta' | 'otro'
  pago_detalle: NullableOpt<string>;
  notas: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface SolicitudFormularioTable {
  id: Generated<string>;
  cuenta_id: string;
  solicitud_id: string;
  oferta_formulario_id: NullableOpt<string>;
  nombre: string;
  archivo_bytes: Buffer;
  archivo_mime: string;
  archivo_ref: NullableOpt<string>;
  firmado_por: NullableOpt<string>;
  firmado_at: Managed;
  created_at: Managed;
  updated_at: Managed;
}

export interface SolicitudDocumentoTable {
  id: Generated<string>;
  cuenta_id: string;
  solicitud_id: string;
  requisito_id: NullableOpt<string>;
  nombre: string;
  archivo_bytes: Buffer;
  archivo_mime: string;
  archivo_ref: NullableOpt<string>;
  legajo_doc_id: NullableOpt<string>;
  subido_por: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface SolicitudCreditoTable {
  id: Generated<string>;
  cuenta_id: string;
  usuario_id: string;
  relacion_id: NullableOpt<string>;
  oferta_id: string;
  monto: string;
  plazo_meses: number;
  consent_datos: Generated<boolean>;
  consent_descuento: Generated<boolean>;
  ingreso_verificado: NullableOpt<string>;
  antiguedad_meses: NullableOpt<number>;
  estado: Generated<string>; // 'pendiente' | 'aprobada' | 'rechazada' | 'cancelada'
  nota: NullableOpt<string>;
  created_at: Managed;
  updated_at: Managed;
}

export interface PrestamoTable {
  id: Generated<string>;
  cuenta_id: string;
  solicitud_id: string;
  usuario_id: string;
  relacion_id: NullableOpt<string>;
  capital: string;
  tasa_mensual: string;
  plazo_meses: number;
  cuota: string;
  total: string;
  fecha_primera_cuota: string;
  estado: Generated<string>; // 'vigente' | 'saldado' | 'cancelado'
  created_at: Managed;
  updated_at: Managed;
}

export interface CuotaPrestamoTable {
  id: Generated<string>;
  cuenta_id: string;
  prestamo_id: string;
  numero: number;
  vencimiento: string;
  capital: string;
  interes: string;
  monto: string;
  saldo: string;
  estado: Generated<string>; // 'pendiente' | 'pagada'
  created_at: Managed;
  updated_at: Managed;
}

export interface FacturaProveedorTable {
  id: Generated<string>;
  cuenta_id: string;
  relacion_id: string;
  periodo: string; // 'YYYY-MM'
  numero: string; // número de la factura que emite el proveedor
  fecha_emision: IsoDate;
  moneda: string;
  monto: string; // numeric(18,2) -> string para no perder precisión
  estado: Generated<string>; // 'recibida' | 'pagada'
  archivo_ref: NullableOpt<string>;
  archivo_bytes: NullableOpt<Buffer>;
  archivo_mime: NullableOpt<string>;
  created_at: Managed;
}

export interface DB {
  empresa: EmpresaTable;
  establecimiento: EstablecimientoTable;
  persona: PersonaTable;
  unidad_org: UnidadOrgTable;
  cargo: CargoTable;
  nivel_salarial: NivelSalarialTable;
  franja_salarial: FranjaSalarialTable;
  relacion_laboral: RelacionLaboralTable;
  relacion_laboral_version: RelacionLaboralVersionTable;
  usuario: UsuarioTable;
  otp_login: OtpLoginTable;
  dispositivo_confiable: DispositivoConfiableTable;
  token_acceso: TokenAccesoTable;
  rol: RolTable;
  invitacion_plantilla: InvitacionPlantillaTable;
  regimen: RegimenTable;
  concepto: ConceptoTable;
  pais_parametro: PaisParametroTable;
  pais_tramo: PaisTramoTable;
  definicion_salida: DefinicionSalidaTable;
  novedad: NovedadTable;
  ausencia_licencia: AusenciaLicenciaTable;
  concepto_ausencia: ConceptoAusenciaTable;
  concepto_manual: ConceptoManualTable;
  asiento_regla: AsientoReglaTable;
  liquidacion_concepto: LiquidacionConceptoTable;
  plan_variable: PlanVariableTable;
  plan_variable_tramo: PlanVariableTramoTable;
  objetivo: ObjetivoTable;
  logro: LogroTable;
  asignacion_plan: AsignacionPlanTable;
  objetivo_periodo: ObjetivoPeriodoTable;
  logro_periodo: LogroPeriodoTable;
  estudio: EstudioTable;
  usuario_estudio: UsuarioEstudioTable;
  vinculo_estudio_empresa: VinculoEstudioEmpresaTable;
  acceso_empresa: AccesoEmpresaTable;
  plan_estudio: PlanEstudioTable;
  plan_estudio_tramo: PlanEstudioTramoTable;
  suscripcion_estudio: SuscripcionEstudioTable;
  registro_estudio: RegistroEstudioTable;
  reset_estudio: ResetEstudioTable;
  corrida_liquidacion: CorridaLiquidacionTable;
  recibo: ReciboTable;
  linea_recibo: LineaReciboTable;
  envio_recibo: EnvioReciboTable;
  factura_proveedor: FacturaProveedorTable;
  retencion: RetencionTable;
  retencion_aplicada: RetencionAplicadaTable;
  api_token: ApiTokenTable;
  plan: PlanTable;
  suscripcion: SuscripcionTable;
  factura_plataforma: FacturaPlataformaTable;
  tarifa_ia: TarifaIaTable;
  consumo_ia: ConsumoIaTable;
  operador: OperadorTable;
  operador_capacidad: OperadorCapacidadTable;
  plan_tramo: PlanTramoTable;
  pasarela_pago: PasarelaPagoTable;
  integracion_facturacion: IntegracionFacturacionTable;
  correo_config: CorreoConfigTable;
  twilio_config: TwilioConfigTable;
  traduccion_override: TraduccionOverrideTable;
  recibo_plantilla: ReciboPlantillaTable;
  usuario_rol: UsuarioRolTable;
  capacidad: CapacidadTable;
  auditoria: AuditoriaTable;
  legajo_doc: LegajoDocTable;
  tipo_documento: TipoDocumentoTable;
  estudio_cert: EstudioCertTable;
  evaluacion: EvaluacionTable;
  capacitacion: CapacitacionTable;
  inscripcion: InscripcionTable;
  comunicado: ComunicadoTable;
  comunicado_categoria: ComunicadoCategoriaTable;
  beneficio: BeneficioTable;
  beneficio_solicitud: BeneficioSolicitudTable;
  solicitud_licencia: SolicitudLicenciaTable;
  push_suscripcion: PushSuscripcionTable;
  oferente: OferenteTable;
  usuario_oferente: UsuarioOferenteTable;
  registro_oferente: RegistroOferenteTable;
  reset_oferente: ResetOferenteTable;
  oferta: OfertaTable;
  oferta_formulario: OfertaFormularioTable;
  oferta_requisito_doc: OfertaRequisitoDocTable;
  oferta_consentimiento: OfertaConsentimientoTable;
  firma_proveedor: FirmaProveedorTable;
  recibo_firma: ReciboFirmaTable;
  firma_empleado: FirmaEmpleadoTable;
  banco: BancoTable;
  tipo_cuenta_bancaria: TipoCuentaBancariaTable;
  medio_pago: MedioPagoTable;
  persona_situacion_aporte: PersonaSituacionAporteTable;
  industria: IndustriaTable;
  oferta_industria: OfertaIndustriaTable;
  oferta_comercial: OfertaComercialTable;
  oferente_comercial: OferenteComercialTable;
  evento_comercial: EventoComercialTable;
  interaccion_oferta: InteraccionOfertaTable;
  oferente_facturacion: OferenteFacturacionTable;
  solicitud_credito: SolicitudCreditoTable;
  solicitud_formulario: SolicitudFormularioTable;
  solicitud_documento: SolicitudDocumentoTable;
  prestamo: PrestamoTable;
  cuota_prestamo: CuotaPrestamoTable;
}

// Helpers de tipo por entidad (select / insert / update).
export type Persona = Selectable<PersonaTable>;
export type NuevaPersona = Insertable<PersonaTable>;
export type CambioPersona = Updateable<PersonaTable>;

export type RelacionLaboral = Selectable<RelacionLaboralTable>;
export type RelacionLaboralVersion = Selectable<RelacionLaboralVersionTable>;
export type FacturaProveedor = Selectable<FacturaProveedorTable>;
