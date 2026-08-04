import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withUsuario } from '../auth/authz';
import { withExterno } from '../db/pool';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { almacen, nuevaClave } from '../almacenamiento/almacen';
import { HttpError } from '../http/errors';

/**
 * La firma autógrafa y la rúbrica de cada persona.
 *
 * ⚠ ESTO NO ES LA FIRMA. Es una imagen que se estampa para que un humano
 * reconozca de un vistazo quién firmó; el valor legal lo da el PAdES. Regla de
 * oro nº1. Ninguna función de este archivo debe usarse para decidir si algo
 * está firmado.
 *
 * ═══ POR QUÉ CUELGA DE LA IDENTIDAD ═══
 *
 * Una persona tiene UNA firma, no una por empresa donde trabaja. Si cambia de
 * trabajo, se va con ella. Es el mismo criterio por el que el admin de una
 * empresa no administra el teléfono ni el segundo factor de nadie.
 *
 * Y por eso mismo hay DOS caminos hacia las mismas cuatro operaciones: el de
 * quien tiene cuenta (`withUsuario`) y el de quien llegó por un enlace de firma
 * y no tiene ninguna (`withExterno`). Lo único que cambia entre los dos es cómo
 * se prueba quién es; la imagen, las validaciones y la tabla son las mismas.
 * Por eso el núcleo está escrito una sola vez y los dos caminos lo llaman.
 *
 * ═══ QUIÉN PONE LA RÚBRICA ═══
 *
 * El firmante, en el acto de firmar. Nunca el emisor, y nunca en el armado del
 * envío: el emisor reserva DÓNDE va —ver `marcas.ts`— pero la imagen es de la
 * persona que firma y sale de acá, de su perfil.
 *
 * ═══ POR QUÉ EL RECORTE Y LA TRANSPARENCIA SE HACEN EN EL NAVEGADOR ═══
 *
 * Convertir la foto de una firma sobre papel blanco en un PNG con fondo
 * transparente es procesamiento de imagen. Hacerlo acá obligaría a sumar una
 * dependencia nativa —y una superficie de ataque— para algo que el `canvas` del
 * navegador hace solo. Acá se recibe el PNG ya limpio y se lo VALIDA: que sea
 * realmente PNG o JPEG, que las dimensiones sean creíbles, que no venga vacío.
 *
 * Validar es obligatorio aunque el recorte sea del cliente: estos bytes van a
 * terminar embebidos en un PDF firmado, y aceptar cualquier cosa que diga ser
 * una imagen es exactamente cómo se cuela algo que no lo es.
 */

export type TipoFirmaVisual = 'firma' | 'rubrica';

export interface DatosImagen {
  mime: string;
  ancho: number;
  alto: number;
}

/**
 * Lee las dimensiones de la cabecera, sin librerías.
 *
 * Se hace a mano y no con un paquete porque son treinta líneas y la alternativa
 * es una dependencia más en el camino de un archivo subido por un usuario. Si
 * no reconoce el formato, tira: lo que no se entiende no se guarda.
 */
export function medirImagen(buf: Buffer): DatosImagen {
  // PNG: 89 50 4E 47 0D 0A 1A 0A, después IHDR con ancho y alto en big-endian.
  if (
    buf.length > 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf.toString('latin1', 12, 16) === 'IHDR'
  ) {
    return { mime: 'image/png', ancho: buf.readUInt32BE(16), alto: buf.readUInt32BE(20) };
  }

  // JPEG: FF D8, y después marcadores. El SOFn trae alto y ancho.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marca = buf[i + 1]!;
      // SOF0..SOF15, salteando DHT (c4), JPG (c8) y DAC (cc), que no son SOF.
      if (marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc) {
        return { mime: 'image/jpeg', alto: buf.readUInt16BE(i + 5), ancho: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }

  throw new HttpError(400, 'El archivo no es un PNG ni un JPEG válido.');
}

const MAX_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// El núcleo, escrito una sola vez
//
// Estas funciones reciben la transacción con el contexto RLS YA puesto. No
// saben —ni tienen por qué— si quien está del otro lado tiene cuenta o llegó
// por un enlace. Lo único que cambia entre los dos casos es cómo se prueba
// quién es, y eso lo resuelve el envoltorio.
// ---------------------------------------------------------------------------

/** Todo lo que se comprueba antes de tocar el disco. Vale para los dos caminos. */
function validar(contenido: Buffer): DatosImagen {
  if (!contenido.length) throw new HttpError(400, 'No llegó ninguna imagen.');
  if (contenido.length > MAX_BYTES) {
    throw new HttpError(400, 'La imagen no puede pesar más de 2 MB. Recortala o bajale la calidad.');
  }

  const img = medirImagen(contenido);
  if (img.mime !== 'image/png') {
    throw new HttpError(
      400,
      'La firma tiene que ser un PNG con fondo transparente: un JPEG llega con su ' +
        'recuadro blanco y taparía el texto del documento. Guardala como PNG, o ' +
        'dibujala acá mismo y la generamos nosotros.',
    );
  }
  if (img.ancho < 40 || img.alto < 20) {
    throw new HttpError(400, 'La imagen es demasiado chica para estamparla legible.');
  }
  if (img.ancho > 4000 || img.alto > 4000) {
    throw new HttpError(400, 'La imagen es demasiado grande. Recortala a la firma sola.');
  }
  return img;
}

async function escribir(
  trx: any,
  identidadId: string,
  tipo: TipoFirmaVisual,
  contenido: Buffer,
  img: DatosImagen,
  clave: string,
  origen: 'subida' | 'dibujada',
) {
  // Cerrar la vigente antes de abrir la nueva: el índice único exige que haya
  // una sola, y hacerlo en la misma transacción evita el estado imposible.
  await sql`
    update firma_visual set vigente = false, reemplazada_en = now()
     where identidad_id = ${identidadId}::uuid and tipo = ${tipo} and vigente
  `.execute(trx);

  // ⚠ El id se pregenera. INSERT ... RETURNING dispara la política de SELECT,
  // que llama a funciones STABLE que no ven la fila que el mismo statement
  // está insertando. Ya nos pasó con crearCarpeta.
  const id = randomUUID();
  await sql`
    insert into firma_visual
      (id, identidad_id, tipo, clave_almacenamiento, mime, bytes, ancho, alto, sha256, origen)
    values (${id}::uuid, ${identidadId}::uuid, ${tipo}, ${clave}, ${img.mime},
            ${contenido.length}, ${img.ancho}, ${img.alto},
            ${createHash('sha256').update(contenido).digest()}, ${origen})
  `.execute(trx);

  return { ok: true, id, tipo, ancho: img.ancho, alto: img.alto, bytes: contenido.length };
}

async function listar(trx: any, identidadId: string) {
  const r = await sql<{
    id: string; tipo: string; mime: string; bytes: number;
    ancho: number; alto: number; origen: string; creada_en: Date;
  }>`
    select id, tipo, mime, bytes, ancho, alto, origen, creada_en
      from firma_visual
     where identidad_id = ${identidadId}::uuid and vigente
     order by tipo
  `.execute(trx);
  return { imagenes: r.rows };
}

async function ubicar(trx: any, identidadId: string, tipo: TipoFirmaVisual) {
  const r = await sql<{ clave: string; mime: string }>`
    select clave_almacenamiento as clave, mime
      from firma_visual
     where identidad_id = ${identidadId}::uuid and tipo = ${tipo} and vigente
  `.execute(trx);
  return r.rows[0] ?? null;
}

async function jubilar(trx: any, identidadId: string, tipo: TipoFirmaVisual) {
  const r = await sql<{ id: string }>`
    update firma_visual set vigente = false, reemplazada_en = now()
     where identidad_id = ${identidadId}::uuid and tipo = ${tipo} and vigente
    returning id
  `.execute(trx);
  if (!r.rows.length) throw new HttpError(404, 'No tenías esa imagen cargada.');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Camino 1: quien tiene cuenta
// ---------------------------------------------------------------------------

/**
 * Guarda una firma o una rúbrica, reemplazando la anterior.
 *
 * ⚠ La anterior NO se borra: queda con `vigente = false`. Hace falta para
 * responder "¿qué imagen se estampó en este documento de hace tres años?". Si se
 * sobrescribiera, esa respuesta se pierde y el expediente queda incompleto.
 */
export async function guardarFirmaVisual(
  cuentaId: string,
  identidadId: string,
  tipo: TipoFirmaVisual,
  contenido: Buffer,
  origen: 'subida' | 'dibujada',
) {
  const img = validar(contenido);
  const clave = nuevaClave();
  await almacen().guardar(clave, contenido);

  return withUsuario(cuentaId, identidadId, async (trx) => {
    // ⚠ Se pregunta ANTES de escribir, y no por desconfianza de la política:
    // la política es la que decide y va a rechazar igual. Pero un rechazo de
    // RLS sale como 500 con "ocurrió un error en el servidor", que manda a
    // buscar el problema al lugar equivocado. Esto convierte esa pared en una
    // frase que dice qué hacer. Lección 5 de lecciones-1-agosto.
    const g = await sql<{ probada: boolean }>`select app.identidad_probada() as probada`
      .execute(trx);
    if (!g.rows[0]?.probada) {
      throw new HttpError(
        403,
        'Para cargar tu firma tenés que haber verificado tu identidad en esta sesión. ' +
          'Cerrá sesión y volvé a entrar con el código que te llega por correo.',
      );
    }

    return escribir(trx, identidadId, tipo, contenido, img, clave, origen);
  });
}

/** Lo que hay cargado hoy. Sin los bytes: la lista no necesita la imagen. */
export async function verFirmasVisuales(cuentaId: string, identidadId: string) {
  return withUsuario(cuentaId, identidadId, (trx) => listar(trx, identidadId));
}

/** El PNG en sí, para mostrarlo en la pantalla de su dueño. */
export async function bajarFirmaVisual(
  cuentaId: string,
  identidadId: string,
  tipo: TipoFirmaVisual,
) {
  const datos = await withUsuario(cuentaId, identidadId, (trx) => ubicar(trx, identidadId, tipo));
  if (!datos) throw new HttpError(404, 'Todavía no cargaste esa imagen.');
  return { contenido: await almacen().leer(datos.clave), mime: datos.mime };
}

/**
 * Da de baja la imagen vigente. No borra la fila: la cierra.
 *
 * Borrarla dejaría documentos ya firmados con un trazo que nadie puede atar a
 * nada. La política de DELETE de la tabla es `false` justamente para que esto
 * no se pueda hacer ni por error.
 */
export async function quitarFirmaVisual(
  cuentaId: string,
  identidadId: string,
  tipo: TipoFirmaVisual,
) {
  return withUsuario(cuentaId, identidadId, (trx) => jubilar(trx, identidadId, tipo));
}

// ---------------------------------------------------------------------------
// Camino 2: el firmante que llegó por un enlace y no tiene cuenta
//
// ═══ POR QUÉ EXISTE ESTE CAMINO ═══
//
// Porque quien pone la rúbrica es el firmante, y buena parte de los firmantes
// de este producto no tienen cuenta: reciben un correo, abren un enlace y
// firman. Sin esto, esa parte firmaba siempre sin nada estampado, y el
// expediente anotaba «el firmante no tiene cargada su firma» sin que la persona
// hubiera tenido nunca la oportunidad de cargarla.
//
// ⚠ La identidad NO viene del pedido: sale del otorgamiento que lleva el
// enlace. Es la misma regla que en `cuenta_del_firmante.ts` — nadie elige de
// quién carga la firma. Y la política de `firma_visual` lo vuelve a comprobar
// del otro lado con `app.puede_gestionar_su_firma_visual`, que además exige que
// el otorgamiento tenga alcance `firmar`: a quien recibe una copia informativa
// no se le pide ninguna rúbrica.
//
// ⚠ Lo que carga acá QUEDA EN SU PERFIL. No es una copia para este documento:
// es su firma. La próxima vez que le manden algo ya la tiene, y si más adelante
// abre cuenta se la encuentra cargada. Por eso la tabla cuelga de la identidad
// y no de la participación.
// ---------------------------------------------------------------------------

/**
 * Traduce el silencio de la RLS en una frase. Igual que en el camino de cuenta,
 * y por el mismo motivo: un rechazo de política sale como 500 y manda a buscar
 * el problema adonde no está.
 */
async function exigirPermiso(trx: any, identidadId: string) {
  const g = await sql<{ puede: boolean }>`
    select app.puede_gestionar_su_firma_visual(${identidadId}::uuid) as puede
  `.execute(trx);
  if (!g.rows[0]?.puede) {
    throw new HttpError(
      403,
      'Este enlace ya no te habilita a firmar, así que tampoco a cargar tu firma. ' +
        'Pedile al emisor que te lo reenvíe.',
    );
  }
}

export async function firmasVisualesDelFirmante(token: string) {
  const e = await verificarEnlaceFirma(token);
  return withExterno(e.otorgamientoId, e.identidadId, (trx) => listar(trx, e.identidadId));
}

export async function guardarFirmaVisualDelFirmante(
  token: string,
  tipo: TipoFirmaVisual,
  contenido: Buffer,
  origen: 'subida' | 'dibujada',
) {
  const e = await verificarEnlaceFirma(token);
  const img = validar(contenido);
  const clave = nuevaClave();
  await almacen().guardar(clave, contenido);

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    await exigirPermiso(trx, e.identidadId);
    return escribir(trx, e.identidadId, tipo, contenido, img, clave, origen);
  });
}

export async function bajarFirmaVisualDelFirmante(token: string, tipo: TipoFirmaVisual) {
  const e = await verificarEnlaceFirma(token);
  const datos = await withExterno(e.otorgamientoId, e.identidadId, (trx) =>
    ubicar(trx, e.identidadId, tipo));
  if (!datos) throw new HttpError(404, 'Todavía no cargaste esa imagen.');
  return { contenido: await almacen().leer(datos.clave), mime: datos.mime };
}

export async function quitarFirmaVisualDelFirmante(token: string, tipo: TipoFirmaVisual) {
  const e = await verificarEnlaceFirma(token);
  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    await exigirPermiso(trx, e.identidadId);
    return jubilar(trx, e.identidadId, tipo);
  });
}
