/**
 * El certificado de finalización: el entregable que un abogado va a mirar.
 *
 * `dibujar()` es una función pura —no toca base ni archivos—, así que se puede
 * probar con datos inventados. Los dos casos son a propósito: el bonito y **el
 * feo**, porque un certificado sirve para lo que dice cuando algo salió mal.
 *
 * ⚠ Lo que vigila esta prueba son tres defectos que ya pasaron:
 *   · el certificado salía con 6 páginas, 4 de ellas EN BLANCO (el pie cerca
 *     del margen inferior hacía que pdfkit agregara hoja);
 *   · «⚠» salía dibujado como «&», porque las 14 fuentes estándar del PDF no
 *     son Unicode y nadie lo había mirado;
 *   · el recuadro de alarma se pintaba con `rect().fill()`, que no mueve el
 *     cursor, y se superponía con el encabezado.
 *
 * Los tres se encontraron **renderizando el PDF y mirándolo**, no leyendo el
 * código. Los archivos quedan en `test/pdf/fixtures/salida/` justamente para
 * poder seguir haciéndolo.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dibujar, type DatosCertificado } from '../../src/services/certificado_pdf';
import { correr, prepararFixtures, sinPoppler } from './fixtures';
import { extraer, guardar, paginasConTinta } from './inspeccion';

const BASE: DatosCertificado = {
  version_plantilla: 1,
  emitido_en: '2026-08-02T18:32:11.000Z',
  circuito: {
    id: '8f14e45f-ceea-467a-9c6e-5b1c2f0a77d1',
    instancia_id: 'c9b1d2e3-4f5a-4b6c-8d9e-0a1b2c3d4e5f',
    numero: 1, instancias: 1,
    titulo: 'Contrato de prestación de servicios profesionales',
    modo: 'serie', nivel_firma: 'simple', pais: 'UY',
    emisor: 'Interfase S.A.',
    creado_en: '2026-07-28T13:02:00.000Z',
    enviado_en: '2026-07-28T14:11:09.000Z',
    cerrado_en: '2026-08-01T09:44:52.000Z',
    estado: 'completo',
  },
  documento: {
    sha256_base: '3b1f8a2c9d4e5f60718293a4b5c6d7e8f9012345678910abcdef0123456789ab',
    sha256_firmado: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
    paginas: 3, bytes: 141_204,
    firmas_en_el_pdf: 2, integro: true, contenido_alterado_entre_firmas: false,
    cambios: ['Después de la firma 1: Se agregó la firma, 3 marca(s) autógrafa(s), ' +
              'su campo de firma. Ninguna página cambió de contenido.'],
  },
  firmantes: [
    {
      nombre: 'Claudio Siebel Viera', email: 'csiebel@mac.com', papel: 'firmante', orden: 1,
      estado: 'firmada', firmada_en: '2026-07-29T16:20:03.000Z', nivel_garantia: 'bajo',
      identificacion: [{ tipo: 'email', probado_en: '2026-07-29T16:18:44.000Z' }],
      certificado: null,
      sello: { autoridad: 'DigiCert', sellado_en: '2026-07-29T16:20:04.000Z',
               serie: '9f2c1a77bd0e4413' },
      cronologia: [
        { tipo: 'notificacion.enviada', cuando: '2026-07-28T14:11:12.000Z', ip: null },
        { tipo: 'documento.abierto', cuando: '2026-07-29T16:17:52.000Z', ip: '190.64.12.8' },
        { tipo: 'identidad.probada', cuando: '2026-07-29T16:18:44.000Z', ip: '190.64.12.8' },
        { tipo: 'consentimiento.dado', cuando: '2026-07-29T16:20:01.000Z', ip: '190.64.12.8' },
        { tipo: 'firma.aplicada', cuando: '2026-07-29T16:20:03.000Z', ip: '190.64.12.8' },
        { tipo: 'firma.sellada', cuando: '2026-07-29T16:20:04.000Z', ip: null },
      ],
      motivo_rechazo: null,
    },
    {
      nombre: 'Ana Pérez Ñandú', email: 'ana.perez@empresa.com.uy', papel: 'firmante', orden: 2,
      estado: 'firmada', firmada_en: '2026-08-01T09:44:50.000Z', nivel_garantia: 'bajo',
      identificacion: [
        { tipo: 'email', probado_en: '2026-08-01T09:41:02.000Z' },
        { tipo: 'telefono', probado_en: '2026-08-01T09:42:30.000Z' },
      ],
      certificado: null,
      sello: { autoridad: 'Sectigo', sellado_en: '2026-08-01T09:44:51.000Z',
               serie: '3ac09b12ff87e650' },
      cronologia: [
        { tipo: 'notificacion.enviada', cuando: '2026-07-29T16:20:10.000Z', ip: null },
        { tipo: 'documento.abierto', cuando: '2026-08-01T09:40:15.000Z', ip: '181.42.99.201' },
        { tipo: 'documento.visto', cuando: '2026-08-01T09:40:40.000Z', ip: '181.42.99.201' },
        { tipo: 'identidad.probada', cuando: '2026-08-01T09:41:02.000Z', ip: '181.42.99.201' },
        { tipo: 'consentimiento.dado', cuando: '2026-08-01T09:44:48.000Z', ip: '181.42.99.201' },
        { tipo: 'firma.aplicada', cuando: '2026-08-01T09:44:50.000Z', ip: '181.42.99.201' },
      ],
      motivo_rechazo: null,
    },
  ],
  evidencia: {
    eventos: 21, huecos: 0, rotos: 0, cadena_ok: true,
    hash_raiz: '7d4e1f9a0b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789',
  },
};

/** El caso feo: cadena rota, PDF alterado entre firmas y un rechazo. */
function feo(): DatosCertificado {
  const f: DatosCertificado = JSON.parse(JSON.stringify(BASE));
  f.evidencia = { eventos: 19, huecos: 1, rotos: 2, cadena_ok: false,
                  hash_raiz: f.evidencia.hash_raiz };
  f.documento.integro = true;
  f.documento.contenido_alterado_entre_firmas = true;
  f.documento.cambios = ['⚠ Después de la firma 1: Cambió lo que muestran 1 página(s) ' +
                         'del documento (/Contents).'];
  f.firmantes[1]!.estado = 'rechazada';
  f.firmantes[1]!.firmada_en = null;
  f.firmantes[1]!.sello = null;
  f.firmantes[1]!.motivo_rechazo = 'El monto de la cláusula 4 no es el que habíamos acordado.';
  f.firmantes[1]!.identificacion = [];
  return f;
}

before(prepararFixtures);

const paginasDe = (archivo: string) =>
  Number(correr('pdfinfo', [archivo]).split('\n')
    .find((l) => l.startsWith('Pages'))?.split(/\s+/)[1] ?? 0);

test('el certificado completo: sin hojas en blanco y con todo adentro', async (t) => {
  const pdf = await dibujar(BASE);
  const archivo = guardar('certificado_bueno.pdf', pdf);
  assert.ok(pdf.length > 3000, 'un certificado de 3 KB es un certificado vacío');

  if (sinPoppler()) return t.skip(String(sinPoppler()));
  const hojas = paginasDe(archivo);
  assert.ok(hojas >= 1 && hojas <= 3, `${hojas} hojas: el pie está empujando páginas de más`);
  assert.equal(paginasConTinta(archivo, hojas).length, hojas, 'ninguna hoja puede quedar vacía');

  // ⚠ Sin acentos no alcanza con buscar en minúscula: los encabezados de cada
  // firmante van en mayúsculas («FIRMANTE 2 — ANA PÉREZ ÑANDÚ»), así que la
  // comparación va sin distinguir caja. La primera versión de esta prueba dio
  // un falso negativo por eso.
  const texto = extraer(archivo).toLocaleLowerCase('es');
  for (const debe of ['Claudio Siebel Viera', 'Ana Pérez Ñandú', 'Interfase S.A.',
                      'DigiCert', '190.64.12.8']) {
    assert.ok(texto.includes(debe.toLocaleLowerCase('es')),
              `falta «${debe}» en el certificado`);
  }
  // Las 14 fuentes estándar del PDF no son Unicode: sin el saneador, «Ñandú»
  // sale «?and?» y el certificado que se presenta en un juicio dice otro nombre.
  assert.ok(!texto.includes('?and'), 'el saneador WinAnsi se comió un acento');
});

test('el certificado feo GRITA lo que salió mal', async (t) => {
  const pdf = await dibujar(feo());
  const archivo = guardar('certificado_feo.pdf', pdf);

  if (sinPoppler()) return t.skip(String(sinPoppler()));
  const hojas = paginasDe(archivo);
  assert.equal(paginasConTinta(archivo, hojas).length, hojas);

  const texto = extraer(archivo).toLowerCase();
  // Un certificado que informa un problema con la misma cara que uno normal no
  // informa nada. Tienen que estar los tres hechos, con sus palabras.
  assert.ok(/rechaz/.test(texto), 'no dice que alguien rechazó');
  assert.ok(texto.includes('cláusula 4'), 'no trae el motivo del rechazo');
  assert.ok(/cambió lo que muestran/.test(texto), 'no dice que el contenido cambió');
  assert.ok(/cadena|evidencia/.test(texto), 'no dice nada de la cadena de evidencia');
});

/**
 * Los idiomas del certificado (deuda 15, v3).
 *
 * ═══ QUÉ DECIDE ═══
 *
 * 1. Con `idioma: 'pt'` o `'en'` el certificado entero sale en ese idioma, con
 *    los rótulos de los eventos tomados de `rotulos` (lo que `certificado.ts`
 *    resuelve desde el catálogo `tipo_evento`).
 * 2. EL CONTROL: sin `idioma` —que es exactamente la forma de los datos
 *    guardados de todo certificado emitido antes de la v3— sale en castellano,
 *    con la red local de rótulos. Si este caso falla, una reimpresión de un
 *    certificado viejo cambiaría de idioma, y un artefacto inmutable que dice
 *    otra cosa al reimprimirlo no es inmutable.
 * 3. En inglés la fecha lleva el MES EN LETRAS: «03/04/2026» es 3 de abril en
 *    español y 4 de marzo en inglés, y esa ambigüedad en un certificado es
 *    inaceptable (multiidioma-y-textos.md §5).
 */
const ROTULOS_PT: Record<string, string> = {
  'notificacion.enviada': 'Notificação enviada',
  'documento.abierto': 'O documento foi aberto',
  'documento.visto': 'O documento foi percorrido por completo',
  'identidad.probada': 'Identidade comprovada',
  'consentimiento.dado': 'Consentiu em assinar',
  'firma.aplicada': 'Assinou',
  'firma.sellada': 'Carimbo do tempo',
};

test('en portugués: el certificado entero habla portugués', async (t) => {
  const datos: DatosCertificado = { ...JSON.parse(JSON.stringify(BASE)), idioma: 'pt', rotulos: ROTULOS_PT };
  const pdf = await dibujar(datos);
  const archivo = guardar('certificado_pt.pdf', pdf);

  if (sinPoppler()) return t.skip(String(sinPoppler()));
  const texto = extraer(archivo).toLocaleLowerCase('pt');
  for (const debe of ['Certificado de conclusão', 'O documento', 'Impressões digitais',
                      'Signatário', 'Assinou', 'Carimbo do tempo', 'Dossiê de evidências',
                      'Como verificar tudo isto sem a MiFirma']) {
    assert.ok(texto.includes(debe.toLocaleLowerCase('pt')), `falta «${debe}» en el certificado pt`);
  }
  // Nada del marco fijo puede quedar en castellano.
  for (const noDebe of ['certificado de finalización', 'huellas del archivo', 'expediente de evidencia']) {
    assert.ok(!texto.includes(noDebe), `quedó castellano en el certificado pt: «${noDebe}»`);
  }
  // La ã y la ç sobrevivieron al saneador WinAnsi.
  assert.ok(!texto.includes('conclus?o'), 'el saneador WinAnsi se comió la ã');
});

test('en inglés: habla inglés y la fecha lleva el mes en letras', async (t) => {
  const datos: DatosCertificado = { ...JSON.parse(JSON.stringify(BASE)), idioma: 'en', rotulos: {} };
  const pdf = await dibujar(datos);
  const archivo = guardar('certificado_en.pdf', pdf);

  if (sinPoppler()) return t.skip(String(sinPoppler()));
  const texto = extraer(archivo);
  for (const debe of ['Certificate of completion', 'File fingerprints', 'Signer',
                      'Evidence file', 'How to verify all of this without MiFirma']) {
    assert.ok(texto.toLowerCase().includes(debe.toLowerCase()), `falta «${debe}» en el certificado en`);
  }
  // La fecha de cierre del circuito es el 1/8/2026: en inglés tiene que salir
  // «01 Aug 2026», nunca «01/08/2026», que un lector estadounidense lee enero.
  assert.ok(texto.includes('Aug 2026'), 'la fecha en inglés no lleva el mes en letras');
  assert.ok(!/\d{2}\/\d{2}\/\d{4}/.test(texto), 'quedó una fecha ambigua dd/mm/yyyy en el certificado en');
});

test('EL CONTROL: sin idioma —los datos de un certificado viejo— sale en castellano', async (t) => {
  // Exactamente BASE, que no trae ni `idioma` ni `rotulos`: es la forma de los
  // datos guardados de cualquier certificado emitido antes de la v3.
  const pdf = await dibujar(BASE);
  const archivo = guardar('certificado_reimpresion_vieja.pdf', pdf);

  if (sinPoppler()) return t.skip(String(sinPoppler()));
  const texto = extraer(archivo).toLocaleLowerCase('es');
  for (const debe of ['Certificado de finalización', 'Huellas del archivo',
                      'Expediente de evidencia', 'Sello de tiempo', 'Firmó']) {
    assert.ok(texto.includes(debe.toLocaleLowerCase('es')),
              `falta «${debe}» en la reimpresión de un certificado viejo`);
  }
});
