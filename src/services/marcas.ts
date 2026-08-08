import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { PDFDocument } from 'pdf-lib';
import { withUsuario } from '../auth/authz';
import { withExterno } from '../db/pool';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { anotar } from './evidencia';
import { almacen } from '../almacenamiento/almacen';
import type { WidgetPredeclarado } from '../firma/apariencia';
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

/** Los dos tipos de marca, y no hay más: lo dice el índice único de la tabla. */
const TIPOS = ['firma', 'rubrica'] as const;

/**
 * El `/T` del widget donde va a caer esta marca en el PDF.
 *
 * ⚠ Se calcula DOS veces sobre la misma marca: una antes de la primera firma,
 * cuando `predeclarar()` reserva el lugar, y otra al firmar, cuando la marca lo
 * completa. Si las dos formas difieren en un carácter, la firma no encuentra el
 * lugar reservado, lo AGREGA, y Acrobat vuelve a decir «el documento se ha
 * modificado o dañado» en todas las firmas menos la última. Por eso vive acá y
 * en ningún otro lado.
 *
 * ═══ POR QUÉ LUGAR Y HOJA, Y NUNCA EL ORDEN DE FIRMA ═══
 *
 * ⚠ Antes estos widgets se llamaban `Marca1_MiFirma2`, o sea que el nombre
 * llevaba **el orden en que se firmó**, que en el momento de reservar el lugar
 * todavía no se conoce —y en modo paralelo no se puede predecir—. Es la lección
 * de la 055 por tercera vez: `MiFirma1` no es el lugar 1, es el primero que
 * firmó.
 *
 * El LUGAR es de la persona y no cambia. La HOJA tampoco: la variante D del
 * laboratorio demostró que un widget no se puede mudar de hoja —Acrobat lo lee
 * como uno eliminado y otro agregado—, así que el lugar reservado está atado a
 * su hoja desde que nace. Ver `claude/cambios-posteriores-a-la-firma.md` §8.
 */
export function nombreDeMarca(m: {
  /** `participacion.posicion`: el lugar del firmante, NO su turno. */
  posicion: number;
  tipo: 'firma' | 'rubrica';
  /** Base 0. En el nombre va base 1, que es como se cuentan las hojas. */
  pagina: number;
}): string {
  return `marca_${m.tipo}_h${m.pagina + 1}__mf${m.posicion}`;
}

/**
 * Todos los lugares donde un firmante PODRÍA poner una marca, para reservarlos
 * antes de la primera firma.
 *
 * ═══ POR QUÉ SON TANTOS, Y POR QUÉ NO PUEDEN SER MENOS ═══
 *
 * Son `2 × firmantes × hojas`. Parece mucho y es el mínimo:
 *
 * · **Por qué por hoja.** Un widget no se puede mudar de hoja (variante D).
 * · **Por qué dos.** El índice único `(participacion, tipo, pagina)` dice que
 *   el máximo que una persona puede poner en una hoja es una firma y una
 *   rúbrica. Ni uno más, ni uno menos.
 * · **Por qué no se filtra por lo que ya está reservado.** Porque el firmante
 *   puede agregar marcas con su propio enlace **después** de que el documento
 *   se normalizó, y ésa es justamente la libertad que no se le quiere sacar.
 *   Reservar sólo lo que hoy existe sería arreglar el caso fácil y dejar roto
 *   el que importa.
 *
 * ⚠ **Y por eso tampoco se lee `marca_firma`.** Además de ser innecesario,
 * evita una trampa: esta consulta corre con el contexto del firmante, y si la
 * RLS no le dejara ver las marcas de los demás, el juego saldría incompleto
 * **sin ningún error a la vista** — se reservarían los lugares de uno solo y
 * las firmas de los otros volverían a agregar. Un juego que se calcula sin
 * mirar datos ajenos no puede salir incompleto por un permiso.
 *
 * El rectángulo va en cero: un lugar reservado no tiene por qué verse, y
 * cuando la marca lo complete le va a poner el suyo, que es un cambio de
 * propiedad y está permitido (variante C). De paso resuelve el R10: con
 * «Resaltar campos existentes», un rectángulo de tamaño cero no pinta nada.
 */
export async function marcasAPredeclarar(
  trx: any,
  instanciaId: string,
  paginas: number,
): Promise<WidgetPredeclarado[]> {
  const r = await sql<{ posicion: number | null }>`
    select p.posicion
      from participacion p
     where p.instancia_id = ${instanciaId}::uuid and p.papel = 'firmante'
     order by p.posicion
  `.execute(trx);

  const salida: WidgetPredeclarado[] = [];
  const vistos = new Set<string>();

  for (const p of r.rows) {
    // Una participación sin lugar no debería existir desde la 055. Si aparece
    // una vieja, se la saltea: reservar con un lugar inventado produciría un
    // nombre que la firma nunca va a buscar, y eso es peor que no reservar.
    if (p.posicion == null) {
      console.warn('[predeclarar] hay una participación de firmante sin posición: no se le reservan marcas');
      continue;
    }
    for (let pagina = 0; pagina < paginas; pagina++) {
      for (const tipo of TIPOS) {
        const nombre = nombreDeMarca({ posicion: p.posicion, tipo, pagina });
        if (vistos.has(nombre)) continue;      // dos firmantes con el mismo lugar
        vistos.add(nombre);
        salida.push({ nombre, pagina, rect: [0, 0, 0, 0], clase: 'marca' });
      }
    }
  }

  return salida;
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
 * Tamaños que tienen sentido para una firma, en puntos PDF.
 *
 * ⚠ El tamaño ahora llega del navegador, así que puede llegar cualquier cosa.
 * Una firma de dos puntos no se ve y una de mil tapa la hoja entera, y las dos
 * salen con la firma criptográfica puesta — que es lo que las vuelve difíciles
 * de notar: el documento está firmado y no se lee.
 *
 * 10 pt son unos 3,5 mm —el alto de una inicial chica, que es un tamaño
 * legítimo— y 600 pt, poco más de 21 cm, el ancho de un A4.
 */
const MARCA_MINIMO = 10;
const MARCA_MAXIMO = 600;

/**
 * El firmante acomoda su marca dentro de la hoja: la corre y le cambia el tamaño.
 *
 * ⚠ Va al expediente, y ésa es la única razón por la que se puede hacer. Mover
 * o agrandar cambia lo que MUESTRA el documento, y sin registro no habría forma
 * de responder por qué la firma quedó en otro lugar o de otro tamaño del que
 * pidió el emisor. Se guarda de dónde a dónde, y de qué tamaño a qué tamaño.
 *
 * ═══ POR QUÉ EL TAMAÑO DEJÓ DE ESTAR PROHIBIDO ═══
 *
 * Acá decía: «no cambia de página ni de tamaño: eso sería rehacer la marca, no
 * moverla, y es decisión del emisor».
 *
 * El argumento valía cuando el emisor reservaba el renglón. Pero **mover ya
 * cambia lo que muestra el documento tanto como redimensionar**, y mover estuvo
 * permitido desde el primer día: una firma corrida diez centímetros tapa lo
 * mismo que una firma agrandada al doble. La línea estaba en el lugar
 * equivocado. Lo que protege al emisor no es prohibir, es que quede escrito.
 *
 * ⚠ Lo que SIGUE prohibido es cambiar de página. Eso no es acomodar la firma:
 * es firmar en otro lado del contrato, y ahí el emisor sí tiene algo que decir.
 */
export async function moverMarca(
  token: string,
  marcaId: string,
  x: number,
  y: number,
  tam: { ancho?: number | null; alto?: number | null } = {},
  ctx: { ip?: string | null; userAgent?: string | null } = {},
) {
  const e = await verificarEnlaceFirma(token);

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const antes = await sql<{
      x: string; y: string; ancho: string; alto: string; pagina: number; tipo: string;
      instancia_id: string; circuito_id: string; cuenta_propietaria_id: string;
      participacion_id: string;
    }>`
      select x::text, y::text, ancho::text, alto::text, pagina, tipo,
             instancia_id, circuito_id, cuenta_propietaria_id, participacion_id
        from marca_firma where id = ${marcaId}::uuid
    `.execute(trx);

    const m = antes.rows[0];
    if (!m) throw new HttpError(404, 'Esa marca no existe o no es tuya.');

    const ancho = tam.ancho ?? Number(m.ancho);
    const alto = tam.alto ?? Number(m.alto);
    const cambioTamano =
      Math.abs(ancho - Number(m.ancho)) > 0.01 || Math.abs(alto - Number(m.alto)) > 0.01;
    const cambioLugar =
      Math.abs(x - Number(m.x)) > 0.01 || Math.abs(y - Number(m.y)) > 0.01;

    // ⚠ El tamaño se valida SÓLO si cambió, y no al entrar.
    //
    // La pantalla manda ancho y alto en cada arrastre —tiene que hacerlo, si no
    // un arrastre después de un zoom guardaría el tamaño viejo— así que casi
    // siempre llegan los que ya estaban. Y el emisor puede haber reservado un
    // renglón más chico que nuestro mínimo: rechazarlo acá sería impedir MOVER
    // una marca por un tamaño que esta persona no eligió y no puede arreglar.
    //
    // Lo que la regla protege es que nadie DEJE la firma en un tamaño que no se
    // ve o que tapa la hoja. Eso es sobre el cambio, no sobre el estado previo.
    if (cambioTamano) {
      for (const [que, v] of [['ancho', ancho], ['alto', alto]] as const) {
        if (!Number.isFinite(v) || v < MARCA_MINIMO || v > MARCA_MAXIMO) {
          throw new HttpError(
            400,
            `Ese ${que} de firma no sirve: tiene que estar entre ${MARCA_MINIMO} y ${MARCA_MAXIMO} puntos.`,
          );
        }
      }
    }

    const upd = await sql<{ id: string }>`
      update marca_firma
         set x = ${x}, y = ${y}, ancho = ${ancho}, alto = ${alto},
             movida_en = now(), movida_por = ${e.identidadId}::uuid
       where id = ${marcaId}::uuid
      returning id
    `.execute(trx);

    if (!upd.rows.length) {
      // Se leyó antes de escribir para poder separar los dos casos: la marca no
      // existe, o existe y ya no se puede mover. La RLS no los distingue.
      throw new HttpError(409, 'Ya no podés mover esta marca: la firma está cerrada.');
    }

    // ⚠ Dos eventos distintos y no uno con todo adentro. El expediente lo lee
    // gente que no escribió el código, y un evento que se llama «movida» y
    // además cuenta otra cosa es un evento en el que no se puede confiar.
    //
    // Y sólo se anota lo que efectivamente cambió: arrastrar una firma sin
    // tocarle el tamaño no tiene por qué dejar una línea diciendo que se
    // redimensionó de 170 a 170.
    if (cambioLugar) {
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
    }

    if (cambioTamano) {
      await anotar(trx, {
        instanciaId: m.instancia_id,
        circuitoId: m.circuito_id,
        cuentaPropietariaId: m.cuenta_propietaria_id,
        identidadId: e.identidadId,
        participacionId: m.participacion_id,
        actorTipo: 'firmante',
        tipo: 'firma.marca_redimensionada',
        datos: {
          tipo_marca: m.tipo,
          pagina: m.pagina,
          desde: { ancho: Number(m.ancho), alto: Number(m.alto) },
          hasta: { ancho, alto },
        },
        canal: 'web',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return { ok: true, ancho, alto };
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

/**
 * La misma marca en todas las hojas, de una vez.
 *
 * ═══ POR QUÉ EXISTE ═══
 *
 * Porque el caso que motivó todo esto es el contrato largo: cuarenta hojas que
 * hay que inicialar una por una para probar que se vieron todas. Hacerlo a mano
 * son cuarenta toques y una probabilidad muy alta de saltearse una — y una hoja
 * sin inicial en un contrato inicialado es exactamente lo que después se
 * discute.
 *
 * El emisor ya tenía este atajo desde la 031 («Rubricar todas las hojas»). El
 * firmante no, y es quien más lo necesita: el emisor lo hace una vez por
 * documento; el firmante, una vez por documento que recibe.
 *
 * ⚠ Las coordenadas las calcula el NAVEGADOR, hoja por hoja, y no es
 * comodidad: cada página puede tener tamaño y rotación distintos, y sólo pdf.js
 * —que ya midió todas para dibujarlas— sabe convertir «abajo a la derecha» en
 * puntos PDF de ESA hoja. El servidor no abre el PDF acá. Es la misma división
 * que ya usa `definirMarcas` para el emisor.
 *
 * ⚠ NO pisa lo que ya hay. Si el emisor reservó un lugar en la hoja 1, esa hoja
 * queda como estaba: el índice único (participacion, tipo, pagina) lo resuelve
 * y el `on conflict do nothing` lo vuelve silencioso. La persona pidió «en
 * todas», no «reemplazá lo que ya está acordado».
 */
export async function marcasEnTodasLasHojas(
  token: string,
  tipo: 'firma' | 'rubrica',
  hojas: { pagina: number; x: number; y: number; ancho: number; alto: number }[],
  ctx: { ip?: string | null; userAgent?: string | null } = {},
) {
  const e = await verificarEnlaceFirma(token);

  // El mismo tope que el emisor: un contrato de 500 hojas rubricado entero son
  // 500 marcas, y más que eso es un error de quien llama, no un caso de uso.
  if (!hojas.length) throw new HttpError(400, 'No llegó ninguna hoja.');
  if (hojas.length > 1000) throw new HttpError(400, 'Demasiadas hojas para una sola marca.');

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const q = await sql<{
      instancia_id: string; circuito_id: string; cuenta_propietaria_id: string;
      paginas: number | null;
    }>`
      select p.instancia_id, p.circuito_id, p.cuenta_propietaria_id, a.paginas
        from participacion p
        join circuito c on c.id = p.circuito_id
        join instancia i on i.id = p.instancia_id
        join archivo a on a.id = coalesce(i.archivo_vigente_id, c.archivo_base_id)
       where p.id = ${e.participacionId}::uuid
    `.execute(trx);
    const f = q.rows[0];
    if (!f) throw new HttpError(403, 'Este enlace ya no está disponible.');

    // Si la columna sabe cuántas hojas hay, manda ella. Si no lo sabe, NO se
    // asume nada: se acepta lo que midió el navegador, que para eso abrió el
    // documento. Lo que no se hace es inventar un número.
    for (const h of hojas) {
      if (h.pagina < 0 || (f.paginas != null && h.pagina >= f.paginas)) {
        throw new HttpError(400, `El documento no tiene una hoja ${h.pagina + 1}.`);
      }
    }

    let puestas = 0;
    for (const h of hojas) {
      const r = await sql<{ id: string }>`
        insert into marca_firma
          (id, participacion_id, instancia_id, circuito_id, cuenta_propietaria_id,
           tipo, pagina, x, y, ancho, alto, x_propuesta, y_propuesta, creada_por)
        values (${randomUUID()}::uuid, ${e.participacionId}::uuid, ${f.instancia_id}::uuid,
                ${f.circuito_id}::uuid, ${f.cuenta_propietaria_id}::uuid,
                ${tipo}, ${h.pagina}, ${h.x}, ${h.y}, ${h.ancho}, ${h.alto},
                ${h.x}, ${h.y}, ${e.identidadId}::uuid)
        on conflict (participacion_id, tipo, pagina) do nothing
        returning id
      `.execute(trx);
      puestas += r.rows.length;
    }

    // UN evento, no doscientos. El expediente tiene que poder leerse: «puso su
    // inicial en las 40 hojas» es un hecho; cuarenta renglones iguales son
    // ruido que tapa los hechos de al lado.
    await anotar(trx, {
      instanciaId: f.instancia_id,
      circuitoId: f.circuito_id,
      cuentaPropietariaId: f.cuenta_propietaria_id,
      identidadId: e.identidadId,
      participacionId: e.participacionId,
      actorTipo: 'firmante',
      tipo: 'firma.marca_agregada',
      datos: { tipo_marca: tipo, modo: 'todas_las_hojas', hojas: puestas, pedidas: hojas.length },
      canal: 'web',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { ok: true, puestas, salteadas: hojas.length - puestas };
  });
}

/**
 * Saca de un tirón todas las marcas que puso esta persona.
 *
 * ⚠ Sólo las suyas: `creada_por` la distingue de la que reservó el emisor, que
 * se puede mover pero no sacar. La política `marca_delete` lo comprueba igual;
 * el `where` de acá está para que el número que se devuelve sea el verdadero.
 */
export async function quitarMisMarcas(
  token: string,
  tipo: 'firma' | 'rubrica' | null,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
) {
  const e = await verificarEnlaceFirma(token);

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const q = await sql<{
      instancia_id: string; circuito_id: string; cuenta_propietaria_id: string;
    }>`
      select instancia_id, circuito_id, cuenta_propietaria_id
        from participacion where id = ${e.participacionId}::uuid
    `.execute(trx);
    const f = q.rows[0];
    if (!f) throw new HttpError(403, 'Este enlace ya no está disponible.');

    const r = await sql<{ id: string }>`
      delete from marca_firma
       where participacion_id = ${e.participacionId}::uuid
         and creada_por = ${e.identidadId}::uuid
         and (${tipo}::text is null or tipo = ${tipo})
      returning id
    `.execute(trx);

    if (r.rows.length) {
      await anotar(trx, {
        instanciaId: f.instancia_id,
        circuitoId: f.circuito_id,
        cuentaPropietariaId: f.cuenta_propietaria_id,
        identidadId: e.identidadId,
        participacionId: e.participacionId,
        actorTipo: 'firmante',
        tipo: 'firma.marca_quitada',
        datos: { tipo_marca: tipo ?? 'todas', modo: 'todas_las_hojas', hojas: r.rows.length },
        canal: 'web',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return { ok: true, quitadas: r.rows.length };
  });
}
