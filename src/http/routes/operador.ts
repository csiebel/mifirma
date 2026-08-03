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
import { adaptadorDe } from '../../services/pagos/registro';
import { formatearMonto } from '../../services/pagos/moneda';
import {
  verIntegracionFacturacion,
  guardarIntegracionFacturacion,
  setIntegracionFacturacionActiva,
} from '../../services/integracion_facturacion';
import { asistirOperador } from '../../services/asistente_operador';
import { listarPaises, guardarPais, borrarPais } from '../../services/paises';
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
} from '../../services/planes';

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
        precio: z.coerce.number().min(0),
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
}
