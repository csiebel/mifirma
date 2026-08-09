/**
 * Una planilla de destinatarios convertida en el texto que ya sabemos leer.
 *
 * ═══ QUÉ HACE, Y SOBRE TODO QUÉ NO ═══
 *
 * Entra un archivo —`.xlsx` o separado por comas— y sale **texto**, en la misma
 * forma que el emisor pegaría a mano: un renglón por persona, `Nombre <correo>`
 * cuando la planilla trae el nombre.
 *
 * ⚠ **No agrega a nadie, no valida direcciones y no toca la base.** Ese texto
 * va al cuadro de la pantalla para que el emisor lo MIRE, y recién cuando
 * aprieta «Agregar todos» pasa por `partirLista` y por las reglas de siempre.
 *
 * ═══ POR QUÉ AL CUADRO Y NO DERECHO A LA LISTA ═══
 *
 * Porque una planilla de verdad no es una lista de personas: es una lista de
 * personas **con cosas alrededor**. Tiene un encabezado, tiene filas vacías en
 * el medio, y abajo de todo suele tener un «Total: 3». Si el archivo agregara
 * directo, el emisor se entera de lo que se leyó mal cuando ya son cuarenta
 * destinatarios de un documento legal — y los destinatarios de un circuito
 * despachado no se sacan.
 *
 * Mostrándolo primero, **ve exactamente qué se entendió antes de que sea nada**,
 * y el aviso de «esto no parece un correo» sigue apareciendo sobre el texto que
 * tiene a la vista, que es donde puede corregirlo.
 *
 * ═══ POR QUÉ NO SE ASUME QUÉ COLUMNA ES CUÁL ═══
 *
 * Nadie manda la planilla que uno espera. Puede venir el correo en la A y el
 * nombre en la B, al revés, o con tres columnas de las cuales dos no importan.
 * Así que **no se lee «la columna 1»: se busca en cada fila la celda que parece
 * un correo**, y el nombre es la primera celda que no lo parece. Con eso, el
 * encabezado deja de ser un problema en vez de ser una regla más: la fila
 * «Correo | Nombre» no tiene ninguna celda con arroba, así que no es una
 * persona y se saltea.
 *
 * ⚠ Y las salteadas **se cuentan y se dicen**. Una fila que se descarta en
 * silencio es una persona que no va a recibir el documento y nadie va a notar.
 */

/** Lo mismo que valida el resto del sistema. Un solo criterio. */
const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Tope de renglones que se devuelven.
 *
 * Un circuito admite 50 participantes. Se muestran hasta cuatro veces eso para
 * que, si el archivo trae de más, el emisor lo vea y recorte él —y no para
 * dejarlo entrar—. Más que esto no es una lista de firmantes: es una base de
 * datos, y la pantalla no es el lugar.
 *
 * ⚠ Si se recorta, se dice. Ver `de_mas` en el resultado.
 */
const TOPE_RENGLONES = 200;

/** Cuánto de una fila salteada se muestra para poder reconocerla. */
const LARGO_RESUMEN = 60;

/** Una fila que no se entendió como persona, para poder mostrarla. */
export interface FilaSalteada {
  /** El número de fila tal como se ve en Excel: la primera es la 1. */
  fila: number;
  /** Lo que decía, resumido, para reconocerla de un vistazo. */
  texto: string;
}

export interface PlanillaLeida {
  /** Lo que va al cuadro de texto, listo para que lo mire el emisor. */
  texto: string;
  /** Cuántas filas se entendieron como una persona. */
  personas: number;
  /**
   * Las filas que no tenían ninguna celda con un correo.
   *
   * ⚠ **Es una lista y no un número, y ésa es la corrección que importa.**
   *
   * La primera versión devolvía sólo la cuenta, y la pantalla decía «saltée 2
   * filas sin correo (el encabezado suele ser una)». Sobre una planilla de
   * cuarenta filas eso es una trampa: el encabezado explica una, y las otras
   * —que pueden ser personas con el correo mal tipeado— se leen como parte del
   * mismo ruido. **Se pierden, y no queda forma de saber cuáles eran.**
   *
   * Lo destapó la primera planilla de prueba de Claudio, con
   * `claudio.siebel@gmail` sin `.com`: la fila entera desapareció del cuadro,
   * no salió como correo malo, y el único rastro fue un contador en 1.
   *
   * > **Regla:** contar lo que se descartó no es avisar. Avisar es decir **qué**
   * > se descartó, con lo suficiente para reconocerlo. Un número se lee como
   * > ruido esperable; un renglón con el nombre de una persona, no.
   */
  salteadas: FilaSalteada[];
  /** Cuántas quedaron afuera por el tope. 0 si entraron todas. */
  de_mas: number;
  /** El nombre de la hoja leída, cuando el archivo es una planilla. */
  hoja: string | null;
}

/** Una fila ya en celdas, venga de donde venga. */
type Fila = (string | null)[];

/**
 * Un CSV de verdad, con comillas.
 *
 * ⚠ No alcanza con `split(',')`: `"Pérez, Ana",ana@empresa.com` son DOS celdas y
 * el `split` da tres, partiendo el apellido del nombre. Es exactamente el
 * apellido compuesto que sí o sí aparece en una lista uruguaya.
 *
 * Acepta coma, punto y coma y tabulación como separador —Excel en español
 * exporta con punto y coma— y `""` adentro de comillas como una comilla.
 */
export function partirCsv(texto: string): Fila[] {
  const filas: Fila[] = [];
  let fila: string[] = [];
  let celda = '';
  let entreComillas = false;

  const cerrarCelda = () => { fila.push(celda); celda = ''; };
  const cerrarFila = () => { cerrarCelda(); filas.push(fila); fila = []; };

  // Se saca el BOM que Excel pone al principio: sin esto la primera celda
  // arranca con un carácter invisible y un correo en la fila 1 deja de parecer
  // un correo.
  const s = String(texto || '').replace(/^﻿/, '');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (entreComillas) {
      if (ch === '"') {
        if (s[i + 1] === '"') { celda += '"'; i++; }
        else entreComillas = false;
      } else celda += ch;
      continue;
    }
    if (ch === '"') { entreComillas = true; continue; }
    if (ch === ',' || ch === ';' || ch === '\t') { cerrarCelda(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { cerrarFila(); continue; }
    celda += ch;
  }
  if (celda !== '' || fila.length) cerrarFila();
  return filas;
}

/**
 * De una fila de celdas al renglón de texto, o `null` si no hay nadie ahí.
 *
 * El correo es la primera celda que lo parece; el nombre, la primera que no lo
 * parece y no está vacía. En ese orden y no al revés: **la que manda es la
 * dirección**, porque es lo único sin lo cual no se puede mandar nada.
 */
export function filaARenglon(fila: Fila): string | null {
  const celdas = fila.map((c) => (c == null ? '' : String(c).trim()));
  const correo = celdas.find((c) => CORREO.test(c));
  if (!correo) return null;
  const nombre = celdas.find((c) => c && c !== correo && !CORREO.test(c));
  // Las comillas van siempre que haya nombre: si trae una coma, sin comillas
  // `partirLista` lo cortaría al medio y perdería el apellido.
  return nombre ? `"${nombre.replace(/"/g, '')}" <${correo}>` : correo;
}

/** De filas a resultado, que es lo único que cambia entre CSV y xlsx. */
function armar(filas: Fila[], hoja: string | null): PlanillaLeida {
  const renglones: string[] = [];
  const salteadas: FilaSalteada[] = [];

  filas.forEach((f, i) => {
    // Una fila entera vacía no es una fila salteada: es el espacio en blanco
    // que toda planilla tiene. Contarla asustaría sin motivo.
    if (!f.some((c) => c != null && String(c).trim() !== '')) return;
    const r = filaARenglon(f);
    if (r) { renglones.push(r); return; }

    // ⚠ Se guarda QUÉ decía, no sólo que hubo una. Ver `salteadas` en la
    // interfaz: es la diferencia entre «saltée 2» —que se lee como el
    // encabezado y nada más— y ver el nombre de alguien que se estaba por
    // perder por un correo mal tipeado.
    const resumen = f
      .map((c) => (c == null ? '' : String(c).trim()))
      .filter(Boolean)
      .join(' / ');
    salteadas.push({
      // +1 porque la primera fila de Excel es la 1 y no la 0: el número tiene
      // que servir para ir a buscarla en la planilla.
      fila: i + 1,
      texto: resumen.length > LARGO_RESUMEN ? resumen.slice(0, LARGO_RESUMEN) + '…' : resumen,
    });
  });

  const de_mas = Math.max(0, renglones.length - TOPE_RENGLONES);
  return {
    texto: renglones.slice(0, TOPE_RENGLONES).join('\n'),
    personas: Math.min(renglones.length, TOPE_RENGLONES),
    salteadas,
    de_mas,
    hoja,
  };
}

/** ¿El archivo es una planilla de Excel o texto separado por comas? */
export function esPlanillaExcel(nombreArchivo: string): boolean {
  return /\.(xlsx|xlsm|xltx)$/i.test(String(nombreArchivo || '').trim());
}

export async function leerPlanilla(datos: Buffer, nombreArchivo: string): Promise<PlanillaLeida> {
  if (!esPlanillaExcel(nombreArchivo)) {
    // ⚠ `latin1` no: se lee como UTF-8, que es lo que exporta todo desde hace
    // quince años. Un CSV viejo en Latin-1 va a mostrar la ñ rota EN EL CUADRO,
    // a la vista, y se corrige ahí. Adivinar la codificación y equivocarse
    // manda el documento a una dirección que nadie escribió.
    return armar(partirCsv(datos.toString('utf8')), null);
  }

  // Se carga acá y no arriba: quien nunca sube una planilla no paga el costo de
  // tener el lector de xlsx en memoria.
  const mod: any = await import('read-excel-file/node');
  const leer = mod.default ?? mod;

  // ⚠ Un Buffer NO alcanza: la versión de Node de la biblioteca espera una ruta
  // en el disco o un stream, y con un Buffer devuelve algo que no es una
  // promesa —«readFiles(...).then is not a function»—. El archivo nos llega por
  // multipart y en memoria, así que se envuelve. Escribirlo a un temporal para
  // pasarle una ruta sería dejar la lista de correos de un cliente tirada en el
  // disco del servidor.
  const { Readable } = await import('node:stream');
  const crudo: any = await leer(Readable.from(datos));

  // Según la versión, devuelve las filas derecho o `[{ sheet, data }]`. Se
  // aceptan las dos formas: que una actualización de la biblioteca cambie la
  // envoltura no puede dejar la lectura en cero sin decir nada.
  if (Array.isArray(crudo) && crudo.length && !Array.isArray(crudo[0]) && crudo[0]?.data) {
    return armar(crudo[0].data as Fila[], crudo[0].sheet ?? null);
  }
  return armar(crudo as Fila[], null);
}
