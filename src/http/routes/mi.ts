import type { FastifyInstance } from 'fastify';
import { withUsuario } from '../../auth/authz';
import { saldoLicencias, listarAusencias } from '../../services/licencias';
import { z } from 'zod';
import { listarComunicadosPublicados } from '../../services/comunicados';
import { crearSolicitud, listarMisSolicitudes } from '../../services/solicitudes_licencia';
import { listarConceptosActivos } from '../../services/conceptos_ausencia';
import { registrarSuscripcion, borrarSuscripcion, clavePublica } from '../../services/push';
import { listarOfertasEmpleado, setConsentimiento, imagenOfertaEmpleado } from '../../services/ofertas';
import { registrarInteraccion } from '../../services/eventos_comercial';
import { listarBeneficiosEmpleado, imagenBeneficioEmpleado, crearSolicitudBeneficio } from '../../services/beneficios';
import { fotoMiPersona } from '../../services/empleados';
import { firmarRecibo, obtenerFirmaEmpleado, guardarFirmaEmpleado } from '../../services/firma';
import { miMedioPago } from '../../services/medio_pago';
import { solicitarCredito, listarMisCreditos, cancelarSolicitudCredito, verCronograma } from '../../services/credito';
import { misFacturas, miMontoPropuesto, registrarMiFactura, miArchivoDeFactura } from '../../services/facturas';
import { misDocumentos, subirMiDocumento, descargarMiDocumento } from '../../services/rrhh';
import { listarTiposDocumento } from '../../services/tipos_documento';
import {
  requisitosDeSolicitud,
  descargarFormularioBlanco,
  subirFormularioFirmado,
  firmarFormularioDigital,
  aportarDocumento,
  aportarDocumentoDesdeLegajo,
  aportarReciboDeSueldo,
  enviarSolicitudCredito,
  descargarFormularioInstancia,
  descargarDocumentoInstancia,
} from '../../services/solicitud_docs';

// Endpoints "self-service" para la app del empleado. Resuelven la propia
// relación laboral a partir de la identidad del usuario logueado, de modo que
// el empleado no necesita conocer su relacion_id. RLS (empresa + alcance) sigue
// aplicando en todas las consultas: nadie ve más de lo suyo.
export function registrarRutasMi(app: FastifyInstance) {
  // Datos del empleado logueado: persona, empresa y su relación principal.
  app.get('/mi/perfil', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return withUsuario(cuentaId, usuarioId, async (trx) => {
      const empresa = await trx
        .selectFrom('empresa')
        .select(['nombre', 'pais', 'moneda'])
        .where('id', '=', cuentaId)
        .executeTakeFirst();

      const usuario = await trx
        .selectFrom('usuario')
        .select(['persona_id'])
        .where('id', '=', usuarioId)
        .executeTakeFirst();

      // Un usuario sin persona asociada (p. ej. un admin que no es empleado) no
      // tiene legajo propio: la app lo trata como "no empleado".
      if (!usuario?.persona_id) {
        return { es_empleado: false, empresa: empresa ?? null };
      }

      const persona = await trx
        .selectFrom('persona')
        .select(['nombre', 'documento', 'email', 'celular'])
        .where('id', '=', usuario.persona_id)
        .executeTakeFirst();

      const relaciones = await trx
        .selectFrom('relacion_laboral as rl')
        .innerJoin('establecimiento as e', 'e.id', 'rl.establecimiento_id')
        .leftJoin('relacion_laboral_version as v', (j) =>
          j.onRef('v.relacion_id', '=', 'rl.id').on('v.vigente_hasta', 'is', null),
        )
        .leftJoin('cargo as c', 'c.id', 'v.cargo_id')
        .select([
          'rl.id as relacion_id',
          'rl.fecha_ingreso as fecha_ingreso',
          'e.nombre as establecimiento',
          'c.nombre as cargo',
        ])
        .where('rl.persona_id', '=', usuario.persona_id)
        .where('rl.fecha_egreso', 'is', null)
        .orderBy('rl.fecha_ingreso', 'desc')
        .execute();

      return {
        es_empleado: relaciones.length > 0,
        nombre: persona?.nombre ?? null,
        documento: persona?.documento ?? null,
        email: persona?.email ?? null,
        celular: persona?.celular ?? null,
        empresa: empresa ?? null,
        relacion_principal: relaciones[0] ?? null,
        relaciones,
      };
    });
  });

  // Recibos del empleado, de todos sus períodos, más nuevo primero.
  app.get('/mi/recibos', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return withUsuario(cuentaId, usuarioId, async (trx) => {
      const empresa = await trx
        .selectFrom('empresa')
        .select(['firma_modalidad'])
        .where('id', '=', cuentaId)
        .executeTakeFirst();
      const firma_modalidad = empresa?.firma_modalidad || 'simple';
      const usuario = await trx
        .selectFrom('usuario')
        .select(['persona_id'])
        .where('id', '=', usuarioId)
        .executeTakeFirst();
      if (!usuario?.persona_id) return { recibos: [], firma_modalidad };

      const recibos = await trx
        .selectFrom('recibo as r')
        .innerJoin('corrida_liquidacion as c', 'c.id', 'r.corrida_id')
        .innerJoin('relacion_laboral as rl', 'rl.id', 'r.relacion_id')
        .leftJoin('recibo_firma as rf', 'rf.recibo_id', 'r.id')
        .select([
          'r.id as id',
          'r.relacion_id as relacion_id',
          'c.periodo as periodo',
          'r.neto as neto',
          'r.moneda as moneda',
          'rf.firmado_at as firmado_at',
        ])
        .where('rl.persona_id', '=', usuario.persona_id)
        .orderBy('c.periodo', 'desc')
        .execute();

      return { recibos, firma_modalidad };
    });
  });

  // Saldo de licencia del año en curso + ausencias del empleado.
  app.get('/mi/licencias', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;

    const relacionId = await withUsuario(cuentaId, usuarioId, async (trx) => {
      const usuario = await trx
        .selectFrom('usuario')
        .select(['persona_id'])
        .where('id', '=', usuarioId)
        .executeTakeFirst();
      if (!usuario?.persona_id) return null;
      const rel = await trx
        .selectFrom('relacion_laboral')
        .select(['id'])
        .where('persona_id', '=', usuario.persona_id)
        .where('fecha_egreso', 'is', null)
        .orderBy('fecha_ingreso', 'desc')
        .executeTakeFirst();
      return rel?.id ?? null;
    });

    if (!relacionId) return { saldo: null, ausencias: [] };

    const anio = new Date().getFullYear();
    let saldo: Awaited<ReturnType<typeof saldoLicencias>> | null = null;
    try {
      saldo = await saldoLicencias(cuentaId, usuarioId, relacionId, anio);
    } catch {
      // El paquete del país puede no tener todavía definidos los días de
      // licencia por antigüedad: en ese caso devolvemos saldo nulo, no un error.
      saldo = null;
    }

    const aus = await listarAusencias(cuentaId, usuarioId, relacionId);
    return { saldo, ausencias: aus.ausencias };
  });

  // Novedades publicadas por RRHH, visibles para el empleado. limite opcional
  // (p. ej. ?limite=1 para mostrar la última en la pantalla de Inicio).
  app.get('/mi/novedades', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const q = req.query as { limite?: string };
    const n = q?.limite ? Number(q.limite) : undefined;
    return listarComunicadosPublicados(cuentaId, usuarioId, Number.isFinite(n as number) ? n : undefined);
  });

  // Certificaciones y estudios del empleado (los de su propia persona).
  app.get('/mi/documentos', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return misDocumentos(cuentaId, usuarioId);
  });

  app.get('/mi/documentos/tipos', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return listarTiposDocumento(cuentaId, usuarioId, true);
  });

  app.post('/mi/documentos', async (req) => {
    const b = z
      .object({
        tipo_documento_id: z.string().uuid().optional(),
        tipo: z.string().min(1).optional(),
        archivo: z.object({ base64: z.string().min(1), mime: z.string(), nombre: z.string().optional() }),
        vencimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.body);
    const { cuentaId, usuarioId } = req.identidad;
    return subirMiDocumento(cuentaId, usuarioId, {
      tipoDocumentoId: b.tipo_documento_id,
      tipo: b.tipo,
      archivo: b.archivo,
      vencimiento: b.vencimiento,
    });
  });

  app.get('/mi/documentos/:id/archivo', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, usuarioId } = req.identidad;
    const doc = await descargarMiDocumento(cuentaId, usuarioId, id);
    if (!doc) return reply.code(404).send({ error: 'Sin archivo' });
    reply.header('Content-Type', doc.mime);
    reply.header('Content-Disposition', 'attachment; filename="' + doc.nombre.replace(/"/g, '') + '"');
    return reply.send(doc.buffer);
  });

  app.get('/mi/certificaciones', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return withUsuario(cuentaId, usuarioId, async (trx) => {
      const usuario = await trx
        .selectFrom('usuario')
        .select(['persona_id'])
        .where('id', '=', usuarioId)
        .executeTakeFirst();
      if (!usuario?.persona_id) return { certificaciones: [] };
      const certificaciones = await trx
        .selectFrom('estudio_cert')
        .select(['id', 'titulo', 'institucion', 'vencimiento'])
        .where('persona_id', '=', usuario.persona_id)
        .orderBy('vencimiento', 'asc')
        .execute();
      return { certificaciones };
    });
  });

  // Evaluaciones de desempeño recibidas por el empleado (ciclo y resultado).
  app.get('/mi/evaluaciones', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return withUsuario(cuentaId, usuarioId, async (trx) => {
      const usuario = await trx
        .selectFrom('usuario')
        .select(['persona_id'])
        .where('id', '=', usuarioId)
        .executeTakeFirst();
      if (!usuario?.persona_id) return { evaluaciones: [] };
      const evaluaciones = await trx
        .selectFrom('evaluacion as ev')
        .innerJoin('relacion_laboral as rl', 'rl.id', 'ev.relacion_id')
        .select(['ev.id as id', 'ev.ciclo as ciclo', 'ev.resultado as resultado'])
        .where('rl.persona_id', '=', usuario.persona_id)
        .orderBy('ev.created_at', 'desc')
        .execute();
      return { evaluaciones };
    });
  });

  // Capacitaciones del empleado (sus inscripciones, con el nombre del curso).
  app.get('/mi/capacitaciones', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return withUsuario(cuentaId, usuarioId, async (trx) => {
      const usuario = await trx
        .selectFrom('usuario')
        .select(['persona_id'])
        .where('id', '=', usuarioId)
        .executeTakeFirst();
      if (!usuario?.persona_id) return { capacitaciones: [] };
      const capacitaciones = await trx
        .selectFrom('inscripcion as i')
        .innerJoin('relacion_laboral as rl', 'rl.id', 'i.relacion_id')
        .innerJoin('capacitacion as c', 'c.id', 'i.capacitacion_id')
        .select(['i.id as id', 'c.nombre as nombre', 'i.estado as estado', 'i.fecha_completado as fecha_completado'])
        .where('rl.persona_id', '=', usuario.persona_id)
        .orderBy('i.created_at', 'desc')
        .execute();
      return { capacitaciones };
    });
  });

  // Solicitudes de licencia del empleado: pedir y ver las propias.
  app.post('/mi/solicitudes', async (req) => {
    const FECHA = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    const b = z
      .object({ tipo: z.string().min(1), desde: FECHA, hasta: FECHA, motivo: z.string().optional(), sin_goce: z.boolean().optional() })
      .parse(req.body);
    const { cuentaId, usuarioId } = req.identidad;
    return crearSolicitud(cuentaId, usuarioId, b);
  });

  // Conceptos de ausencia activos de la empresa (para el selector de "pedir licencia").
  app.get('/mi/conceptos-ausencia', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return listarConceptosActivos(cuentaId, usuarioId);
  });

  app.get('/mi/solicitudes', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return listarMisSolicitudes(cuentaId, usuarioId);
  });

  // Notificaciones push: clave pública para suscribirse y alta/baja por dispositivo.
  app.get('/push/clave-publica', async () => ({ clave: clavePublica() }));

  app.post('/mi/push/suscribir', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const b = (req.body || {}) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      userAgent?: string;
    };
    return registrarSuscripcion(cuentaId, usuarioId, {
      endpoint: b.endpoint,
      keys: b.keys,
      userAgent: b.userAgent,
    });
  });

  app.post('/mi/push/desuscribir', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const b = (req.body || {}) as { endpoint?: string };
    return borrarSuscripcion(cuentaId, usuarioId, b.endpoint || '');
  });

  // Ofertas / Beneficios: vidriera del empleado y su consentimiento por oferente.
  app.get('/mi/ofertas', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return listarOfertasEmpleado(cuentaId, usuarioId);
  });

  app.post('/mi/ofertas/consentimiento', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const b = z.object({ oferente_id: z.string().min(1), otorgar: z.boolean() }).parse(req.body);
    return setConsentimiento(cuentaId, usuarioId, b.oferente_id, b.otorgar);
  });

  // Medición de publicidad: el empleado registra impresión/click de una oferta (telemetría
  // best-effort, deduplicada y validada en la capa de datos).
  app.post('/mi/ofertas/:id/interaccion', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id } = req.params as { id: string };
    const b = z.object({ tipo: z.enum(['impresion', 'click']) }).parse(req.body);
    return registrarInteraccion(cuentaId, usuarioId, id, b.tipo);
  });

  app.get('/mi/ofertas/:id/imagen', async (req, reply) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id } = req.params as { id: string };
    const img = await imagenOfertaEmpleado(cuentaId, usuarioId, id);
    if (!img) return reply.code(404).send({ error: 'Sin imagen' });
    reply.header('Content-Type', img.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    if (img.mime === 'image/svg+xml') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    return reply.send(img.buffer);
  });

  // Foto de perfil del propio empleado (la carga RRHH/Admin; acá solo se lee).
  app.get('/mi/foto', async (req, reply) => {
    const { cuentaId, usuarioId } = req.identidad;
    const img = await fotoMiPersona(cuentaId, usuarioId);
    if (!img) return reply.code(404).send({ error: 'Sin foto' });
    reply.header('Content-Type', img.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(img.buffer);
  });

  // Beneficios que ofrece la empresa (activos). La gestión es de RRHH; acá solo se leen.
  app.get('/mi/beneficios', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return listarBeneficiosEmpleado(cuentaId, usuarioId);
  });
  app.get('/mi/beneficios/:id/imagen', async (req, reply) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id } = req.params as { id: string };
    const img = await imagenBeneficioEmpleado(cuentaId, usuarioId, id);
    if (!img) return reply.code(404).send({ error: 'Sin imagen' });
    reply.header('Content-Type', img.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    if (img.mime === 'image/svg+xml') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    return reply.send(img.buffer);
  });
  app.post('/mi/beneficios/:id/solicitar', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id } = req.params as { id: string };
    const nota = ((req.body ?? {}) as { nota?: string }).nota || undefined;
    return crearSolicitudBeneficio(cuentaId, usuarioId, id, nota);
  });

  app.post('/mi/recibos/:id/firmar', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id } = req.params as { id: string };
    const b = z.object({ imagen: z.string().optional() }).parse(req.body ?? {});
    return firmarRecibo(cuentaId, usuarioId, id, { ip: req.ip, userAgent: req.headers['user-agent'], imagen: b.imagen });
  });

  // Firma reutilizable del empleado (la dibuja una vez y se usa en sus documentos).
  app.get('/mi/firma', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return (await obtenerFirmaEmpleado(cuentaId, usuarioId)) ?? { imagen: null };
  });
  app.put('/mi/firma', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const b = z.object({ imagen: z.string().min(1) }).parse(req.body);
    return guardarFirmaEmpleado(cuentaId, usuarioId, b.imagen);
  });

  // Medio de pago del propio empleado (read-only; lo configura la empresa).
  app.get('/mi/medio-pago', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return miMedioPago(cuentaId, usuarioId);
  });

  // Crédito (Fase 1): solicitud del empleado sobre una oferta financiera.
  app.post('/mi/creditos/solicitar', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const b = z.object({
      oferta_id: z.string().min(1),
      monto: z.number().positive(),
      plazo_meses: z.number().int().positive(),
      consent_datos: z.boolean(),
      consent_descuento: z.boolean().optional(),
    }).parse(req.body);
    return solicitarCredito(cuentaId, usuarioId, {
      oferta_id: b.oferta_id,
      monto: b.monto,
      plazo_meses: b.plazo_meses,
      consent_datos: b.consent_datos,
      consent_descuento: b.consent_descuento ?? false,
    });
  });
  app.get('/mi/creditos', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return listarMisCreditos(cuentaId, usuarioId);
  });
  app.post('/mi/creditos/:id/cancelar', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id } = req.params as { id: string };
    return cancelarSolicitudCredito(cuentaId, usuarioId, id);
  });

  // Etapa 2B: documentación que el empleado completa para una solicitud.
  const docArchivo = z.object({ base64: z.string().min(1), mime: z.string(), nombre: z.string().optional() });
  app.get('/mi/creditos/:id/requisitos', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return requisitosDeSolicitud(cuentaId, usuarioId, id);
  });
  app.get('/mi/creditos/:id/formularios/:fid/blanco', async (req, reply) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id, fid } = z.object({ id: z.string().uuid(), fid: z.string().uuid() }).parse(req.params);
    const doc = await descargarFormularioBlanco(cuentaId, usuarioId, id, fid);
    if (!doc) return reply.code(404).send({ error: 'Sin archivo' });
    reply.header('Content-Type', doc.mime);
    reply.header('Content-Disposition', 'attachment; filename="' + doc.nombre.replace(/"/g, '') + '"');
    return reply.send(doc.buffer);
  });
  app.post('/mi/creditos/:id/formularios/:fid', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id, fid } = z.object({ id: z.string().uuid(), fid: z.string().uuid() }).parse(req.params);
    const b = z.object({ archivo: docArchivo }).parse(req.body);
    return subirFormularioFirmado(cuentaId, usuarioId, id, fid, b.archivo);
  });

  app.post('/mi/creditos/:id/formularios/:fid/firmar-digital', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id, fid } = z.object({ id: z.string().uuid(), fid: z.string().uuid() }).parse(req.params);
    const b = z.object({ imagen: z.string().optional() }).parse(req.body ?? {});
    return firmarFormularioDigital(cuentaId, usuarioId, id, fid, { ip: req.ip, userAgent: req.headers['user-agent'], imagen: b.imagen });
  });
  app.get('/mi/creditos/formularios/:iid/archivo', async (req, reply) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { iid } = z.object({ iid: z.string().uuid() }).parse(req.params);
    const doc = await descargarFormularioInstancia(cuentaId, usuarioId, iid);
    if (!doc) return reply.code(404).send({ error: 'Sin archivo' });
    reply.header('Content-Type', doc.mime);
    reply.header('Content-Disposition', 'attachment; filename="' + doc.nombre.replace(/"/g, '') + '"');
    return reply.send(doc.buffer);
  });
  app.post('/mi/creditos/:id/documentos/:rid', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id, rid } = z.object({ id: z.string().uuid(), rid: z.string().uuid() }).parse(req.params);
    const b = z.object({ archivo: docArchivo, guardar_en_legajo: z.boolean().optional() }).parse(req.body);
    return aportarDocumento(cuentaId, usuarioId, id, rid, b.archivo, b.guardar_en_legajo !== false);
  });
  app.post('/mi/creditos/:id/documentos/:rid/legajo', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id, rid } = z.object({ id: z.string().uuid(), rid: z.string().uuid() }).parse(req.params);
    const b = z.object({ legajo_doc_id: z.string().uuid() }).parse(req.body);
    return aportarDocumentoDesdeLegajo(cuentaId, usuarioId, id, rid, b.legajo_doc_id);
  });
  app.post('/mi/creditos/:id/documentos/:rid/recibo', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id, rid } = z.object({ id: z.string().uuid(), rid: z.string().uuid() }).parse(req.params);
    return aportarReciboDeSueldo(cuentaId, usuarioId, id, rid);
  });
  app.post('/mi/creditos/:id/enviar', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return enviarSolicitudCredito(cuentaId, usuarioId, id);
  });
  app.get('/mi/creditos/documentos/:iid/archivo', async (req, reply) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { iid } = z.object({ iid: z.string().uuid() }).parse(req.params);
    const doc = await descargarDocumentoInstancia(cuentaId, usuarioId, iid);
    if (!doc) return reply.code(404).send({ error: 'Sin archivo' });
    reply.header('Content-Type', doc.mime);
    reply.header('Content-Disposition', 'attachment; filename="' + doc.nombre.replace(/"/g, '') + '"');
    return reply.send(doc.buffer);
  });
  app.get('/mi/prestamos/:id/cronograma', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { id } = req.params as { id: string };
    return verCronograma(cuentaId, usuarioId, id);
  });

  // Facturas del proveedor unipersonal logueado (su propia relación).
  app.get('/mi/facturas', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return misFacturas(cuentaId, usuarioId);
  });
  app.get('/mi/facturas/monto-propuesto', async (req) => {
    const { periodo } = z.object({ periodo: z.string().regex(/^[0-9]{4}-[0-9]{2}$/) }).parse(req.query);
    const { cuentaId, usuarioId } = req.identidad;
    return miMontoPropuesto(cuentaId, usuarioId, periodo);
  });
  app.post('/mi/facturas', async (req) => {
    const b = z
      .object({
        periodo: z.string().regex(/^[0-9]{4}-[0-9]{2}$/),
        numero: z.string().min(1),
        fecha_emision: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
        monto: z.number().positive(),
        archivo: z
          .object({ base64: z.string(), mime: z.string(), nombre: z.string().optional() })
          .nullish(),
      })
      .parse(req.body);
    const { cuentaId, usuarioId } = req.identidad;
    return registrarMiFactura(cuentaId, usuarioId, {
      periodo: b.periodo,
      numero: b.numero,
      fechaEmision: b.fecha_emision,
      monto: b.monto,
      archivo: b.archivo ?? null,
    });
  });
  app.get('/mi/facturas/:id/archivo', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, usuarioId } = req.identidad;
    const a = await miArchivoDeFactura(cuentaId, usuarioId, id);
    if (!a) return reply.code(404).send({ error: 'Sin adjunto' });
    reply.header('Content-Type', a.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(a.buffer);
  });
}
