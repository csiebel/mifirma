import './setup_env'; // PRIMER import: setea AUTH_DEV_SECRET antes de cargar identity.ts (empresa)
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

// Sin DB: los handlers mutantes elegidos validan con zod ANTES de tocar la base, así que
// con payload vacío devuelven 400 sin conectarse — suficiente para ejercitar el hook de CSRF.
import { construirServidor } from '../src/server';
import { emitirTokenOperador } from '../src/operador/sesion';
import { emitirSesion } from '../src/auth/identity';

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
  const sess = await emitirSesion('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000022');
  // POST /usuarios valida zod (email/rol_id) ANTES de tocar la base: con payload
  // vacío responde 400 sin conectarse. Eso es lo que hace que este test no
  // necesite base y, a la vez, que un 400 signifique "pasó el hook de CSRF".
  await casosCsrf(t, app, { ruta: '/usuarios', sessCookie: 'sess_emp', csrfCookie: 'csrf_emp', sess });
  await app.close();
});

test('CSRF Fase B (double-submit + Origin) — realm operador', async (t) => {
  const app = construirServidor();
  await app.ready();
  const sess = await emitirTokenOperador({
    operadorId: '00000000-0000-0000-0000-000000000031',
    usuario: 'test-op', esSuperadmin: true, capacidades: ['gestionar_industrias'],
  });
  // POST /operador/industrias: sesión + exigirCap (sin base) y después zod.
  await casosCsrf(t, app, { ruta: '/operador/industrias', sessCookie: 'sess_op', csrfCookie: 'csrf_op', sess });
  await app.close();
});

// El tercer caso de payroll cubría /mi, la PWA del empleado, que compartía la
// cookie de sesión de la consola. Ese realm no existe en MiFirma: el firmante
// externo no entra por cookie sino por un enlace que apunta a un otorgamiento,
// y su protección no es CSRF sino la RLS (tests T3, T4 y T12 de rls_test.sql).
//
// Cuando exista el repositorio del firmante registrado, vuelve un caso acá.
