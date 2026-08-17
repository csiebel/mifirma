import PDFDocument from 'pdfkit';

/**
 * El DIBUJO del certificado de finalización. Sin base de datos y sin efectos:
 * entra un objeto, sale un PDF.
 *
 * ⚠ Está separado a propósito. Un generador de PDF que necesita una base para
 * correr no se prueba nunca —y esto hay que mirarlo, no razonarlo—. Así se
 * renderiza con datos inventados, se abre, y se ve si el certificado se
 * entiende. Ver `t8_certificado.ts` del laboratorio.
 *
 * ═══ EL IDIOMA (v3, 12/8/2026 — deuda 15) ═══
 *
 * El certificado sale en UN idioma: el del circuito (`datos.idioma`), que se
 * resuelve al crear el circuito por el marco legal —Brasil → portugués; Uruguay
 * y Paraguay → español— y que el emisor podrá pisar el día que exista la
 * pantalla. Decidido por Claudio el 12/8: «marco legal con override».
 *
 * Acá adentro el idioma decide DOS cosas:
 *
 *  · Los textos fijos —títulos, etiquetas, alarmas— salen del diccionario
 *    `TEXTOS` de este archivo, en es/pt/en.
 *  · Los rótulos de los eventos vienen YA RESUELTOS en `datos.rotulos`: los
 *    saca `certificado.ts` del catálogo `tipo_evento`, que está en tres
 *    idiomas desde la migración 020 y es el que mantiene el operador. La vieja
 *    copia local `ETIQUETA` queda como RED para reimprimir certificados
 *    emitidos antes de la v3, cuyos datos guardados no traen rótulos.
 *
 * ⚠ LÍMITE CONOCIDO: las líneas de «qué se escribió entre una firma y la
 * siguiente» las redacta el analizador de cambios (`src/firma/cambios.ts`,
 * tramo sellado) y salen en castellano en cualquier idioma. Traducirlas es
 * tocar el tramo sellado; el día que se abra por otra causa, va con eso.
 */

// Milímetros a puntos, que es la unidad del PDF. Se escribe una vez y no se
// vuelve a pensar.
const mm = (v: number) => (v * 72) / 25.4;

/**
 * Texto que las fuentes estándar del PDF pueden escribir.
 *
 * ⚠ Helvetica y las demás fuentes de los 14 estándar usan WinAnsi, que llega
 * hasta el byte 255. Cualquier carácter fuera de ahí NO da error: sale otra
 * cosa. El símbolo ⚠ se imprimía como «&», y un título de documento con un
 * emoji habría salido con basura en el medio sin que nada lo dijera.
 *
 * Se mapean los tipográficos que usamos y se deja el resto en «?», que al menos
 * se ve como lo que es: un carácter que no se pudo representar.
 *
 * ⚠ LÍMITE CONOCIDO: un título en cirílico, griego o chino perdería sus
 * caracteres. Para el MVP —castellano, portugués e inglés— WinAnsi alcanza de
 * sobra (la ã, la õ y la ç están adentro). El día que haya un país con otro
 * alfabeto hay que embeber una fuente Unicode (pdfkit lo soporta con
 * `registerFont`), y son ~700 KB en el repo.
 */
const MAPA: Record<string, string> = {
  '⚠': '!', '⏱': '', '·': '·', '—': '—', '–': '–',
  '“': '“', '”': '”', '‘': '‘', '’': '’', '…': '…',
  '✓': 'OK', '✗': 'X', '→': '->', '←': '<-', '⚡': '',
};
const WINANSI = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d,
  0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);

function txt(s: unknown): string {
  const v = String(s ?? '');
  let out = '';
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (MAPA[ch] !== undefined) { out += MAPA[ch]; continue; }
    if (c <= 0xff || WINANSI.has(c)) { out += ch; continue; }
    out += '?';
  }
  return out;
}

const AZUL = '#0B2B4A';
const GRIS = '#5a6878';
const LINEA = '#e4ebf3';
const ROJO = '#b42318';

export interface DatosCertificado {
  version_plantilla: number;
  emitido_en: string;
  /**
   * Idioma del certificado (BCP 47 corto: 'es' | 'pt' | 'en'). Ausente en los
   * datos guardados de certificados anteriores a la v3: cae a 'es', que es lo
   * que aquellos decían. Migración de datos no hay ni hace falta.
   */
  idioma?: string;
  /**
   * Rótulos de los tipos de evento, ya resueltos al idioma por `certificado.ts`
   * desde el catálogo `tipo_evento` (en tres idiomas desde la migración 020).
   * Ausente en datos guardados viejos: cae a la copia local `ETIQUETA`.
   */
  rotulos?: Record<string, string>;
  circuito: {
    id: string; instancia_id: string; numero: number; instancias: number;
    titulo: string; modo: string; nivel_firma: string; pais: string | null;
    emisor: string; creado_en: string; enviado_en: string | null; cerrado_en: string | null;
    estado: string;
  };
  documento: {
    sha256_base: string; sha256_firmado: string | null;
    paginas: number | null; bytes: number | null;
    firmas_en_el_pdf: number; integro: boolean | null;
    contenido_alterado_entre_firmas: boolean | null;
    cambios: string[];
  };
  firmantes: Array<{
    nombre: string | null; email: string; papel: string; orden: number;
    estado: string; firmada_en: string | null;
    nivel_garantia: string | null;
    identificacion: Array<{ tipo: string; probado_en: string }>;
    certificado: { sujeto: string | null; emisor: string | null } | null;
    sello: { autoridad: string; sellado_en: string; serie: string } | null;
    cronologia: Array<{ tipo: string; cuando: string; ip: string | null }>;
    motivo_rechazo: string | null;
  }>;
  evidencia: {
    eventos: number; huecos: number; rotos: number; cadena_ok: boolean;
    hash_raiz: string;
  };
}

// ---------------------------------------------------------------------------
// Los textos, por idioma
// ---------------------------------------------------------------------------

/**
 * ⚠ EL CASTELLANO ES EL ORIGINAL Y NO SE TOCA AL TRADUCIR. Las pruebas usan el
 * es como control: si una traducción obliga a cambiar el texto español, eso es
 * una decisión aparte y con su propio motivo, no un efecto colateral.
 *
 * ⚠ El portugués y el inglés los redactó el chat el 12/8/2026 siguiendo la
 * terminología que ya existe en `tipo_evento` y en `i18n/textos.ts`. Valen como
 * borrador bueno; si un hablante nativo corrige algo, se corrige acá y sube la
 * versión de plantilla — un certificado emitido es inmutable y el texto viejo
 * queda en los ya emitidos.
 */
interface TextosCert {
  tituloDoc: string;
  emitido: (f: string) => string;
  alarmaCadena: (h: number, r: number) => string;
  alarmaVerifica: string;
  alarmaAlterado: string;
  secDocumento: string;
  lTitulo: string; lEmisor: string; lId: string; lCircuito: string;
  copia: (n: number, m: number) => string;
  lModo: string; modos: Record<string, string>;
  lNivel: string; niveles: Record<string, string>;
  marcoLegal: (p: string) => string;
  lEstado: string; estadosCircuito: Record<string, string>;
  lCreado: string; lEnviado: string; lCerrado: string; lPaginas: string;
  secHuellas: string; huellasExpl: string;
  lBase: string; lFirmado: string; lFirmasPdf: string; lVerificacion: string;
  vNoLeer: string; vOk: string; vNo: string;
  cambiosTitulo: string;
  papeles: Record<string, string>;
  firmo: string; rechazoFirmar: string;
  lCorreo: string; lMotivo: string; lFirmoEl: string; lGarantia: string;
  garantias: Record<string, string>;
  lComoId: string; sinFactores: string;
  probadoEl: (f: string) => string;
  anclaje: Record<string, string>;
  lHoraCert: string; lSello: string; sinSello: string;
  cronologia: string;
  desde: (ip: string) => string;
  secVerificar: string; verificarTexto: string;
  secExpediente: string; lEventos: string; lCadena: string;
  cadenaOk: string;
  cadenaNo: (h: number, r: number) => string;
  lHashRaiz: string; cadenaExpl: string;
  pieCertificado: string; pieplantilla: string;
  metaTitulo: (t: string) => string;
  metaAsunto: (id: string) => string;
}

const TEXTOS: Record<'es' | 'pt' | 'en', TextosCert> = {
  es: {
    tituloDoc: 'Certificado de finalización',
    emitido: (f) => `Emitido por MiFirma el ${f}. Todo lo que dice sale del expediente del documento y del PDF firmado.`,
    alarmaCadena: (h, r) => 'La cadena de evidencia de este documento NO cierra: hay ' + h +
      ' hueco(s) y ' + r + ' eslabón(es) roto(s). El expediente pudo haber sido alterado.',
    alarmaVerifica: 'El PDF firmado NO verifica: alguna firma no cubre los bytes que dice cubrir.',
    alarmaAlterado: 'Se cambió lo que MUESTRA alguna página del documento después de que ' +
      'alguien ya lo había firmado. Las firmas verifican igual, pero lo que vio el primer ' +
      'firmante no es lo que muestra el archivo.',
    secDocumento: 'El documento',
    lTitulo: 'Título', lEmisor: 'Emitido por', lId: 'Identificador', lCircuito: 'Circuito',
    copia: (n, m) => `  (copia ${n} de ${m})`,
    lModo: 'Modo de firma',
    modos: { serie: 'Uno después del otro', paralelo: 'Todos a la vez', copias: 'Copias' },
    lNivel: 'Nivel de firma',
    niveles: { simple: 'simple', avanzada: 'avanzada' },
    marcoLegal: (p) => ` · marco legal de ${p}`,
    lEstado: 'Estado',
    estadosCircuito: { borrador: 'Borrador', enviado: 'Enviado a firmar', completo: 'Completo',
                       cancelado: 'Cancelado', vencido: 'Vencido' },
    lCreado: 'Creado', lEnviado: 'Enviado a firmar', lCerrado: 'Cerrado', lPaginas: 'Páginas',
    secHuellas: 'Huellas del archivo',
    huellasExpl: 'SHA-256. Es lo que ata este certificado a un archivo concreto: si el PDF que ' +
      'tenés en la mano da otra huella, no es este documento.',
    lBase: 'Documento base', lFirmado: 'Documento firmado', lFirmasPdf: 'Firmas en el PDF',
    lVerificacion: 'Verificación',
    vNoLeer: 'no se pudo leer el archivo firmado',
    vOk: 'todas las firmas verifican y no hay bytes sin firmar',
    vNo: 'NO verifica',
    cambiosTitulo: 'Qué se escribió entre una firma y la siguiente:',
    papeles: { firmante: 'Firmante', copia: 'Copia' },
    firmo: 'Firmó', rechazoFirmar: 'RECHAZÓ firmar',
    lCorreo: 'Correo', lMotivo: 'Motivo del rechazo', lFirmoEl: 'Firmó el',
    lGarantia: 'Nivel de garantía',
    garantias: { ninguno: 'ninguno', bajo: 'bajo', medio: 'medio', alto: 'alto' },
    lComoId: 'Cómo se identificó', sinFactores: 'sin factores acreditados',
    probadoEl: (f) => ` — probado el ${f}`,
    anclaje: {
      email: 'Control de la casilla de correo',
      telefono: 'Control del teléfono',
      documento: 'Documento de identidad',
      certificado: 'Certificado digital',
      biometria: 'Biometría del dispositivo',
    },
    lHoraCert: 'Hora certificada por', lSello: 'Sello de tiempo',
    sinSello: 'sin sello: la fecha de esta firma la afirma MiFirma, no un tercero',
    cronologia: 'Cronología',
    desde: (ip) => `   ·   desde ${ip}`,
    secVerificar: 'Cómo verificar todo esto sin MiFirma',
    verificarTexto:
      '1. Abrí el PDF firmado con cualquier lector que valide firmas —Adobe Acrobat Reader, ' +
      'por ejemplo—. El panel de firmas tiene que mostrar una firma por cada persona de la ' +
      'lista de arriba, todas válidas.\n\n' +
      '2. Calculá el SHA-256 del archivo que tenés y comparalo con la huella de este ' +
      'certificado. En una terminal: shasum -a 256 archivo.pdf\n\n' +
      '3. La firma electrónica y su sello de tiempo están DENTRO del PDF. No hace falta ' +
      'MiFirma, ni conexión, ni permiso de nadie: el documento se prueba solo.',
    secExpediente: 'Expediente de evidencia',
    lEventos: 'Eventos registrados', lCadena: 'Cadena',
    cadenaOk: 'cierra: sin huecos ni eslabones rotos',
    cadenaNo: (h, r) => `NO cierra: ${h} hueco(s), ${r} roto(s)`,
    lHashRaiz: 'Hash raíz',
    cadenaExpl: 'Cada evento del expediente lleva el hash del anterior. Cambiar uno solo obliga a ' +
      'rehacer todos los siguientes, y el hash raíz de arriba deja de coincidir.',
    pieCertificado: 'certificado de finalización', pieplantilla: 'plantilla',
    metaTitulo: (t) => `Certificado de finalización — ${t}`,
    metaAsunto: (id) => `Instancia ${id}`,
  },

  pt: {
    tituloDoc: 'Certificado de conclusão',
    emitido: (f) => `Emitido pela MiFirma em ${f}. Tudo o que este certificado afirma sai do dossiê de evidências do documento e do PDF assinado.`,
    alarmaCadena: (h, r) => 'A cadeia de evidências deste documento NÃO fecha: há ' + h +
      ' lacuna(s) e ' + r + ' elo(s) quebrado(s). O dossiê pode ter sido alterado.',
    alarmaVerifica: 'O PDF assinado NÃO verifica: alguma assinatura não cobre os bytes que diz cobrir.',
    alarmaAlterado: 'O que alguma página do documento MOSTRA foi alterado depois que alguém ' +
      'já o havia assinado. As assinaturas verificam mesmo assim, mas o que o primeiro ' +
      'signatário viu não é o que o arquivo mostra.',
    secDocumento: 'O documento',
    lTitulo: 'Título', lEmisor: 'Emitido por', lId: 'Identificador', lCircuito: 'Circuito',
    copia: (n, m) => `  (cópia ${n} de ${m})`,
    lModo: 'Modo de assinatura',
    modos: { serie: 'Um depois do outro', paralelo: 'Todos ao mesmo tempo', copias: 'Cópias' },
    lNivel: 'Nível de assinatura',
    niveles: { simple: 'simples', avanzada: 'avançada' },
    marcoLegal: (p) => ` · marco legal: ${p}`,
    lEstado: 'Situação',
    estadosCircuito: { borrador: 'Rascunho', enviado: 'Enviado para assinatura', completo: 'Concluído',
                       cancelado: 'Cancelado', vencido: 'Vencido' },
    lCreado: 'Criado', lEnviado: 'Enviado para assinatura', lCerrado: 'Encerrado', lPaginas: 'Páginas',
    secHuellas: 'Impressões digitais do arquivo',
    huellasExpl: 'SHA-256. É o que vincula este certificado a um arquivo concreto: se o PDF que ' +
      'você tem em mãos dá outra impressão digital, não é este documento.',
    lBase: 'Documento base', lFirmado: 'Documento assinado', lFirmasPdf: 'Assinaturas no PDF',
    lVerificacion: 'Verificação',
    vNoLeer: 'não foi possível ler o arquivo assinado',
    vOk: 'todas as assinaturas verificam e não há bytes sem assinar',
    vNo: 'NÃO verifica',
    cambiosTitulo: 'O que foi escrito entre uma assinatura e a seguinte:',
    papeles: { firmante: 'Signatário', copia: 'Cópia' },
    firmo: 'Assinou', rechazoFirmar: 'RECUSOU assinar',
    lCorreo: 'E-mail', lMotivo: 'Motivo da recusa', lFirmoEl: 'Assinou em',
    lGarantia: 'Nível de garantia',
    garantias: { ninguno: 'nenhum', bajo: 'baixo', medio: 'médio', alto: 'alto' },
    lComoId: 'Como se identificou', sinFactores: 'sem fatores comprovados',
    probadoEl: (f) => ` — comprovado em ${f}`,
    anclaje: {
      email: 'Controle da caixa de e-mail',
      telefono: 'Controle do telefone',
      documento: 'Documento de identidade',
      certificado: 'Certificado digital',
      biometria: 'Biometria do dispositivo',
    },
    lHoraCert: 'Hora certificada por', lSello: 'Carimbo do tempo',
    sinSello: 'sem carimbo: a data desta assinatura é afirmada pela MiFirma, não por um terceiro',
    cronologia: 'Cronologia',
    desde: (ip) => `   ·   de ${ip}`,
    secVerificar: 'Como verificar tudo isto sem a MiFirma',
    verificarTexto:
      '1. Abra o PDF assinado com qualquer leitor que valide assinaturas — Adobe Acrobat ' +
      'Reader, por exemplo. O painel de assinaturas deve mostrar uma assinatura para cada ' +
      'pessoa da lista acima, todas válidas.\n\n' +
      '2. Calcule o SHA-256 do arquivo que você tem e compare com a impressão digital deste ' +
      'certificado. Em um terminal: shasum -a 256 arquivo.pdf\n\n' +
      '3. A assinatura eletrônica e seu carimbo do tempo estão DENTRO do PDF. Não é preciso ' +
      'a MiFirma, nem conexão, nem permissão de ninguém: o documento prova a si mesmo.',
    secExpediente: 'Dossiê de evidências',
    lEventos: 'Eventos registrados', lCadena: 'Cadeia',
    cadenaOk: 'fecha: sem lacunas nem elos quebrados',
    cadenaNo: (h, r) => `NÃO fecha: ${h} lacuna(s), ${r} quebrado(s)`,
    lHashRaiz: 'Hash raiz',
    cadenaExpl: 'Cada evento do dossiê carrega o hash do anterior. Alterar um único evento obriga ' +
      'a refazer todos os seguintes, e o hash raiz acima deixa de coincidir.',
    pieCertificado: 'certificado de conclusão', pieplantilla: 'modelo',
    metaTitulo: (t) => `Certificado de conclusão — ${t}`,
    metaAsunto: (id) => `Instância ${id}`,
  },

  en: {
    tituloDoc: 'Certificate of completion',
    emitido: (f) => `Issued by MiFirma on ${f}. Everything it states comes from the document's evidence file and the signed PDF.`,
    alarmaCadena: (h, r) => 'The evidence chain of this document does NOT close: ' + h +
      ' gap(s) and ' + r + ' broken link(s). The evidence file may have been altered.',
    alarmaVerifica: 'The signed PDF does NOT verify: some signature does not cover the bytes it claims to cover.',
    alarmaAlterado: 'What some page of the document DISPLAYS was changed after someone had ' +
      'already signed it. The signatures still verify, but what the first signer saw is not ' +
      'what the file now shows.',
    secDocumento: 'The document',
    lTitulo: 'Title', lEmisor: 'Issued by', lId: 'Identifier', lCircuito: 'Circuit',
    copia: (n, m) => `  (copy ${n} of ${m})`,
    lModo: 'Signing mode',
    modos: { serie: 'One after another', paralelo: 'All at once', copias: 'Copies' },
    lNivel: 'Signature level',
    niveles: { simple: 'simple', avanzada: 'advanced' },
    marcoLegal: (p) => ` · legal framework: ${p}`,
    lEstado: 'Status',
    estadosCircuito: { borrador: 'Draft', enviado: 'Sent for signing', completo: 'Completed',
                       cancelado: 'Cancelled', vencido: 'Expired' },
    lCreado: 'Created', lEnviado: 'Sent for signing', lCerrado: 'Closed', lPaginas: 'Pages',
    secHuellas: 'File fingerprints',
    huellasExpl: 'SHA-256. This is what ties this certificate to one specific file: if the PDF ' +
      'in your hands yields a different fingerprint, it is not this document.',
    lBase: 'Source document', lFirmado: 'Signed document', lFirmasPdf: 'Signatures in the PDF',
    lVerificacion: 'Verification',
    vNoLeer: 'the signed file could not be read',
    vOk: 'all signatures verify and no bytes are left unsigned',
    vNo: 'does NOT verify',
    cambiosTitulo: 'What was written between one signature and the next:',
    papeles: { firmante: 'Signer', copia: 'Copy' },
    firmo: 'Signed', rechazoFirmar: 'REFUSED to sign',
    lCorreo: 'Email', lMotivo: 'Reason for refusal', lFirmoEl: 'Signed on',
    lGarantia: 'Assurance level',
    garantias: { ninguno: 'none', bajo: 'low', medio: 'medium', alto: 'high' },
    lComoId: 'How they identified themselves', sinFactores: 'no verified factors',
    probadoEl: (f) => ` — verified on ${f}`,
    anclaje: {
      email: 'Control of the email inbox',
      telefono: 'Control of the phone',
      documento: 'Identity document',
      certificado: 'Digital certificate',
      biometria: 'Device biometrics',
    },
    lHoraCert: 'Time certified by', lSello: 'Timestamp',
    sinSello: 'no timestamp: the date of this signature is asserted by MiFirma, not by a third party',
    cronologia: 'Timeline',
    desde: (ip) => `   ·   from ${ip}`,
    secVerificar: 'How to verify all of this without MiFirma',
    verificarTexto:
      '1. Open the signed PDF with any reader that validates signatures — Adobe Acrobat ' +
      'Reader, for example. The signature panel must show one signature for each person ' +
      'listed above, all of them valid.\n\n' +
      '2. Compute the SHA-256 of the file you have and compare it with the fingerprint on ' +
      'this certificate. In a terminal: shasum -a 256 file.pdf\n\n' +
      '3. The electronic signature and its timestamp live INSIDE the PDF. You need no ' +
      'MiFirma, no connection, no one’s permission: the document proves itself.',
    secExpediente: 'Evidence file',
    lEventos: 'Recorded events', lCadena: 'Chain',
    cadenaOk: 'closes: no gaps, no broken links',
    cadenaNo: (h, r) => `does NOT close: ${h} gap(s), ${r} broken`,
    lHashRaiz: 'Root hash',
    cadenaExpl: 'Each event in the file carries the hash of the previous one. Changing a single ' +
      'event forces redoing all that follow, and the root hash above no longer matches.',
    pieCertificado: 'certificate of completion', pieplantilla: 'template',
    metaTitulo: (t) => `Certificate of completion — ${t}`,
    metaAsunto: (id) => `Instance ${id}`,
  },
};

// ---------------------------------------------------------------------------
// El PDF
// ---------------------------------------------------------------------------

// ⚠ ESTA LISTA ES LA RED, NO LA FUENTE. Desde la v3 los rótulos vienen en
// `datos.rotulos`, resueltos por `certificado.ts` desde el catálogo
// `tipo_evento` — que está en tres idiomas y es el que ve el operador. Esta
// copia en castellano queda para REIMPRIMIR certificados emitidos antes de la
// v3, cuyos datos guardados no traen rótulos, y como último recurso si un
// código nuevo no está en el catálogo al emitir (no debería: el catálogo es la
// fuente de los códigos).
//
// ⚠ SIGUE VALIENDO: un código sin rótulo en NINGUNA de las dos fuentes sale
// CRUDO en el certificado de un cliente. El 9/8 faltaban ocho. Para saber si
// falta alguno, con el túnel abierto:
//   select codigo from tipo_evento where codigo not in ( ...los de acá... );
const ETIQUETA: Record<string, string> = {
  'documento.subido': 'Documento subido',
  'documento.copiado': 'Se creó su copia del documento',
  'circuito.despachado': 'Enviado a firmar',
  // ⚠⚠ CUATRO HECHOS DISTINTOS, Y LOS CUATRO TEXTOS TIENEN QUE PODER
  // DISTINGUIRSE A SIMPLE VISTA. Es lo que un perito va a leer.
  //
  //   · enviada      → el relay lo ACEPTÓ. No dice que haya llegado.
  //   · entregada    → llegó. Lo escribe el webhook desde la migración 063.
  //   · fallida      → NO SALIÓ del sistema. Falló nuestro despacho.
  //   · no_entregada → salió, el relay lo aceptó, y NO llegó (064).
  //
  // ⚠ El mismo texto vive en `tipo_evento` y los dos se cambian juntos. Que
  // este certificado no lea del catálogo es deuda anotada: además de duplicar
  // la afirmación, es lo que hoy impide que salga en portugués o en inglés.
  // Ver migraciones 058, 063 y 064.
  'notificacion.enviada': 'Aviso aceptado por el servidor de correo',
  'notificacion.entregada': 'Aviso entregado al destinatario',
  'notificacion.fallida': 'El aviso NO salió',
  'notificacion.no_entregada': 'El aviso salió pero NO se pudo entregar',
  'documento.abierto': 'Abrió el enlace',
  'documento.visto': 'Vio el documento',
  'documento.campo_completado': 'Completó un dato',
  'documento.campos_congelados': 'Se cerraron los datos antes de firmar',
  'identidad.probada': 'Probó su identidad',
  'firma.caracter_declarado': 'Declaró con qué carácter firma',
  'consentimiento.dado': 'Consintió firmar',
  'firma.aplicada': 'Firmó',
  'firma.sellada': 'Sello de tiempo',
  'sello.fallido': 'El sello NO se pudo obtener',
  'firma.representacion_visual': 'Marca autógrafa',
  'firma.marca_agregada': 'Colocó su marca',
  'firma.marca_quitada': 'Quitó una marca suya',
  'firma.marca_movida': 'Movió su marca',
  'firma.marca_redimensionada': 'Cambió el tamaño de su marca',
  'firma.rechazada': 'Rechazó firmar',
  'circuito.completo': 'Circuito completo',
  'circuito.cancelado': 'Se canceló el circuito',
  'circuito.vencido': 'Venció el plazo',
  'documento.descargado': 'Descargó el documento',
  'certificado.emitido': 'Certificado emitido',
};

const MES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * ⚠ La fecha cambia de FORMA según el idioma, no sólo de palabras. «03/04/2026»
 * es 3 de abril en español y 4 de marzo en inglés (`multiidioma-y-textos.md`
 * §5): en un certificado esa ambigüedad es inaceptable, así que el inglés lleva
 * el mes en letras. Español y portugués comparten el día/mes/año de siempre.
 */
function fecha(iso: string | null, idioma: 'es' | 'pt' | 'en'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const hms = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
  if (idioma === 'en') {
    return `${p(d.getUTCDate())} ${MES_EN[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hms}`;
  }
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${hms}`;
}

export function dibujar(d: DatosCertificado): Promise<Buffer> {
  // El idioma del certificado. 'es' para los datos guardados anteriores a la
  // v3, y para cualquier valor que no tenga diccionario — mejor un certificado
  // en español que uno a medias.
  const lang: 'es' | 'pt' | 'en' =
    d.idioma === 'pt' || d.idioma === 'en' ? d.idioma : 'es';
  const T = TEXTOS[lang];
  const F = (iso: string | null) => fecha(iso, lang);
  // El rótulo de un evento: primero el resuelto del catálogo, después la red
  // local en castellano, y si no hay nada, el código crudo — que al menos se ve
  // como lo que es.
  const rot = (codigo: string) => d.rotulos?.[codigo] ?? ETIQUETA[codigo] ?? codigo;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: mm(18), bottom: mm(18), left: mm(18), right: mm(18) },
      // Hace falta para numerar «3 de 7» al final: sin esto no se puede volver
      // a una hoja ya escrita, y el total no se sabe hasta que se terminó.
      bufferPages: true,
      info: {
        Title: T.metaTitulo(d.circuito.titulo),
        Author: 'MiFirma',
        Subject: T.metaAsunto(d.circuito.instancia_id),
      },
    });
    const trozos: Buffer[] = [];
    doc.on('data', (x: Buffer) => trozos.push(x));
    doc.on('end', () => resolve(Buffer.concat(trozos)));
    doc.on('error', reject);

    const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const izq = doc.page.margins.left;

    const titulo = (t: string) => {
      if (doc.y > doc.page.height - mm(40)) doc.addPage();
      doc.moveDown(0.9);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(AZUL).text(txt(t).toUpperCase(), izq, doc.y,
        { characterSpacing: 0.7 });
      doc.moveTo(izq, doc.y + 3).lineTo(izq + ancho, doc.y + 3).lineWidth(0.7).strokeColor(LINEA).stroke();
      doc.moveDown(0.6);
    };

    const campo = (k: string, v: string, resaltado = false) => {
      if (doc.y > doc.page.height - mm(28)) doc.addPage();
      const y = doc.y;
      doc.font('Helvetica').fontSize(8.5).fillColor(GRIS).text(txt(k), izq, y, { width: mm(48) });
      doc.font(resaltado ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
         .fillColor(resaltado ? ROJO : '#0f1e2c')
         .text(txt(v), izq + mm(50), y, { width: ancho - mm(50) });
      doc.y = Math.max(y + 12, doc.y + 2);
    };

    // ── Encabezado
    doc.font('Helvetica-Bold').fontSize(19).fillColor(AZUL)
       .text(txt(T.tituloDoc), izq, doc.y);
    doc.font('Helvetica').fontSize(9.5).fillColor(GRIS)
       .text(txt(T.emitido(F(d.emitido_en))), { width: ancho });

    // ⚠ Las alarmas van ARRIBA DE TODO. Un certificado que esconde el problema
    // en la página 3 es peor que no emitirlo: nadie llega a la página 3.
    const alarmas: string[] = [];
    if (!d.evidencia.cadena_ok) {
      alarmas.push(T.alarmaCadena(d.evidencia.huecos, d.evidencia.rotos));
    }
    if (d.documento.integro === false) {
      alarmas.push(T.alarmaVerifica);
    }
    if (d.documento.contenido_alterado_entre_firmas) {
      alarmas.push(T.alarmaAlterado);
    }
    if (alarmas.length) {
      doc.moveDown(0.8);
      // ⚠ `rect().fill()` NO mueve `doc.y`. Calcular la posición del texto
      // restándole el alto lo mandaba HACIA ARRIBA, encima del título. Se guarda
      // la posición antes de dibujar y se avanza a mano.
      const y0 = doc.y;
      const alto = alarmas.length * 32 + 14;
      doc.rect(izq, y0, ancho, alto).fillColor('#fef3f2').fill();
      doc.rect(izq, y0, 3, alto).fillColor(ROJO).fill();
      doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(9.5);
      let y = y0 + 8;
      for (const a of alarmas) {
        doc.text(txt('! ' + a), izq + 12, y, { width: ancho - 24 });
        y = doc.y + 5;
      }
      doc.y = Math.max(y, y0 + alto) + 8;
    }

    // ── El documento
    titulo(T.secDocumento);
    campo(T.lTitulo, d.circuito.titulo);
    campo(T.lEmisor, d.circuito.emisor);
    campo(T.lId, d.circuito.instancia_id);
    campo(T.lCircuito, d.circuito.id +
      (d.circuito.instancias > 1 ? T.copia(d.circuito.numero, d.circuito.instancias) : ''));
    campo(T.lModo, T.modos[d.circuito.modo] ?? d.circuito.modo);
    campo(T.lNivel, (T.niveles[d.circuito.nivel_firma] ?? d.circuito.nivel_firma) +
      (d.circuito.pais ? T.marcoLegal(d.circuito.pais) : ''));
    campo(T.lEstado, T.estadosCircuito[d.circuito.estado] ?? d.circuito.estado);
    campo(T.lCreado, F(d.circuito.creado_en));
    campo(T.lEnviado, F(d.circuito.enviado_en));
    campo(T.lCerrado, F(d.circuito.cerrado_en));
    campo(T.lPaginas, d.documento.paginas ? String(d.documento.paginas) : '—');

    titulo(T.secHuellas);
    doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
       .text(txt(T.huellasExpl), izq, doc.y, { width: ancho });
    doc.moveDown(0.4);
    campo(T.lBase, d.documento.sha256_base);
    campo(T.lFirmado, d.documento.sha256_firmado ?? '—');
    campo(T.lFirmasPdf, String(d.documento.firmas_en_el_pdf));
    campo(T.lVerificacion,
      d.documento.integro === null ? T.vNoLeer
        : d.documento.integro ? T.vOk
        : T.vNo,
      d.documento.integro === false);

    if (d.documento.cambios.length) {
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
         .text(txt(T.cambiosTitulo), izq, doc.y, { width: ancho });
      // ⚠ Estas líneas las redacta el analizador de cambios (tramo sellado) y
      // salen en castellano en cualquier idioma. Ver el encabezado.
      for (const c of d.documento.cambios) {
        doc.font('Helvetica').fontSize(8.5)
           .fillColor(c.includes('⚠') ? ROJO : GRIS)
           .text(txt('- ' + c), izq + 8, doc.y + 2, { width: ancho - 8 });
      }
      doc.moveDown(0.3);
    }

    // ── Los firmantes
    for (const f of d.firmantes) {
      titulo(`${T.papeles[f.papel] ?? f.papel} ${f.orden} — ${f.nombre || f.email}`);
      campo(T.lCorreo, f.email);
      campo(T.lEstado, f.estado === 'firmada' ? T.firmo :
                       f.estado === 'rechazada' ? T.rechazoFirmar : f.estado,
            f.estado === 'rechazada');
      if (f.motivo_rechazo) campo(T.lMotivo, f.motivo_rechazo, true);
      campo(T.lFirmoEl, F(f.firmada_en));
      campo(T.lGarantia, f.nivel_garantia == null ? '—'
        : (T.garantias[f.nivel_garantia] ?? f.nivel_garantia));

      // ⚠ Esto es la respuesta a «¿cómo saben que era él?».
      if (f.identificacion.length) {
        doc.moveDown(0.2);
        const y0 = doc.y;
        doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
           .text(txt(T.lComoId), izq, y0, { width: mm(48) });
        // ⚠ `doc.y` avanza sola después de cada `text`. Restarle 11 para
        // «volver» a la línea anterior funciona con UN elemento y superpone dos
        // renglones con dos: los dos factores de Ana salían uno encima del otro.
        let y = y0;
        for (const a of f.identificacion) {
          doc.font('Helvetica').fontSize(9).fillColor('#0f1e2c')
             .text(txt('- ' + (T.anclaje[a.tipo] ?? a.tipo) + T.probadoEl(F(a.probado_en))),
                   izq + mm(50), y, { width: ancho - mm(50) });
          y = doc.y + 1;
        }
        doc.y = Math.max(y, y0 + 12);
        doc.moveDown(0.3);
      } else {
        campo(T.lComoId, T.sinFactores, true);
      }

      if (f.sello) {
        campo(T.lHoraCert, f.sello.autoridad);
        campo(T.lSello, F(f.sello.sellado_en) + '  ·  ' + f.sello.serie);
      } else if (f.estado === 'firmada') {
        campo(T.lSello, T.sinSello, true);
      }

      if (f.cronologia.length) {
        doc.moveDown(0.2);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRIS)
           .text(txt(T.cronologia), izq, doc.y, { width: ancho });
        doc.moveDown(0.2);
        for (const e of f.cronologia) {
          if (doc.y > doc.page.height - mm(26)) doc.addPage();
          // Las dos columnas se escriben en la MISMA `y`, y recién después se
          // avanza a la más baja de las dos. Es la única forma de alinearlas sin
          // adivinar cuántas líneas ocupó cada una.
          const y = doc.y;
          doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
             .text(F(e.cuando), izq + 8, y, { width: mm(45) });
          const yIzq = doc.y;
          doc.fillColor('#0f1e2c')
             .text(txt(rot(e.tipo) + (e.ip ? T.desde(e.ip) : '')),
                   izq + mm(50), y, { width: ancho - mm(50) });
          doc.y = Math.max(yIzq, doc.y);
        }
      }
    }

    // ── Verificación
    titulo(T.secVerificar);
    doc.font('Helvetica').fontSize(9).fillColor('#0f1e2c').text(
      txt(T.verificarTexto),
      izq, doc.y, { width: ancho, lineGap: 1.5 });

    titulo(T.secExpediente);
    campo(T.lEventos, String(d.evidencia.eventos));
    campo(T.lCadena, d.evidencia.cadena_ok
      ? T.cadenaOk
      : T.cadenaNo(d.evidencia.huecos, d.evidencia.rotos),
      !d.evidencia.cadena_ok);
    campo(T.lHashRaiz, d.evidencia.hash_raiz || '—');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(8.5).fillColor(GRIS).text(
      txt(T.cadenaExpl),
      izq, doc.y, { width: ancho });

    // ── Pie de página en todas las hojas
    const total = doc.bufferedPageRange().count;
    for (let i = 0; i < total; i++) {
      doc.switchToPage(i);
      // ⚠ Sin bajar el margen inferior, escribir el pie AGREGA UNA HOJA: pdfkit
      // ve que el texto pasa el margen y salta de página, sola, en silencio. El
      // certificado salía con seis hojas y cuatro en blanco.
      const guardado = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - mm(12);
      doc.font('Helvetica').fontSize(7.5).fillColor(GRIS)
         .text(`MiFirma · ${T.pieCertificado} · ${T.pieplantilla} v${d.version_plantilla} · ` +
               `${d.circuito.instancia_id}`, izq, y, { width: ancho - 60, lineBreak: false });
      doc.text(`${i + 1} / ${total}`, izq + ancho - 60, y, { width: 60, align: 'right', lineBreak: false });
      doc.page.margins.bottom = guardado;
    }

    doc.end();
  });
}
