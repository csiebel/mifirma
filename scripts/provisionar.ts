import 'dotenv/config';
import { provisionarEmpresa } from '../src/admin/provisioning';
import { cerrarOwnerPool } from '../src/db/owner';

// Uso:
//   npm run provisionar -- "<nombre>" <pais> <moneda> <adminEmail> "<adminNombre>" <adminDoc>
// Ej:
//   npm run provisionar -- "Acme SA" UY UYU admin@acme.com "Ana Admin" A-100
const [nombre, pais, moneda, email, adminNombre, documento] = process.argv.slice(2);

if (!nombre || !pais || !moneda || !email || !adminNombre || !documento) {
  console.error(
    'Uso: npm run provisionar -- "<nombre>" <pais UY|PY> <moneda> <adminEmail> "<adminNombre>" <adminDoc>',
  );
  process.exit(1);
}

provisionarEmpresa({ nombre, pais, moneda, admin: { email, nombre: adminNombre, documento } })
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
  })
  .catch((e) => {
    console.error('Error en el provisioning:', e.message);
    process.exitCode = 1;
  })
  .finally(() => cerrarOwnerPool());
