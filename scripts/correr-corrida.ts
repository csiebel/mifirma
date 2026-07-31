import 'dotenv/config';
import { correrCorrida } from '../src/services/corrida';
import { cerrarPool } from '../src/db/pool';

// Uso:  npm run corrida -- <cuentaId> <periodo YYYY-MM>
// o por entorno: CORRIDA_EMPRESA=... CORRIDA_PERIODO=2025-03 npm run corrida
const cuentaId = process.env.CORRIDA_EMPRESA ?? process.argv[2];
const periodo = process.env.CORRIDA_PERIODO ?? process.argv[3];

if (!cuentaId || !periodo) {
  console.error('Uso: npm run corrida -- <cuentaId> <periodo YYYY-MM>');
  process.exit(1);
}

correrCorrida(cuentaId, periodo)
  .then((resumen) => {
    console.log(JSON.stringify(resumen, null, 2));
  })
  .catch((err) => {
    console.error('Error en la corrida:', err.message);
    process.exitCode = 1;
  })
  .finally(() => cerrarPool());
