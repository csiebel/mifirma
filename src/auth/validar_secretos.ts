import { createHash } from 'node:crypto';
// Validación de los secretos de firma/cifrado al arrancar. Convierte "confío en que el
// secreto es fuerte" en una garantía estructural: si un secreto falta, es demasiado corto
// o es un valor de ejemplo, la app NO levanta (mejor un arranque fallido y visible que
// producción firmando tokens con un secreto adivinable).
//
// AUTH_DEV_SECRET es el secreto principal: firma los tokens de empresa y es el respaldo
// de las sesiones de estudio y operador. Por eso es obligatorio y se exige que sea fuerte.

const VALORES_DEBILES = new Set([
  'dev',
  'devsecret',
  'dev-secret',
  'dev_secret',
  'secret',
  'secreto',
  'changeme',
  'change-me',
  'password',
  'passwd',
  'clave',
  'test',
  'testing',
  'admin',
  'default',
  'cambiame',
  '123456',
  '12345678',
  'secret123',
]);

const MIN_FALLA = 16; // por debajo de esto se aborta el arranque
const MIN_RECOMENDADO = 32; // por debajo de esto se advierte (ideal para HS256)

function evaluarSecreto(nombre: string, valor: string | undefined, requerido: boolean): string[] {
  const errores: string[] = [];
  if (!valor || !valor.trim()) {
    if (requerido) errores.push(`${nombre} no está configurada.`);
    return errores;
  }
  const v = valor.trim();
  if (VALORES_DEBILES.has(v.toLowerCase())) {
    errores.push(`${nombre} usa un valor de ejemplo inseguro; generá uno aleatorio.`);
  } else if (v.length < MIN_FALLA) {
    errores.push(`${nombre} es demasiado corta (${v.length} caracteres; mínimo ${MIN_FALLA}).`);
  } else if (v.length < MIN_RECOMENDADO) {
    console.warn(
      `[seguridad] ${nombre} tiene ${v.length} caracteres; se recomiendan al menos ${MIN_RECOMENDADO} para HS256.`,
    );
  }
  return errores;
}

/**
 * Valida los secretos críticos al arranque. Si alguno es inseguro, lanza y aborta el
 * proceso (Railway mostrará el error en los logs del deploy). Los que tienen respaldo en
 * AUTH_DEV_SECRET no son obligatorios, pero si están definidos también se exige que sean
 * fuertes.
 */
/**
 * Huella de la clave con la que este proceso va a cifrar y descifrar secretos.
 *
 * Se imprime al arrancar para que se pueda comparar con la del script de línea
 * de comandos. `dotenv` no pisa variables ya presentes en el entorno, así que
 * dos procesos con el mismo .env pueden terminar con claves distintas y nada
 * lo delata hasta que un secreto guardado deja de leerse.
 */
function huellaDeLaClave(): string {
  const s = process.env.GATEWAY_ENC_KEY || process.env.OPERADOR_JWT_SECRET || process.env.AUTH_DEV_SECRET;
  if (!s) return 'sin-clave';
  return createHash('sha256').update(createHash('sha256').update(s).digest()).digest('hex').slice(0, 12);
}

/**
 * ¿Esto es una instalación de verdad, o la máquina de alguien?
 *
 * Se mira `APP_BASE_URL`: en desarrollo apunta a localhost, y en Railway al
 * dominio. No se usa `NODE_ENV` porque Railway no lo fija solo, y un control de
 * seguridad que depende de una variable que nadie pone es un control apagado.
 */
function esInstalacionPublica(): boolean {
  const u = (process.env.APP_BASE_URL || '').trim();
  if (!u) return false;
  return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u);
}

export function validarSecretos(): void {
  const errores: string[] = [
    ...evaluarSecreto('AUTH_DEV_SECRET', process.env.AUTH_DEV_SECRET, true),
    ...evaluarSecreto('OPERADOR_JWT_SECRET', process.env.OPERADOR_JWT_SECRET, false),
    ...evaluarSecreto('ESTUDIO_JWT_SECRET', process.env.ESTUDIO_JWT_SECRET, false),
    ...evaluarSecreto('GATEWAY_ENC_KEY', process.env.GATEWAY_ENC_KEY, false),
  ];

  // ⚠ EL CARTELITO DE «NO SOY UN ROBOT» NO PUEDE FALTAR EN UNA INSTALACIÓN PÚBLICA.
  //
  // `services/captcha.ts` se saltea la verificación cuando no hay secreto — que es
  // lo que hace falta en la máquina de uno, sin Cloudflare adelante. Ese salteo es
  // exactamente la clase de cosa que en producción no se nota: el formulario sigue
  // andando, sólo que sin guardia, y nadie se entera hasta la factura de correos.
  //
  // Así que acá se vuelve estructural: con `APP_BASE_URL` apuntando a un dominio,
  // sin `TURNSTILE_SECRET` la app NO LEVANTA. Mismo criterio que el resto de este
  // archivo — un arranque fallido y ruidoso es mejor que un cerco silencioso.
  //
  // Las claves de prueba de Cloudflare, que siempre dan por buena la verificación,
  // sirven para desarrollo y las publica ella misma:
  //   TURNSTILE_SITE_KEY=1x00000000000000000000AA
  //   TURNSTILE_SECRET=1x0000000000000000000000000000000AA
  if (esInstalacionPublica()) {
    if (!process.env.TURNSTILE_SECRET?.trim()) {
      errores.push('TURNSTILE_SECRET no está configurada, y APP_BASE_URL no es localhost.');
    }
    if (!process.env.TURNSTILE_SITE_KEY?.trim()) {
      errores.push('TURNSTILE_SITE_KEY no está configurada, y APP_BASE_URL no es localhost.');
    }
  }
  if (errores.length > 0) {
    console.error('[seguridad] No se puede arrancar: configuración de secretos insegura.');
    for (const e of errores) console.error(`  - ${e}`);
    console.error(
      "  Generá un secreto fuerte con:  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    );
    throw new Error('Arranque abortado: secretos inseguros. Revisá las variables de entorno.');
  }

  // Con qué clave va a cifrar y descifrar ESTE proceso. Comparable con la que
  // muestra `npm run correo -- ver`: si no coinciden, los secretos guardados por
  // uno no los puede leer el otro, y el síntoma es "la contraseña no está
  // cargada" sobre una contraseña que sí está.
  const cual = process.env.GATEWAY_ENC_KEY
    ? 'GATEWAY_ENC_KEY'
    : process.env.OPERADOR_JWT_SECRET
      ? 'OPERADOR_JWT_SECRET'
      : 'AUTH_DEV_SECRET';
  console.log(`[seguridad] Clave de cifrado de secretos: ${cual}, huella ${huellaDeLaClave()}`);
}
