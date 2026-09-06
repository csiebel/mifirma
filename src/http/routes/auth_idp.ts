import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  proveedoresDeIdentidad, iniciarLogin, iniciarVinculacion,
  completarLogin, completarVinculacion, misVinculaciones, desvincular,
  type ViajeIdp,
} from '../../services/auth_idp';
import { cuentasDe, elegirCuentaLogin } from '../../services/auth_login';
import { verificarDesafioCuenta, autenticar } from '../../auth/identity';
import { setCookieSesion, setCookieCsrf, tokenDeCookie } from '../cookies_sesion';
import { HttpError } from '../errors';

/**
 * Entrar al producto con una identidad digital, y conectarla desde adentro.
 *
 * Dos superficies:
 *
 *   · `/auth/idp/*`  — antes de tener sesión. Públicas.
 *   · `/mi/idp*`     — con sesión. Self-scoped, como el resto de `/mi/*`.
 *
 * ⚠ La VUELTA no vive acá: llega por `/identidad/tuid/vuelta`, que es la única
 * dirección que tuID tiene registrada. `routes/tuid.ts` la reparte por el
 * propósito del `state` y llama a `vueltaDelIdp`, que está abajo. Ver la
 * cabecera de `services/auth_idp.ts`.
 */

// ---------------------------------------------------------------------------
// La cookie del desafío de cuenta
//
// Quien tiene acceso a más de una empresa elige a cuál entra, igual que con
// contraseña. Con contraseña el desafío viaja en la respuesta JSON y vive en
// una variable del navegador; acá el paso anterior fue una REDIRECCIÓN desde
// tuID, así que no hay JSON donde ponerlo.
//
// ⚠⚠ Y no va en la barra. Un desafío de cuenta es una credencial: quien lo
// tenga abre sesión en esas cuentas sin probar nada más. En la URL quedaría en
// el historial del navegador y se filtraría por el `Referer` — que es
// exactamente la protección que `auth/enlace_firma.ts` implementa a propósito
// para el token de firma. Va en una cookie httpOnly, acotada a `/auth` y a diez
// minutos, que es lo que dura el desafío.
// ---------------------------------------------------------------------------
const COOKIE_DESAFIO = 'idp_cuenta';

function guardarDesafio(req: FastifyRequest, reply: FastifyReply, desafio: string) {
  reply.setCookie(COOKIE_DESAFIO, desafio, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    path: '/auth',
    maxAge: 600,
  });
}

function olvidarDesafio(reply: FastifyReply) {
  reply.clearCookie(COOKIE_DESAFIO, { path: '/auth' });
}

function desafioDeCookie(req: FastifyRequest): string {
  const v = req.cookies?.[COOKIE_DESAFIO];
  if (!v) throw new HttpError(401, 'La selección expiró. Volvé a entrar.');
  return v;
}

// ---------------------------------------------------------------------------
// La vuelta, invocada desde routes/tuid.ts
// ---------------------------------------------------------------------------

/**
 * Termina el viaje del login federado y redirige a una pantalla.
 *
 * ⚠ Todas las redirecciones son RELATIVAS, por lo mismo que las de la
 * verificación del firmante (6/9): `APP_BASE_URL` es lo que se le declara a
 * tuID y tiene que ser https, pero la pantalla a la que volvemos está en el
 * mismo host que atendió este pedido — que en la Mac es http. Con una URL
 * absoluta armada desde `APP_BASE_URL`, en desarrollo el navegador se va a
 * `https://localhost` y se queda en la página anterior.
 *
 * ⚠ Y nunca se redirige con el `code` ni el `state` en la barra: lo que se
 * lleva el navegador es el resultado, no las credenciales del viaje.
 */
export async function vueltaDelIdp(
  req: FastifyRequest,
  reply: FastifyReply,
  viaje: ViajeIdp,
  code: string,
): Promise<FastifyReply> {
  if (viaje.modo === 'vincular') {
    // ⚠⚠ DOS PRUEBAS, NO UNA — y hacen falta las dos.
    //
    // El sobre firmado dice a qué identidad vincular, y con eso solo alcanzaría
    // si nadie pudiera hacerse de un sobre ajeno. Pero el sobre viaja en la
    // barra hasta el proveedor y vuelve por la barra: es exactamente el dato
    // que un `Referer` filtra. Quien consiguiera el sobre de otra persona
    // podría terminar el viaje CON SU PROPIA identidad digital y quedar
    // conectado a la cuenta ajena — o sea, quedarse con una llave para entrar.
    //
    // Por eso se exige además la sesión abierta de ESA misma persona. Ahora
    // hacen falta las dos cosas, y quien tenga la sesión ya tiene la cuenta:
    // no gana nada. La cookie llega porque es `SameSite=Lax` y esto es una
    // navegación de primer nivel por GET, que es justo lo que Lax deja pasar.
    //
    // Si la sesión venció durante el viaje, no se vincula: se lo manda a
    // entrar. Es correcto y es legible — vincular a ciegas sería peor.
    let quienEsta: string | null = null;
    try {
      const tk = tokenDeCookie(req, 'emp');
      if (tk) quienEsta = (await autenticar(`Bearer ${tk}`)).identidadId;
    } catch {
      quienEsta = null;
    }
    if (quienEsta !== viaje.identidadId) {
      return reply.redirect('/entrar?idp=sesion');
    }

    try {
      const r = await completarVinculacion(code, viaje);
      return reply.redirect(`/app?idp=${r.yaEstaba ? 'ya_estaba' : 'vinculada'}#cuenta`);
    } catch (e) {
      // El 409 —esa identidad ya está en otra cuenta, o ya tenés otra
      // conectada— no es un error técnico: es una respuesta del sistema, y va a
      // la pantalla con un motivo legible en vez de a un 500.
      if (e instanceof HttpError && e.statusCode === 409) {
        return reply.redirect('/app?idp=ocupada#cuenta');
      }
      // ⚠ Ver la nota de abajo: un viaje que ya no sirve vuelve a la pantalla,
      // no a un JSON.
      console.error('idp: falló la vinculación:', e);
      return reply.redirect('/app?idp=error#cuenta');
    }
  }

  // ⚠⚠ TODO LO QUE FALLE ACÁ VUELVE A UNA PANTALLA, NUNCA A UN JSON CRUDO.
  //
  // Esto lo abrió el navegador siguiendo una redirección del proveedor: quien
  // está del otro lado es una persona mirando, no un programa leyendo. Un
  // `{"error":"TuID rechazó el canje del código"}` en pantalla es ilegible y,
  // peor, MIENTE sobre la causa — el 6/9 tuID no había rechazado nada: el
  // código ya se había gastado en un viaje anterior que había salido bien.
  //
  // Y va a pasar de manera corriente, no sólo por un defecto: un código de
  // OAuth es de UN SOLO USO, así que recargar la página o apretar «atrás»
  // vuelve a mandar uno gastado. Eso no es un error del sistema, es alguien
  // usando el navegador.
  //
  // ⚠ Esto NO tapa nada: el motivo real queda en el log del servidor con su
  // traza, que es donde se diagnostica. Lo que cambia es lo que ve la persona.
  let r;
  try {
    r = await completarLogin(code, viaje, req.ip, req.headers['user-agent']);
  } catch (e) {
    console.error('idp: falló el login federado:', e);
    return reply.redirect('/entrar?idp=error');
  }

  if (r.tipo === 'sin_vincular') return reply.redirect('/entrar?idp=sin_vincular');
  if (r.tipo === 'sin_cuenta') return reply.redirect('/entrar?idp=sin_cuenta');

  if (r.tipo === 'elegir_cuenta') {
    guardarDesafio(req, reply, r.desafio);
    return reply.redirect('/entrar?idp=elegir');
  }

  // ⚠ Acá la cookie se pone A MANO. El hook de `preSerialization` de server.ts
  // guarda la sesión cuando un endpoint de `LOGIN_PATHS` devuelve `{ token }`
  // en un JSON — y esto no devuelve JSON, devuelve una redirección. Sin estas
  // dos líneas el login terminaría bien, el navegador saltaría a /app y ahí no
  // habría sesión: consola vacía y de vuelta a /entrar.
  setCookieSesion(req, reply, 'emp', r.token);
  setCookieCsrf(req, reply, 'emp');
  olvidarDesafio(reply);
  return reply.redirect('/app');
}

// ---------------------------------------------------------------------------
// Las rutas
// ---------------------------------------------------------------------------

export function registrarRutasAuthIdp(app: FastifyInstance) {
  /**
   * Qué proveedores ofrecer en la pantalla de entrar.
   *
   * Público y sin parámetros a propósito: es catálogo nuestro y no dice nada de
   * ninguna cuenta. Si devuelve vacío, la pantalla no dibuja ningún botón — un
   * botón que no puede funcionar es peor que ninguno.
   */
  app.get('/auth/idp/proveedores', async () => {
    return { proveedores: await proveedoresDeIdentidad() };
  });

  /** Arranca el viaje. Devuelve a dónde mandar el navegador. */
  app.post(
    '/auth/idp/iniciar',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req) => {
      const b = z.object({ proveedor: z.string().min(1).max(40) }).parse(req.body);
      return iniciarLogin(b.proveedor);
    },
  );

  /**
   * Las cuentas entre las que hay que elegir, para pintar la pantalla.
   *
   * El desafío está en la cookie y no se devuelve nunca: lo único que sale de
   * acá son los nombres, que es lo que hay que mostrar.
   */
  app.get('/auth/idp/pendiente', async (req) => {
    const { identidadId, cuentas } = await verificarDesafioCuenta(desafioDeCookie(req));
    const vigentes = await cuentasDe(identidadId);
    return {
      opciones: vigentes
        .filter((c) => cuentas.includes(c.cuentaId))
        .map((c) => ({ cuenta_id: c.cuentaId, cuenta_nombre: c.nombre })),
    };
  });

  /**
   * A qué cuenta entra.
   *
   * Reusa `elegirCuentaLogin`, el mismo del login con contraseña: revalida
   * contra la base que la membresía siga viva y emite la sesión definitiva. El
   * `token` que devuelve lo guarda en la cookie el hook de `preSerialization`,
   * porque esta ruta está en `LOGIN_PATHS`.
   */
  app.post('/auth/idp/elegir-cuenta', async (req, reply) => {
    const b = z.object({ cuenta_id: z.string().uuid() }).parse(req.body);
    const r = await elegirCuentaLogin(
      desafioDeCookie(req),
      b.cuenta_id,
      req.ip,
      req.headers['user-agent'],
    );
    olvidarDesafio(reply);
    return r;
  });

  // ---- Con sesión: mis identidades conectadas ----

  app.get('/mi/idp', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    const [proveedores, vinculadas] = await Promise.all([
      proveedoresDeIdentidad(),
      misVinculaciones(cuentaId, identidadId),
    ]);
    return { proveedores, vinculadas };
  });

  app.post('/mi/idp/vincular', async (req) => {
    const b = z.object({ proveedor: z.string().min(1).max(40) }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return iniciarVinculacion(cuentaId, identidadId, b.proveedor);
  });

  app.delete('/mi/idp/:id', async (req) => {
    const p = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return desvincular(cuentaId, identidadId, p.id);
  });
}
