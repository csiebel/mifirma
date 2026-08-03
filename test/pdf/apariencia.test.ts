/**
 * `huecoVisible()` y `sellar()`: el camino real de firmar, sin base de datos.
 *
 * Casos de borde, encadenamiento de firmas, y lo que TIENE que fallar. Que un
 * error salga con el mensaje correcto es parte de la función: el 2/8 el usuario
 * vio «El documento tiene 1 página(s): la 3 no existe» y con eso solo supo qué
 * había pasado.
 */
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { SignPdf } from '@signpdf/signpdf';
import { huecoVisible, type Marca } from '../../src/firma/apariencia';
import { normalizar, sellar, verificar } from '../../src/firma/pades';
import { base, firma, firmanteLab, prepararFixtures, rubrica, sinPoppler } from './fixtures';
import { firmasSegunPoppler, guardar } from './inspeccion';

const signpdf = new SignPdf();
let FIRMA: Buffer;
let RUBRICA: Buffer;
let BASE: Buffer;

before(async () => {
  await prepararFixtures();
  FIRMA = firma();
  RUBRICA = rubrica();
  BASE = await normalizar(base());
});

const firmarCon = (pdf: Buffer, marcas: Marca[], nombre: string, quien: 'a' | 'b') =>
  signpdf.sign(
    huecoVisible({ pdf, marcas, razon: `Firmado por ${nombre}`, nombre, largoFirma: 16384 }),
    firmanteLab(quien).signer(),
  );

describe('huecoVisible: casos de borde', () => {
  test('una sola marca: verifica y se lee quién firmó', async () => {
    const p = await firmarCon(BASE, [{ pagina: 0, rect: [80, 100, 250, 155], imagen: FIRMA }],
                              'Ana Pérez', 'a');
    const v = verificar(p);
    assert.ok(v.integro);
    assert.equal(v.firmas.length, 1);
    assert.equal(v.firmas[0]!.nombre_declarado, 'Ana Pérez');
  });

  test('acentos y eñes en el nombre declarado van y vuelven', async () => {
    // ⚠ El nombre viaja como cadena de PDF en UTF-16BE. Escribirla en UTF-8
    // —que es lo que hace `Buffer.from(str)` por omisión— produce «PÃ©rez» en
    // el panel de firmas de cualquier lector.
    const p = await firmarCon(BASE, [{ pagina: 0, rect: [80, 100, 250, 155], imagen: FIRMA }],
                              'Ñandú Güemes-Peña', 'a');
    assert.equal(verificar(p).firmas[0]!.nombre_declarado, 'Ñandú Güemes-Peña');
  });

  test('tres firmas encadenadas: alcances y nombres en orden', async () => {
    let p = BASE;
    for (const [i, n] of ['Ana Pérez', 'Beto Silva', 'Carla Núñez'].entries()) {
      p = await firmarCon(p, [
        { pagina: 0, rect: [430, 60 + i * 50, 485, 100 + i * 50], imagen: RUBRICA },
        { pagina: 2, rect: [70, 100 + i * 60, 240, 155 + i * 60], imagen: FIRMA, principal: true },
      ], n, i % 2 ? 'b' : 'a');
    }
    const v = verificar(p);
    guardar('apariencia_tres.pdf', p);
    assert.equal(v.firmas.length, 3);
    assert.ok(v.integro);
    assert.ok(v.firmas.every((f) => f.verifica));
    // Sólo la última cubre el archivo hasta el final; las anteriores tienen
    // bytes después, que son las firmas que vinieron a continuación.
    assert.deepEqual(v.firmas.map((f) => f.alcance),
                     ['firma_posterior', 'firma_posterior', 'final']);
    assert.deepEqual(v.firmas.map((f) => f.nombre_declarado),
                     ['Ana Pérez', 'Beto Silva', 'Carla Núñez']);
  });

  test('sin marcas: el hueco invisible también es nuestro', async (t) => {
    // Antes este camino usaba `plainAddPlaceholder`, que corrompe la página
    // cuando su `/Annots` es una referencia indirecta. Un camino solo, probado.
    const p = await signpdf.sign(
      huecoVisible({ pdf: BASE, marcas: [], razon: 'Firmado por Ana', nombre: 'Ana Pérez',
                     largoFirma: 16384 }),
      firmanteLab('a').signer(),
    );
    const v = verificar(p);
    assert.ok(v.integro);
    assert.equal(v.firmas.length, 1);

    if (sinPoppler()) return t.skip(String(sinPoppler()));
    const archivo = guardar('apariencia_invisible.pdf', p);
    const s = firmasSegunPoppler(archivo);
    assert.equal(s.campos, 1, 'el lector tiene que ver el campo de firma');
    assert.ok(!s.sinFirmar, 'ningún lector puede decir que el campo no está firmado');
    if (s.puedeValidar) assert.ok(s.validas === 1, s.texto);
  });
});

describe('huecoVisible: lo que tiene que fallar, y con qué mensaje', () => {
  const casos: [string, RegExp, () => unknown][] = [
    ['página que no existe', /no existe la 10/,
     () => huecoVisible({ pdf: BASE, razon: '', nombre: '',
                          marcas: [{ pagina: 9, rect: [0, 0, 10, 10], imagen: FIRMA }] })],
    ['imagen que no es PNG', /no es PNG/,
     () => huecoVisible({ pdf: BASE, razon: '', nombre: '',
                          marcas: [{ pagina: 0, rect: [0, 0, 10, 10],
                                     imagen: Buffer.from('JFIF no soy un png') }] })],
    ['PNG sin un solo trazo', /trazo|trans/i,
     () => huecoVisible({ pdf: BASE, razon: '', nombre: '',
                          marcas: [{ pagina: 0, rect: [0, 0, 10, 10], imagen: pngVacio() }] })],
    ['marca con imagen Y texto a la vez', /uno y sólo uno/,
     () => huecoVisible({ pdf: BASE, razon: '', nombre: '',
                          marcas: [{ pagina: 0, rect: [0, 0, 10, 10], imagen: FIRMA, texto: 'x' }] })],
  ];
  for (const [titulo, mensaje, f] of casos) {
    test(titulo, () => assert.throws(f, mensaje));
  }
});

describe('sellar: el camino real de firmar', () => {
  const marcas = (): Marca[] => [
    { pagina: 0, rect: [430, 60, 485, 100], imagen: RUBRICA },
    { pagina: 1, rect: [430, 60, 485, 100], imagen: RUBRICA },
    { pagina: 2, rect: [430, 60, 485, 100], imagen: RUBRICA },
    { pagina: 2, rect: [70, 150, 240, 205], imagen: FIRMA, principal: true },
  ];

  test('con marcas: estampa las cuatro y verifica', async () => {
    const r = await sellar(BASE, { razon: 'Firmado por Ana Pérez', nombre: 'Ana Pérez',
                                   marcas: marcas() }, firmanteLab('a'));
    assert.equal(r.marcasEstampadas, 4);
    assert.equal(r.errorMarca, null);
    assert.ok(verificar(r.pdf).integro);
  });

  test('sin marcas: se firma igual y el documento vale lo mismo', async () => {
    // Regla de oro nº1. Un documento sin marca está firmado igual.
    const r = await sellar(BASE, { razon: 'Firmado por Beto Silva', nombre: 'Beto Silva' },
                           firmanteLab('b'));
    assert.equal(r.marcasEstampadas, 0);
    assert.equal(r.errorMarca, null);
    assert.ok(verificar(r.pdf).integro);
  });

  test('la imagen no se puede dibujar: se firma, y queda dicho por qué', async () => {
    // Perder la firma —lo único con valor legal— porque un PNG venía en un
    // formato que no sabemos leer sería dejar que la decoración decida sobre lo
    // jurídico. La ausencia de la marca tiene que ser un hecho explicado.
    const r = await sellar(BASE, {
      razon: 'Firmado por Carla Núñez', nombre: 'Carla Núñez',
      marcas: [{ pagina: 0, rect: [80, 100, 250, 155],
                 imagen: Buffer.from('esto es un JPEG, digamos') }],
    }, firmanteLab('a'));
    const v = verificar(r.pdf);
    assert.ok(v.integro);
    assert.equal(v.firmas.length, 1);
    assert.equal(r.marcasEstampadas, 0);
    assert.ok(r.errorMarca, 'tiene que decir por qué no se dibujó');
  });

  test('encadenado con, sin, con: las tres firmas siguen verificando', async () => {
    let pdf = BASE;
    const quienes: [string, 'a' | 'b', Marca[] | undefined][] = [
      ['Ana Pérez', 'a', marcas()],
      ['Beto Silva', 'b', undefined],
      ['Carla Núñez', 'a', marcas().map((m) => ({
        ...m, rect: [m.rect[0], m.rect[1] + 60, m.rect[2], m.rect[3] + 60] as Marca['rect'],
      }))],
    ];
    for (const [nombre, quien, ms] of quienes) {
      pdf = (await sellar(pdf, { razon: `Firmado por ${nombre}`, nombre, marcas: ms },
                          firmanteLab(quien))).pdf;
    }
    const v = verificar(pdf);
    guardar('apariencia_mixto.pdf', pdf);
    assert.ok(v.integro);
    assert.equal(v.firmas.length, 3);
    assert.ok(v.firmas.every((f) => f.verifica),
              v.firmas.map((f) => `${f.nombre_declarado}:${f.verifica}`).join(' '));
  });
});

/** PNG RGBA 20×20 completamente transparente: no tiene un solo píxel de tinta. */
function pngVacio(): Buffer {
  const ancho = 20, alto = 20;
  const filas = Buffer.alloc(alto * (ancho * 4 + 1));
  const crc = (b: Buffer) => {
    let c = -1;
    for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    return (c ^ -1) >>> 0;
  };
  const trozo = (tipo: string, datos: Buffer) => {
    const b = Buffer.alloc(8 + datos.length + 4);
    b.writeUInt32BE(datos.length, 0); b.write(tipo, 4, 'latin1'); datos.copy(b, 8);
    b.writeUInt32BE(crc(Buffer.concat([Buffer.from(tipo, 'latin1'), datos])), 8 + datos.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0); ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr), trozo('IDAT', zlib.deflateSync(filas)), trozo('IEND', Buffer.alloc(0)),
  ]);
}
