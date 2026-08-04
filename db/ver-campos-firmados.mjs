/**
 * db/ver-campos-firmados.mjs — ¿qué quedó adentro del último documento firmado?
 *
 * Contesta con hechos lo que a ojo no se puede contestar: si los valores están
 * en el archivo, si algún nombre de campo quedó repetido, y si el formulario del
 * cliente quedó editable después de firmar.
 *
 *   node db/ver-campos-firmados.mjs                 → el último archivo firmado
 *   node db/ver-campos-firmados.mjs ruta/al.pdf     → uno en particular
 *
 * ⚠ Es una lectura. No escribe nada y no toca la base.
 */
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = new URL('../datos/archivos/', import.meta.url).pathname;

/** El archivo más reciente del almacén, que es el que se acaba de firmar. */
function ultimoFirmado() {
  const todos = [];
  const caminar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) caminar(p);
      else todos.push({ p, t: fs.statSync(p).mtimeMs, b: fs.statSync(p).size });
    }
  };
  if (!fs.existsSync(RAIZ)) {
    console.error('No encuentro datos/archivos. Corré esto desde la raíz del repo.');
    process.exit(1);
  }
  caminar(RAIZ);
  // Un PDF firmado pesa bastante más que el original: el PKCS#7, el sello y las
  // apariencias. Los de pocos KB son certificados de finalización.
  const grandes = todos.filter((x) => x.b > 20_000).sort((a, b) => b.t - a.t);
  return (grandes[0] ?? todos.sort((a, b) => b.t - a.t)[0])?.p;
}

const archivo = process.argv[2] ?? ultimoFirmado();
if (!archivo) { console.error('No hay ningún archivo para mirar.'); process.exit(1); }

const bytes = fs.readFileSync(archivo);
console.log(`\n${path.basename(archivo)} · ${(bytes.length / 1024).toFixed(1)} KB · ` +
            `${new Date(fs.statSync(archivo).mtimeMs).toLocaleString('es-UY')}\n`);

const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
const campos = doc.getForm().getFields();

const vistos = new Map();
const repetidos = new Set();
const editables = [];
let firmas = 0, conValor = 0;

console.log('CAMPOS DEL DOCUMENTO');
console.log('─'.repeat(78));

for (const f of campos) {
  const n = f.getName();
  const clase = (f.constructor?.name ?? '').replace('PDF', '');
  vistos.set(n, (vistos.get(n) ?? 0) + 1);
  if (vistos.get(n) > 1) repetidos.add(n);

  let v = '';
  try {
    if (clase.includes('Signature')) { firmas++; v = '(firma)'; }
    else if (clase.includes('Text')) v = f.getText() ?? '';
    else if (clase.includes('CheckBox')) v = f.isChecked?.() ? 'sí' : '';
    else if (clase.includes('Dropdown') || clase.includes('OptionList')) v = (f.getSelected?.() ?? []).join(', ');
    else if (clase.includes('Button')) v = '(rúbrica)';
  } catch (e) { v = '‹no se pudo leer›'; }

  const bloqueado = f.isReadOnly();
  if (!bloqueado && !clase.includes('Signature')) editables.push(n);
  if (v && !clase.includes('Signature') && !clase.includes('Button')) conValor++;

  console.log(
    (repetidos.has(n) && vistos.get(n) > 1 ? '⚠ ' : '  ') +
    n.padEnd(30).slice(0, 30) + ' ' +
    clase.padEnd(11) + ' ' +
    (bloqueado ? '🔒' : '✎ ') + ' ' +
    (v ? JSON.stringify(v) : '—'));
}

console.log('─'.repeat(78));
console.log(`${campos.length} campos · ${firmas} firma(s) · ${conValor} con valor\n`);

console.log('VEREDICTO');
let mal = 0;

if (repetidos.size) {
  mal++;
  console.log(`  ✗ NOMBRES REPETIDOS: ${[...repetidos].join(', ')}`);
  console.log('    Un nombre de campo tiene que ser único en un AcroForm. Con dos');
  console.log('    iguales el lector muestra el primero —el original vacío— y los');
  console.log('    valores no se ven. Ver migración de nombres en services/campos.ts.');
} else {
  console.log('  ✓ ningún nombre de campo repetido');
}

if (editables.length) {
  mal++;
  console.log(`  ✗ ${editables.length} CAMPO(S) EDITABLE(S) sobre un documento firmado:`);
  console.log(`    ${editables.slice(0, 8).join(', ')}${editables.length > 8 ? '…' : ''}`);
  console.log('    Cualquiera puede escribir ahí y guardarlo: el documento se ve');
  console.log('    distinto y la firma sigue verificando. Lo bloquea normalizar()');
  console.log('    en firma/pades.ts, y sólo corre en el PRIMER firmado — un');
  console.log('    documento firmado antes de ese cambio no se arregla solo.');
} else {
  console.log('  ✓ ningún campo editable: el formulario quedó congelado');
}

if (!firmas) { mal++; console.log('  ✗ no tiene ningún campo de firma'); }
else console.log(`  ✓ ${firmas} firma(s) en el panel`);

if (!conValor) {
  console.log('  · ningún campo trae valor — si completaste alguno, algo se perdió');
} else {
  console.log(`  ✓ ${conValor} valor(es) adentro del archivo, legibles como dato`);
}

console.log(mal ? '\nHay algo que revisar.\n' : '\nEstá como tiene que estar.\n');
process.exit(mal ? 1 : 0);
