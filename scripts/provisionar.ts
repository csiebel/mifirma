/**
 * Alta de una cuenta desde la línea de comandos.
 *
 *   npm run provisionar -- --nombre "Estudio Pérez" --pais UY \
 *     --email admin@estudio.com --nombre-admin "Ana Pérez" [--password ...]
 *
 * Sin `--password`, la cuenta queda creada y el administrador entra por el
 * enlace de invitación. Es el camino recomendado: fijar una contraseña por
 * línea de comandos la deja en el historial del shell.
 */
import { provisionarCuenta } from '../src/admin/provisioning';
import { cerrarPool } from '../src/db/pool';

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const MONEDA: Record<string, string> = { UY: 'UYU', PY: 'PYG', BR: 'BRL' };

async function main() {
  const nombre = arg('nombre');
  const pais = (arg('pais') || 'UY').toUpperCase();
  const email = arg('email');

  if (!nombre || !email) {
    console.error('Faltan datos. Uso:');
    console.error('  npm run provisionar -- --nombre "Empresa" --pais UY --email admin@empresa.com [--nombre-admin "Ana"] [--password ...]');
    process.exit(1);
  }
  if (!MONEDA[pais]) {
    console.error(`País no soportado: ${pais}. Usá UY, PY o BR.`);
    process.exit(1);
  }

  const r = await provisionarCuenta({
    nombre,
    tipo: (arg('tipo') as 'empresa' | 'persona') ?? 'empresa',
    pais,
    moneda: arg('moneda')?.toUpperCase() ?? MONEDA[pais],
    admin: { email, nombre: arg('nombre-admin'), password: arg('password') },
  });

  console.log('Cuenta creada.');
  console.log('  cuenta_id  :', r.cuentaId);
  console.log('  admin      :', email, `(${r.adminIdentidadId})`);
  console.log('  roles      :', Object.entries(r.roles).map(([k, v]) => `${k}=${v}`).join(' '));
  console.log('  carpeta raíz:', r.carpetaRaizId);
  if (!arg('password')) {
    console.log('\nSin contraseña: mandale la invitación desde el panel, o usá el recupero.');
  }
}

main()
  .catch((e: unknown) => {
    console.error('Falló el alta:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => cerrarPool());
