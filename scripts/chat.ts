import '../src/entorno';
import { responder } from '../src/ai/orquestador';
import { cerrarPool } from '../src/db/pool';

// Uso: npm run chat -- <cuentaId> <usuarioId> "tu pregunta"
const cuentaId = process.argv[2];
const usuarioId = process.argv[3];
const pregunta = process.argv.slice(4).join(' ');

if (!cuentaId || !usuarioId || !pregunta) {
  console.error('Uso: npm run chat -- <cuentaId> <usuarioId> "tu pregunta"');
  process.exit(1);
}

responder(cuentaId, usuarioId, pregunta)
  .then((r) => console.log('\n' + r + '\n'))
  .catch((e) => {
    console.error('Error:', e.message);
    process.exitCode = 1;
  })
  .finally(() => cerrarPool());
