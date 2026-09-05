import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { iniciarVerificacion, completarVerificacion } from '../../services/tuid_identidad';
import { HttpError } from '../errors';

/**
 * Verificación de identidad del firmante externo con tuID.
 *
 *   1. POST /identidad/tuid/iniciar   → devuelve a dónde mandar el navegador
 *   2. GET  /identidad/tuid/vuelta    → tuID trae de vuelta al firmante
 *
 * ⚠ Las dos son PÚBLICAS, y tienen que serlo: el firmante externo no tiene
 * sesión. La autorización no la da un token de sesión sino el enlace de firma,
 * que se verifica adentro del servicio. No agregar un `preHandler` de sesión
 * acá: dejaría afuera exactamente a la gente para la que existe esto.
 */
export function registrarRutasTuid(app: FastifyInstance) {
  // ---- Ida ----
  //
  // POST y no GET aunque «sólo redirija»: el token del enlace viaja en el
  // cuerpo. En una query quedaría en los logs del servidor, en el historial del
  // navegador y en el Referer — que es justo lo que `enlace_firma.ts` evita
  // mandándolo en el fragmento de la URL.
  app.post(
    '/identidad/tuid/iniciar',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req) => {
      const b = z
        .object({
          token: z.string().min(1),
          volver_a: z.string().max(300).optional(),
        })
        .parse(req.body);
      return iniciarVerificacion(b.token, b.volver_a);
    },
  );

  // ---- Vuelta ----
  //
  // GET porque lo hace tuID redirigiendo el navegador, no nosotros.
  //
  // ⚠ El `code` llega por query y no hay forma de evitarlo: así funciona OAuth.
  // Por eso el código es de un solo uso y de vida corta, y por eso el `state`
  // vence a los cinco minutos. Lo que NO hacemos es dejarlo en la URL después:
  // se responde con una redirección limpia.
  app.get('/identidad/tuid/vuelta', async (req, reply) => {
    const q = z
      .object({
        code: z.string().min(1).optional(),
        state: z.string().min(1).optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      })
      .parse(req.query);

    const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

    // El firmante apretó «cancelar» en tuID, o tuID rechazó. No es un error
    // nuestro y no merece una pantalla de error: vuelve a firmar sin verificar.
    if (q.error) {
      return reply.redirect(`${base}/firmar?verificacion=cancelada`);
    }
    if (!q.code || !q.state) {
      throw new HttpError(400, 'Respuesta incompleta de tuID.');
    }

    try {
      const r = await completarVerificacion(q.code, q.state);
      // ⚠ Redirección sin el código ni el state en la URL. Lo que se lleva el
      // navegador es el hecho, no las credenciales del viaje.
      const destino = r.volverA && r.volverA.startsWith('/') ? r.volverA : '/firmar';
      return reply.redirect(`${base}${destino}?verificacion=ok`);
    } catch (e) {
      // El rechazo por documento que no coincide (T6) es el caso que más va a
      // pasar de verdad, y no es un error técnico: es una respuesta del sistema.
      // Va a la pantalla con un motivo legible, no a un 500.
      if (e instanceof HttpError && e.statusCode === 403) {
        return reply.redirect(`${base}/firmar?verificacion=documento_distinto`);
      }
      throw e;
    }
  });
}
