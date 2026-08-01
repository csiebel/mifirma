import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

// Hashing de contraseñas con scrypt (incluido en Node: sin dependencias nativas).
// scrypt es memory-hard, lo que encarece los ataques por fuerza bruta. Guardamos
// los parámetros y la sal junto al hash, así se pueden subir en el futuro sin
// romper los hashes viejos. La contraseña en claro nunca se persiste.
//
// Formato: scrypt$<N>$<r>$<p>$<sal_base64>$<hash_base64>

const N = 16384; // costo de CPU/memoria (2^14)
const R = 8;
const P = 1;
const KEYLEN = 32;
const SAL_BYTES = 16;

export function hashPassword(plano: string): string {
  const sal = randomBytes(SAL_BYTES);
  const hash = scryptSync(plano, sal, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(plano: string, guardado: string | null | undefined): boolean {
  if (!guardado) return false;
  const p = guardado.split('$');
  if (p.length !== 6 || p[0] !== 'scrypt') return false;
  const n = Number(p[1]);
  const r = Number(p[2]);
  const pp = Number(p[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(pp)) return false;
  let sal: Buffer;
  let esperado: Buffer;
  try {
    sal = Buffer.from(p[4], 'base64');
    esperado = Buffer.from(p[5], 'base64');
  } catch {
    return false;
  }
  let actual: Buffer;
  try {
    actual = scryptSync(plano, sal, esperado.length, { N: n, r, p: pp });
  } catch {
    return false;
  }
  return actual.length === esperado.length && timingSafeEqual(actual, esperado);
}

// Política mínima de contraseña. Devuelve un mensaje de error o null si está OK.
//
// ═══ POR QUÉ 12 Y NO 8 ═══
//
// scrypt encarece el ataque por fuerza bruta, pero no lo impide: si algún día se
// filtra la tabla `credencial`, el atacante prueba de a millones contra su
// propio hardware, sin límite de intentos y sin que nos enteremos. Ahí lo único
// que sigue defendiendo es el LARGO. Ocho caracteres elegidos por una persona
// —una palabra, una mayúscula al principio y un número al final— es un espacio
// que se recorre entero; doce ya no.
//
// No se piden mayúsculas ni símbolos a propósito. Las reglas de composición
// empujan al mismo patrón previsible (`Empresa2026!`) y no agregan entropía
// real: NIST retiró esa recomendación junto con la del cambio periódico
// obligatorio. Largo mínimo y nada más.
//
// El chequeo de caracteres distintos mata el atajo obvio de la regla de largo:
// `aaaaaaaaaaaa` y `123412341234` tienen doce caracteres y ninguna resistencia.
//
// ⚠ Lo que falta y vale más que todo esto junto: contrastar contra una lista de
// contraseñas ya filtradas (HIBP con k-anonimato). Una contraseña larga que ya
// está en un diccionario público se rompe en el primer intento.
const LARGO_MINIMO = 12;
const DISTINTOS_MINIMO = 5;

export function validarPassword(plano: string): string | null {
  if (typeof plano !== 'string' || plano.length < LARGO_MINIMO) {
    return `La contraseña debe tener al menos ${LARGO_MINIMO} caracteres.`;
  }
  if (plano.length > 200) return 'La contraseña es demasiado larga.';
  if (new Set(plano).size < DISTINTOS_MINIMO) {
    return 'Esa contraseña repite siempre los mismos caracteres. Probá con algo menos regular.';
  }
  return null;
}
