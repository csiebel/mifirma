import 'dotenv/config';
import { provisionarEstudio } from '../src/admin/provisioning_estudio';
import { cerrarOwnerPool } from '../src/db/owner';

// Uso:
//   npm run provisionar:estudio -- "<nombre>" <pais UY|PY> <adminEmail> "<adminNombre>" [password]
// Ej:
//   npm run provisionar:estudio -- "Estudio Lopez" UY admin@lopez.uy "Ana Lopez" clave-de-8-o-mas
const [nombre, pais, email, adminNombre, password] = process.argv.slice(2);

if (!nombre || !pais || !email || !adminNombre) {
  console.error(
    'Uso: npm run provisionar:estudio -- "<nombre>" <pais UY|PY> <adminEmail> "<adminNombre>" [password]',
  );
  process.exit(1);
}

provisionarEstudio({ nombre, pais, admin: { email, nombre: adminNombre, password } })
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
  })
  .catch((e) => {
    console.error('Error en el provisioning del estudio:', e.message);
    process.exitCode = 1;
  })
  .finally(() => cerrarOwnerPool());
