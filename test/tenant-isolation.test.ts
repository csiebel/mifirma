import 'dotenv/config';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, cerrarPool } from '../src/db/pool';
import { crearPersona, listarPersonas } from '../src/repositories/personas';

// Requiere: una base con la migración 001 aplicada, DATABASE_URL apuntando a un
// rol `app_user`, y dos empresas ya creadas (el alta es un proceso privilegiado).
//   TEST_EMPRESA_A / TEST_EMPRESA_B = uuids de dos empresas distintas.
// No se ejecuta en este entorno (sin Postgres); correr con `npm test`.

after(() => cerrarPool());

test('una empresa no ve personas de otra (aislamiento por RLS)', async () => {
  const A = process.env.TEST_EMPRESA_A;
  const B = process.env.TEST_EMPRESA_B;
  if (!A || !B) assert.fail('Definí TEST_EMPRESA_A y TEST_EMPRESA_B');

  const doc = `A-${Date.now()}`;
  await withTenant(A, (trx) => crearPersona(trx, A, { documento: doc, nombre: 'Persona de A' }));

  const vistasDesdeB = await withTenant(B, (trx) => listarPersonas(trx));
  assert.ok(
    !vistasDesdeB.some((p) => p.documento === doc),
    'La empresa B no debería ver personas de la empresa A',
  );
});

test('withTenant exige cuentaId (defensa extra sobre el fail-closed de RLS)', async () => {
  await assert.rejects(
    () => withTenant('', async () => undefined),
    /cuentaId es requerido/,
  );
});
