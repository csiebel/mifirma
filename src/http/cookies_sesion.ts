import '@fastify/cookie'; // augmenta FastifyRequest.cookies / FastifyReply.setCookie
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Cookies de sesión httpOnly por realm (Fase A de la migración a cookies; ver
// docs/plan-auth-httponly-cookies.md). Cada realm usa SU PROPIA cookie para que
// las sesiones no se pisen en un mismo navegador (empresa + estudio + oferente +
// operador conviviendo). En Fase A el token SIGUE viajando en el JSON del login;
// la cookie es aditiva y el backend acepta cookie O header.
export type Realm = 'emp' | 'est' | 'ofe' | 'op';

interface DefRealm {
  cookie: string;
  csrf: string; // cookie CSRF del realm (NO httpOnly: el JS del realm la lee para el double-submit)
  path: string; // alcance de la cookie: acotado por realm salvo empresa (transversal a /app, /auth, etc.)
  maxAgeSeg: number; // igual al TTL del JWT del realm, para que la cookie expire con el token
}

// TTL de los JWT: empresa 8h (auth/identity.emitirTokenDev); estudio/oferente/operador 12h.
// La cookie CSRF (csrf_<realm>) usa el MISMO path que la de sesión: así document.cookie la
// puede leer desde la página del realm (p. ej. /oferente lee csrf_ofe con Path=/oferente).
const REALMS: Record<Realm, DefRealm> = {
  emp: { cookie: 'sess_emp', csrf: 'csrf_emp', path: '/', maxAgeSeg: 8 * 60 * 60 },
  est: { cookie: 'sess_est', csrf: 'csrf_est', path: '/estudio', maxAgeSeg: 12 * 60 * 60 },
  ofe: { cookie: 'sess_ofe', csrf: 'csrf_ofe', path: '/oferente', maxAgeSeg: 12 * 60 * 60 },
  op: { cookie: 'sess_op', csrf: 'csrf_op', path: '/operador', maxAgeSeg: 12 * 60 * 60 },
};

// Realm al que pertenece un path, para LEER la cookie correcta. Mismo dispatch por
// prefijo que usa el preHandler de autenticación en server.ts.
export function realmDePath(path: string): Realm {
  if (path === '/operador' || path.startsWith('/operador/')) return 'op';
  if (path === '/estudio' || path.startsWith('/estudio/')) return 'est';
  if (path === '/oferente' || path.startsWith('/oferente/')) return 'ofe';
  return 'emp';
}

function opciones(req: FastifyRequest, r: DefRealm, httpOnly: boolean) {
  return {
    httpOnly,
    sameSite: 'lax' as const, // primera línea anti-CSRF: no viaja en POST cross-site
    secure: req.protocol === 'https', // en localhost (http) no marca Secure para no romper dev
    path: r.path,
    maxAge: r.maxAgeSeg, // segundos (cookie.serialize)
  };
}

// Guarda el token recién emitido en la cookie httpOnly del realm.
export function setCookieSesion(req: FastifyRequest, reply: FastifyReply, realm: Realm, token: string): void {
  const r = REALMS[realm];
  reply.setCookie(r.cookie, token, opciones(req, r, true));
}

// Setea la cookie CSRF del realm con un valor aleatorio (double-submit, Fase B). NO es
// httpOnly a propósito: el JS del realm la lee y la reenvía en el header X-CSRF-Token.
// El server solo compara header vs cookie (stateless), no guarda el valor.
export function setCookieCsrf(req: FastifyRequest, reply: FastifyReply, realm: Realm): void {
  const r = REALMS[realm];
  reply.setCookie(r.csrf, randomBytes(32).toString('base64url'), opciones(req, r, false));
}

// Lee el token de la cookie de sesión del realm (undefined si no está).
export function tokenDeCookie(req: FastifyRequest, realm: Realm): string | undefined {
  const v = req.cookies?.[REALMS[realm].cookie];
  return v || undefined;
}

// Lee el valor de la cookie CSRF del realm (undefined si no está), para el double-submit.
export function tokenCsrfDeCookie(req: FastifyRequest, realm: Realm): string | undefined {
  const v = req.cookies?.[REALMS[realm].csrf];
  return v || undefined;
}

// Borra AMBAS cookies del realm (sesión + csrf) en el logout. clearCookie debe usar el
// MISMO path que se usó al setear para que el navegador las elimine.
export function clearCookieSesion(reply: FastifyReply, realm: Realm): void {
  const r = REALMS[realm];
  reply.clearCookie(r.cookie, { path: r.path });
  reply.clearCookie(r.csrf, { path: r.path });
}

// Endpoints de login que emiten un token de sesión de SU realm (allowlist para el
// hook de set-cookie). Excluye a propósito casos que devuelven un `token` que NO es
// la sesión del realm del path: creación de api_token (consola de empresa) y
// "abrir empresa como contador" (devuelve token de empresa desde /estudio/*).
export const LOGIN_PATHS: ReadonlyMap<string, Realm> = new Map<string, Realm>([
  // Empresa (sess_emp)
  ['/auth/login', 'emp'],
  ['/auth/otp', 'emp'],
  // Elegir cuenta emite la sesión definitiva cuando la identidad tiene acceso a
  // más de una. Se llamaba 'elegir-empresa' en payroll y quedó apuntando a una
  // ruta que ya no existe: el que tenía dos cuentas entraba sin cookie.
  ['/auth/login/elegir-cuenta', 'emp'],
  // El alta emite sesión igual que un login. Sin esto, la cuenta se crea, el
  // navegador salta a /app y ahí no hay cookie: consola vacía y a /entrar.
  //
  // ⚠ Desde el 3/8 el alta es en DOS pasos y la sesión sale del SEGUNDO. El
  // primero devuelve `{ok:true}` y nada más — dejar acá `/auth/registro` no
  // rompería nada, pero diría que ese endpoint emite sesión, y ya no lo hace.
  ['/auth/registro/confirmar', 'emp'],
  // El firmante que se queda con su repositorio. Emite sesión de empresa igual
  // que un alta, porque una cuenta persona es una cuenta como cualquier otra.
  ['/firmar/cuenta/crear', 'emp'],
  // Estudio (sess_est)
  ['/estudio/login', 'est'],
  ['/estudio/login/elegir', 'est'],
  ['/estudio/registro/verificar', 'est'],
  // Oferente (sess_ofe)
  ['/oferente/login', 'ofe'],
  ['/oferente/login/elegir', 'ofe'],
  ['/oferente/registro/verificar', 'ofe'],
  // Operador (sess_op)
  ['/operador/login', 'op'],
]);
