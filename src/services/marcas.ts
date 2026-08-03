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
