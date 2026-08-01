import './setup_env'; // PRIMER import: setea AUTH_DEV_SECRET antes de cargar identity.ts (empresa)
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

// Sin DB: los handlers mutantes elegidos validan con zod ANTES de tocar la base, así que
// con payload vacío devuelven 400 sin conectarse — suficiente para ejercitar el hook de CSRF.
import { construirServidor } from '../src/server';
import { emitirTokenOperador } from '../src/operador/sesion';
import { emitirTokenDev } from '../src/auth/identity';

const CSRF = 'valor-csrf-de-prueba';
const HOST = 'localhost'; // Host y Origin consistentes -> chequeo de Origin determinístico
const ORIGEN_PROPIO = 'http://localhost';

// Un bloqueo del hook de CSRF es un 403 cuyo mensaje habla de CSRF u Origen. Un 400 de zod
// (o cualquier otra respuesta) significa que la request PASÓ el hook de CSRF.
function bloqueadoPorCsrf(res: { statusCode: number; body: string }): boolean {
  return res.statusCode === 403 && (res.body.includes('CSRF') || res.body.includes('Origen'));
}

interface CfgRealm {
  ruta: string; // ruta que muta (POST), no pública, del realm
  sessCookie: string; // nombre de la cookie de sesión (sess_<realm>)
  csrfCookie: string; // nombre de la cookie CSRF (csrf_<realm>)
  sess: string; // JWT de sesión válido del realm
}

async function casosCsrf(t: TestContext, app: FastifyInstance, cfg: CfgRealm): Promise<void> {
  const conCookies: Record<string, string> = { [cfg.sessCookie]: cfg.sess, [cfg.csrfCookie]: CSRF };

  // (a) Identidad por cookie, SIN header X-CSRF-Token -> 403 (double-submit falla).
  await t.test('(a) cookie sin X-CSRF-Token -> 403 CSRF', async () => {
    const res = await app.inject({ method: 'POST', url: cfg.ruta, payload: {}, cookies: conCookies, headers: { host: HOST, origin: ORIGEN_PROPIO } });
    assert.equal(res.statusCode, 403);
    assert.ok(res.body.includes('CSRF'), `esperaba bloqueo de CSRF, fue: ${res.body}`);
  });

  // (b) Cookie + X-CSRF-Token coincidente + Origin propio -> pasa el CSRF (llega al handler,
  //     que devuelve 400 de zod por payload vacío).
  await t.test('(b) cookie + X-CSRF-Token + Origin propio -> pasa CSRF', async () => {
    const res = await app.inject({ method: 'POST', url: cfg.ruta, payload: {}, cookies: conCookies, headers: { host: HOST, origin: ORIGEN_PROPIO, 'x-csrf-token': CSRF } });
    assert.ok(!bloqueadoPorCsrf(res), `no debía bloquear por CSRF, fue ${res.statusCode}: ${res.body}`);
  });

  // (c) Identidad por Authorization header (frontend no migrado) -> el CSRF NO se chequea.
  await t.test('(c) Authorization header -> CSRF no se chequea', async () => {
    const res = await app.inject({ method: 'POST', url: cfg.ruta, payload: {}, headers: { host: HOST, authorization: 'Bearer ' + cfg.sess } });
    assert.ok(!bloqueadoPorCsrf(res), `header-auth no debía bloquear por CSRF, fue ${res.statusCode}: ${res.body}`);
  });

  // (d) Cookie + X-CSRF-Token coincidente, pero Origin de OTRO dominio -> 403 (Origin).
  await t.test('(d) cookie + Origin de otro dominio -> 403 Origin', async () => {
    const res = await app.inject({ method: 'POST', url: cfg.ruta, payload: {}, cookies: conCookies, headers: { host: HOST, origin: 'https://evil.example.com', 'x-csrf-token': CSRF } });
    assert.equal(res.statusCode, 403);
    assert.ok(res.body.includes('Origen'), `esperaba bloqueo por Origin, fue: ${res.body}`);
  });
}



test('CSRF Fase B (double-submit + Origin) — realm empresa', async (t) => {
  const app = construirServidor();
  await app.ready();
  const sess = await emitirTokenDev('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000022');
  // POST /usuarios valida zod (relacion_id/email/rol_id) antes de DB -> 400 con payload vacío.
  await casosCsrf(t, app, { ruta: '/usuarios', sessCookie: 'sess_emp', csrfCookie: 'csrf_emp', sess });
  await app.close();
});

test('CSRF Fase B (double-submit + Origin) — realm operador', async (t) => {
  const app = construirServidor();
  await app.ready();
  const sess = await emitirTokenOperador({
    operadorId: '00000000-0000-0000-0000-000000000031',
    usuario: 'test-op', esSuperadmin: true, capacidades: ['gestionar_planes'],
  });
  // POST /operador/planes: sesion + exigirCap (sin DB) y luego zod -> 400 con payload vacío.
  await casosCsrf(t, app, { ruta: '/operador/planes', sessCookie: 'sess_op', csrfCookie: 'csrf_op', sess });
  await app.close();
});

test('CSRF Fase B (double-submit + Origin) — /mi (PWA empleado, comparte sess_emp)', async (t) => {
  const app = construirServidor();
  await app.ready();
  // /mi es realm EMPRESA: usa el mismo token e sess_emp/csrf_emp que la consola.
  const sess = await emitirTokenDev('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-000000000042');
  // POST /mi/solicitudes valida zod (tipo/desde/hasta) antes de DB -> 400 con payload vacío.
  await casosCsrf(t, app, { ruta: '/mi/solicitudes', sessCookie: 'sess_emp', csrfCookie: 'csrf_emp', sess });
  await app.close();
});
