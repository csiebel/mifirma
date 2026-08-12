import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HttpError } from '../http/errors';

/**
 * Dónde viven los bytes de los documentos.
 *
 * ═══ POR QUÉ NO EN POSTGRES ═══
 *
 * `archivo` guarda metadatos y una CLAVE; el contenido va afuera. Un PDF de
 * veinte megas por documento, multiplicado por el envío masivo que es el caso
 * de uso central, convierte la base en un almacén de blobs: los backups se
 * vuelven inmanejables, cada réplica arrastra los archivos y una consulta que
 * sólo quería el título toca TOAST.
 *
 * ═══ LA CLAVE ES OPACA A PROPÓSITO ═══
 *
 * Nada de `cuenta/2026/contratos/juan-perez.pdf`. Una ruta adivinable anula
 * toda la RLS: se llega al documento sin pasar por la base, y ahí no hay
 * política que valga. La clave son 32 bytes aleatorios y no dice nada de quién
 * es el archivo ni de qué trata. Ver `propiedad-y-otorgamientos.md` R3.
 *
 * ═══ LO QUE FALTA, Y HAY QUE DECIRLO ═══
 *
 * ⚠ CIFRADO EN REPOSO. Hoy el driver local escribe el PDF tal cual. `iso-27001.md`
 * §3 pide cifrado con clave del KMS y modo de clave por cuenta. No está hecho
 * porque falta decidir nube y KMS, que es un pendiente de infraestructura. La
 * interfaz no cambia cuando se agregue —cifrar y descifrar ocurren acá adentro—
 * pero los archivos escritos antes hay que reescribirlos.
 */

export interface Almacen {
  /** Escribe el contenido bajo `clave`. Si ya existe, lo pisa. */
  guardar(clave: string, contenido: Buffer): Promise<void>;
  /**
   * Devuelve los bytes.
   *
   * ⚠ Distingue DOS fallas que no son la misma (deuda 16): «el archivo no está
   * en este almacén» y «está pero no lo pude leer». Ver `noEsta()`.
   */
  leer(clave: string): Promise<Buffer>;
  /** Best-effort: se usa para limpiar cuando la transacción falla después de escribir. */
  borrar(clave: string): Promise<void>;
  /** Etiqueta que se guarda en `archivo.region`, para saber dónde buscarlo. */
  readonly region: string;
}

/** 32 bytes aleatorios en base64url. Sin estructura, sin fecha, sin nombre. */
export function nuevaClave(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * ⚠⚠ «NO ESTÁ» Y «NO PUDE LEERLO» NO SON LO MISMO — deuda 16.
 *
 * Hasta hoy los dos casos subían como un error crudo de Node y salían por la
 * misma puerta: «Ocurrió un error en el servidor». La consecuencia real, medida
 * el 10/8: el visor mostraba una hoja en blanco y **no había forma de saber si
 * el documento estaba roto, si el disco había fallado, o si simplemente los
 * bytes vivían en otro almacén** — que era el caso, y es la topología conocida
 * de «una base, dos almacenes» (§2 del estado). Se perdieron dos diagnósticos
 * ahí.
 *
 * Ahora se separan, y cada uno dice lo suyo:
 *
 *  · **No está (`ENOENT`)** → 404. La base tiene la fila y el almacén no tiene
 *    los bytes. En desarrollo, casi siempre es un documento que firmó el otro
 *    entorno; en producción sería un archivo perdido, que es grave y hay que
 *    poder verlo como lo que es. El mensaje nombra la REGIÓN del almacén, que
 *    es el dato que resuelve la duda en un segundo.
 *  · **Cualquier otra cosa** (permisos, disco, red) → 503. El archivo puede
 *    estar perfecto; lo que falló es llegar a él, y eso se reintenta.
 *
 * ⚠ Se traduce ACÁ y no en cada llamador: son doce lugares los que leen del
 * almacén —incluidos los del dominio de firma, que no se tocan— y un error
 * traducido en un solo punto llega bien a todos. Es el mismo criterio con el
 * que se arregló `req.ip` en `server.ts`.
 */
function traducirFalla(e: unknown, region: string): never {
  const codigo = (e as { code?: string } | null)?.code;
  if (codigo === 'ENOENT') {
    throw new HttpError(
      404,
      `El archivo no está en el almacén «${region}». La ficha del documento existe, ` +
      'pero sus bytes no están acá — puede ser un documento generado por otro entorno.',
    );
  }
  console.error('[almacen] no se pudo leer del almacén', region, '-', e);
  throw new HttpError(
    503,
    'No se pudo leer el archivo del almacenamiento. El documento no se perdió: ' +
    'volvé a intentarlo en un momento.',
  );
}

/**
 * Driver de disco local.
 *
 * Sirve para desarrollo y para un despliegue de un solo nodo con volumen
 * persistente. NO sirve con varias instancias: cada una vería sus propios
 * archivos y la mitad de las descargas darían 404 de forma intermitente, que es
 * la peor forma de descubrir el problema. Antes de escalar horizontalmente hay
 * que pasar a un driver S3.
 */
class AlmacenLocal implements Almacen {
  readonly region = 'local';
  constructor(private readonly raiz: string) {}

  // Dos niveles de subdirectorio: un directorio con cien mil entradas es lento
  // de listar en casi todo sistema de archivos.
  private ruta(clave: string): string {
    const limpia = clave.replace(/[^A-Za-z0-9_-]/g, '');
    if (limpia !== clave || limpia.length < 8) throw new Error('clave de almacenamiento inválida');
    return join(this.raiz, limpia.slice(0, 2), limpia.slice(2, 4), limpia);
  }

  async guardar(clave: string, contenido: Buffer): Promise<void> {
    const r = this.ruta(clave);
    await mkdir(dirname(r), { recursive: true });
    await writeFile(r, contenido);
  }

  async leer(clave: string): Promise<Buffer> {
    try {
      return await readFile(this.ruta(clave));
    } catch (e) {
      // ⚠ El `await` de arriba no es decorativo: sin él la promesa se devuelve
      // sin pasar por este `catch` y el rechazo sale crudo, que es exactamente
      // lo que esta deuda vino a arreglar.
      return traducirFalla(e, this.region);
    }
  }

  async borrar(clave: string): Promise<void> {
    try {
      await unlink(this.ruta(clave));
    } catch {
      /* si no está, ya está */
    }
  }
}

let _almacen: Almacen | null = null;

export function almacen(): Almacen {
  if (!_almacen) {
    const dir = process.env.ALMACEN_DIR || resolve(process.cwd(), 'datos/archivos');
    _almacen = new AlmacenLocal(dir);
  }
  return _almacen;
}
