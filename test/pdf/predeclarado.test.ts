/**
 * Los widgets pre-declarados: la firma COMPLETA, no AGREGA.
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * Medido en Acrobat el 8/8 con tres PDF de laboratorio que difieren en una sola
 * cosa (`claude/cambios-posteriores-a-la-firma.md`): agregar un campo de
 * formulario después de una firma **no** está entre los cambios que un lector da
 * por permitidos —dice «El documento se ha modificado o dañado desde que fue
 * firmado»— y completar uno que ya estaba, **sí**. Con N firmantes, la forma
 * vieja dejaba N−1 firmas en rojo sobre un documento legítimo.
 *
 * Acrobat no se puede correr desde acá. Lo que sí se puede es comprobar la
 * propiedad EXACTA que Acrobat mira: **que el objeto del widget sea uno que ya
 * existía antes de la primera firma**. Si el índice es anterior, la firma lo
 * reescribió; si es posterior, lo agregó. Esa es toda la diferencia.
 *
 * ⚠ Por eso el caso 4 firma el MISMO documento sin pre-declarar y exige el
 * resultado contrario. Sin ese control, esta prueba podría estar pasando porque
 * la medición no mide nada.
 *
 * De paso quedan dos de las tres comprobaciones que el 8/8 se pidieron para el
 * banco y que habrían encontrado defectos de ese día sin que nadie mirara:
 * nombres duplicados en el AcroForm, y `undefined`/`null` adentro de un nombre.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { huecoVisible, predeclarar, type Marca, type WidgetPredeclarado } from '../../src/firma/apariencia';
import { normalizar, verificar } from '../../src/firma/pades';
import { base, firma, firmanteLab, prepararFixtures, rubrica } from './fixtures';
import { acroformFinal, estructura } from './inspeccion';

const req = createRequire(import.meta.url);
const readPdf = req('@signpdf/placeholder-plain/dist/readPdf').default;

const signpdf = new SignPdf();

/** Los dos campos del documento: uno del lugar 1 y otro del lugar 2. */
const WIDGETS: WidgetPredeclarado[] = [
  { nombre: 'nombre__mf1', pagina: 0, rect: [80, 700, 300, 722] },
  { nombre: 'cargo__mf2', pagina: 0, rect: [80, 650, 300, 672] },
];

let BASE: Buffer;
let FORM: Buffer;
let FIRMA: Buffer;
let RUBRICA: Buffer;

before(async () => {
  await prepararFixtures();
  BASE = base();
  FIRMA = firma();
  RUBRICA = rubrica();

  // Un documento que YA trae AcroForm propio, que es la mitad de lo que sube un
  // cliente. Es el otro camino de `predeclarar()`: reescribir el diccionario que
  // había en vez de crear uno.
  const doc = await PDFDocument.create();
  const pag = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  pag.drawText('SOLICITUD', { x: 50, y: 800, size: 14, font: helv });
  const f = doc.getForm().createTextField('razon_social');
  f.setText('');
  f.addToPage(pag, { x: 180, y: 760, width: 320, height: 22 });
  FORM = Buffer.from(await doc.save({ useObjectStreams: false }));
});

/** Firma una vez, completando los campos que se le pasen. */
const firmarCon = (pdf: Buffer, marcas: Marca[], nombre: string, quien: 'a' | 'b') =>
  signpdf.sign(
    huecoVisible({ pdf, marcas, razon: `Firmado por ${nombre}`, nombre, largoFirma: 16384 }),
    firmanteLab(quien).signer(),
  );

/** El valor de un campo, tal como lo manda `prepararCampos`. */
const valor = (etiqueta: string, texto: string, rect: [number, number, number, number]): Marca =>
  ({ pagina: 0, rect, texto, modo: 'campo', etiqueta });

/** Nombre del campo → referencia del objeto, según el AcroForm que gana. */
function porNombre(pdf: Buffer): Map<string, string> {
  const { campos } = acroformFinal(pdf);
  const m = new Map<string, string>();
  for (const c of estructura(pdf, campos)) m.set(c.nombre, c.campo);
  return m;
}

const indice = (ref: string) => Number(ref.split(/\s+/)[0]);

/**
 * Las dos comprobaciones que se contestan solas sobre cualquier documento
 * firmado. Van juntas porque las dos preguntan lo mismo: si el AcroForm quedó
 * diciendo algo que ningún lector puede resolver bien.
 */
function acroformSano(pdf: Buffer) {
  const { campos } = acroformFinal(pdf);
  // ⚠ Se saltean los `?`: son los campos cuyo `/T` es hexadecimal —los que
  // escribe pdf-lib— y `estructura()` no los sabe nombrar. Contarlos como
  // iguales entre sí inventaría duplicados que no existen.
  const nombres = estructura(pdf, campos).map((c) => c.nombre).filter((n) => n !== '?');
  const repetidos = nombres.filter((n, i) => nombres.indexOf(n) !== i);
  const rotos = nombres.filter((n) => /undefined|null|NaN/.test(n));
  return { nombres, repetidos, rotos };
}

test('pre-declarar deja los widgets en /Fields, en /Annots y marcados como nuestros', async () => {
  const norm = await normalizar(BASE, WIDGETS);
  const s = norm.toString('latin1');

  const mapa = porNombre(norm);
  for (const w of WIDGETS) {
    assert.ok(mapa.has(w.nombre), `«${w.nombre}» no quedó en el /Fields del AcroForm`);
  }

  // ⚠ Sin `/MiFirma true` no los reconoceríamos al firmar, y —peor— podríamos
  // reescribir un campo del cliente que se llamara igual.
  assert.equal((s.match(/\/MiFirma\s+true/g) || []).length, WIDGETS.length);

  // Y el `/T` tiene que ser CADENA LITERAL. Es la forma que sabe leer
  // `widgetsPredeclarados()`; en hexadecimal no reconocería ninguno y el arreglo
  // entero no haría nada sin un solo error a la vista.
  for (const w of WIDGETS) assert.ok(s.includes(`/T (${w.nombre})`), `el /T de «${w.nombre}» no es literal`);

  // En el `/Annots` de la página. Un campo que está en `/Fields` y no en la
  // página no se dibuja — y si la firma tuviera que agregarlo a `/Annots`
  // después, ese cambio solo ya alcanza para que Acrobat se queje.
  const info = readPdf(norm);
  const annots = /\/Annots\s*\[([^\]]*)\]/.exec(s.slice(s.lastIndexOf('/Type /Page')))
    ?? /\/Annots\s*\[([^\]]*)\]/.exec(s);
  for (const w of WIDGETS) {
    const ref = mapa.get(w.nombre)!;
    assert.ok(annots?.[1]?.includes(ref.split(' ')[0]!), `«${w.nombre}» no está en el /Annots de su hoja`);
    assert.ok(indice(ref) <= info.xref.maxIndex);
  }
});

test('dos firmas COMPLETAN los widgets: los objetos son los de antes de firmar', async () => {
  const norm = await normalizar(BASE, WIDGETS);
  const antes = porNombre(norm);
  const maxAntes = readPdf(norm).xref.maxIndex;

  const uno = await firmarCon(norm, [valor('nombre__mf1', 'Ana Pérez', [80, 700, 300, 722])],
                              'Ana Pérez', 'a');
  const dos = await firmarCon(uno, [valor('cargo__mf2', 'Directora', [80, 650, 300, 672])],
                              'Beto Silva', 'b');

  // Lo primero: que el documento siga siendo un documento.
  const v = verificar(dos);
  assert.equal(v.firmas.length, 2);
  assert.ok(v.firmas.every((f) => f.verifica), 'alguna firma no verifica');
  assert.ok(v.integro, 'quedaron bytes que ninguna firma cubre');

  // ⚠ Y lo que decide todo: el objeto del widget es el MISMO que ya existía
  // antes de la primera firma. Si el índice fuera mayor que `maxAntes`, la firma
  // lo habría agregado, y Acrobat diría «el documento se ha modificado o dañado
  // desde que fue firmado» en todas las firmas menos la última.
  const despues = porNombre(dos);
  for (const w of WIDGETS) {
    assert.ok(despues.has(w.nombre), `«${w.nombre}» desapareció del AcroForm`);
    assert.equal(indice(despues.get(w.nombre)!), indice(antes.get(w.nombre)!),
                 `«${w.nombre}» se agregó de nuevo en vez de completarse`);
    assert.ok(indice(despues.get(w.nombre)!) <= maxAntes);
  }

  // El valor entró de verdad, y no sólo el widget vacío.
  const s = dos.toString('latin1');
  assert.ok(s.includes('(Ana Pérez)') || s.includes('Ana P'), 'no se escribió el valor del lugar 1');

  const sano = acroformSano(dos);
  assert.deepEqual(sano.repetidos, [], 'hay nombres repetidos en el AcroForm');
  assert.deepEqual(sano.rotos, [], 'hay un undefined/null adentro de un nombre de campo');

  // Los dos widgets + los dos campos de firma, y nada más. Un widget de más es
  // uno duplicado que el lector puede llegar a mostrar vacío.
  assert.equal(sano.nombres.length, 4);
});

/**
 * ⚠⚠ LA PRUEBA QUE JUSTIFICA QUE `predeclarar()` ESCRIBA BYTES.
 *
 * `widgetsPredeclarados()` reconoce el `/T` con una regex de CADENA LITERAL, y
 * dice —correctamente— que no hace falta cubrir la hexadecimal «porque no la
 * generamos». Acá se mide qué genera pdf-lib, que es con lo que se hizo la
 * primera versión de esto: **`/T <FEFF00720061...>`, hexadecimal UTF-16**.
 *
 * O sea que si estos widgets los hubiera escrito la API de formularios de
 * pdf-lib, no se habría reconocido ni uno, cada firma habría vuelto a AGREGAR,
 * y el arreglo entero no habría hecho nada — sin un solo error a la vista, y
 * enterándonos recién al abrir el documento en Acrobat.
 *
 * Es el mismo tipo de defecto que las cuatro lecciones del 7/8: lo que se ve no
 * es lo que hay.
 */
test('nuestro /T es literal y el de pdf-lib es hexadecimal: por eso esto se escribe con bytes', async () => {
  const norm = await normalizar(FORM, WIDGETS);
  const nombres: string[] = norm.toString('latin1').match(/\/T\s*[(<][^)>]*[)>]/g) ?? [];

  // El del cliente, escrito por pdf-lib.
  assert.ok(nombres.some((t) => /^\/T\s*<FEFF/i.test(t)),
            'pdf-lib dejó de escribir el /T en hexadecimal: revisar widgetsPredeclarados()');
  // Los nuestros, escritos por predeclarar().
  for (const w of WIDGETS) assert.ok(nombres.includes(`/T (${w.nombre})`));
});

test('sobre un formulario del cliente: se reescribe su AcroForm, no se pierde el suyo', async () => {
  const norm = await normalizar(FORM, WIDGETS);
  const mapa = porNombre(norm);

  // El campo del cliente sigue estando —su `/T` es hexadecimal, así que
  // `estructura()` no lo sabe nombrar— y los nuestros se sumaron.
  assert.equal(acroformFinal(norm).campos.length, 3, 'el AcroForm no quedó con el del cliente más los dos nuestros');
  for (const w of WIDGETS) assert.ok(mapa.has(w.nombre));

  const firmado = await firmarCon(norm, [valor('nombre__mf1', 'Ana Pérez', [80, 700, 300, 722])],
                                  'Ana Pérez', 'a');
  const v = verificar(firmado);
  assert.equal(v.firmas.length, 1);
  assert.ok(v.integro);

  assert.equal(indice(porNombre(firmado).get('nombre__mf1')!), indice(mapa.get('nombre__mf1')!));

  const sano = acroformSano(firmado);
  assert.deepEqual(sano.repetidos, []);
  assert.deepEqual(sano.rotos, []);
});

test('EL CONTROL: sin pre-declarar, la firma AGREGA — que es lo que Acrobat castiga', async () => {
  // Mismo documento, mismos valores, sin la lista. Si esto también diera
  // «índice anterior», la comprobación de arriba no estaría midiendo nada.
  const norm = await normalizar(BASE);
  const maxAntes = readPdf(norm).xref.maxIndex;

  const firmado = await firmarCon(norm, [valor('nombre__mf1', 'Ana Pérez', [80, 700, 300, 722])],
                                  'Ana Pérez', 'a');

  const ref = porNombre(firmado).get('nombre__mf1');
  assert.ok(ref, 'el widget no llegó al AcroForm ni por el camino viejo');
  assert.ok(indice(ref) > maxAntes,
            'sin pre-declarar el widget tendría que ser un objeto NUEVO; si no lo es, el control no sirve');
});

/**
 * ═══ FASE 2: LAS MARCAS ═══
 *
 * Es lo único que quedaba agregándose después de una firma, y con eso solo
 * alcanzaba para el cartel: medido en Acrobat el 8/8 sobre un documento real,
 * «Campos de formulario agregados: Campo `Marca1_MiFirma2`».
 *
 * ⚠ Los nombres van escritos a mano y no importados de `services/marcas.ts`, a
 * propósito. Primero porque importarlo arrastraría la capa de base de datos a
 * una prueba de PDF; y segundo porque este formato es un contrato entre dos
 * momentos separados por una firma: si alguien lo cambia, esta prueba tiene que
 * romperse y obligarlo a pensar, no seguirlo en silencio.
 */
const LUGARES_DE_MARCA: WidgetPredeclarado[] = [1, 2].flatMap((mf) =>
  [0, 1, 2].flatMap((h) =>
    (['firma', 'rubrica'] as const).map((tipo) => ({
      nombre: `marca_${tipo}_h${h + 1}__mf${mf}`,
      pagina: h,
      // En cero a propósito: un lugar reservado no tiene por qué verse, y con
      // «Resaltar campos existentes» un rectángulo de tamaño cero no pinta nada.
      rect: [0, 0, 0, 0] as [number, number, number, number],
      clase: 'marca' as const,
    }))));

test('fase 2: las rúbricas COMPLETAN su lugar, y sólo el campo de firma se agrega', async () => {
  const todos = [...WIDGETS, ...LUGARES_DE_MARCA];
  const norm = await normalizar(BASE, todos);
  const maxAntes = readPdf(norm).xref.maxIndex;
  const antes = porNombre(norm);

  // Los 12 lugares de marca existen antes de que exista ninguna firma.
  for (const w of LUGARES_DE_MARCA) {
    assert.ok(antes.has(w.nombre), `no se reservó «${w.nombre}»`);
  }
  // Y nacen como BOTÓN, que es lo que van a ser. Si nacieran como campo de
  // texto, completarlos les cambiaría el tipo adentro de un documento firmado —
  // una variable que el laboratorio nunca aisló.
  const s = norm.toString('latin1');
  assert.equal((s.match(/\/FT\s*\/Btn/g) || []).length, LUGARES_DE_MARCA.length);

  /** El lugar 1 firma: su firma completa (principal) y una rúbrica en la hoja 1. */
  const uno = await firmarCon(norm, [
    { pagina: 2, rect: [70, 100, 240, 155], imagen: FIRMA, principal: true,
      etiqueta: 'marca_firma_h3__mf1' },
    { pagina: 0, rect: [430, 60, 485, 100], imagen: RUBRICA, etiqueta: 'marca_rubrica_h1__mf1' },
  ], 'Ana Pérez', 'a');

  const dos = await firmarCon(uno, [
    { pagina: 2, rect: [280, 100, 450, 155], imagen: FIRMA, principal: true,
      etiqueta: 'marca_firma_h3__mf2' },
    { pagina: 0, rect: [430, 120, 485, 160], imagen: RUBRICA, etiqueta: 'marca_rubrica_h1__mf2' },
  ], 'Beto Silva', 'b');

  const v = verificar(dos);
  assert.equal(v.firmas.length, 2);
  assert.ok(v.firmas.every((f) => f.verifica));
  assert.ok(v.integro);

  const despues = porNombre(dos);

  // ⚠ LO QUE DECIDE TODO: las rúbricas conservan su objeto, o sea que se
  // completaron. Si el índice fuera mayor que `maxAntes`, se habrían agregado y
  // Acrobat volvería a decir «el documento se ha modificado o dañado».
  for (const n of ['marca_rubrica_h1__mf1', 'marca_rubrica_h1__mf2']) {
    assert.ok(despues.has(n), `«${n}» desapareció`);
    assert.equal(indice(despues.get(n)!), indice(antes.get(n)!), `«${n}» se agregó en vez de completarse`);
    assert.ok(indice(despues.get(n)!) <= maxAntes);
  }

  // Lo único nuevo son los dos campos de FIRMA, y agregarlos está permitido.
  const nuevos = acroformSano(dos).nombres.filter((n) => {
    const r = despues.get(n);
    return r && indice(r) > maxAntes;
  });
  assert.deepEqual(nuevos.sort(), ['MiFirma1', 'MiFirma2'],
                   `se agregó algo que no es un campo de firma: ${nuevos.join(', ')}`);

  const sano = acroformSano(dos);
  assert.deepEqual(sano.repetidos, []);
  assert.deepEqual(sano.rotos, []);
});

test('fase 2: un lugar de marca que nadie usa no se ve ni estorba', async () => {
  const norm = await normalizar(BASE, [...WIDGETS, ...LUGARES_DE_MARCA]);
  // Se firma sin ninguna marca: los 12 lugares quedan vacíos para siempre.
  const p = await firmarCon(norm, [valor('nombre__mf1', 'Ana Pérez', [80, 700, 300, 722])],
                            'Ana Pérez', 'a');
  assert.ok(verificar(p).integro);

  const sano = acroformSano(p);
  assert.deepEqual(sano.repetidos, []);
  assert.deepEqual(sano.rotos, []);
  // Siguen ahí, en cero, sin apariencia propia y sin valor.
  assert.equal(LUGARES_DE_MARCA.filter((w) => sano.nombres.includes(w.nombre)).length,
               LUGARES_DE_MARCA.length);
});

test('sin lista, el archivo sale byte por byte como salía antes', async () => {
  // Un circuito despachado antes de que esto existiera no tiene nada
  // pre-declarado, y tiene que seguir firmando exactamente igual.
  const doc = await normalizar(BASE);
  assert.ok(Buffer.isBuffer(doc));
  assert.equal(predeclarar(doc, []).compare(doc), 0);
});

test('un campo que apunta a una hoja que no existe no impide firmar', async () => {
  // Pre-declarar es una mejora de lo que el cliente LEE. Cambiar un cartel feo
  // por un documento que no se puede firmar sería un mal negocio.
  const norm = await normalizar(BASE, [
    { nombre: 'bueno__mf1', pagina: 0, rect: [80, 700, 300, 722] },
    { nombre: 'imposible__mf1', pagina: 40, rect: [80, 650, 300, 672] },
  ]);
  const mapa = porNombre(norm);
  assert.ok(mapa.has('bueno__mf1'));
  assert.ok(!mapa.has('imposible__mf1'));

  const firmado = await firmarCon(norm, [valor('bueno__mf1', 'Ana', [80, 700, 300, 722])], 'Ana', 'a');
  assert.ok(verificar(firmado).integro);
});
