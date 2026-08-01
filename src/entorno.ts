import { config } from 'dotenv';
import { existsSync } from 'node:fs';

/**
 * Carga del entorno. SE IMPORTA PRIMERO, ANTES QUE CUALQUIER OTRA COSA.
 *
 * ═══ POR QUÉ ES UN MÓDULO Y NO DOS LÍNEAS EN index.ts ═══
 *
 * En ESM los `import` se evalúan ANTES del cuerpo del archivo que los importa.
 * Poner la carga del entorno en el cuerpo de `index.ts` llega tarde: para
 * entonces `db/pool.ts` ya se importó, ya leyó `process.env.DATABASE_URL` y ya
 * creó el pool con el valor viejo.
 *
 * Eso costó una tarde. El síntoma fue perfecto para despistar: la consola del
 * operador funcionaba —su pool se crea perezosamente, la primera vez que se
 * usa, cuando el entorno ya estaba corregido— y la de cliente fallaba con
 * ECONNREFUSED contra un puerto que ya no existía. Dos comportamientos
 * distintos para la misma base, en el mismo proceso.
 *
 * Siendo un módulo aparte e importado primero, se evalúa antes que todo lo
 * demás y no hay forma de equivocarse en el orden.
 *
 * ═══ QUÉ CARGA, Y EN QUÉ ORDEN ═══
 *
 *   1. `.env` — lo de siempre.
 *   2. `db/.env.tunel` — el puerto vigente del túnel, PISANDO lo anterior.
 *
 * El paso 2 sólo existe en desarrollo: lo escribe `db/tunel.sh` cada vez que
 * abre un túnel, porque Railway asigna un puerto efímero distinto en cada
 * sesión. En Railway ese archivo no existe y la conexión viene de las variables
 * del servicio.
 *
 * ⚠ `dotenv` NO pisa variables que ya están en el entorno, salvo con
 * `override: true`. Eso es exactamente lo que hace falta acá: la terminal donde
 * arranca el servidor puede tener exportado el puerto de un túnel anterior, y
 * el archivo es la fuente de verdad, no el shell.
 */

config();

const ENV_TUNEL = new URL('../db/.env.tunel', import.meta.url);
if (existsSync(ENV_TUNEL)) {
  config({ path: ENV_TUNEL, override: true });
  console.log('[dev] Conexión a la base tomada de db/.env.tunel');
}
