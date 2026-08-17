import '../src/entorno';
import {
  verCorreo,
  guardarCorreo,
  setCorreoActivo,
  enviarPrueba,
  PRESET_GMAIL,
  PRESET_ICLOUD,
} from '../src/services/correo';
import { cerrarPool } from '../src/db/pool';

/**
 * Conexión de correo saliente de la plataforma, desde la línea de comandos.
 *
 * Sin esto no sale ni un código de acceso: el segundo factor del login viaja por
 * correo, así que una plataforma sin SMTP configurado deja afuera a todo el
 * mundo salvo a quien entre desde un equipo ya confiado.
 *
 *   npm run correo -- ver
 *   npm run correo -- set --preset icloud --usuario vos@me.com --password 'xxxx-xxxx-xxxx-xxxx' \
 *                        --remitente "MiFirma" --desde vos@me.com
 *   npm run correo -- probar vos@me.com
 *   npm run correo -- desactivar
 *
 * Presets: `icloud` (smtp.mail.me.com:587 STARTTLS) y `gmail`
 * (smtp.gmail.com:465 TLS). Cualquier otro proveedor: --host --puerto
 * --seguridad tls|starttls|ninguna.
 *
 * ⚠ La contraseña es una CONTRASEÑA DE APLICACIÓN, no la de la cuenta. iCloud y
 * Gmail rechazan la contraseña normal cuando hay verificación en dos pasos, que
 * es como debería estar cualquier casilla que manda códigos de acceso.
 *
 * ⚠ Va a quedar en el historial del shell. Si la casilla es la de producción,
 * borrá la línea después (`history -d`) o rotá la contraseña de aplicación.
 *
 * Se guarda cifrada con AES-256-GCM usando GATEWAY_ENC_KEY. Si esa clave
 * cambia, la contraseña guardada deja de poder descifrarse y hay que cargarla
 * de nuevo — no es un error, es lo que tiene que pasar.
 */

const args = process.argv.slice(2);
const cmd = args[0];

function opt(nombre: string): string | undefined {
  const i = args.indexOf('--' + nombre);
  return i >= 0 ? args[i + 1] : undefined;
}

const PRESETS: Record<string, typeof PRESET_GMAIL | typeof PRESET_ICLOUD> = {
  gmail: PRESET_GMAIL,
  icloud: PRESET_ICLOUD,
};

async function main() {
  if (cmd === 'ver') {
    const { config } = await verCorreo();
    if (!config) {
      console.log('No hay ninguna conexión de correo configurada.');
      return;
    }
    console.log(JSON.stringify(config, null, 2));
    if (!config.activo) console.log('\n⚠ Está configurada pero DESACTIVADA: no sale ningún correo.');
    if (config.tiene_password && !config.password_descifrable) {
      console.log(
        '\n✗ La contraseña está guardada pero NO se puede descifrar con la clave de este proceso' +
          ` (huella ${config.huella_clave}).\n` +
          '  Compará esa huella con la que imprime el servidor al arrancar:\n' +
          '    [seguridad] Clave de cifrado de secretos: …, huella …\n' +
          '  Si no coinciden, hay una variable de entorno exportada en una de las dos terminales:\n' +
          '  dotenv NO pisa las variables que ya existen en el entorno.',
      );
    }
    return;
  }

  if (cmd === 'set') {
    const preset = opt('preset');
    const base = preset ? PRESETS[preset] : undefined;
    if (preset && !base) {
      throw new Error(`Preset desconocido: ${preset}. Usá gmail, icloud, o pasá --host y --puerto.`);
    }

    const usuario = opt('usuario');
    const password = opt('password');
    const desde = opt('desde') ?? usuario;
    if (!usuario) throw new Error('Falta --usuario (la casilla que se autentica contra el SMTP).');
    if (!password) throw new Error('Falta --password (la contraseña de aplicación).');

    const host = opt('host') ?? base?.host;
    const puerto = Number(opt('puerto') ?? base?.puerto);
    const seguridad = (opt('seguridad') ?? base?.seguridad ?? 'tls') as 'tls' | 'starttls' | 'ninguna';
    if (!host || !puerto) throw new Error('Falta --host o --puerto (o usá --preset).');

    await guardarCorreo({
      proveedor: preset ?? 'smtp',
      host,
      puerto,
      seguridad,
      usuario,
      password,
      remitenteNombre: opt('remitente') ?? 'MiFirma',
      remitenteEmail: desde!,
    });
    // Guardar deja la conexión inactiva a propósito (una config a medio cargar
    // no debe empezar a mandar). Como acá vino la contraseña, se activa: era la
    // intención de quien corrió el comando.
    await setCorreoActivo(true);
    console.log(`Conexión guardada y activada: ${usuario} vía ${host}:${puerto} (${seguridad}).`);
    console.log('Probala:  npm run correo -- probar <tu-correo>');
    return;
  }

  if (cmd === 'probar') {
    const para = args[1];
    if (!para) throw new Error('Indicá a qué dirección mandar la prueba.');
    const r = await enviarPrueba(para);
    console.log(`Correo de prueba enviado a ${para}. Si no llega, mirá la carpeta de spam.`);
    // Los dos candidatos a amarre entre el evento de entrega y el expediente.
    // Se imprimen para poder comparar lo que SALIÓ con lo que VUELVE en el
    // webhook: ver si viene «un» message-id no alcanza, hay que saber si es el
    // nuestro o uno que puso el relay. Ver `http/routes/correo_webhook.ts`.
    console.log(`  etiqueta que salió   : ${r.etiqueta}`);
    console.log(`  message-id que salió : ${r.id}`);
    return;
  }

  if (cmd === 'activar' || cmd === 'desactivar') {
    await setCorreoActivo(cmd === 'activar');
    console.log(cmd === 'activar' ? 'Conexión activada.' : 'Conexión desactivada: no sale ningún correo.');
    return;
  }

  console.log(
    'Uso:\n' +
      '  npm run correo -- ver\n' +
      '  npm run correo -- set --preset icloud|gmail --usuario <casilla> --password <app-password> \\\n' +
      '                        [--remitente "MiFirma"] [--desde <casilla>]\n' +
      '  npm run correo -- set --host <host> --puerto <n> --seguridad tls|starttls|ninguna ...\n' +
      '  npm run correo -- probar <destino>\n' +
      '  npm run correo -- activar | desactivar',
  );
}

main()
  .catch((e) => {
    console.error('\n✗ ' + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  })
  .finally(() => cerrarPool());
