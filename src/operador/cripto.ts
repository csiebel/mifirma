import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { HttpError } from '../http/errors';

// Cifrado simétrico para secretos sensibles (credenciales de pasarelas de pago).
// AES-256-GCM con una clave de 32 bytes derivada de un secreto del entorno.
// Formato almacenado: "v1:<ivHex>:<tagHex>:<cipherHex>".
function clave(): Buffer {
  const s = process.env.GATEWAY_ENC_KEY || process.env.OPERADOR_JWT_SECRET || process.env.AUTH_DEV_SECRET;
  if (!s) throw new HttpError(503, 'Falta GATEWAY_ENC_KEY (o un secreto) para cifrar credenciales.');
  return createHash('sha256').update(s).digest();
}

/**
 * Huella de la clave de cifrado: los primeros bytes de su sha256.
 *
 * Existe para responder una pregunta que costó horas: ¿el proceso que cifró y
 * el que descifra están usando la MISMA clave? Comparar huellas lo dice en un
 * segundo. No revela la clave —es un hash— pero dos procesos con la misma
 * huella tienen la misma clave.
 *
 * La trampa que la hizo necesaria: `dotenv` NO pisa las variables que ya
 * existen en el entorno. Una terminal con GATEWAY_ENC_KEY exportada de otra
 * sesión hace que el servidor use un valor y el script de línea de comandos
 * otro, con el mismo .env delante de los ojos.
 */
export function huellaClave(): string {
  try {
    return createHash('sha256').update(clave()).digest('hex').slice(0, 12);
  } catch {
    return 'sin-clave';
  }
}

export function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', clave(), iv);
  const ct = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function descifrar(blob: string | null | undefined): string {
  if (!blob) return '';
  const [v, ivh, tagh, cth] = blob.split(':');
  if (v !== 'v1' || !ivh || !tagh || !cth) return '';
  try {
    const d = createDecipheriv('aes-256-gcm', clave(), Buffer.from(ivh, 'hex'));
    d.setAuthTag(Buffer.from(tagh, 'hex'));
    return Buffer.concat([d.update(Buffer.from(cth, 'hex')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// Pista enmascarada para mostrar en la UI (sin revelar el secreto completo).
export function enmascarar(blob: string | null | undefined): string {
  const t = descifrar(blob);
  if (!t) return '';
  return t.length <= 4 ? '••••' : '••••' + t.slice(-4);
}
