import 'dotenv/config';
import { facturarPeriodo, suscribir } from '../src/services/facturacion';
import { cerrarOwnerPool } from '../src/db/owner';

// Operaciones del operador (no del cliente):
//   Facturar un período:   npm run facturar -- <cuentaId> <YYYY-MM>
//   Suscribir a un plan:   npm run facturar -- suscribir <cuentaId> <planCodigo>
const args = process.argv.slice(2);

async function main() {
  if (args[0] === 'suscribir') {
    const [, cuentaId, plan] = args;
    if (!cuentaId || !plan) throw new Error('Uso: npm run facturar -- suscribir <cuentaId> <planCodigo>');
    return suscribir(cuentaId, plan);
  }
  const [cuentaId, periodo] = args;
  if (!cuentaId || !periodo) {
    throw new Error('Uso: npm run facturar -- <cuentaId> <YYYY-MM>   (o: suscribir <cuentaId> <planCodigo>)');
  }
  return facturarPeriodo(cuentaId, periodo);
}

main()
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => {
    console.error('Error:', e.message);
    process.exitCode = 1;
  })
  .finally(() => cerrarOwnerPool());
