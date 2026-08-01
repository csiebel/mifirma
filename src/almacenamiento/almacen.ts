import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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
    return readFile(this.ruta(clave));
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
