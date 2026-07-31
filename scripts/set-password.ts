import 'dotenv/config';
import { ownerDb, cerrarOwnerPool } from '../src/db/owner';
import { hashPassword, validarPassword } from '../src/auth/password';

// Uso:
//   npm run set-password -- "<empresa>" <email> "<contraseña>"
// Fija (o cambia) la contraseña de un usuario existente. Útil para los usuarios
// creados antes del login real. La contraseña la tipeás vos; el script solo guarda
// el hash. Corre con la conexión privilegiada (ownerDb).
const [empresa, email, password] = process.argv.slice(2);

if (!empresa || !email || !password) {
  console.error('Uso: npm run set-password -- "<empresa>" <email> "<contraseña>"');
  process.exit(1);
}

const errPwd = validarPassword(password);
if (errPwd) {
  console.error(errPwd);
  process.exit(1);
}

async function main(empresaNombre: string, emailUsuario: string, plano: string) {
  const db = ownerDb();
  const emp = await db
    .selectFrom('empresa')
    .select(['id', 'nombre'])
    .where('nombre', '=', empresaNombre.trim())
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!emp) throw new Error(`No existe una empresa llamada "${empresaNombre}".`);

  const usr = await db
    .selectFrom('usuario')
    .select(['id', 'email'])
    .where('cuenta_id', '=', emp.id)
    .where('email', '=', emailUsuario.trim())
    .executeTakeFirst();
  if (!usr) throw new Error(`No existe el usuario "${emailUsuario}" en ${empresaNombre}.`);

  await db
    .updateTable('usuario')
    .set({ password_hash: hashPassword(plano), password_actualizado: new Date(), activo: true })
    .where('id', '=', usr.id)
    .execute();

  console.log(`Contraseña actualizada para ${usr.email} en ${emp.nombre}.`);
}

main(empresa, email, password)
  .then(() => cerrarOwnerPool())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await cerrarOwnerPool();
    process.exit(1);
  });
