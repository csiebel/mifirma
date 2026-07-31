import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { HttpError } from '../http/errors';

// Sesión de OPERADOR: JWT propio, separado del de los clientes. Se firma con
// OPERADOR_JWT_SECRET (o, si no está, AUTH_DEV_SECRET para desarrollo). El token
// lleva el id del operador, si es superadmin y sus capacidades.
export interface SesionOperador {
  operadorId: string;
  usuario: string;
  esSuperadmin: boolean;
  capacidades: string[];
}

function secreto(): Uint8Array {
  const s = process.env.OPERADOR_JWT_SECRET || process.env.AUTH_DEV_SECRET;
  if (!s) {
    throw new HttpError(503, 'Falta OPERADOR_JWT_SECRET (o AUTH_DEV_SECRET) para firmar la sesión de operador.');
  }
  return new TextEncoder().encode(s);
}

export async function emitirTokenOperador(s: SesionOperador): Promise<string> {
  return new SignJWT({ usuario: s.usuario, sa: s.esSuperadmin, caps: s.capacidades })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(s.operadorId)
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(secreto());
}

export async function verificarTokenOperador(authHeader?: string): Promise<SesionOperador> {
  if (!authHeader?.startsWith('Bearer ')) throw new HttpError(401, 'Falta el token de operador.');
  const token = authHeader.slice('Bearer '.length);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secreto()));
  } catch {
    throw new HttpError(401, 'Sesión de operador inválida o expirada.');
  }
  const operadorId = payload.sub;
  if (!operadorId) throw new HttpError(401, 'Token de operador sin sujeto.');
  return {
    operadorId,
    usuario: typeof payload.usuario === 'string' ? payload.usuario : '',
    esSuperadmin: payload.sa === true,
    capacidades: Array.isArray(payload.caps) ? (payload.caps as string[]) : [],
  };
}
