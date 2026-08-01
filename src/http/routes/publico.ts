import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emitirTokenDev } from '../../auth/identity';
import { ownerDb } from '../../db/owner';
import { provisionarEmpresa } from '../../admin/provisioning';
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

  // Catálogo de rubros para el selector del alta de empresa (público, sin token).
  app.get('/industrias-publicas', async () => {
    return await listarIndustrias();
  });

  // Alta self-service con elección de plan.
}
