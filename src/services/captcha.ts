import { HttpError } from '../http/errors';

/**
 * El cartelito de «confirmá que no sos un robot», con Turnstile de Cloudflare.
 *
 * ═══ QUÉ PROTEGE, Y QUÉ NO ═══
 *
 * Protege los dos formularios PÚBLICOS que MANDAN UN CORREO: el alta y el
 * recupero de contraseña. Ésos son los que un programa puede apretar diez mil
 * veces, y cada golpe sale de la cuota de envíos —compartida con payroll—.
 *
 * ⚠ NO protege el login. Ahí el ataque es adivinar una contraseña, y contra eso
 * el cerco es el tope por IP, que desde `e127559` funciona de verdad por primera
 * vez. Ponerle un cartelito al login sería fricción diaria para todos los que
 * entran bien, a cambio de nada.
 *
 * ═══ POR QUÉ TURNSTILE Y NO OTRO ═══
 *
 * Porque el dominio ya está en Cloudflare, es gratis, no agrega dependencias
 * —se verifica con un `fetch`— y en el caso normal no le pide nada al usuario:
 * resuelve solo y no hay semáforos que marcar.
 *
 * ═══ CUÁNDO ESTÁ ENCENDIDO ═══
 *
 * Cuando existe `TURNSTILE_SECRET`. Sin ella, la verificación se saltea — que es
 * lo que hace falta en desarrollo, donde no hay Cloudflare adelante.
 *
 * ⚠ Y para que ese «se saltea» no se convierta en un agujero silencioso en
 * producción, `auth/validar_secretos.ts` NO DEJA ARRANCAR sin la clave cuando
 * `APP_BASE_URL` no es localhost. El apagado tiene que ser una decisión de
 * desarrollo, no un olvido de configuración: es la misma lección que dejó
 * `/auth/login-dev`, sólo que del lado contrario.
 *
 * Para probarlo de punta a punta sin sacar claves de ningún lado, Cloudflare
 * publica un par de prueba que siempre da por buena la verificación:
 *
 *   TURNSTILE_SITE_KEY=1x00000000000000000000AA
 *   TURNSTILE_SECRET=1x0000000000000000000000000000000AA
 */

const URL_VERIFICACION = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Milisegundos antes de rendirse. Cloudflare responde en decenas de ms. */
const TIMEOUT_MS = 5_000;

/** La clave pública, para dibujar el cartelito. Null = apagado. */
export function claveDelSitio(): string | null {
  const s = process.env.TURNSTILE_SITE_KEY;
  return s && s.trim() ? s.trim() : null;
}

/** ¿Hay que verificar? Lo decide el SECRETO, no la clave pública. */
export function captchaEncendido(): boolean {
  const s = process.env.TURNSTILE_SECRET;
  return !!(s && s.trim());
}

/**
 * Verifica el token que mandó el navegador. Tira `HttpError` si no sirve.
 *
 * ⚠ Si Cloudflare no contesta —se cayó, o el servidor se quedó sin salida— la
 * verificación FALLA, no pasa de largo. Es la decisión incómoda y es la
 * correcta: un cartelito que se abre solo cuando el guardia no está no es un
 * cartelito. El costo, dicho para que no sorprenda: una caída de Cloudflare
 * deja el alta y el recupero fuera de servicio, con un mensaje que lo explica.
 */
export async function verificarCaptcha(token: string | null | undefined, ip?: string): Promise<void> {
  if (!captchaEncendido()) return;

  const t = (token ?? '').trim();
  if (!t) throw new HttpError(400, 'Falta la comprobación de que no sos un robot. Recargá la página e intentá de nuevo.');

  const cuerpo = new URLSearchParams();
  cuerpo.set('secret', process.env.TURNSTILE_SECRET!.trim());
  cuerpo.set('response', t);
  // La IP es la real desde el arreglo de `server.ts` del 10/8: antes de eso la
  // elegía quien llamaba, y mandársela a Cloudflare habría sido mentirle.
  if (ip) cuerpo.set('remoteip', ip);

  let datos: { success?: boolean; 'error-codes'?: string[] };
  try {
    const r = await fetch(URL_VERIFICACION, {
      method: 'POST',
      body: cuerpo,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    datos = (await r.json()) as typeof datos;
  } catch (e) {
    console.warn('[captcha] no se pudo verificar con Cloudflare -', e instanceof Error ? e.message : e);
    throw new HttpError(503, 'No pudimos completar la comprobación de seguridad. Probá de nuevo en un momento.');
  }

  if (!datos.success) {
    // Los códigos van al log del servidor y no a la respuesta: al usuario no le
    // sirven, y a quien esté probando el formulario le dirían qué ajustar.
    console.warn('[captcha] rechazado -', (datos['error-codes'] ?? []).join(', ') || 'sin código');
    throw new HttpError(400, 'La comprobación de seguridad no salió bien. Recargá la página e intentá de nuevo.');
  }
}
