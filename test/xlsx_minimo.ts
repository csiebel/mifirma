/**
 * Un `.xlsx` mínimo, armado acá, para que la prueba no dependa de un binario.
 *
 * ═══ POR QUÉ NO UN ARCHIVO GUARDADO EN EL REPO ═══
 *
 * Porque un fixture binario es una prueba que nadie puede corregir. Dentro de un
 * año, «agregale una columna al xlsx de la prueba» significa abrir Excel, tocar,
 * guardar y commitear un blob que en la revisión se ve como una línea que dice
 * «Binary files differ». Nadie sabe qué cambió, y nadie se anima a tocarlo.
 *
 * Escrito así, la planilla de la prueba se lee en el código y se cambia
 * editando un arreglo.
 *
 * ═══ QUÉ ES UN .xlsx ═══
 *
 * Un zip con XML adentro. Se guarda **sin comprimir** (método 0): así el zip se
 * arma con un CRC y unos encabezados, sin depender de nada.
 *
 * ⚠ Y van **siete** archivos, no los cuatro que hacen falta de verdad. Los dos
 * últimos —`xl/styles.xml` y `xl/sharedStrings.xml`— van **vacíos y sólo para
 * que existan**: `read-excel-file` los busca sin preguntar si están, y cuando
 * faltan no dice «falta styles.xml» sino **`readFiles(...).then is not a
 * function`**, que no señala nada. El zip sin ellos es válido —`unzip` lo lista
 * entero y Python lo abre sin chistar—; el que no lo acepta es el lector.
 * Costó una hora encontrarlo; queda escrito para que no cueste dos.
 *
 * ⚠ Esto sirve para LEER en una prueba. No es un escritor de Excel y no tiene
 * por qué serlo: no maneja números, ni fechas, ni formatos, ni hojas múltiples.
 */
import { crc32 } from 'node:zlib';

const xml = (s: string) =>
  String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

interface Entrada { nombre: string; datos: Buffer }

/** Un zip sin comprimir: encabezado por archivo, y el directorio al final. */
function zip(entradas: Entrada[]): Buffer {
  const locales: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entradas) {
    const nombre = Buffer.from(e.nombre, 'utf8');
    const crc = crc32(e.datos);

    const enc = Buffer.alloc(30);
    enc.writeUInt32LE(0x04034b50, 0);   // firma de archivo local
    enc.writeUInt16LE(20, 4);           // versión necesaria
    enc.writeUInt16LE(0, 6);            // sin banderas
    enc.writeUInt16LE(0, 8);            // método 0 = guardado sin comprimir
    enc.writeUInt16LE(0, 10);           // hora — fija, para que el zip sea reproducible
    enc.writeUInt16LE(0x2821, 12);      // fecha — 1 de enero de 2000
    enc.writeUInt32LE(crc, 14);
    enc.writeUInt32LE(e.datos.length, 18);
    enc.writeUInt32LE(e.datos.length, 22);
    enc.writeUInt16LE(nombre.length, 26);
    enc.writeUInt16LE(0, 28);
    locales.push(enc, nombre, e.datos);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);   // firma de entrada del directorio
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x2821, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(e.datos.length, 20);
    dir.writeUInt32LE(e.datos.length, 24);
    dir.writeUInt16LE(nombre.length, 28);
    dir.writeUInt32LE(offset, 42);      // dónde empieza su encabezado local
    central.push(dir, nombre);

    offset += enc.length + nombre.length + e.datos.length;
  }

  const cuerpo = Buffer.concat(locales);
  const directorio = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(cuerpo.length, 16);
  return Buffer.concat([cuerpo, directorio, fin]);
}

const b = (s: string) => Buffer.from(s, 'utf8');

/**
 * Arma una planilla de una hoja con las filas que se le pasen.
 *
 * Todo entra como texto (`t="inlineStr"`), que es lo que hay en una lista de
 * correos y evita la tabla de cadenas compartidas.
 */
export function xlsxMinimo(filas: (string | null)[][], hoja = 'Hoja1'): Buffer {
  const celdas = filas
    .map((fila, f) => {
      const cs = fila
        .map((v, c) =>
          v == null || v === ''
            ? ''
            : `<c r="${String.fromCharCode(65 + c)}${f + 1}" t="inlineStr">` +
              `<is><t xml:space="preserve">${xml(v)}</t></is></c>`,
        )
        .join('');
      return `<row r="${f + 1}">${cs}</row>`;
    })
    .join('');

  return zip([
    {
      nombre: '[Content_Types].xml',
      datos: b(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      ),
    },
    {
      nombre: '_rels/.rels',
      datos: b(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      nombre: 'xl/_rels/workbook.xml.rels',
      datos: b(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      nombre: 'xl/workbook.xml',
      datos: b(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets><sheet name="${xml(hoja)}" sheetId="1" r:id="rId1"/></sheets>` +
          '</workbook>',
      ),
    },
    {
      nombre: 'xl/worksheets/sheet1.xml',
      datos: b(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          `<sheetData>${celdas}</sheetData></worksheet>`,
      ),
    },
    // Los dos que el lector exige aunque no tengan nada. Ver el encabezado.
    {
      nombre: 'xl/styles.xml',
      datos: b(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<cellXfs count="1"><xf/></cellXfs></styleSheet>',
      ),
    },
    {
      nombre: 'xl/sharedStrings.xml',
      datos: b(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'count="0" uniqueCount="0"/>',
      ),
    },
  ]);
}
