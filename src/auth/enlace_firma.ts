import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { HttpError } from '../http/errors';

/**
 * El enlace que recibe el firmante externo.
 *
 * ═══ NO ES UNA SESIÓN: ES UN PUNTERO A UNA FILA ═══
 *
 * El token no dice "esta persona está autenticada". Dice "quien traiga esto
 * actúa bajo el otorgamiento X". La aplicación lo pone en el GUC
 * `app.otorgamiento_id` y la política RLS hace el resto: el firmante externo ve
 * exactamente el alcance de esa fila y nada más, aunque adivine el uuid de otra
 * instancia, aunque haya un bug de ruteo, aunque exista una inyección.
 *
 * Por eso acá no hay cuenta ni roles ni capacidades. El externo no pertenece a
 * ninguna cuenta: pertenece a un otorgamiento.
 *
 * ═══ POR QUÉ NO SE GUARDA EN LA BASE ═══
 *
 * Un `token_acceso` sería una segunda fuente de verdad sobre lo mismo. Revocar
 * el acceso ya es revocar el otorgamiento —la política lo consulta en cada
 * consulta, no al abrir el enlace—, así que una tabla de tokens agregaría un
 * lugar más donde el acceso puede quedar vivo después de revocado. El token
 * firmado sólo transporta el id; la autoridad está en la fila.
 *
 * ═══ VIGENCIA ═══
 *
 * El JWT vence en 90 días, pero eso NO es la vigencia del acceso: la manda
 * `otorgamiento.vigente_hasta`. El vencimiento del token existe para que un
 * enlace filtrado en un correo reenviado deje de servir en algún momento
 * aunque el otorgamiento sea irrevocable.
 */

const TTL_ENLACE = '90d';

function secreto(): Uint8Array {
  const s = process.env.AUTH_DEV_SECRET || process.env.OPERADOR_JWT_SECRET;
  if (!s) throw new HttpError(503, 'Falta AUTH_DEV_SECRET para firmar el enlace de firma.');
  return new TextEncoder().encode(s);
}

export interface EnlaceFirma {
  otorgamientoId: string;
  identidadId: string;
  participacionId: string;
}

export async function emitirEnlaceFirma(e: EnlaceFirma): Promise<string> {
  return new SignJWT({ oid: e.otorgamientoId, pid: e.participacionId, proposito: 'firma' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(e.identidadId)
    .setIssuedAt()
    .setExpirationTime(TTL_ENLACE)
    .sign(secreto());
}

export async function verificarEnlaceFirma(token: string): Promise<EnlaceFirma> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secreto()));
  } catch {
    throw new HttpError(401, 'Este enlace no es válido o ya venció. Pedile al emisor que te lo reenvíe.');
  }
  // El propósito va dentro del token y se verifica: sin esto, un token de sesión
  // de otra parte del sistema serviría como enlace de firma.
  if (payload.proposito !== 'firma') throw new HttpError(401, 'Este enlace no sirve para firmar.');
  const oid = payload.oid, pid = payload.pid, sub = payload.sub;
  if (typeof oid !== 'string' || typeof pid !== 'string' || typeof sub !== 'string') {
    throw new HttpError(401, 'Enlace incompleto.');
  }
  return { otorgamientoId: oid, participacionId: pid, identidadId: sub };
}

/** La URL que va en el correo. El token viaja en el fragmento, no en la query:
 *  el fragmento no llega al servidor, así que no queda en logs ni se filtra por
 *  el Referer al hacer clic en cualquier enlace de la página. */
export function urlDeFirma(token: string): string {
  const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  return `${base}/firmar#t=${token}`;
}
