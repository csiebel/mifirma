import { jwtVerify, createRemoteJWKSet, SignJWT, type JWTPayload } from 'jose';
import { HttpError } from '../http/errors';
import type { NivelGarantia } from '../db/contexto';

/**
 * Emisión y verificación de tokens.
 *
 * ⚠ El token lleva los ANCLAJES PROBADOS y el NIVEL DE GARANTÍA de la sesión, y
 * eso los vuelve datos de seguridad de primer orden: son lo que decide si un
 * firmante puede abrir un documento que exige nivel sustancial. Van firmados
 * dentro del JWT y NUNCA se leen de un header, un query param o el cuerpo de la
 * request. Si algún día alguien agrega `?nivel=alto`, la firma avanzada deja de
 * significar nada.
 *
 * El nivel es de la SESIÓN, no de la identidad: la misma persona entra hoy con
 * contraseña (bajo) y mañana con certificado (alto). Por eso viaja en el token
 * y no se lee de una tabla.
 */

export interface Identidad {
  cuentaId: string;
  identidadId: string;
  /** Ids de `anclaje_identidad` efectivamente probados en esta sesión. */
  anclajesProbados: string[];
  nivelGarantia: NivelGarantia;
  idioma?: string;
}

const jwks = process.env.AUTH_JWKS_URL
  ? createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URL))
  : null;

// DEV: secreto local para emitir/verificar JWT sin IdP.
// En producción se usa AUTH_JWKS_URL; nunca AUTH_DEV_SECRET.
const devSecret = process.env.AUTH_DEV_SECRET
  ? new TextEncoder().encode(process.env.AUTH_DEV_SECRET)
  : null;

function secreto(): Uint8Array {
  if (!devSecret) {
    throw new HttpError(500, 'AUTH_DEV_SECRET no configurado: el login local está deshabilitado.');
  }
  return devSecret;
}

export interface DatosDeSesion {
  anclajesProbados?: string[];
  nivelGarantia?: NivelGarantia;
  idioma?: string;
}

/** Sesión de trabajo: identidad + cuenta activa + lo que probó al entrar. */
export async function emitirSesion(
  cuentaId: string,
  identidadId: string,
  datos: DatosDeSesion = {},
): Promise<string> {
  return new SignJWT({
    cuenta_id: cuentaId,
    anc: datos.anclajesProbados ?? [],
    niv: datos.nivelGarantia ?? 'bajo',
    lang: datos.idioma,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(identidadId)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secreto());
}

export async function autenticar(authHeader?: string): Promise<Identidad> {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Falta el token Bearer');
  }
  const token = authHeader.slice('Bearer '.length);
  let payload: JWTPayload;
  if (devSecret) {
    ({ payload } = await jwtVerify(token, devSecret));
  } else if (jwks) {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: process.env.AUTH_ISSUER,
      audience: process.env.AUTH_AUDIENCE,
    }));
  } else {
    throw new HttpError(500, 'No hay método de autenticación configurado (AUTH_JWKS_URL o AUTH_DEV_SECRET)');
  }

  const cuentaId = typeof payload.cuenta_id === 'string' ? payload.cuenta_id : undefined;
  const identidadId = payload.sub;
  if (!cuentaId || !identidadId) {
    throw new HttpError(401, 'El token no trae cuenta_id / sub');
  }

  return {
    cuentaId,
    identidadId,
    anclajesProbados: Array.isArray(payload.anc)
      ? (payload.anc as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    nivelGarantia: esNivel(payload.niv) ? payload.niv : 'bajo',
    idioma: typeof payload.lang === 'string' ? payload.lang : undefined,
  };
}

function esNivel(v: unknown): v is NivelGarantia {
  return v === 'ninguno' || v === 'bajo' || v === 'sustancial' || v === 'alto';
}

// ---------------------------------------------------------------------------
// Desafíos intermedios del login
//
// Ninguno lleva `sub`, así que `autenticar` los rechaza: un desafío no sirve
// como token de sesión aunque alguien lo intente usar en el header.
// ---------------------------------------------------------------------------

/**
 * Paso contraseña → OTP. Prueba que la contraseña ya se validó.
 *
 * NO lleva cuenta_id, y eso es el cambio de fondo respecto de Payroll NG: en
 * MiFirma la identidad es global y precede a la cuenta. Se prueba quién sos
 * primero; a qué cuenta entrás se decide después.
 */
export async function firmarDesafioOtp(identidadId: string, deviceId: string): Promise<string> {
  return new SignJWT({ iid: identidadId, did: deviceId, purpose: 'otp' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secreto());
}

export async function verificarDesafioOtp(
  token: string,
): Promise<{ identidadId: string; deviceId: string }> {
  const payload = await verificar(token, 'otp', 'El desafío de verificación venció o no es válido. Iniciá sesión de nuevo.');
  const identidadId = typeof payload.iid === 'string' ? payload.iid : undefined;
  const deviceId = typeof payload.did === 'string' ? payload.did : undefined;
  if (!identidadId || !deviceId) throw new HttpError(401, 'Desafío incompleto.');
  return { identidadId, deviceId };
}

/**
 * Paso identidad probada → elección de cuenta.
 *
 * Lleva firmado lo que la persona probó en esta sesión (anclajes y nivel) para
 * que no se pierda entre un paso y el otro, y las cuentas elegibles, para que
 * el cliente no pueda pedir entrar a una que no le corresponde.
 */
export async function firmarDesafioCuenta(
  identidadId: string,
  cuentas: string[],
  datos: DatosDeSesion,
): Promise<string> {
  return new SignJWT({
    iid: identidadId,
    cuentas,
    anc: datos.anclajesProbados ?? [],
    niv: datos.nivelGarantia ?? 'bajo',
    lang: datos.idioma,
    purpose: 'elegir_cuenta',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secreto());
}

export async function verificarDesafioCuenta(
  token: string,
): Promise<{ identidadId: string; cuentas: string[]; datos: DatosDeSesion }> {
  const payload = await verificar(token, 'elegir_cuenta', 'La selección expiró. Iniciá sesión de nuevo.');
  const identidadId = typeof payload.iid === 'string' ? payload.iid : undefined;
  const cuentas = Array.isArray(payload.cuentas)
    ? (payload.cuentas as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (!identidadId || cuentas.length === 0) throw new HttpError(401, 'Desafío incompleto.');
  return {
    identidadId,
    cuentas,
    datos: {
      anclajesProbados: Array.isArray(payload.anc)
        ? (payload.anc as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
      nivelGarantia: esNivel(payload.niv) ? payload.niv : 'bajo',
      idioma: typeof payload.lang === 'string' ? payload.lang : undefined,
    },
  };
}

async function verificar(token: string, purpose: string, mensaje: string): Promise<JWTPayload> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secreto()));
  } catch {
    throw new HttpError(401, mensaje);
  }
  if (payload.purpose !== purpose) throw new HttpError(401, 'Desafío inválido.');
  return payload;
}
