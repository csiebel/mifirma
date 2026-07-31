import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors';
import { clearCookieSesion } from '../cookies_sesion';
import { verificarTokenOperador, type SesionOperador } from '../../operador/sesion';
import { listarAuditoriaOperador } from '../../services/auditoria';
import {
  listarPlanes,
  crearPlan,
  editarPlan,
  eliminarPlan,
  listarEmpresasConPlan,
  suscribir,
  facturarPeriodo,
  marcarFacturaPagada,
  facturasDeEmpresa,
} from '../../services/facturacion';
import {
  listarTarifasIa,
  guardarTarifaIa,
  eliminarTarifaIa,
  setOverrideIaEmpresa,
} from '../../services/consumo_ia';
import {
  listarCatalogoPagoAdmin,
  crearCatalogoPago,
  editarCatalogoPago,
  eliminarCatalogoPago,
  tablaValida,
} from '../../services/catalogos_pago_admin';
import {
  listarPlanesEstudio,
  crearPlanEstudio,
  editarPlanEstudio,
  eliminarPlanEstudio,
  listarEstudiosConPlan,
  suscribirEstudio,
} from '../../services/facturacion_estudios';
import {
  loginOperador,
  crearOperador,
  listarOperadores,
  setOperadorActivo,
  editarCapacidades,
  cambiarPasswordOperador,
  setPasswordOperador,
  CAPACIDADES,
} from '../../services/operadores';
import {
  listarPasarelas,
  guardarPasarela,
  setPasarelaActiva,
  eliminarPasarela,
} from '../../services/pasarelas';
import { adaptadorDe } from '../../services/pagos/registro';
import { formatearMonto } from '../../services/pagos/moneda';
import {
  verIntegracionFacturacion,
  guardarIntegracionFacturacion,
  setIntegracionFacturacionActiva,
} from '../../services/integracion_facturacion';
import { verCorreo, guardarCorreo, setCorreoActivo, enviarPrueba } from '../../services/correo';
import { verTwilio, guardarTwilio, setTwilioActivo, enviarPruebaTwilio } from '../../services/twilio';
import { listarTraducciones, setTraduccion, borrarTraduccion } from '../../services/traducciones';
import { borrarEmpresa } from '../../admin/borrar_empresa';
import {
  setOfertasEmpresa,
  listarOferentes,
  crearOferente,
  editarOferente,
  setOferenteActivo,
  borrarOferente,
  setVerificacionOferente,
  setCreditoOferente,
  aprobarOferta,
  rechazarOferta,
  listarOfertasAdmin,
  crearOferta,
  editarOferta,
  setOfertaActiva,
  borrarOferta,
  guardarImagenOferta,
  borrarImagenOferta,
  imagenOferta,
  getIndustriasOferta,
  setIndustriasOferta,
  listarFormulariosOferta,
  agregarFormularioOferta,
  borrarFormularioOferta,
  archivoFormularioOferta,
  listarRequisitosOferta,
  agregarRequisitoOferta,
  borrarRequisitoOferta,
} from '../../services/ofertas';
import {
  setCondicionComercial,
  borrarCondicionComercial,
  getCondicionComercialResuelta,
  getComercialOferente,
  setComercialOferente,
  borrarComercialOferente,
} from '../../services/oferta_comercial';
import { listarEventosComerciales, confirmarEvento, rechazarEvento } from '../../services/eventos_comercial';
import { resumenFacturacionOferentes } from '../../services/resumen_oferentes';
import { getFacturacionOferente, setFacturacionOferente } from '../../services/oferente_facturacion';
import { listarSolicitudesCreditoOperador, resolverSolicitudCredito, verCronogramaOperador } from '../../services/credito';
import { documentacionSolicitudOperador, descargarFormularioInstanciaOperador, descargarDocumentoInstanciaOperador } from '../../services/solicitud_docs';
import { asistirOperador } from '../../services/asistente_operador';
import {
  listarFirmaProveedores,
  crearFirmaProveedor,
  editarFirmaProveedor,
  setFirmaProveedorActivo,
  setFirmaProveedorIntegrado,
  borrarFirmaProveedor,
} from '../../services/firma';
import {
  listarIndustrias,
  crearIndustria,
  editarIndustria,
  setIndustriaActiva,
  borrarIndustria,
} from '../../services/industrias';

// Autenticación de la consola: sesión de operador (JWT propio). El login con
// usuario/contraseña la emite; cada acción exige el privilegio que corresponde.
async function sesion(req: FastifyRequest): Promise<SesionOperador> {
  return verificarTokenOperador(req.headers.authorization);
}
function exigirCap(s: SesionOperador, cap: string) {
  if (s.esSuperadmin) return;
  if (!s.capacidades.includes(cap)) throw new HttpError(403, `Te falta el privilegio "${cap}".`);
}
function exigirSuperadmin(s: SesionOperador) {
  if (!s.esSuperadmin) throw new HttpError(403, 'Solo un superadmin puede hacer esto.');
}

const loginSchema = z.object({ usuario: z.string().min(1), password: z.string().min(1) });

const franjaSchema = z.object({
  desde: z.coerce.number().int().min(0),
  hasta: z.coerce.number().int().min(0).nullable().optional(),
  precio: z.coerce.number().min(0),
});

const crearPlanSchema = z.object({
  codigo: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'Solo letras, números, guion y guion bajo.'),
  nombre: z.string().min(1),
  moneda: z.string().length(3).optional(),
  modo_precio: z.enum(['fijo', 'por_funcionario']).optional(),
  precio_fijo: z.coerce.number().min(0).optional(),
  precio_por_funcionario: z.coerce.number().min(0).optional(),
  funcionarios_gratis: z.coerce.number().int().min(0).optional(),
  periodo: z.enum(['mensual', 'semestral', 'anual']).optional(),
  vigente_desde: z.string().optional(),
  asistente_ia: z.boolean().optional(),
  ia_cobra: z.boolean().optional(),
  ia_margen_pct: z.coerce.number().min(0).optional(),
  ia_incluido: z.coerce.number().min(0).optional(),
  tramos: z.array(franjaSchema).optional(),
});
const editarPlanSchema = z.object({
  nombre: z.string().min(1).optional(),
  moneda: z.string().length(3).optional(),
  modo_precio: z.enum(['fijo', 'por_funcionario']).optional(),
  precio_fijo: z.coerce.number().min(0).optional(),
  precio_por_funcionario: z.coerce.number().min(0).optional(),
  funcionarios_gratis: z.coerce.number().int().min(0).optional(),
  periodo: z.enum(['mensual', 'semestral', 'anual']).optional(),
  activo: z.boolean().optional(),
  vigente_hasta: z.string().nullable().optional(),
  asistente_ia: z.boolean().optional(),
  ia_cobra: z.boolean().optional(),
  ia_margen_pct: z.coerce.number().min(0).optional(),
  ia_incluido: z.coerce.number().min(0).optional(),
  tramos: z.array(franjaSchema).optional(),
});
const suscSchema = z.object({
  plan_codigo: z.string().min(1),
  estado: z.enum(['prueba', 'activa', 'suspendida', 'cancelada']).optional(),
});
const factSchema = z.object({ periodo: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'Formato YYYY-MM.') });

const crearPlanEstudioSchema = z.object({
  codigo: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'Solo letras, números, guion y guion bajo.'),
  nombre: z.string().min(1),
  moneda: z.string().length(3).optional(),
  precio_por_empresa: z.coerce.number().min(0).optional(),
  empresas_gratis: z.coerce.number().int().min(0).optional(),
  limite_empresas: z.coerce.number().int().min(0).nullable().optional(),
  periodo: z.enum(['mensual', 'semestral', 'anual']).optional(),
  vigente_desde: z.string().optional(),
  tramos: z.array(franjaSchema).optional(),
});
const editarPlanEstudioSchema = z.object({
  nombre: z.string().min(1).optional(),
  moneda: z.string().length(3).optional(),
  precio_por_empresa: z.coerce.number().min(0).optional(),
  empresas_gratis: z.coerce.number().int().min(0).optional(),
  limite_empresas: z.coerce.number().int().min(0).nullable().optional(),
  periodo: z.enum(['mensual', 'semestral', 'anual']).optional(),
  activo: z.boolean().optional(),
  vigente_hasta: z.string().nullable().optional(),
  tramos: z.array(franjaSchema).optional(),
});

const crearOpSchema = z.object({
  usuario: z.string().min(1),
  nombre: z.string().min(1),
  password: z.string().min(8, 'Mínimo 8 caracteres.'),
  es_superadmin: z.boolean().optional(),
  capacidades: z.array(z.string()).optional(),
});
const editarOpSchema = z.object({
  activo: z.boolean().optional(),
  capacidades: z.array(z.string()).optional(),
});

const guardarPasarelaSchema = z.object({
  proveedor: z.string().min(1),
  nombre: z.string().min(1),
  modo: z.enum(['sandbox', 'produccion']).optional(),
  moneda: z.string().length(3).optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  webhook_secret: z.string().optional(),
});

const guardarCorreoSchema = z.object({
  proveedor: z.string().optional(),
  host: z.string().min(1),
  puerto: z.coerce.number().int().min(1).max(65535),
  seguridad: z.enum(['ssl', 'starttls']).optional(),
  usuario: z.string().min(1),
  remitente_nombre: z.string().min(1),
  remitente_email: z.string().email(),
  password: z.string().optional(),
});

export function registrarRutasOperador(app: FastifyInstance) {
  // ---- Sesión ----
  app.post('/operador/login', async (req) => {
    const b = loginSchema.parse(req.body);
    return loginOperador(b.usuario, b.password);
  });

  // Cerrar sesión: borra la cookie httpOnly del realm operador (Fase A). Público.
  app.post('/operador/logout', async (_req, reply) => {
    clearCookieSesion(reply, 'op');
    return { ok: true };
  });

  app.get('/operador/yo', async (req) => {
    const s = await sesion(req);
    return { usuario: s.usuario, es_superadmin: s.esSuperadmin, capacidades: s.capacidades, catalogo: CAPACIDADES };
  });

  // Cambiar la propia contraseña (cualquier operador autenticado, sólo la suya).
  app.put('/operador/yo/password', async (req) => {
    const s = await sesion(req);
    const b = z.object({ actual: z.string().min(1), nueva: z.string().min(1) }).parse(req.body);
    return cambiarPasswordOperador(s.operadorId, b.actual, b.nueva);
  });

  // ---- Planes (config comercial global) ----
  app.get('/operador/planes', async (req) => {
    await sesion(req);
    return listarPlanes();
  });
  app.post('/operador/planes', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const b = crearPlanSchema.parse(req.body);
    return crearPlan({
      codigo: b.codigo,
      nombre: b.nombre,
      moneda: b.moneda,
      modoPrecio: b.modo_precio,
      precioFijo: b.precio_fijo,
      precioPorFuncionario: b.precio_por_funcionario,
      funcionariosGratis: b.funcionarios_gratis,
      periodo: b.periodo,
      vigenteDesde: b.vigente_desde,
      asistenteIa: b.asistente_ia,
      iaCobra: b.ia_cobra,
      iaMargenPct: b.ia_margen_pct,
      iaIncluido: b.ia_incluido,
      tramos: b.tramos?.map((t) => ({ desde: t.desde, hasta: t.hasta ?? null, precio: t.precio })),
    });
  });
  app.patch('/operador/planes/:codigo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { codigo } = req.params as { codigo: string };
    const b = editarPlanSchema.parse(req.body);
    return editarPlan(codigo, {
      nombre: b.nombre,
      moneda: b.moneda,
      modoPrecio: b.modo_precio,
      precioFijo: b.precio_fijo,
      precioPorFuncionario: b.precio_por_funcionario,
      funcionariosGratis: b.funcionarios_gratis,
      periodo: b.periodo,
      activo: b.activo,
      vigenteHasta: b.vigente_hasta,
      asistenteIa: b.asistente_ia,
      iaCobra: b.ia_cobra,
      iaMargenPct: b.ia_margen_pct,
      iaIncluido: b.ia_incluido,
      tramos: b.tramos?.map((t) => ({ desde: t.desde, hasta: t.hasta ?? null, precio: t.precio })),
    });
  });

  app.delete('/operador/planes/:codigo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { codigo } = req.params as { codigo: string };
    return eliminarPlan(codigo);
  });

  // ---- Tarifas de IA (catálogo) + override de IA por empresa ----
  app.get('/operador/tarifas-ia', async (req) => {
    await sesion(req);
    return listarTarifasIa();
  });
  app.post('/operador/tarifas-ia', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const b = z
      .object({
        modelo: z.string().min(1),
        moneda: z.string().length(3).optional(),
        precio_input_millon: z.coerce.number().min(0),
        precio_output_millon: z.coerce.number().min(0),
        vigente_desde: z.string().optional(),
      })
      .parse(req.body);
    return guardarTarifaIa({
      modelo: b.modelo,
      moneda: b.moneda,
      precioInputMillon: b.precio_input_millon,
      precioOutputMillon: b.precio_output_millon,
      vigenteDesde: b.vigente_desde,
    });
  });
  app.delete('/operador/tarifas-ia/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id } = req.params as { id: string };
    return eliminarTarifaIa(id);
  });
  app.patch('/operador/empresas/:id/ia', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id } = req.params as { id: string };
    const b = z
      .object({
        asistente_ia: z.boolean().nullable().optional(),
        ia_cobra: z.boolean().nullable().optional(),
        ia_margen_pct: z.coerce.number().min(0).nullable().optional(),
        ia_incluido: z.coerce.number().min(0).nullable().optional(),
      })
      .parse(req.body);
    return setOverrideIaEmpresa(id, {
      asistenteIa: b.asistente_ia,
      iaCobra: b.ia_cobra,
      iaMargenPct: b.ia_margen_pct,
      iaIncluido: b.ia_incluido,
    });
  });

  // ---- Catálogos de pago (banco / tipo de cuenta) por país ----
  app.get('/operador/catalogos-pago/:tabla', async (req) => {
    await sesion(req);
    const { tabla } = req.params as { tabla: string };
    const { pais } = req.query as { pais?: string };
    return listarCatalogoPagoAdmin(tablaValida(tabla), pais);
  });
  app.post('/operador/catalogos-pago/:tabla', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { tabla } = req.params as { tabla: string };
    const b = z
      .object({ pais: z.string().min(2).max(3), nombre: z.string().min(1), orden: z.coerce.number().int().optional() })
      .parse(req.body);
    return crearCatalogoPago(tablaValida(tabla), { pais: b.pais, nombre: b.nombre, orden: b.orden });
  });
  app.patch('/operador/catalogos-pago/:tabla/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { tabla, id } = req.params as { tabla: string; id: string };
    const b = z
      .object({ nombre: z.string().min(1).optional(), activo: z.boolean().optional(), orden: z.coerce.number().int().optional() })
      .parse(req.body);
    return editarCatalogoPago(tablaValida(tabla), id, b);
  });
  app.delete('/operador/catalogos-pago/:tabla/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { tabla, id } = req.params as { tabla: string; id: string };
    return eliminarCatalogoPago(tablaValida(tabla), id);
  });

  // ---- Estudios (planes + cartera) ----
  app.get('/operador/planes-estudio', async (req) => {
    await sesion(req);
    return listarPlanesEstudio();
  });
  app.post('/operador/planes-estudio', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const b = crearPlanEstudioSchema.parse(req.body);
    return crearPlanEstudio({
      codigo: b.codigo,
      nombre: b.nombre,
      moneda: b.moneda,
      precioPorEmpresa: b.precio_por_empresa,
      empresasGratis: b.empresas_gratis,
      limiteEmpresas: b.limite_empresas,
      periodo: b.periodo,
      vigenteDesde: b.vigente_desde,
      tramos: b.tramos?.map((t) => ({ desde: t.desde, hasta: t.hasta ?? null, precio: t.precio })),
    });
  });
  app.patch('/operador/planes-estudio/:codigo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { codigo } = req.params as { codigo: string };
    const b = editarPlanEstudioSchema.parse(req.body);
    return editarPlanEstudio(codigo, {
      nombre: b.nombre,
      moneda: b.moneda,
      precioPorEmpresa: b.precio_por_empresa,
      empresasGratis: b.empresas_gratis,
      limiteEmpresas: b.limite_empresas,
      periodo: b.periodo,
      activo: b.activo,
      vigenteHasta: b.vigente_hasta,
      tramos: b.tramos?.map((t) => ({ desde: t.desde, hasta: t.hasta ?? null, precio: t.precio })),
    });
  });
  app.delete('/operador/planes-estudio/:codigo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { codigo } = req.params as { codigo: string };
    return eliminarPlanEstudio(codigo);
  });
  app.get('/operador/estudios', async (req) => {
    await sesion(req);
    return listarEstudiosConPlan();
  });
  app.post('/operador/estudios/:id/suscripcion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id } = req.params as { id: string };
    const b = suscSchema.parse(req.body);
    return suscribirEstudio(id, b.plan_codigo, b.estado);
  });

  // ---- Empresas (cartera) ----
  app.get('/operador/empresas', async (req) => {
    await sesion(req);
    return listarEmpresasConPlan();
  });
  app.post('/operador/empresas/:id/suscripcion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_empresas');
    const { id } = req.params as { id: string };
    const b = suscSchema.parse(req.body);
    return suscribir(id, b.plan_codigo, b.estado);
  });
  app.post('/operador/empresas/:id/facturar', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_empresas');
    const { id } = req.params as { id: string };
    const b = factSchema.parse(req.body);
    return facturarPeriodo(id, b.periodo);
  });
  app.get('/operador/empresas/:id/facturas', async (req) => {
    await sesion(req);
    const { id } = req.params as { id: string };
    return facturasDeEmpresa(id);
  });
  app.post('/operador/empresas/:id/facturas/:periodo/pagar', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_empresas');
    const { id, periodo } = req.params as { id: string; periodo: string };
    return marcarFacturaPagada(id, periodo);
  });

  // Borrar una empresa por completo. CANDADOS: solo superadmin, confirmación por
  // nombre exacto, y se niega si hay recibos emitidos (retención legal).
  // Queda auditado en los logs del servidor (quién borró qué y cuándo).
  app.delete('/operador/empresas/:id', async (req) => {
    const s = await sesion(req);
    exigirSuperadmin(s);
    const { id } = req.params as { id: string };
    const b = z.object({ confirmar_nombre: z.string().min(1) }).parse(req.body);
    const r = await borrarEmpresa(id, b.confirmar_nombre);
    req.log.warn(
      {
        evento: 'operador.empresa.borrada',
        operador: s.usuario,
        operador_id: s.operadorId,
        cuenta_id: r.cuenta_id,
        empresa: r.empresa_nombre,
        filas: r.filas_borradas,
      },
      'Operador borró una empresa',
    );
    return r;
  });

  // ---- Operadores (gestión de usuarios de la consola) ----
  app.get('/operador/operadores', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_operadores');
    return listarOperadores();
  });
  app.post('/operador/operadores', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_operadores');
    const b = crearOpSchema.parse(req.body);
    return crearOperador({
      usuario: b.usuario,
      nombre: b.nombre,
      password: b.password,
      esSuperadmin: b.es_superadmin,
      capacidades: b.capacidades,
    });
  });
  app.patch('/operador/operadores/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_operadores');
    const { id } = req.params as { id: string };
    const b = editarOpSchema.parse(req.body);
    const out: Record<string, unknown> = {};
    if (b.capacidades !== undefined) Object.assign(out, await editarCapacidades(id, b.capacidades));
    if (b.activo !== undefined) Object.assign(out, await setOperadorActivo(id, b.activo));
    return { ok: true, ...out };
  });
  // Reset de contraseña de un operador (acción administrativa del que gestiona operadores).
  app.post('/operador/operadores/:id/password', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_operadores');
    const { id } = req.params as { id: string };
    const b = z.object({ nueva: z.string().min(1) }).parse(req.body);
    return setPasswordOperador(id, b.nueva);
  });

  // ---- Pasarelas de pago (configuración de gateways) ----
  app.get('/operador/pasarelas', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    return listarPasarelas();
  });
  app.post('/operador/pasarelas', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = guardarPasarelaSchema.parse(req.body);
    return guardarPasarela({
      proveedor: b.proveedor,
      nombre: b.nombre,
      modo: b.modo,
      moneda: b.moneda,
      clientId: b.client_id,
      clientSecret: b.client_secret,
      webhookSecret: b.webhook_secret,
    });
  });
  app.patch('/operador/pasarelas/:proveedor', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { proveedor } = req.params as { proveedor: string };
    const b = z.object({ activo: z.boolean() }).parse(req.body);
    return setPasarelaActiva(proveedor, b.activo);
  });
  app.delete('/operador/pasarelas/:proveedor', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { proveedor } = req.params as { proveedor: string };
    return eliminarPasarela(proveedor);
  });

  // ---- Prueba del adaptador (Fase 1): crea una orden sandbox y devuelve el link de aprobación ----
  app.post('/operador/pasarelas/:proveedor/orden-prueba', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { proveedor } = req.params as { proveedor: string };
    // PayPal = camino USD (no soporta UYU/PYG). El monto se formatea según la moneda.
    const b = z.object({ monto: z.string().default('10.00'), moneda: z.string().default('USD') }).parse(req.body ?? {});
    const base = (process.env.APP_BASE_URL || 'https://mi-firma.digital').replace(/\/$/, '');
    const adaptador = await adaptadorDe(proveedor);
    const r = await adaptador.iniciarCobro({
      referencia: 'prueba-' + Date.now(),
      monto: formatearMonto(b.monto, b.moneda),
      moneda: b.moneda,
      descripcion: 'Orden de prueba (Fase 1) · MiFirma',
      urlRetorno: base + '/operador?pago=ok',
      urlCancelacion: base + '/operador?pago=cancelado',
    });
    return { order_id: r.referenciaExterna, estado: r.estado, link_aprobacion: r.linkAprobacion ?? null };
  });

  app.get('/operador/pasarelas/:proveedor/orden/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { proveedor, id } = req.params as { proveedor: string; id: string };
    const adaptador = await adaptadorDe(proveedor);
    return { order_id: id, estado: await adaptador.consultarEstado(id) };
  });

  // ---- Integración de facturación (Nodum): el operador elige el modo de entrega ----
  app.get('/operador/integracion-facturacion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    return verIntegracionFacturacion();
  });
  app.post('/operador/integracion-facturacion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z
      .object({
        modo: z.enum(['api', 'archivo']),
        api_url: z.string().optional().nullable(),
        api_credencial: z.string().optional(),
        archivo_formato: z.string().optional().nullable(),
      })
      .parse(req.body);
    return guardarIntegracionFacturacion({ modo: b.modo, apiUrl: b.api_url, apiCredencial: b.api_credencial, archivoFormato: b.archivo_formato });
  });
  app.patch('/operador/integracion-facturacion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z.object({ activo: z.boolean() }).parse(req.body);
    return setIntegracionFacturacionActiva(b.activo);
  });

  // --- Conexión de correo saliente (plataforma) ---
  app.get('/operador/correo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    return verCorreo();
  });
  app.post('/operador/correo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = guardarCorreoSchema.parse(req.body);
    return guardarCorreo({
      proveedor: b.proveedor,
      host: b.host,
      puerto: b.puerto,
      seguridad: b.seguridad,
      usuario: b.usuario,
      remitenteNombre: b.remitente_nombre,
      remitenteEmail: b.remitente_email,
      password: b.password,
    });
  });
  app.patch('/operador/correo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z.object({ activo: z.boolean() }).parse(req.body);
    return setCorreoActivo(b.activo);
  });
  app.post('/operador/correo/prueba', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z.object({ para: z.string().email() }).parse(req.body);
    return enviarPrueba(b.para);
  });

  // --- Conexión de Twilio (SMS / WhatsApp para OTP de login) ---
  app.get('/operador/twilio', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    return verTwilio();
  });
  app.post('/operador/twilio', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z
      .object({
        account_sid: z.string().min(1),
        auth_token: z.string().optional(),
        from_sms: z.string().optional(),
        from_whatsapp: z.string().optional(),
        wa_content_sid: z.string().optional(),
      })
      .parse(req.body);
    return guardarTwilio({
      accountSid: b.account_sid,
      authToken: b.auth_token,
      fromSms: b.from_sms,
      fromWhatsapp: b.from_whatsapp,
      waContentSid: b.wa_content_sid,
    });
  });
  app.patch('/operador/twilio', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z.object({ activo: z.boolean() }).parse(req.body);
    return setTwilioActivo(b.activo);
  });
  app.post('/operador/twilio/prueba', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z.object({ canal: z.enum(['sms', 'whatsapp']), telefono: z.string().min(1) }).parse(req.body);
    return enviarPruebaTwilio(b.canal, b.telefono);
  });

  // Diccionario de etiquetas editable (global del operador).
  app.get('/operador/i18n', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { idioma } = z.object({ idioma: z.string() }).parse(req.query);
    return listarTraducciones(idioma);
  });
  app.put('/operador/i18n', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z.object({ idioma: z.string(), clave: z.string().min(1), valor: z.string() }).parse(req.body);
    return setTraduccion(b.idioma, b.clave, b.valor);
  });
  app.delete('/operador/i18n', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { idioma, clave } = z.object({ idioma: z.string(), clave: z.string().min(1) }).parse(req.query);
    return borrarTraduccion(idioma, clave);
  });

  // ----- Ofertas / Beneficios: flag por empresa + catálogo de plataforma -----
  app.post('/operador/empresas/:id/ofertas', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z.object({ habilitado: z.boolean() }).parse(req.body);
    return setOfertasEmpresa(id, b.habilitado);
  });

  app.get('/operador/oferentes', async (req) => {
    await sesion(req);
    return listarOferentes();
  });
  app.post('/operador/oferentes', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const b = z
      .object({ nombre: z.string().min(1), tipo: z.string().optional(), pais: z.string().nullable().optional() })
      .parse(req.body);
    return crearOferente(b);
  });
  app.put('/operador/oferentes/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z
      .object({
        nombre: z.string().optional(),
        tipo: z.string().optional(),
        pais: z.string().nullable().optional(),
        activo: z.boolean().optional(),
      })
      .parse(req.body);
    if (b.activo !== undefined) await setOferenteActivo(id, b.activo);
    return editarOferente(id, b);
  });
  app.delete('/operador/oferentes/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    return borrarOferente(id);
  });

  // §oferentes Fase 4: verificación (KYC) y habilitación de crédito del oferente.
  app.put('/operador/oferentes/:id/verificacion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z.object({ estado: z.enum(['pendiente', 'verificado', 'rechazado']), nota: z.string().nullable().optional() }).parse(req.body);
    return setVerificacionOferente(id, b.estado, b.nota ?? null);
  });
  app.put('/operador/oferentes/:id/credito', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z.object({ habilitado: z.boolean() }).parse(req.body);
    return setCreditoOferente(id, b.habilitado);
  });

  // §oferentes Fase 5: condición comercial POR DEFECTO del oferente (la heredan sus ofertas).
  app.get('/operador/oferentes/:id/comercial', async (req) => {
    await sesion(req);
    const { id } = req.params as { id: string };
    return getComercialOferente(id);
  });
  app.put('/operador/oferentes/:id/comercial', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z.object({
      modelo: z.string(),
      unidad: z.string().nullable().optional(),
      tarifa: z.number().nullable().optional(),
      porcentaje: z.number().nullable().optional(),
      monto_fijo: z.number().nullable().optional(),
      solicitud_modo: z.string().nullable().optional(),
      solicitud_valor: z.number().nullable().optional(),
      moneda: z.string().nullable().optional(),
      notas: z.string().nullable().optional(),
    }).parse(req.body);
    return setComercialOferente(id, b);
  });
  app.delete('/operador/oferentes/:id/comercial', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    return borrarComercialOferente(id);
  });

  // Datos de facturación y medio de pago del oferente (billing; solo operador, no lo ve el cliente).
  app.get('/operador/oferentes/:id/facturacion', async (req) => {
    await sesion(req);
    const { id } = req.params as { id: string };
    return getFacturacionOferente(id);
  });
  app.put('/operador/oferentes/:id/facturacion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z.object({
      razon_social: z.string().nullable().optional(),
      id_fiscal: z.string().nullable().optional(),
      domicilio: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      contacto: z.string().nullable().optional(),
      moneda: z.string().nullable().optional(),
      medio_pago: z.string().nullable().optional(),
      pago_detalle: z.string().nullable().optional(),
      notas: z.string().nullable().optional(),
    }).parse(req.body);
    return setFacturacionOferente(id, b);
  });

  const ofertaSchema = z.object({
    oferente_id: z.string().min(1),
    tipo: z.string().optional(),
    titulo: z.string().min(1),
    descripcion: z.string().nullable().optional(),
    cta_texto: z.string().nullable().optional(),
    cta_url: z.string().nullable().optional(),
    pais: z.string().nullable().optional(),
    requiere_consentimiento: z.boolean().optional(),
    vigente_desde: z.string().nullable().optional(),
    vigente_hasta: z.string().nullable().optional(),
    orden: z.number().optional(),
    salario_min: z.number().nullable().optional(),
    salario_max: z.number().nullable().optional(),
  });

  app.get('/operador/ofertas', async (req) => {
    await sesion(req);
    return listarOfertasAdmin();
  });
  app.post('/operador/ofertas', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const b = ofertaSchema.parse(req.body);
    return crearOferta(b);
  });
  app.put('/operador/ofertas/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = ofertaSchema.partial().extend({ activo: z.boolean().optional() }).parse(req.body);
    if (b.activo !== undefined) await setOfertaActiva(id, b.activo);
    return editarOferta(id, b);
  });
  app.delete('/operador/ofertas/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    return borrarOferta(id);
  });

  // §oferentes Fase 4: revisión de ofertas enviadas por el oferente (en_revision).
  app.post('/operador/ofertas/:id/aprobar', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    return aprobarOferta(id);
  });
  app.post('/operador/ofertas/:id/rechazar', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z.object({ nota: z.string().min(1) }).parse(req.body);
    return rechazarOferta(id, b.nota);
  });

  // §oferentes Fase 5: eventos comerciales (ventas/préstamos que carga el oferente).
  app.get('/operador/eventos-comerciales', async (req) => {
    await sesion(req);
    const q = z.object({ pendientes: z.string().optional() }).parse(req.query);
    return listarEventosComerciales(q.pendientes !== '0');
  });
  app.post('/operador/eventos-comerciales/:id/confirmar', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    return confirmarEvento(id);
  });
  app.post('/operador/eventos-comerciales/:id/rechazar', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z.object({ nota: z.string().min(1) }).parse(req.body);
    return rechazarEvento(id, b.nota);
  });

  // §oferentes Fase 5: resumen (estimado) de lo facturable por oferente en un período.
  app.get('/operador/facturacion-oferentes', async (req) => {
    await sesion(req);
    const q = z.object({ periodo: z.string().optional() }).parse(req.query);
    return resumenFacturacionOferentes(q.periodo);
  });

  const imagenOfertaBody = z.object({
    base64: z.string().min(1),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
  });
  app.put('/operador/ofertas/:id/imagen', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = imagenOfertaBody.parse(req.body);
    return guardarImagenOferta(id, b.base64, b.mime);
  });
  app.delete('/operador/ofertas/:id/imagen', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    return borrarImagenOferta(id);
  });
  app.get('/operador/ofertas/:id/imagen', async (req, reply) => {
    await sesion(req);
    const { id } = req.params as { id: string };
    const img = await imagenOferta(id);
    if (!img) return reply.code(404).send({ error: 'Sin imagen' });
    reply.header('Content-Type', img.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    if (img.mime === 'image/svg+xml') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    return reply.send(img.buffer);
  });

  // Industrias a las que aplica una oferta (vacío = todas). Segmentación por industria.
  app.get('/operador/ofertas/:id/industrias', async (req) => {
    await sesion(req);
    const { id } = req.params as { id: string };
    return getIndustriasOferta(id);
  });
  app.put('/operador/ofertas/:id/industrias', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z.object({ industria_ids: z.array(z.string()).default([]) }).parse(req.body);
    return setIndustriasOferta(id, b.industria_ids);
  });

  // Etapa 2A: formularios del banco (para que el empleado los firme) y documentos que pide el préstamo.
  app.get('/operador/ofertas/:id/formularios', async (req) => {
    await sesion(req);
    const { id } = req.params as { id: string };
    return listarFormulariosOferta(id);
  });
  app.post('/operador/ofertas/:id/formularios', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z
      .object({
        nombre: z.string().min(1),
        archivo: z.object({ base64: z.string().min(1), mime: z.string(), nombre: z.string().optional() }),
        metodo_firma: z.enum(['autografa', 'digital', 'avanzada', 'sin_firma']).optional(),
        orden: z.number().int().optional(),
      })
      .parse(req.body);
    return agregarFormularioOferta(id, {
      nombre: b.nombre,
      base64: b.archivo.base64,
      mime: b.archivo.mime,
      archivoNombre: b.archivo.nombre,
      metodoFirma: b.metodo_firma,
      orden: b.orden,
    });
  });
  app.delete('/operador/ofertas/formularios/:fid', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { fid } = req.params as { fid: string };
    return borrarFormularioOferta(fid);
  });
  app.get('/operador/ofertas/formularios/:fid/archivo', async (req, reply) => {
    await sesion(req);
    const { fid } = req.params as { fid: string };
    const doc = await archivoFormularioOferta(fid);
    if (!doc) return reply.code(404).send({ error: 'Sin archivo' });
    reply.header('Content-Type', doc.mime);
    reply.header('Content-Disposition', 'attachment; filename="' + doc.nombre.replace(/"/g, '') + '"');
    return reply.send(doc.buffer);
  });

  app.get('/operador/ofertas/:id/requisitos', async (req) => {
    await sesion(req);
    const { id } = req.params as { id: string };
    return listarRequisitosOferta(id);
  });
  app.post('/operador/ofertas/:id/requisitos', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z.object({ nombre: z.string().min(1), orden: z.number().int().optional() }).parse(req.body);
    return agregarRequisitoOferta(id, b.nombre, b.orden);
  });
  app.delete('/operador/ofertas/requisitos/:rid', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { rid } = req.params as { rid: string };
    return borrarRequisitoOferta(rid);
  });

  // Condición comercial de la oferta (billing de oferentes; solo operador, no la ve el cliente).
  app.get('/operador/ofertas/:id/comercial', async (req) => {
    await sesion(req);
    const { id } = req.params as { id: string };
    return getCondicionComercialResuelta(id);
  });
  app.put('/operador/ofertas/:id/comercial', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    const b = z.object({
      modelo: z.string(),
      unidad: z.string().nullable().optional(),
      tarifa: z.number().nullable().optional(),
      porcentaje: z.number().nullable().optional(),
      monto_fijo: z.number().nullable().optional(),
      solicitud_modo: z.string().nullable().optional(),
      solicitud_valor: z.number().nullable().optional(),
      moneda: z.string().nullable().optional(),
      notas: z.string().nullable().optional(),
    }).parse(req.body);
    return setCondicionComercial(id, b);
  });
  app.delete('/operador/ofertas/:id/comercial', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_ofertas');
    const { id } = req.params as { id: string };
    return borrarCondicionComercial(id);
  });

  // Solicitudes de crédito (Fase 1): el operador, en nombre del prestador, las ve y resuelve.
  app.get('/operador/solicitudes-credito', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_creditos');
    return listarSolicitudesCreditoOperador();
  });
  app.put('/operador/solicitudes-credito/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_creditos');
    const { id } = req.params as { id: string };
    const b = z
      .object({
        estado: z.string(),
        nota: z.string().nullable().optional(),
        tasa_mensual: z.number().nonnegative().optional(),
        fecha_primera_cuota: z.string().optional(),
      })
      .parse(req.body);
    const condiciones =
      b.tasa_mensual != null && b.fecha_primera_cuota
        ? { tasaMensual: b.tasa_mensual, fechaPrimeraCuota: b.fecha_primera_cuota }
        : undefined;
    return resolverSolicitudCredito(id, b.estado, b.nota ?? null, condiciones);
  });
  app.get('/operador/prestamos/:id/cronograma', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_creditos');
    const { id } = req.params as { id: string };
    return verCronogramaOperador(id);
  });

  app.get('/operador/solicitudes-credito/:id/documentacion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_creditos');
    const { id } = req.params as { id: string };
    return documentacionSolicitudOperador(id);
  });
  app.get('/operador/solicitudes-credito/formularios/:iid/archivo', async (req, reply) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_creditos');
    const { iid } = req.params as { iid: string };
    const doc = await descargarFormularioInstanciaOperador(iid);
    if (!doc) return reply.code(404).send({ error: 'Sin archivo' });
    reply.header('Content-Type', doc.mime);
    reply.header('Content-Disposition', 'attachment; filename="' + doc.nombre.replace(/"/g, '') + '"');
    return reply.send(doc.buffer);
  });
  app.get('/operador/solicitudes-credito/documentos/:iid/archivo', async (req, reply) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_creditos');
    const { iid } = req.params as { iid: string };
    const doc = await descargarDocumentoInstanciaOperador(iid);
    if (!doc) return reply.code(404).send({ error: 'Sin archivo' });
    reply.header('Content-Type', doc.mime);
    reply.header('Content-Disposition', 'attachment; filename="' + doc.nombre.replace(/"/g, '') + '"');
    return reply.send(doc.buffer);
  });

  // Asistente de ayuda: explica cómo usar la consola. No accede a datos ni ejecuta acciones.
  app.post('/operador/asistente', async (req) => {
    await sesion(req); // cualquier operador autenticado puede pedir ayuda
    const b = z
      .object({
        pregunta: z.string().min(1),
        historial: z
          .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
          .optional(),
      })
      .parse(req.body);
    const respuesta = await asistirOperador(b.pregunta, b.historial ?? []);
    return { respuesta };
  });

  // ----- Auditoría de plataforma (ingresos, OTP, recupero, etc.) -----
  app.get('/operador/auditoria', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'ver_auditoria');
    const q = z
      .object({
        q: z.string().optional(),
        tipo: z.enum(['ingresos', 'todo']).optional(),
        desde: z.string().optional(),
        hasta: z.string().optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      })
      .parse(req.query);
    return { eventos: await listarAuditoriaOperador(q) };
  });

  // ----- Firma: catálogo de proveedores de firma avanzada por país -----
  app.get('/operador/firma-proveedores', async (req) => {
    await sesion(req);
    return listarFirmaProveedores();
  });
  const firmaProvSchema = z.object({
    pais: z.string().min(2),
    nombre: z.string().min(1),
    sitio_url: z.string().nullable().optional(),
    orden: z.number().optional(),
  });
  app.post('/operador/firma-proveedores', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_firma');
    const b = firmaProvSchema.parse(req.body);
    return crearFirmaProveedor(b);
  });
  app.put('/operador/firma-proveedores/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_firma');
    const { id } = req.params as { id: string };
    const b = z
      .object({
        pais: z.string().min(2).optional(),
        nombre: z.string().min(1).optional(),
        sitio_url: z.string().nullable().optional(),
        orden: z.number().optional(),
        activo: z.boolean().optional(),
        integrado: z.boolean().optional(),
      })
      .parse(req.body);
    if (b.activo !== undefined) await setFirmaProveedorActivo(id, b.activo);
    if (b.integrado !== undefined) await setFirmaProveedorIntegrado(id, b.integrado);
    return editarFirmaProveedor(id, b);
  });
  app.delete('/operador/firma-proveedores/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_firma');
    const { id } = req.params as { id: string };
    return borrarFirmaProveedor(id);
  });

  // ----- Industrias / rubros de empresa (catálogo de plataforma) -----
  app.get('/operador/industrias', async (req) => {
    await sesion(req);
    return listarIndustrias();
  });
  app.post('/operador/industrias', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_industrias');
    const b = z.object({ nombre: z.string().min(1), orden: z.number().optional() }).parse(req.body);
    return crearIndustria(b);
  });
  app.put('/operador/industrias/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_industrias');
    const { id } = req.params as { id: string };
    const b = z
      .object({ nombre: z.string().optional(), orden: z.number().optional(), activo: z.boolean().optional() })
      .parse(req.body);
    if (b.activo !== undefined) await setIndustriaActiva(id, b.activo);
    return editarIndustria(id, b);
  });
  app.delete('/operador/industrias/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_industrias');
    const { id } = req.params as { id: string };
    return borrarIndustria(id);
  });
}
