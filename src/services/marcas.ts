import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { PDFDocument } from 'pdf-lib';
import { withUsuario } from '../auth/authz';
import { withExterno } from '../db/pool';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { anotar } from './evidencia';
import { almacen } from '../almacenamiento/almacen';
import { HttpError } from '../http/errors';

/**
 * Dónde se estampa la firma y la rúbrica de cada firmante.
 *
 * ⚠ Una marca NO es una firma: es una imagen ubicada. El valor legal lo da el
 * PAdES. Ver `claude/representacion-visual.md`.
 *
 * ═══ DOS PERMISOS DISTINTOS, Y SE CONFUNDEN ═══
 *
 * · DEFINIR las marcas es del emisor, mientras el circuito está en borrador.
 * · MOVERLAS es del firmante, mientras no haya firmado.
 *
 * Ninguno de los dos se comprueba acá: los deciden `app.puede_definir_marcas` y
 * `app.puede_mover_marca` desde las políticas. Este archivo traduce el silencio
 * de la RLS en un mensaje que se entiende, que es otra cosa.
 */

export interface MarcaEntrada {
  tipo: 'firma' | 'rubrica';
  /** Base 0. Se ignora si `todasLasPaginas` es true. */
  pagina?: number;
  x: number;
  y: number;
  ancho: number;
  alto: number;
  /** Replica la marca en todas las hojas del documento. */
  todasLasPaginas?: boolean;
}

/** Las marcas de un documento, para dibujarlas sobre el visor. */
export async function verMarcas(cuentaId: string, identidadId: string, instanciaId: string) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const r = await sql<{
      id: string; participacion_id: string; tipo: string; pagina: number;
      x: string; y: string; ancho: string; alto: string;
      movida_en: Date | null; firmante: string | null;
    }>`
      select m.id, m.participacion_id, m.tipo, m.pagina,
             m.x::text, m.y::text, m.ancho::text, m.alto::text, m.movida_en,
             i.nombre_mostrado as firmante
        from marca_firma m
        join participacion p on p.id = m.participacion_id
        left join identidad i on i.id = p.identidad_id
       where m.instancia_id = ${instanciaId}::uuid
       order by m.pagina, m.tipo
    `.execute(trx);

    return {
      marcas: r.rows.map((m) => ({
        ...m,
        x: Number(m.x), y: Number(m.y), ancho: Number(m.ancho), alto: Number(m.alto),
      })),
    };
  });
}

/**
 * Reemplaza TODAS las marcas de una participación.
 *
 * Reemplazar y no editar de a una: el editor visual manda el estado completo de
 * lo que el usuario ve, y comparar posición por posición para decidir qué
 * cambió es trabajo extra que sólo sirve para introducir estados imposibles.
 * Como sólo se puede hacer en borrador, no hay historia que preservar.
 */

/**
 * Cuántas hojas tiene el documento, cuando la columna no lo sabe.
 *
 * ⚠ NO se persiste el resultado, y no es pereza: `archivo_update` es
 * `using (false)` —un archivo es inmutable, que es lo que hace que su huella
 * signifique algo—. `paginas` sólo se puede escribir en el INSERT.
 *
 * Los documentos subidos ANTES del 2/8/2026 tienen la columna en NULL porque
 * nadie la llenaba. Para ésos se cuenta acá, cada vez. Es una operación rara
 * —ubicar firmas se hace una vez por documento— y el archivo ya está a mano.
 *
 * Los nuevos traen el número desde que se suben y no pasan por acá.
 */
async function contarHojas(clave: string): Promise<number> {
  try {
    const doc = await PDFDocument.load(await almacen().leer(clave), { ignoreEncryption: true });
    return doc.getPageCount() || 1;
  } catch {
    throw new HttpError(
      400,
      'No se pudo leer el documento para saber cuántas hojas tiene. ' +
        'Puede estar dañado o protegido con contraseña.',
    );
  }
}

export async function definirMarcas(
  cuentaId: string,
  identidadId: string,
  participacionId: string,
  entradas: MarcaEntrada[],
) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const ctx = await sql<{
      instancia_id: string; circuito_id: string; cuenta_propietaria_id: string;
      estado: string; paginas: number | null; clave: string;
    }>`
      select p.instancia_id, p.circuito_id, p.cuenta_propietaria_id, c.estado, a.paginas,
             a.clave_almacenamiento as clave
        from participacion p
        join circuito c on c.id = p.circuito_id
        join archivo a on a.id = c.archivo_base_id
       where p.id = ${participacionId}::uuid
    `.execute(trx);

    const f = ctx.rows[0];
    if (!f) throw new HttpError(404, 'Ese firmante no existe o no lo podés ver.');
    if (f.estado !== 'borrador') {
      throw new HttpError(
        409,
        'El documento ya se despachó: las marcas no se cambian después, porque los ' +
          'firmantes ya vieron dónde iban.',
      );
    }

    // "Todas las hojas" se expande ACÁ y no en el navegador: el servidor sabe
    // cuántas páginas tiene el documento por el archivo, y esa es la fuente de
    // verdad. Que la cuente el cliente es pedirle que acierte.
    //
    // ⚠ Pero si la columna no lo sabe, NO se asume 1. Acá había un `?? 1` que
    // convertía "no lo sé" en "tiene una sola hoja", y con la columna siempre en
    // NULL eso rechazaba cualquier marca fuera de la primera página con un
    // mensaje que afirmaba con total seguridad algo falso: «el documento tiene
    // 1 página(s)». Un valor por defecto que se presenta como un hecho es peor
    // que un error.
    const paginas = f.paginas ?? (await contarHojas(f.clave));
    const expandidas: Required<Omit<MarcaEntrada, 'todasLasPaginas'>>[] = [];
    for (const e of entradas) {
      const destino = e.todasLasPaginas
        ? Array.from({ length: paginas }, (_, i) => i)
        : [e.pagina ?? 0];
      for (const pagina of destino) {
        if (pagina < 0 || pagina >= paginas) {
          throw new HttpError(400, `El documento tiene ${paginas} página(s): la ${pagina + 1} no existe.`);
        }
        expandidas.push({ tipo: e.tipo, pagina, x: e.x, y: e.y, ancho: e.ancho, alto: e.alto });
      }
    }

    // Un tope que no es arbitrario: un contrato de 500 páginas rubricado entero
    // son 500 marcas, y más que eso es un error de quien llama, no un caso de
    // uso. Sin tope, un bucle en el cliente escribe hasta llenar el disco.
    if (expandidas.length > 1000) {
      throw new HttpError(400, 'Demasiadas marcas para un solo firmante.');
    }

    await sql`delete from marca_firma where participacion_id = ${participacionId}::uuid`.execute(trx);

    for (const m of expandidas) {
      await sql`
        insert into marca_firma
          (participacion_id, instancia_id, circuito_id, cuenta_propietaria_id,
           tipo, pagina, x, y, ancho, alto, x_propuesta, y_propuesta, creada_por)
        values (${participacionId}::uuid, ${f.instancia_id}::uuid, ${f.circuito_id}::uuid,
                ${f.cuenta_propietaria_id}::uuid, ${m.tipo}, ${m.pagina},
                ${m.x}, ${m.y}, ${m.ancho}, ${m.alto}, ${m.x}, ${m.y}, ${identidadId}::uuid)
      `.execute(trx);
    }

    return { ok: true, marcas: expandidas.length };
  });
}

/**
 * El firmante corre una marca dentro de su hoja.
 *
 * ⚠ Va al expediente. Mover cambia lo que MUESTRA el documento, y sin registro
 * no habría forma de responder por qué la firma quedó en otro lugar del que
 * pidió el emisor. Se guarda de dónde a dónde.
 *
 * ⚠ No cambia de página ni de tamaño: eso sería rehacer la marca, no moverla, y
 * es decisión del emisor. Lo que se permite es acomodarla cuando tapa un
 * párrafo.
 */
export async function moverMarca(
  token: string,
  marcaId: string,
  x: number,
  y: number,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
) {
  const e = await verificarEnlaceFirma(token);

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const antes = await sql<{
      x: string; y: string; pagina: number; tipo: string;
      instancia_id: string; circuito_id: string; cuenta_propietaria_id: string;
      participacion_id: string;
    }>`
      select x::text, y::text, pagina, tipo, instancia_id, circuito_id,
             cuenta_propietaria_id, participacion_id
        from marca_firma where id = ${marcaId}::uuid
    `.execute(trx);

    const m = antes.rows[0];
    if (!m) throw new HttpError(404, 'Esa marca no existe o no es tuya.');

    const upd = await sql<{ id: string }>`
      update marca_firma
         set x = ${x}, y = ${y}, movida_en = now(), movida_por = ${e.identidadId}::uuid
       where id = ${marcaId}::uuid
      returning id
    `.execute(trx);

    if (!upd.rows.length) {
      // Se leyó antes de escribir para poder separar los dos casos: la marca no
      // existe, o existe y ya no se puede mover. La RLS no los distingue.
      throw new HttpError(409, 'Ya no podés mover esta marca: la firma está cerrada.');
    }

    await anotar(trx, {
      instanciaId: m.instancia_id,
      circuitoId: m.circuito_id,
      cuentaPropietariaId: m.cuenta_propietaria_id,
      identidadId: e.identidadId,
      participacionId: m.participacion_id,
      actorTipo: 'firmante',
      tipo: 'firma.marca_movida',
      datos: {
        tipo_marca: m.tipo,
        pagina: m.pagina,
        desde: { x: Number(m.x), y: Number(m.y) },
        hasta: { x, y },
      },
      canal: 'web',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { ok: true };
  });
}

/**
 * El firmante agrega una rúbrica suya, donde el emisor no reservó ninguna.
 *
 * ═══ POR QUÉ ESTO EXISTE ═══
 *
 * Porque quien pone su rúbrica en un documento es el firmante, en el acto de
 * firmar. El emisor PROPONE dónde va —la línea de firma del contrato— y eso
 * sigue siendo lo normal y lo prolijo; pero si no propuso nada, o si la persona
 * quiere además inicialar una hoja, no puede quedar atada a lo que el otro haya
 * previsto. Antes de esto sólo se podía MOVER una caja existente: sin caja, no
 * había rúbrica posible.
 *
 * ⚠ El permiso lo decide `app.puede_mover_marca` desde la política, que exige
 * que la participación sea SUYA y esté abierta. Acá no se comprueba nada de
 * eso: se traduce el silencio de la RLS en una frase que se entiende.
 *
 * ⚠ Las columnas `circuito_id`, `instancia_id` y `cuenta_propietaria_id` no se
 * mandan: las deriva el trigger `marca_coherente` de la participación. Son
 * columnas que la política después consulta, así que no pueden ser un dato de
 * entrada.
 *
 * ⚠ `x_propuesta`/`y_propuesta` quedan iguales a `x`/`y`: nadie propuso nada,
 * la puso la propia persona. Es lo que después deja distinguir en el expediente
 * una firma que se corrió de una que se colocó.
 */
export async function agregarMarca(
  token: string,
  entrada: {
    tipo: 'firma' | 'rubrica';
    pagina: number;
    x: number;
    y: number;
    ancho: number;
    alto: number;
  },
  ctx: { ip?: string | null; userAgent?: string | null } = {},
) {
  const e = await verificarEnlaceFirma(token);

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const q = await sql<{
      participacion_id: string; instancia_id: string; circuito_id: string;
      cuenta_propietaria_id: string; paginas: number | null;
    }>`
      select p.id as participacion_id, p.instancia_id, p.circuito_id,
             p.cuenta_propietaria_id, a.paginas
        from participacion p
        join circuito c on c.id = p.circuito_id
        join instancia i on i.id = p.instancia_id
        join archivo a on a.id = coalesce(i.archivo_vigente_id, c.archivo_base_id)
       where p.id = ${e.participacionId}::uuid
    `.execute(trx);

    const f = q.rows[0];
    if (!f) throw new HttpError(403, 'Este enlace ya no está disponible.');

    // ⚠ Si la columna no sabe cuántas hojas tiene, NO se asume una. Es el mismo
    // `?? 1` que en `definirMarcas` rechazaba cualquier marca fuera de la
    // primera hoja de un documento de cuarenta.
    if (f.paginas != null && (entrada.pagina < 0 || entrada.pagina >= f.paginas)) {
      throw new HttpError(400, `El documento tiene ${f.paginas} página(s): la ${entrada.pagina + 1} no existe.`);
    }

    const id = randomUUID();
    try {
      await sql`
        insert into marca_firma
          (id, participacion_id, instancia_id, circuito_id, cuenta_propietaria_id,
           tipo, pagina, x, y, ancho, alto, x_propuesta, y_propuesta, creada_por)
        values (${id}::uuid, ${f.participacion_id}::uuid, ${f.instancia_id}::uuid,
                ${f.circuito_id}::uuid, ${f.cuenta_propietaria_id}::uuid,
                ${entrada.tipo}, ${entrada.pagina},
                ${entrada.x}, ${entrada.y}, ${entrada.ancho}, ${entrada.alto},
                ${entrada.x}, ${entrada.y}, ${e.identidadId}::uuid)
      `.execute(trx);
    } catch (err: any) {
      // 23505 = el índice único (participacion_id, tipo, pagina). No es un
      // error del sistema: es que en esa hoja ya tiene una de ese tipo, y lo
      // que quiere es moverla.
      if (err?.code === '23505') {
        throw new HttpError(409, 'Ya tenés una marca de ese tipo en esa hoja. Movela en vez de agregar otra.');
      }
      // 42501 = la política. Traducida, porque un 500 manda a buscar el
      // problema adonde no está.
      if (err?.code === '42501') {
        throw new HttpError(403, 'Ya no podés cambiar dónde va tu firma en este documento.');
      }
      throw err;
    }

    await anotar(trx, {
      instanciaId: f.instancia_id,
      circuitoId: f.circuito_id,
      cuentaPropietariaId: f.cuenta_propietaria_id,
      identidadId: e.identidadId,
      participacionId: f.participacion_id,
      actorTipo: 'firmante',
      tipo: 'firma.marca_agregada',
      datos: { tipo_marca: entrada.tipo, pagina: entrada.pagina, x: entrada.x, y: entrada.y },
      canal: 'web',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { ok: true, id };
  });
}

/**
 * El firmante saca una marca que había puesto él.
 *
 * ⚠ La que propuso el emisor no se puede sacar, y no se comprueba acá: lo hace
 * la política `marca_delete` mirando `creada_por`. Mover una firma que tapa un
 * párrafo es acomodar; hacerla desaparecer es firmar en otro lado del que se
 * pidió, y esa decisión no es del firmante.
 */
export async function quitarMarca(
  token: string,
  marcaId: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
) {
  const e = await verificarEnlaceFirma(token);

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    // Se lee antes de borrar para poder separar los casos y para tener qué
    // anotar: después del delete la fila ya no está.
    const antes = await sql<{
      tipo: string; pagina: number; creada_por: string | null;
      instancia_id: string; circuito_id: string; cuenta_propietaria_id: string;
      participacion_id: string;
    }>`
      select tipo, pagina, creada_por, instancia_id, circuito_id,
             cuenta_propietaria_id, participacion_id
        from marca_firma where id = ${marcaId}::uuid
    `.execute(trx);

    const m = antes.rows[0];
    if (!m) throw new HttpError(404, 'Esa marca no existe o no es tuya.');
    if (m.creada_por !== e.identidadId) {
      throw new HttpError(
        409,
        'Esa marca la reservó quien te mandó el documento: podés moverla, pero no sacarla.',
      );
    }

    const del = await sql<{ id: string }>`
      delete from marca_firma where id = ${marcaId}::uuid returning id
    `.execute(trx);
    if (!del.rows.length) {
      throw new HttpError(409, 'Ya no podés cambiar dónde va tu firma en este documento.');
    }

    await anotar(trx, {
      instanciaId: m.instancia_id,
      circuitoId: m.circuito_id,
      cuentaPropietariaId: m.cuenta_propietaria_id,
      identidadId: e.identidadId,
      participacionId: m.participacion_id,
      actorTipo: 'firmante',
      tipo: 'firma.marca_quitada',
      datos: { tipo_marca: m.tipo, pagina: m.pagina },
      canal: 'web',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { ok: true };
  });
}

/**
 * Lo que el firmante ve en su visor: dónde va SU firma, y dónde va la de los
 * demás.
 *
 * ⚠ Devuelve también las ajenas, marcadas como tales. No es una filtración: la
 * política `marca_select` ya se las muestra a quien tiene otorgamiento sobre la
 * instancia, y son la información que necesita para no poner la suya encima. Lo
 * que no puede es tocarlas — eso lo decide `app.puede_mover_marca`, no esta
 * lista.
 */
export async function misMarcas(token: string) {
  const e = await verificarEnlaceFirma(token);

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const r = await sql<{
      id: string; participacion_id: string; tipo: string; pagina: number;
      x: string; y: string; ancho: string; alto: string;
      x_propuesta: string; y_propuesta: string;
      creada_por: string | null; movida_en: Date | null; firmante: string | null;
    }>`
      select m.id, m.participacion_id, m.tipo, m.pagina,
             m.x::text, m.y::text, m.ancho::text, m.alto::text,
             m.x_propuesta::text, m.y_propuesta::text,
             m.creada_por, m.movida_en, i.nombre_mostrado as firmante
        from marca_firma m
        join participacion p on p.id = m.participacion_id
        left join identidad i on i.id = p.identidad_id
       where m.participacion_id = ${e.participacionId}::uuid
          or m.instancia_id = (select instancia_id from participacion
                                where id = ${e.participacionId}::uuid)
       order by m.pagina, m.tipo
    `.execute(trx);

    return {
      marcas: r.rows.map((m) => ({
        id: m.id,
        tipo: m.tipo,
        pagina: m.pagina,
        x: Number(m.x), y: Number(m.y),
        ancho: Number(m.ancho), alto: Number(m.alto),
        // Suya o de otro: define si se puede arrastrar.
        mia: m.participacion_id === e.participacionId,
        // Suya del todo —la puso ella— o reservada por el emisor. La primera se
        // puede sacar; la segunda sólo mover.
        propia: m.creada_por === e.identidadId,
        movida: m.movida_en != null,
        // Dónde la había pedido el emisor, para poder ofrecer "volver al lugar
        // original" sin inventarlo.
        x_propuesta: Number(m.x_propuesta), y_propuesta: Number(m.y_propuesta),
        firmante: m.firmante,
      })),
    };
  });
}
