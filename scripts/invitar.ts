import 'dotenv/config';
import { ownerDb, cerrarOwnerPool } from '../src/db/owner';
import { invitarUsuario } from '../src/services/auth_reset';

// Uso:
//   npm run invitar -- "<empresa>" <adminEmail> <nuevoEmail> "<nombre>" <documento>
// Crea un usuario nuevo en la empresa (sin contraseña) y le manda por correo una
// invitación para que elija su clave. Se valida que el admin tenga permiso.
// (En la Tanda 4 esto mismo lo hace el admin desde su panel.)
const [empresa, adminEmail, nuevoEmail, nombre, documento] = process.argv.slice(2);

if (!empresa || !adminEmail || !nuevoEmail || !nombre || !documento) {
  console.error('Uso: npm run invitar -- "<empresa>" <adminEmail> <nuevoEmail> "<nombre>" <documento>');
  process.exit(1);
}

async function main(empresaNombre: string, admin: string, nuevo: string, nom: string, doc: string) {
  const db = ownerDb();
  const emp = await db
    .selectFrom('empresa')
    .select(['id', 'nombre'])
    .where('nombre', '=', empresaNombre.trim())
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!emp) throw new Error(`No existe una empresa llamada "${empresaNombre}".`);

  const adminU = await db
    .selectFrom('usuario')
    .select(['id'])
    .where('cuenta_id', '=', emp.id)
    .where('email', '=', admin.trim())
    .executeTakeFirst();
  if (!adminU) throw new Error(`No existe el admin "${admin}" en ${empresaNombre}.`);

  const r = await invitarUsuario(emp.id, adminU.id, { nombre: nom, email: nuevo, documento: doc });
  console.log(`Invitado ${r.email} (usuario ${r.usuario_id}) en ${emp.nombre}. Se le envió el enlace por correo.`);
}

main(empresa, adminEmail, nuevoEmail, nombre, documento)
  .then(() => cerrarOwnerPool())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await cerrarOwnerPool();
    process.exit(1);
  });
