/**
 * Carga la credencial de un proveedor, cifrada.
 *
 * ═══ POR QUÉ EXISTE ESTE SCRIPT ═══
 *
 * `proveedor_firma.credenciales_cif` guarda el secreto cifrado con
 * `cripto.cifrar()`, que es TypeScript. Desde `psql` no se puede: habría que
 * pegar el valor en claro en la línea de comandos, y eso lo deja en el historial
 * del shell, en los logs de la base y a la vista de cualquiera que mire la
 * pantalla.
 *
 * Esto es un puente hasta que exista la pantalla del operador, que es donde esto
 * va a vivir de verdad. No lo agrandes: si empieza a hacer más cosas, hacé la
 * pantalla.
 *
 * ═══ CÓMO SE USA ═══
 *
 *   export MIFIRMA_DB="…"            # el túnel, ya abierto
 *   export GATEWAY_ENC_KEY="…"       # la misma que usa la app
 *   read -rs CRED_SECRETO            # ⚠ pegás el secreto acá; no se ve ni queda
 *   export CRED_SECRETO
 *   npx tsx scripts/cargar_credencial.ts tuid
 *   unset CRED_SECRETO
 *
 * ⚠ `read -rs` es la parte importante: la shell NO guarda en el historial lo que
 * se escribe ahí, a diferencia de un `export CRED_SECRETO=...` tipeado, que
 * queda en `.zsh_history` para siempre.
 *
 * ⚠ El secreto NO se pasa como argumento del comando. Un argumento es visible
 * para cualquier usuario de la máquina con un `ps`, mientras el proceso corre.
 */

import { Pool } from 'pg';
import { cifrar, huellaClave } from '../src/operador/cripto';

async function main() {
  const codigo = process.argv[2];
  const secreto = process.env.CRED_SECRETO;
  const url = process.env.MIFIRMA_DB;

  if (!codigo) {
    console.error('Uso: npx tsx scripts/cargar_credencial.ts <codigo_proveedor>');
    process.exit(1);
  }
  if (!secreto) {
    console.error('Falta CRED_SECRETO. Cargalo con `read -rs CRED_SECRETO` y `export CRED_SECRETO`.');
    process.exit(1);
  }
  if (!url) {
    console.error('Falta MIFIRMA_DB. Abrí el túnel con `source db/tunel.sh`.');
    process.exit(1);
  }
  if (!process.env.GATEWAY_ENC_KEY) {
    console.error('Falta GATEWAY_ENC_KEY: sin ella el secreto se guardaría sin cifrar o no se guardaría.');
    process.exit(1);
  }

  // La huella identifica QUÉ clave se usó, sin revelarla. Si mañana el
  // descifrado falla, lo primero que hay que comparar es esto contra la huella
  // de la clave que tiene la aplicación — sin esa comparación, «no descifra» es
  // indistinguible de «el dato está corrupto».
  console.log(`Clave de cifrado en uso: ${huellaClave()}`);

  const cif = cifrar(secreto);

  const pool = new Pool({ connectionString: url });
  try {
    const cli = await pool.connect();
    try {
      // ⚠ Como app_operador y en el realm operador: es quien tiene el GRANT de
      // update sobre esta columna. Correr esto como `postgres` funcionaría
      // igual —el superusuario saltea la RLS— y sería peor: no probaría que la
      // consola del operador va a poder hacer lo mismo mañana.
      await cli.query('begin');
      await cli.query('set role app_operador');
      await cli.query("select set_config('app.actor','operador',true)");

      const r = await cli.query(
        `update proveedor_firma
            set credenciales_cif = $2,
                credencial_puesta_en = now(),
                credencial_puesta_por = $3,
                actualizado_en = now()
          where codigo = $1
          returning id, nombre_mostrado, entorno, activo_global`,
        [codigo, cif, `cargar_credencial.ts (${huellaClave()})`],
      );

      if (r.rowCount === 0) {
        await cli.query('rollback');
        console.error(`No existe ningún proveedor con código «${codigo}».`);
        process.exit(1);
      }

      await cli.query('commit');
      const p = r.rows[0];
      console.log(`✓ Credencial cargada para ${p.nombre_mostrado} (${p.entorno}).`);
      console.log(`  activo_global: ${p.activo_global}`);
      if (!p.activo_global) {
        console.log('  ⚠ Sigue deshabilitado. Encenderlo es una decisión aparte, y va después de probar el flujo.');
      }
    } finally {
      cli.release();
    }
  } finally {
    await pool.end();
  }

  // ⚠ No se vuelve a leer para "verificar". Leerla implicaría traerla de vuelta
  // y tenerla en memoria por nada: la única verificación honesta es que el flujo
  // real funcione contra tuID.
}

main().catch((e) => {
  // Sin volcar el error entero: puede arrastrar la consulta, y la consulta lleva
  // el cifrado.
  console.error('Falló la carga de la credencial:', e instanceof Error ? e.message : 'error desconocido');
  process.exit(1);
});
