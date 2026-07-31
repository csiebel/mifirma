import { randomBytes, createHash } from 'node:crypto';

// Token de acceso por mail (reset / invitación). Es de alta entropía (32 bytes),
// así que se guarda hasheado con sha256: no necesita hashing lento como una
// contraseña. El secreto viaja en el enlace; en la base solo queda el hash.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generarToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
