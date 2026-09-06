import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { completarVerificacion } from '../../services/tuid_identidad';
import { HttpError } from '../errors';

/**
 * Verificación de identidad del firmante externo con tuID — la VUELTA.
 *
 *   GET /identidad/tuid/vuelta → tuID trae de vuelta al firmante
 *
 * La IDA vive en `firma.ts` como `POST /firmar/identidad/iniciar`, bajo /firmar:
 * ahí llega la cookie del enlace, que está acotada a ese camino a propósito.
 * (Hasta el 6/9 la ida estaba acá y pedía el token en el cuerpo — pero la
 * pantalla se saca el token de la barra apenas entra, así que al apretar el
 * botón ya no lo tenía. La ruta pedía algo que la pantalla no podía dar.)
 *
 * Esta ruta no necesita cookie —tuID redirige el navegador y trae el `state`
 * firmado— y por eso puede vivir acá, en la URL que quedó registrada en tuID.
 *
 * ⚠ Es PÚBLICA, y tiene que serlo: el firmante externo no tiene sesión. Está en
 * `PUBLICAS` de server.ts (desde el 6/9: antes no estaba, y la vuelta habría
 * rebotado pidiendo sesión). No agregar un `preHandler` de sesión acá: dejaría
 * afuera exactamente a la gente para la que existe esto.
 */
export function registrarRutasTuid(app: FastifyInstance) {
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
