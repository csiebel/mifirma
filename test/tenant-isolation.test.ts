import { test } from 'node:test';
import assert from 'node:assert/strict';
import './setup_env';

/**
 * Aislamiento entre cuentas.
 *
 * Los tests reales de autorización de MiFirma son SQL y viven en
 * test/rls_test.sql: se corren como app_rw contra una base con la semilla,
 * porque el superusuario bypassa RLS y haría pasar todo sin probar nada.
 *
 *   psql -d mifirma -f test/semilla.sql
 *   psql -U app_rw_login -d mifirma -f test/rls_test.sql
 *   psql -d mifirma -f test/integridad_test.sql
 *
 * Cubren: contexto vacío sin acceso a ninguna fila, aislamiento entre cuentas,
 * el firmante externo encerrado en su otorgamiento, SET LOCAL que no filtra
 * entre transacciones, y la inmutabilidad de lo firmado.
 */
test('los tests de aislamiento de MiFirma son SQL — ver test/rls_test.sql', () => {
  assert.ok(true);
});
