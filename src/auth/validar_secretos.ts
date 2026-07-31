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
export function validarSecretos(): void {
  const errores: string[] = [
    ...evaluarSecreto('AUTH_DEV_SECRET', process.env.AUTH_DEV_SECRET, true),
    ...evaluarSecreto('OPERADOR_JWT_SECRET', process.env.OPERADOR_JWT_SECRET, false),
    ...evaluarSecreto('ESTUDIO_JWT_SECRET', process.env.ESTUDIO_JWT_SECRET, false),
    ...evaluarSecreto('GATEWAY_ENC_KEY', process.env.GATEWAY_ENC_KEY, false),
  ];
  if (errores.length > 0) {
    console.error('[seguridad] No se puede arrancar: configuración de secretos insegura.');
    for (const e of errores) console.error(`  - ${e}`);
    console.error(
      "  Generá un secreto fuerte con:  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    );
    throw new Error('Arranque abortado: secretos inseguros. Revisá las variables de entorno.');
  }
}
