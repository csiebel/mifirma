import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as push from '../../services/push';

/**
 * Avisos en el teléfono (las notificaciones que aparecen aunque la aplicación
 * esté cerrada).
 *
 * Tres rutas y nada más: dar la clave pública para que el navegador se pueda
 * suscribir, guardar la suscripción, y borrarla cuando la persona apaga los
 * avisos. El envío no vive acá — lo hace `services/push.ts` desde el motor de
 * mensajes, y quién puede ver qué lo decide el RLS.
 *
 * ⚠ Las tres piden sesión: NO van a `PUBLICAS`. Una suscripción se guarda
 * contra la identidad del que la pide, nunca contra una que venga en el cuerpo.
 */
export function registrarRutasAvisos(app: FastifyInstance) {
  /**
   * La clave pública VAPID, que el navegador necesita para suscribirse. No es
   * secreta: viaja en cada suscripción y sirve para verificar que el envío lo
   * hizo quien dice. `null` significa «esto todavía no está configurado en el
   * servidor», y la pantalla lo usa para no ofrecer un botón que no funciona.
   */
  app.get('/push/clave', async () => ({ clave: push.clavePublica() }));

  /**
   * Guarda la suscripción de ESTE navegador en ESTE dispositivo.
   *
   * El `endpoint` es una dirección que fabrica el navegador (Google, Apple o
   * Mozilla, según cuál sea) y a la que después le mandamos el aviso; las dos
   * claves son las que cifran el contenido de punta a punta, así que el
   * intermediario no puede leerlo. Nada de esto identifica a la persona: la
   * identidad la pone el servidor, de la sesión.
   */
  app.post('/push/suscribir', async (req) => {
    const b = z
      .object({
        endpoint: z.string().url().max(2000),
        keys: z.object({ p256dh: z.string().max(300), auth: z.string().max(300) }),
      })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return push.registrarSuscripcion(cuentaId, identidadId, {
      endpoint: b.endpoint,
      keys: b.keys,
      // Sirve para que la persona reconozca cuál de sus dispositivos es cuando
      // haya una lista. No se usa para identificar ni para decidir nada.
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    });
  });

  /** La persona apagó los avisos en este dispositivo. */
  app.post('/push/baja', async (req) => {
    const b = z.object({ endpoint: z.string().url().max(2000) }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return push.borrarSuscripcion(cuentaId, identidadId, b.endpoint);
  });
}
