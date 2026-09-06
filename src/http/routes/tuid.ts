import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { completarVerificacion } from '../../services/tuid_identidad';
import { viajeDelState } from '../../services/auth_idp';
import { vueltaDelIdp } from './auth_idp';
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
 * ═══ ⚠⚠ POR ACÁ VUELVEN DOS VIAJES DISTINTOS (6/9) ═══
 *
 * Desde que se puede ENTRAR al producto con la identidad digital, esta misma
 * dirección recibe dos cosas: el firmante que se verifica (lo de abajo, sin
 * cambios) y la persona que entra o conecta su identidad (`services/auth_idp.ts`).
 *
 * No es por comodidad: tuID compara la `redirect_uri` CARÁCTER POR CARÁCTER
 * contra una lista corta que administran ellos, y no tiene registrada ninguna
 * dirección del login. Una dirección propia sería más prolija y no se podría
 * probar hasta que tuID la registre, que es un trámite abierto. Decisión de
 * Claudio: se reusa ésta y se reparte adentro.
 *
 * ⚠ Lo que separa los dos caminos NO es el orden de los `if`: es que cada uno
 * RECHAZA el sobre del otro. El `state` del login lleva `proposito: 'idp'` y
 * `verificarState` de `oauth.ts` sólo acepta `proposito: 'tuid'`; al revés,
 * `viajeDelState` sólo acepta 'idp' y ante cualquier otra cosa devuelve `null`.
 * Un sobre de firma no sirve para entrar, y uno de login no sirve para anclar,
 * aunque alguien los mande por la puerta equivocada a propósito.
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

    // ═══ El reparto, ANTES DE TODO LO DEMÁS ═══
    //
    // Va arriba del `if (q.error)` a propósito: si la persona aprieta
    // «cancelar» en tuID viniendo del login, mandarla a la pantalla de firma
    // sería dejarla en un documento que no estaba mirando. Quién canceló lo
    // dice el sobre, no el error.
    //
    // Debajo de esta línea, el camino del firmante queda exactamente como
    // estaba: si el sobre no es del login, `viajeDelState` devuelve `null` y no
    // se ejecuta nada de acá.
    const viajeIdp = q.state ? await viajeDelState(q.state) : null;
    if (viajeIdp) {
      if (q.error) {
        return reply.redirect(
          viajeIdp.modo === 'vincular' ? '/app?idp=cancelada#cuenta' : '/entrar?idp=cancelada',
        );
      }
      if (!q.code) throw new HttpError(400, 'Respuesta incompleta de tuID.');
      return vueltaDelIdp(req, reply, viajeIdp, q.code);
    }

    // ⚠ Las redirecciones de vuelta son RELATIVAS (6/9). `APP_BASE_URL` es lo
    // que se le declara a tuID como redirect_uri y tiene que ser https (lo exige
    // tuID); pero la pantalla a la que volvemos es la nuestra, en el mismo host
    // que atendió este pedido — que en la Mac es http. Con una URL absoluta
    // armada desde APP_BASE_URL, en desarrollo el navegador iba a https://localhost
    // y se quedaba en la página anterior.

    // El firmante apretó «cancelar» en tuID, o tuID rechazó. No es un error
    // nuestro y no merece una pantalla de error: vuelve a firmar sin verificar.
    if (q.error) {
      return reply.redirect('/firmar?verificacion=cancelada');
    }
    if (!q.code || !q.state) {
      throw new HttpError(400, 'Respuesta incompleta de tuID.');
    }

    try {
      const r = await completarVerificacion(q.code, q.state);
      // ⚠ Redirección sin el código ni el state en la URL. Lo que se lleva el
      // navegador es el hecho, no las credenciales del viaje.
      const destino = r.volverA && r.volverA.startsWith('/') ? r.volverA : '/firmar';
      return reply.redirect(`${destino}?verificacion=ok`);
    } catch (e) {
      // El rechazo por documento que no coincide (T6) es el caso que más va a
      // pasar de verdad, y no es un error técnico: es una respuesta del sistema.
      // Va a la pantalla con un motivo legible, no a un 500.
      if (e instanceof HttpError && e.statusCode === 403) {
        return reply.redirect('/firmar?verificacion=documento_distinto');
      }
      // Una cédula es una sola identidad (6/9): la cédula ya está en otra
      // cuenta. Tampoco es un error técnico: es una respuesta del sistema.
      if (e instanceof HttpError && e.statusCode === 409) {
        return reply.redirect('/firmar?verificacion=cedula_en_otra_cuenta');
      }
      throw e;
    }
  });
}
