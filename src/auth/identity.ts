import { jwtVerify, createRemoteJWKSet, SignJWT, type JWTPayload } from 'jose';
import { HttpError } from '../http/errors';

export interface Identidad {
  usuarioId: string;
  cuentaId: string;
}

// Paso 1: validamos un JWT firmado y extraemos empresa + usuario para fijar el
// contexto de tenant. El login/SSO real, la rotación de claves y la resolución
// de roles/capacidades + alcance jerárquico se enchufan acá en el Paso 3 (§14).
const jwks = process.env.AUTH_JWKS_URL
  ? createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URL))
  : null;

// DEV: secreto local para emitir/verificar JWT sin IdP (login de desarrollo).
// En producción se usa AUTH_JWKS_URL (IdP real); nunca AUTH_DEV_SECRET.
const devSecret = process.env.AUTH_DEV_SECRET
  ? new TextEncoder().encode(process.env.AUTH_DEV_SECRET)
  : null;

// Emite un token de desarrollo (HS256) para que la UI se autentique sin IdP.
export async function emitirTokenDev(cuentaId: string, usuarioId: string): Promise<string> {
  if (!devSecret) {
    throw new HttpError(500, 'AUTH_DEV_SECRET no configurado: el login de desarrollo está deshabilitado');
  }
  return new SignJWT({ cuenta_id: cuentaId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(usuarioId)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(devSecret);
}

// Desafío de OTP: token corto que prueba que el paso 1 (contraseña) ya pasó, sin
// emitir sesión. NO lleva `sub`, así `autenticar` lo rechaza: no sirve como token
// de sesión aunque alguien lo intente. Lleva usuario + equipo en claims propios.
export async function firmarDesafioOtp(cuentaId: string, usuarioId: string, deviceId: string): Promise<string> {
  if (!devSecret) throw new HttpError(500, 'AUTH_DEV_SECRET no configurado.');
  return new SignJWT({ cuenta_id: cuentaId, uid: usuarioId, did: deviceId, purpose: 'otp' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(devSecret);
}

export async function verificarDesafioOtp(
  token: string,
): Promise<{ cuentaId: string; usuarioId: string; deviceId: string }> {
  if (!devSecret) throw new HttpError(500, 'AUTH_DEV_SECRET no configurado.');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, devSecret));
  } catch {
    throw new HttpError(401, 'El desafío de verificación venció o no es válido. Iniciá sesión de nuevo.');
  }
  if (payload.purpose !== 'otp') throw new HttpError(401, 'Desafío inválido.');
  const cuentaId = typeof payload.cuenta_id === 'string' ? payload.cuenta_id : undefined;
  const usuarioId = typeof payload.uid === 'string' ? payload.uid : undefined;
  const deviceId = typeof payload.did === 'string' ? payload.did : undefined;
  if (!cuentaId || !usuarioId || !deviceId) throw new HttpError(401, 'Desafío incompleto.');
  return { cuentaId, usuarioId, deviceId };
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
  const usuarioId = payload.sub;
  if (!cuentaId || !usuarioId) {
    throw new HttpError(401, 'El token no trae cuenta_id / sub');
  }

  return { cuentaId, usuarioId };
}

// Desafío de SELECCIÓN de empresa: cuando un email tiene la misma contraseña en varias
// empresas, el login valida la contraseña y emite este JWT corto (prueba de que ya se
// validó) con los pares empresa/usuario elegibles. El segundo paso lo presenta junto
// con la empresa elegida; así no se filtra en qué empresas existe el email ni se puede
// manipular la elección desde el cliente.
export async function firmarDesafioEleccionEmpresa(
  email: string,
  pares: { cuentaId: string; usuarioId: string }[],
): Promise<string> {
  if (!devSecret) throw new HttpError(500, 'AUTH_DEV_SECRET no configurado.');
  return new SignJWT({ email, pares, purpose: 'elegir_empresa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(devSecret);
}

export async function verificarDesafioEleccionEmpresa(
  token: string,
): Promise<{ email: string; pares: { cuentaId: string; usuarioId: string }[] }> {
  if (!devSecret) throw new HttpError(500, 'AUTH_DEV_SECRET no configurado.');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, devSecret));
  } catch {
    throw new HttpError(401, 'La selección expiró. Iniciá sesión de nuevo.');
  }
  if (payload.purpose !== 'elegir_empresa') throw new HttpError(401, 'Desafío inválido.');
  const email = typeof payload.email === 'string' ? payload.email : '';
  const pares: { cuentaId: string; usuarioId: string }[] = [];
  if (Array.isArray(payload.pares)) {
    for (const p of payload.pares as unknown[]) {
      if (p && typeof p === 'object') {
        const e = (p as Record<string, unknown>).cuentaId;
        const u = (p as Record<string, unknown>).usuarioId;
        if (typeof e === 'string' && typeof u === 'string') pares.push({ cuentaId: e, usuarioId: u });
      }
    }
  }
  if (!email || pares.length === 0) throw new HttpError(401, 'Desafío incompleto.');
  return { email, pares };
}
