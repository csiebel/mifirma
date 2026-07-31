import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emitirTokenDev } from '../../auth/identity';
import { ownerDb } from '../../db/owner';
import { provisionarEmpresa } from '../../admin/provisioning';
import { listarPlanesPublicos, suscribir } from '../../services/facturacion';
import { listarIndustrias } from '../../services/industrias';
import { HttpError } from '../errors';

// Endpoints PÚBLICOS (sin token) que consume el sitio comercial: el catálogo de
// planes y el enrolamiento self-service.
//
// Enrolamiento: la empresa se da de alta sola y elige un plan. En esta etapa NO
// se cobra. La empresa queda creada con su suscripción en estado 'prueba'; el
// cobro efectivo (PayPal) se enchufa más adelante sobre la pasarela configurada.
// Todavía sin contraseña (mismo login de desarrollo que el resto del sistema):
// se devuelve un token para entrar directo a la consola.
//
// NOTA producción: al ser público conviene sumar límite de altas por IP,
// verificación de email y captcha antes de abrirlo al mundo. No está acá.
const cuerpoEnrolar = z.object({
  empresa: z.string().min(1),
  pais: z.enum(['UY', 'PY']),
  plan_codigo: z.string().min(1),
  razon_social: z.string().optional(),
  id_fiscal: z.string().optional(),
  num_seguridad_social: z.string().optional(),
  domicilio: z.string().optional(),
  admin: z.object({
    nombre: z.string().min(1),
    email: z.string().min(1),
    documento: z.string().min(1),
    password: z.string().min(8),
  }),
});

export function registrarRutasPublico(app: FastifyInstance) {
  // Catálogo de planes activos para mostrar precios en el sitio.
  app.get('/planes-publicos', async () => {
    return await listarPlanesPublicos();
  });

  // Catálogo de rubros para el selector del alta de empresa (público, sin token).
  app.get('/industrias-publicas', async () => {
    return await listarIndustrias();
  });

  // Alta self-service con elección de plan.
  app.post('/enrolar', async (req) => {
    const b = cuerpoEnrolar.parse(req.body);
    const moneda = b.pais === 'UY' ? 'UYU' : 'PYG';

    // El plan tiene que existir y estar activo (mismo catálogo público).
    const plan = await ownerDb()
      .selectFrom('plan')
      .select(['codigo', 'activo'])
      .where('codigo', '=', b.plan_codigo)
      .executeTakeFirst();
    if (!plan || !plan.activo) throw new HttpError(400, `El plan "${b.plan_codigo}" no está disponible.`);

    // Nombre de empresa único (mismo criterio que el login por nombre).
    const existe = await ownerDb()
      .selectFrom('empresa')
      .select('id')
      .where('nombre', '=', b.empresa)
      .executeTakeFirst();
    if (existe)
      throw new HttpError(409, `Ya existe una empresa llamada "${b.empresa}". Probá entrar en lugar de crearla.`);

    const r = await provisionarEmpresa({
      nombre: b.empresa,
      pais: b.pais,
      moneda,
      razonSocial: b.razon_social,
      idFiscal: b.id_fiscal,
      numSeguridadSocial: b.num_seguridad_social,
      domicilio: b.domicilio,
      admin: b.admin,
    });

    // Suscripción en prueba: queda enganchada al plan, sin cobro todavía.
    await suscribir(r.cuentaId, b.plan_codigo, 'prueba');

    const token = await emitirTokenDev(r.cuentaId, r.adminUsuarioId);
    return {
      token,
      cuenta_id: r.cuentaId,
      usuario_id: r.adminUsuarioId,
      empresa_nombre: b.empresa,
      usuario_email: b.admin.email,
      plan_codigo: b.plan_codigo,
      estado: 'prueba',
    };
  });
}
