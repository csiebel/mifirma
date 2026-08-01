import 'dotenv/config';
import { crearSuperadmin, listarOperadores, resetPasswordOperadorPorUsuario } from '../src/services/operadores';
import { cerrarPool } from '../src/db/pool';

// Arranque en frío de la consola de operador:
//   Crear el primer superadmin:  npm run operador -- crear-superadmin <usuario> <password> "<nombre>"
//   Listar operadores:           npm run operador -- listar
//   Resetear una contraseña:     npm run operador -- reset-password <usuario> <nueva>
const args = process.argv.slice(2);

async function main() {
  if (args[0] === 'crear-superadmin') {
    const [, usuario, password, nombre] = args;
    if (!usuario || !password || !nombre) {
      throw new Error('Uso: npm run operador -- crear-superadmin <usuario> <password> "<nombre>"');
    }
    return crearSuperadmin(usuario, password, nombre);
  }
  if (args[0] === 'reset-password') {
    const [, usuario, nueva] = args;
    if (!usuario || !nueva) {
      throw new Error('Uso: npm run operador -- reset-password <usuario> <nueva>');
    }
    return resetPasswordOperadorPorUsuario(usuario, nueva);
  }
  if (args[0] === 'listar') return listarOperadores();
  throw new Error('Uso: npm run operador -- crear-superadmin <usuario> <password> "<nombre>"   |   reset-password <usuario> <nueva>   |   listar');
}

main()
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => {
    console.error('Error:', e.message);
    process.exitCode = 1;
  })
  .finally(() => cerrarPool());
