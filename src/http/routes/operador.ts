import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors';
import { clearCookieSesion } from '../cookies_sesion';
import { verificarTokenOperador, type SesionOperador } from '../../operador/sesion';
import { listarBitacoraOperador, registrarPlataforma } from '../../services/auditoria';
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
// ⚠ `CAPACIDADES` se renombra al importarlo: `services/operadores` ya exporta uno
// con ese nombre —las capacidades de los OPERADORES— y son cosas distintas. Sin
// el alias, el segundo import pisa al primero y los privilegios de la consola
// pasarían a validarse contra la lista de capacidades de los proveedores.
import {
  listarProveedores,
  guardarProveedor,
  guardarCapacidades,
  habilitarEnPais,
  setProveedorActivo,
  listarAcuerdos,
  crearAcuerdo,
  cerrarAcuerdo,
  actualizarMarca,
  imagenDeAcuerdo,
  CAPACIDADES as CAPACIDADES_PROVEEDOR,
} from '../../services/proveedores';
import { adaptadorDe } from '../../services/pagos/registro';
import { formatearMonto } from '../../services/pagos/moneda';
import {
  verIntegracionFacturacion,
  guardarIntegracionFacturacion,
  setIntegracionFacturacionActiva,
} from '../../services/integracion_facturacion';
import { asistirOperador } from '../../services/asistente_operador';
import { listarPaises, guardarPais, borrarPais } from '../../services/paises';
import { estadoDelCertificado, cargarCertificadoDelSitio } from '../../services/sello';
import {
  listarIndustriasOperador,
  crearIndustria,
  editarIndustria,
  borrarIndustria,
} from '../../services/industrias';
import {
  verCorreo,
  guardarCorreo,
  setCorreoActivo,
  enviarPrueba,
  PRESET_GMAIL,
  PRESET_ICLOUD,
} from '../../services/correo';
import {
  verTwilio,
  guardarTwilio,
  setTwilioActivo,
  enviarPruebaTwilio,
} from '../../services/twilio';
import {
  listarPlanes,
  historialPrecios,
  crearPlan,
  editarPlan,
  borrarPlan,
  setPrecio,
  bajaPrecio,
  PRESTACIONES,
} from '../../services/planes';
import {
  listarEmpresas, verEmpresa, asignarPlan, setOverridePrestacion, quitarOverridePrestacion,
} from '../../services/empresas';
import {
  consumosDelPeriodo, liquidaciones, emitirLiquidacion, pagarLiquidacion,
} from '../../services/consumos';

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
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  webhook_secret: z.string().optional(),
});

// Plan comercial de MiFirma. Los textos son por idioma: el operador escribe en
// el que quiera y la web muestra el del visitante, con castellano de respaldo.
const planSchema = z.object({
  nombre_i18n: z.record(z.string()),
  descripcion_i18n: z.record(z.string()).optional(),
  incluye_i18n: z.record(z.array(z.string())).optional(),
  activo: z.boolean().optional(),
  publico: z.boolean().optional(),
  destacado: z.boolean().optional(),
  orden: z.coerce.number().int().min(0).optional(),
  // Las prestaciones del plan (071). Si no vienen, no se tocan.
  prestaciones: z
    .array(
      z.object({
        prestacion: z.enum(PRESTACIONES),
        incluida: z.boolean(),
        cobra: z.boolean(),
        cantidad_incluida: z.coerce.number().min(0),
        margen_pct: z.coerce.number().min(0),
      }),
    )
    .optional(),
  // Con qué se firma y qué se guarda (072).
  proveedores: z
    .object({ modo: z.enum(['todos', 'lista']), ids: z.array(z.string().uuid()) })
    .optional(),
  custodia: z
    .object({
      modo: z.enum(['sin_custodia', 'con_tope', 'sin_tope']),
      tope_documentos: z.coerce.number().int().positive().nullable(),
      tope_bytes: z.coerce.number().int().positive().nullable(),
      dias_emisor: z.coerce.number().int().min(0).nullable(),
      dias_firmante: z.coerce.number().int().min(0).nullable(),
    })
    .optional(),
});

const guardarCorreoSchema = z.object({
  proveedor: z.string().optional(),
  host: z.string().min(1),
  puerto: z.coerce.number().int().min(1).max(65535),
  seguridad: z.enum(['tls', 'starttls', 'ninguna']).optional(),
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

  // ---- Planes y precios (parametría comercial global) ----
  //
  // El plan se define una vez; el precio se carga por país. Un plan sin precio
  // en un país no se ofrece ahí, y eso ES el mecanismo para abrir o cerrar un
  // país: no hay ninguna tabla de "países habilitados" que mantener en sincronía.
  app.get('/operador/planes', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    return listarPlanes(s.operadorId);
  });

  app.get('/operador/planes/:id/historial', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return historialPrecios(s.operadorId, id);
  });

  app.post('/operador/planes', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const b = planSchema.extend({ codigo: z.string().min(1).max(40) }).parse(req.body);
    return crearPlan(s.operadorId, b.codigo, b);
  });

  app.put('/operador/planes/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return editarPlan(s.operadorId, id, planSchema.parse(req.body));
  });

  app.delete('/operador/planes/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return borrarPlan(s.operadorId, id);
  });

  app.put('/operador/precios', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const b = z
      .object({
        plan_id: z.string().uuid(),
        pais: z.string().length(2),
        moneda: z.string().length(3),
        metrica: z.string().min(1),
        nivel_firma: z.string().nullable().optional(),
        proveedor_id: z.string().uuid().nullable().optional(),
        precio: z.coerce.number().min(0),
        cantidad_incluida: z.coerce.number().min(0).optional(),
      })
      .parse(req.body);
    return setPrecio(s.operadorId, b);
  });

  app.delete('/operador/precios/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return bajaPrecio(s.operadorId, id);
  });

  // ---- Países: moneda de cobro, idioma y marco legal ----
  //
  // ⚠ La moneda de cobro es el DÓLAR salvo que acá diga otra cosa. Un país sin
  // fila cobra en USD y funciona sin configurar nada; la moneda local es la
  // excepción declarada. Ver migración 032.
  //
  // Esto NO decide en qué países se ofrece el producto: eso lo sigue decidiendo
  // tener precios cargados.
  app.get('/operador/paises', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    return listarPaises();
  });

  app.put('/operador/paises', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const b = z
      .object({
        codigo: z.string().length(2),
        nombre_i18n: z.record(z.string()).optional(),
        bandera: z.string().max(8).nullable().optional(),
        idioma: z.string().min(2).max(5).optional(),
        orden: z.coerce.number().int().min(0).max(9999).optional(),
        moneda: z.string().length(3).optional(),
        admite_usd: z.boolean().optional(),
        tc_fuente: z.string().max(40).nullable().optional(),
        marco_legal: z.string().max(120).nullable().optional(),
        certificador: z.string().max(120).nullable().optional(),
        fuente: z.string().max(300).optional(),
        verificado_por: z.string().max(120).nullable().optional(),
        verificado_en: z.string().nullable().optional(),
      })
      .parse(req.body);
    return guardarPais(s.operadorId, b);
  });

  app.delete('/operador/paises/:codigo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { codigo } = z.object({ codigo: z.string().length(2) }).parse(req.params);
    return borrarPais(s.operadorId, codigo);
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
        precio_input_millon: z.coerce.number().min(0),
        precio_output_millon: z.coerce.number().min(0),
        vigente_desde: z.string().optional(),
      })
      .parse(req.body);
    return guardarTarifaIa({
      modelo: b.modelo,
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
  // ---- Empresas: qué plan tienen y qué les trae de verdad ----
  //
  // ⚠ Hasta el 7/9 esta pantalla no existía y el plan de una cuenta sólo se
  // podía ver con psql. La ruta de abajo (`/ia`) es de la 013 y apuntaba a una
  // pantalla que nunca se construyó: ahora hay una que la usa, y otra genérica
  // para las otras cinco prestaciones.
  app.get('/operador/empresas', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { q } = (req.query ?? {}) as { q?: string };
    return listarEmpresas(s.operadorId, q);
  });

  app.get('/operador/empresas/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return verEmpresa(s.operadorId, id);
  });

  app.put('/operador/empresas/:id/plan', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        plan_id: z.string().uuid(),
        medio_cobro: z.enum(['tarjeta', 'transferencia', 'debito_bancario', 'manual']).optional(),
      })
      .parse(req.body);
    return asignarPlan(s.operadorId, id, b.plan_id, b.medio_cobro);
  });

  app.put('/operador/empresas/:id/prestacion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        prestacion: z.enum(PRESTACIONES),
        // null en un campo = vuelve a heredar del plan, que no es lo mismo que
        // ponerle el mismo valor: lo heredado cambia si el plan cambia.
        incluida: z.boolean().nullable().optional(),
        cobra: z.boolean().nullable().optional(),
        cantidad_incluida: z.coerce.number().min(0).nullable().optional(),
        margen_pct: z.coerce.number().min(0).nullable().optional(),
      })
      .parse(req.body);
    return setOverridePrestacion(s.operadorId, id, b.prestacion, b);
  });

  app.delete('/operador/empresas/:id/prestacion/:prestacion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const { id, prestacion } = z
      .object({ id: z.string().uuid(), prestacion: z.enum(PRESTACIONES) })
      .parse(req.params);
    return quitarOverridePrestacion(s.operadorId, id, prestacion);
  });

  // ---- Consumos y liquidaciones ----
  app.get('/operador/consumos', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_planes');
    const q = z
      .object({ periodo: z.string().regex(/^\d{4}-\d{2}$/), cuenta_id: z.string().uuid().optional() })
      .parse(req.query ?? {});
    return consumosDelPeriodo(s.operadorId, q.periodo, q.cuenta_id);
  });

  app.get('/operador/liquidaciones', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const q = z.object({ periodo: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query ?? {});
    return liquidaciones(s.operadorId, q.periodo);
  });

  app.post('/operador/liquidaciones', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z
      .object({
        proveedor_id: z.string().uuid(),
        pais: z.string().length(2),
        periodo: z.string().regex(/^\d{4}-\d{2}$/),
        moneda: z.string().length(3),
      })
      .parse(req.body);
    return emitirLiquidacion(s.operadorId, b);
  });

  app.patch('/operador/liquidaciones/:id/pagada', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ referencia: z.string().max(200).optional() }).parse(req.body ?? {});
    return pagarLiquidacion(s.operadorId, id, b.referencia);
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
    }, s.operadorId);
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

  // ---- Empresas (cartera) ----

  // Borrar una empresa por completo. CANDADOS: solo superadmin, confirmación por
  // nombre exacto, y se niega si hay recibos emitidos (retención legal).
  // Queda auditado en los logs del servidor (quién borró qué y cuándo).

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
    const { pais } = z.object({ pais: z.string().length(2) }).parse(req.query);
    return verIntegracionFacturacion(pais.toUpperCase());
  });
  app.post('/operador/integracion-facturacion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z
      .object({
        pais: z.string().length(2),
        modo: z.enum(['api', 'archivo']),
        api_url: z.string().optional().nullable(),
        api_credencial: z.string().optional(),
        archivo_formato: z.string().optional().nullable(),
      })
      .parse(req.body);
    return guardarIntegracionFacturacion(b.pais.toUpperCase(), { modo: b.modo, apiUrl: b.api_url, apiCredencial: b.api_credencial, archivoFormato: b.archivo_formato });
  });
  app.patch('/operador/integracion-facturacion', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z.object({ pais: z.string().length(2), activo: z.boolean() }).parse(req.body);
    return setIntegracionFacturacionActiva(b.pais.toUpperCase(), b.activo);
  });

  // --- Conexión de correo saliente (plataforma) ---
  //
  // Una sola casilla manda por todas las cuentas. Sin esto no sale ni un código
  // de acceso: el segundo factor del login viaja por correo.
  //
  // La contraseña nunca vuelve por HTTP —`verCorreo` devuelve una máscara— y
  // guardar sin contraseña deja la que había. Así se puede corregir el host sin
  // tener que volver a escribir la credencial ni exponerla en la pantalla.
  app.get('/operador/correo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_mensajeria');
    const r = await verCorreo();
    return { ...r, presets: { gmail: PRESET_GMAIL, icloud: PRESET_ICLOUD } };
  });

  app.post('/operador/correo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_mensajeria');
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
    exigirCap(s, 'gestionar_mensajeria');
    const { activo } = z.object({ activo: z.boolean() }).parse(req.body);
    return setCorreoActivo(activo);
  });

  app.post('/operador/correo/prueba', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_mensajeria');
    const { para } = z.object({ para: z.string().email() }).parse(req.body);
    return enviarPrueba(para);
  });


  // --- Conexión de Twilio (SMS / WhatsApp para OTP de login) ---
  //
  // Es opcional: sin Twilio el código sale por correo igual. Con Twilio, quien
  // tenga teléfono cargado elige por dónde recibirlo — y un SMS llega donde un
  // correo a veces no.
  app.get('/operador/twilio', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_mensajeria');
    return verTwilio();
  });

  app.post('/operador/twilio', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_mensajeria');
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
    exigirCap(s, 'gestionar_mensajeria');
    const { activo } = z.object({ activo: z.boolean() }).parse(req.body);
    return setTwilioActivo(activo);
  });

  app.post('/operador/twilio/prueba', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_mensajeria');
    const b = z
      .object({ canal: z.enum(['sms', 'whatsapp']), telefono: z.string().min(6) })
      .parse(req.body);
    // La prueba del operador se anota igual que un envío real. Es el evento que
    // permite distinguir "Twilio está caído" de "el teléfono de esa persona
    // está mal cargado", que son dos reclamos que llegan idénticos.
    try {
      const r = await enviarPruebaTwilio(b.canal, b.telefono);
      await registrarPlataforma(null, {
        accion: 'sms.prueba',
        recursoTipo: 'twilio',
        despues: { canal: b.canal, destino: r.telefono },
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return r;
    } catch (err) {
      await registrarPlataforma(null, {
        accion: 'sms.prueba_fallida',
        recursoTipo: 'twilio',
        despues: {
          canal: b.canal,
          motivo: err instanceof Error ? err.message.slice(0, 300) : 'desconocido',
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      throw err;
    }
  });


  // Diccionario de etiquetas editable (global del operador).

  // ----- Ofertas / Beneficios: flag por empresa + catálogo de plataforma -----


  // §oferentes Fase 4: verificación (KYC) y habilitación de crédito del oferente.

  // §oferentes Fase 5: condición comercial POR DEFECTO del oferente (la heredan sus ofertas).

  // Datos de facturación y medio de pago del oferente (billing; solo operador, no lo ve el cliente).

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


  // §oferentes Fase 4: revisión de ofertas enviadas por el oferente (en_revision).

  // §oferentes Fase 5: eventos comerciales (ventas/préstamos que carga el oferente).

  // §oferentes Fase 5: resumen (estimado) de lo facturable por oferente en un período.

  const imagenOfertaBody = z.object({
    base64: z.string().min(1),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
  });

  // Industrias a las que aplica una oferta (vacío = todas). Segmentación por industria.

  // Etapa 2A: formularios del banco (para que el empleado los firme) y documentos que pide el préstamo.


  // Condición comercial de la oferta (billing de oferentes; solo operador, no la ve el cliente).

  // Solicitudes de crédito (Fase 1): el operador, en nombre del prestador, las ve y resuelve.


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

  // ----- Bitácora de plataforma (ingresos, OTP, recupero, cambios de config) -----
  //
  // El operador ve QUÉ se hizo en cada cuenta, jamás QUÉ decía el documento: su
  // rol no tiene GRANT sobre `archivo`, `instancia` ni `participacion`, y eso lo
  // verifica el test C4. Ver claude/infraestructura.md.
  app.get('/operador/bitacora', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'ver_auditoria');
    const q = z
      .object({
        q: z.string().optional(),
        accion: z.string().optional(),
        recursoTipo: z.string().optional(),
        desde: z.string().optional(),
        hasta: z.string().optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      })
      .parse(req.query);
    return { eventos: await listarBitacoraOperador(s.operadorId, q) };
  });

  // ----- Firma: catálogo de proveedores de firma avanzada por país -----
  const firmaProvSchema = z.object({
    pais: z.string().min(2),
    nombre: z.string().min(1),
    sitio_url: z.string().nullable().optional(),
    orden: z.number().optional(),
  });

  // ----- Industrias / rubros de empresa (catálogo de plataforma) -----
  app.get('/operador/industrias', async (req) => {
    const s = await sesion(req);
    return { industrias: await listarIndustriasOperador(s.operadorId) };
  });
  app.post('/operador/industrias', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_industrias');
    // El nombre va por idioma: el catálogo lo ve un usuario brasileño en
    // portugués sin que nadie traduzca a mano.
    const b = z
      .object({ codigo: z.string().min(1), nombres: z.record(z.string(), z.string()) })
      .parse(req.body);
    return crearIndustria(s.operadorId, b);
  });
  app.put('/operador/industrias/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_industrias');
    const { id } = req.params as { id: string };
    const b = z.object({ nombres: z.record(z.string(), z.string()) }).parse(req.body);
    return editarIndustria(s.operadorId, id, b);
  });
  app.delete('/operador/industrias/:id', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_industrias');
    const { id } = req.params as { id: string };
    return borrarIndustria(s.operadorId, id);
  });

  // ---- Proveedores de firma e identidad (catálogo global) ----
  //
  // ⚠ Va con `gestionar_pagos` y no con una capacidad nueva. Es discutible y lo
  // dejo escrito: encender un proveedor de firma tiene consecuencia económica
  // —cada firma tiene un costo por proveedor— y de cumplimiento, así que por
  // ahora lo ve quien ya administra pagos. Si mañana se separa el rol de
  // cumplimiento del de finanzas, esto pide su propia capacidad.
  app.get('/operador/proveedores', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    return listarProveedores();
  });

  // ── El certificado del sitio (077, 10/9): con qué se sella la firma simple.
  //
  // Va aparte del alta de proveedores porque no es uno: no tiene URLs ni
  // client_id, tiene un archivo y una contraseña. El P12 llega en base64 en el
  // cuerpo (son unos KB) y se abre en el servidor antes de guardarse.
  app.get('/operador/sello', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    return estadoDelCertificado(s.operadorId);
  });

  const cargarSelloSchema = z.object({
    p12_b64: z.string().min(100).max(120_000),
    password: z.string().max(200).default(''),
  });

  app.put<{ Params: { ambito: string } }>('/operador/sello/:ambito', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = cargarSelloSchema.parse(req.body);
    const r = await cargarCertificadoDelSitio(s.operadorId, req.params.ambito, b.p12_b64, b.password);
    // Queda en la bitácora de plataforma: cambiar con qué se sella es de las
    // cosas que un auditor pregunta primero. Sin el secreto, claro.
    await registrarPlataforma(null, {
      accion: 'sello.certificado_cargado',
      recursoTipo: 'proveedor_firma',
      recursoId: r.codigo,
      despues: { ambito: req.params.ambito, titular: r.titular, emisor: r.emisor, vigente_hasta: r.vigente_hasta, por: s.operadorId },
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { ok: true, ...r };
  });

  const guardarProveedorSchema = z.object({
    codigo: z.string().min(1).max(40),
    nombre_mostrado: z.string().min(1).max(120),
    entorno: z.string().min(1).max(40),
    endpoints: z.record(z.string(), z.record(z.string(), z.string())),
    parametros: z.record(z.string(), z.unknown()).default({}),
    orden_preferencia: z.number().int().min(0).max(9999).optional(),
    // ⚠ Opcional a propósito: vacío significa «no lo toques», no «borralo».
    credencial: z.string().optional(),
  });

  app.post('/operador/proveedores', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = guardarProveedorSchema.parse(req.body);
    return guardarProveedor({
      codigo: b.codigo,
      nombreMostrado: b.nombre_mostrado,
      entorno: b.entorno,
      endpoints: b.endpoints,
      parametros: b.parametros,
      ordenPreferencia: b.orden_preferencia,
      credencial: b.credencial,
      porQuien: s.operadorId,
    });
  });

  app.put('/operador/proveedores/:id/capacidades', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { id } = req.params as { id: string };
    const b = z
      .object({
        firma_hash: z.boolean().optional(),
        identifica_titular: z.boolean().optional(),
        sellado_tiempo: z.boolean().optional(),
        devuelve_documento_id: z.boolean().optional(),
        alcance_por_firma: z.boolean().optional(),
        requiere_presencia: z.boolean().optional(),
        soporta_lote: z.boolean().optional(),
        formatos_devueltos: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return guardarCapacidades(id, b, s.operadorId);
  });

  app.put('/operador/proveedores/:id/paises/:pais', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { id, pais } = req.params as { id: string; pais: string };
    const b = z
      .object({
        capacidades: z.array(z.enum(CAPACIDADES_PROVEEDOR)),
        activo: z.boolean().optional(),
        preferido: z.boolean().optional(),
        acreditado_por: z.string().max(120).nullable().optional(),
        costo_por_firma: z.string().nullable().optional(),
        moneda_costo: z.string().length(3).nullable().optional(),
      })
      .parse(req.body);
    return habilitarEnPais(id, pais, {
      capacidades: b.capacidades,
      activo: b.activo,
      preferido: b.preferido,
      acreditadoPor: b.acreditado_por,
      costoPorFirma: b.costo_por_firma,
      monedaCosto: b.moneda_costo,
    }, s.operadorId);
  });

  app.patch('/operador/proveedores/:codigo/activo', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { codigo } = req.params as { codigo: string };
    const b = z.object({ activo: z.boolean() }).parse(req.body);
    return setProveedorActivo(codigo, b.activo, s.operadorId);
  });

  // ---- Acuerdos de exclusividad por país ----
  //
  // ⚠ No hay DELETE, y es deliberado. Un acuerdo vigente tuvo consecuencias:
  // hubo documentos firmados bajo él y hubo un logo en la portada. Borrarlo
  // haría que el sistema no pudiera contestar «qué acuerdo regía en marzo». Se
  // cierra con fecha; no se borra.
  app.get('/operador/exclusividad', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    return listarAcuerdos();
  });

  app.post('/operador/exclusividad', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const b = z
      .object({
        pais: z.string().length(2),
        proveedor_id: z.string().uuid(),
        socio_nombre: z.string().min(1).max(200),
        vigente_desde: z.string().min(8),
        vigente_hasta: z.string().min(8).nullable().optional(),
        capacidades: z.array(z.enum(CAPACIDADES_PROVEEDOR)).optional(),
        logo_producto_url: z.string().max(500).nullable().optional(),
        logo_socio_url: z.string().max(500).nullable().optional(),
        autorizacion_marca: z.boolean().optional(),
        nota: z.string().max(1000).nullable().optional(),
      })
      .parse(req.body);
    return crearAcuerdo({
      pais: b.pais,
      proveedorId: b.proveedor_id,
      socioNombre: b.socio_nombre,
      vigenteDesde: b.vigente_desde,
      vigenteHasta: b.vigente_hasta,
      capacidades: b.capacidades,
      logoProductoUrl: b.logo_producto_url,
      logoSocioUrl: b.logo_socio_url,
      autorizacionMarca: b.autorizacion_marca,
      nota: b.nota,
      porQuien: s.operadorId,
    });
  });

  // La imagen guardada, para la vista previa del modal de marca. Sin la puerta
  // pública: el operador mira lo que subió antes de autorizar la marca.
  app.get('/operador/exclusividad/:id/imagen/:cual', async (req, reply) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { id, cual } = z
      .object({ id: z.string().uuid(), cual: z.enum(['socio', 'producto']) })
      .parse(req.params);
    const f = await imagenDeAcuerdo(id, cual, s.operadorId);
    if (!f) return reply.code(404).send({ error: 'sin_imagen' });
    return reply
      .header('Content-Type', f.mime)
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store')
      .send(f.img);
  });

  // La marca del país (071): logos subidos o por URL, enlaces, texto por idioma
  // y autorización. Es lo único del acuerdo que se edita en el lugar.
  app.patch('/operador/exclusividad/:id/marca', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { id } = req.params as { id: string };
    const url = z.string().max(500).nullable().optional();
    const b = z
      .object({
        logo_socio_url: url,
        logo_socio_enlace: url,
        logo_socio_img: z.string().max(600_000).nullable().optional(),
        copiar_socio: z.boolean().optional(),
        logo_producto_url: url,
        logo_producto_enlace: url,
        logo_producto_img: z.string().max(600_000).nullable().optional(),
        copiar_producto: z.boolean().optional(),
        texto_i18n: z.record(z.string().max(400)).nullable().optional(),
        autorizacion_marca: z.boolean().optional(),
      })
      .parse(req.body);
    return actualizarMarca(id, {
      logoSocioUrl: b.logo_socio_url,
      logoSocioEnlace: b.logo_socio_enlace,
      logoSocioImg: b.logo_socio_img,
      copiarSocio: b.copiar_socio,
      logoProductoUrl: b.logo_producto_url,
      logoProductoEnlace: b.logo_producto_enlace,
      logoProductoImg: b.logo_producto_img,
      copiarProducto: b.copiar_producto,
      textoI18n: b.texto_i18n,
      autorizacionMarca: b.autorizacion_marca,
    }, s.operadorId);
  });

  app.patch('/operador/exclusividad/:id/cerrar', async (req) => {
    const s = await sesion(req);
    exigirCap(s, 'gestionar_pagos');
    const { id } = req.params as { id: string };
    const b = z.object({ vigente_hasta: z.string().min(8) }).parse(req.body);
    return cerrarAcuerdo(id, b.vigente_hasta, s.operadorId);
  });
}
