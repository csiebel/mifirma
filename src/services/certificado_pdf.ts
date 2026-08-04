import PDFDocument from 'pdfkit';

/**
 * El DIBUJO del certificado de finalización. Sin base de datos y sin efectos:
 * entra un objeto, sale un PDF.
 *
 * ⚠ Está separado a propósito. Un generador de PDF que necesita una base para
 * correr no se prueba nunca —y esto hay que mirarlo, no razonarlo—. Así se
 * renderiza con datos inventados, se abre, y se ve si el certificado se
 * entiende. Ver `t8_certificado.ts` del laboratorio.
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
 * caracteres. Para el MVP —castellano y portugués— WinAnsi alcanza de sobra.
 * El día que haya un país con otro alfabeto hay que embeber una fuente Unicode
 * (pdfkit lo soporta con `registerFont`), y son ~700 KB en el repo.
 */
const MAPA: Record<string, string> = {
  '⚠': '!', '⏱': '', '·': '\u00b7', '—': '\u2014', '–': '\u2013',
  '“': '\u201c', '”': '\u201d', '‘': '\u2018', '’': '\u2019', '…': '\u2026',
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
// El PDF
// ---------------------------------------------------------------------------

const ETIQUETA: Record<string, string> = {
  'documento.subido': 'Documento subido',
  'circuito.despachado': 'Enviado a firmar',
  'notificacion.enviada': 'Aviso enviado',
  'notificacion.fallida': 'El aviso NO salió',
  'documento.abierto': 'Abrió el enlace',
  'documento.visto': 'Vio el documento',
  'identidad.probada': 'Probó su identidad',
  'consentimiento.dado': 'Consintió firmar',
  'firma.aplicada': 'Firmó',
  'firma.sellada': 'Sello de tiempo',
  'sello.fallido': 'El sello NO se pudo obtener',
  'firma.representacion_visual': 'Marca autógrafa',
  'firma.marca_agregada': 'Colocó su marca',
  'firma.marca_quitada': 'Quitó una marca suya',
  'firma.marca_movida': 'Movió su marca',
  'firma.rechazada': 'Rechazó firmar',
  'circuito.completo': 'Circuito completo',
  'documento.descargado': 'Descargó el documento',
  'certificado.emitido': 'Certificado emitido',
};

const ANCLAJE: Record<string, string> = {
  email: 'Control de la casilla de correo',
  telefono: 'Control del teléfono',
  documento: 'Documento de identidad',
  certificado: 'Certificado digital',
  biometria: 'Biometría del dispositivo',
};

function fecha(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

export function dibujar(d: DatosCertificado): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: mm(18), bottom: mm(18), left: mm(18), right: mm(18) },
      // Hace falta para numerar «3 de 7» al final: sin esto no se puede volver
      // a una hoja ya escrita, y el total no se sabe hasta que se terminó.
      bufferPages: true,
      info: {
        Title: `Certificado de finalización — ${d.circuito.titulo}`,
        Author: 'MiFirma',
        Subject: `Instancia ${d.circuito.instancia_id}`,
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
       .text('Certificado de finalización', izq, doc.y);
    doc.font('Helvetica').fontSize(9.5).fillColor(GRIS)
       .text('Emitido por MiFirma el ' + fecha(d.emitido_en) +
             '. Todo lo que dice sale del expediente del documento y del PDF firmado.', { width: ancho });

    // ⚠ Las alarmas van ARRIBA DE TODO. Un certificado que esconde el problema
    // en la página 3 es peor que no emitirlo: nadie llega a la página 3.
    const alarmas: string[] = [];
    if (!d.evidencia.cadena_ok) {
      alarmas.push('La cadena de evidencia de este documento NO cierra: hay ' +
        d.evidencia.huecos + ' hueco(s) y ' + d.evidencia.rotos + ' eslabón(es) roto(s). ' +
        'El expediente pudo haber sido alterado.');
    }
    if (d.documento.integro === false) {
      alarmas.push('El PDF firmado NO verifica: alguna firma no cubre los bytes que dice cubrir.');
    }
    if (d.documento.contenido_alterado_entre_firmas) {
      alarmas.push('Se cambió lo que MUESTRA alguna página del documento después de que ' +
        'alguien ya lo había firmado. Las firmas verifican igual, pero lo que vio el primer ' +
        'firmante no es lo que muestra el archivo.');
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
    titulo('El documento');
    campo('Título', d.circuito.titulo);
    campo('Emitido por', d.circuito.emisor);
    campo('Identificador', d.circuito.instancia_id);
    campo('Circuito', d.circuito.id +
      (d.circuito.instancias > 1 ? `  (copia ${d.circuito.numero} de ${d.circuito.instancias})` : ''));
    campo('Modo de firma', { serie: 'Uno después del otro', paralelo: 'Todos a la vez', copias: 'Copias' }[d.circuito.modo] ?? d.circuito.modo);
    campo('Nivel de firma', d.circuito.nivel_firma + (d.circuito.pais ? ` · marco legal de ${d.circuito.pais}` : ''));
    campo('Estado', d.circuito.estado);
    campo('Creado', fecha(d.circuito.creado_en));
    campo('Enviado a firmar', fecha(d.circuito.enviado_en));
    campo('Cerrado', fecha(d.circuito.cerrado_en));
    campo('Páginas', d.documento.paginas ? String(d.documento.paginas) : '—');

    titulo('Huellas del archivo');
    doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
       .text('SHA-256. Es lo que ata este certificado a un archivo concreto: si el PDF que ' +
             'tenés en la mano da otra huella, no es este documento.', izq, doc.y, { width: ancho });
    doc.moveDown(0.4);
    campo('Documento base', d.documento.sha256_base);
    campo('Documento firmado', d.documento.sha256_firmado ?? '—');
    campo('Firmas en el PDF', String(d.documento.firmas_en_el_pdf));
    campo('Verificación',
      d.documento.integro === null ? 'no se pudo leer el archivo firmado'
        : d.documento.integro ? 'todas las firmas verifican y no hay bytes sin firmar'
        : 'NO verifica',
      d.documento.integro === false);

    if (d.documento.cambios.length) {
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
         .text('Qué se escribió entre una firma y la siguiente:', izq, doc.y, { width: ancho });
      for (const c of d.documento.cambios) {
        doc.font('Helvetica').fontSize(8.5)
           .fillColor(c.includes('⚠') ? ROJO : GRIS)
           .text(txt('- ' + c), izq + 8, doc.y + 2, { width: ancho - 8 });
      }
      doc.moveDown(0.3);
    }

    // ── Los firmantes
    for (const f of d.firmantes) {
      titulo(`${f.papel === 'firmante' ? 'Firmante' : f.papel} ${f.orden} \u2014 ${f.nombre || f.email}`);
      campo('Correo', f.email);
      campo('Estado', f.estado === 'firmada' ? 'Firmó' :
                      f.estado === 'rechazada' ? 'RECHAZÓ firmar' : f.estado,
            f.estado === 'rechazada');
      if (f.motivo_rechazo) campo('Motivo del rechazo', f.motivo_rechazo, true);
      campo('Firmó el', fecha(f.firmada_en));
      campo('Nivel de garantía', f.nivel_garantia ?? '—');

      // ⚠ Esto es la respuesta a «¿cómo saben que era él?».
      if (f.identificacion.length) {
        doc.moveDown(0.2);
        const y0 = doc.y;
        doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
           .text('Cómo se identificó', izq, y0, { width: mm(48) });
        // ⚠ `doc.y` avanza sola después de cada `text`. Restarle 11 para
        // «volver» a la línea anterior funciona con UN elemento y superpone dos
        // renglones con dos: los dos factores de Ana salían uno encima del otro.
        let y = y0;
        for (const a of f.identificacion) {
          doc.font('Helvetica').fontSize(9).fillColor('#0f1e2c')
             .text(txt('- ' + (ANCLAJE[a.tipo] ?? a.tipo) + ' \u2014 probado el ' + fecha(a.probado_en)),
                   izq + mm(50), y, { width: ancho - mm(50) });
          y = doc.y + 1;
        }
        doc.y = Math.max(y, y0 + 12);
        doc.moveDown(0.3);
      } else {
        campo('Cómo se identificó', 'sin factores acreditados', true);
      }

      if (f.sello) {
        campo('Hora certificada por', f.sello.autoridad);
        campo('Sello de tiempo', fecha(f.sello.sellado_en) + '  ·  ' + f.sello.serie);
      } else if (f.estado === 'firmada') {
        campo('Sello de tiempo', 'sin sello: la fecha de esta firma la afirma MiFirma, no un tercero', true);
      }

      if (f.cronologia.length) {
        doc.moveDown(0.2);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRIS)
           .text('Cronología', izq, doc.y, { width: ancho });
        doc.moveDown(0.2);
        for (const e of f.cronologia) {
          if (doc.y > doc.page.height - mm(26)) doc.addPage();
          // Las dos columnas se escriben en la MISMA `y`, y recién después se
          // avanza a la más baja de las dos. Es la única forma de alinearlas sin
          // adivinar cuántas líneas ocupó cada una.
          const y = doc.y;
          doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
             .text(fecha(e.cuando), izq + 8, y, { width: mm(45) });
          const yIzq = doc.y;
          doc.fillColor('#0f1e2c')
             .text(txt((ETIQUETA[e.tipo] ?? e.tipo) + (e.ip ? '   \u00b7   desde ' + e.ip : '')),
                   izq + mm(50), y, { width: ancho - mm(50) });
          doc.y = Math.max(yIzq, doc.y);
        }
      }
    }

    // ── Verificación
    titulo('Cómo verificar todo esto sin MiFirma');
    doc.font('Helvetica').fontSize(9).fillColor('#0f1e2c').text(
      '1. Abrí el PDF firmado con cualquier lector que valide firmas —Adobe Acrobat Reader, ' +
      'por ejemplo—. El panel de firmas tiene que mostrar una firma por cada persona de la ' +
      'lista de arriba, todas válidas.\n\n' +
      '2. Calculá el SHA-256 del archivo que tenés y comparalo con la huella de este ' +
      'certificado. En una terminal: shasum -a 256 archivo.pdf\n\n' +
      '3. La firma electrónica y su sello de tiempo están DENTRO del PDF. No hace falta ' +
      'MiFirma, ni conexión, ni permiso de nadie: el documento se prueba solo.',
      izq, doc.y, { width: ancho, lineGap: 1.5 });

    titulo('Expediente de evidencia');
    campo('Eventos registrados', String(d.evidencia.eventos));
    campo('Cadena', d.evidencia.cadena_ok
      ? 'cierra: sin huecos ni eslabones rotos'
      : `NO cierra: ${d.evidencia.huecos} hueco(s), ${d.evidencia.rotos} roto(s)`,
      !d.evidencia.cadena_ok);
    campo('Hash raíz', d.evidencia.hash_raiz || '—');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(8.5).fillColor(GRIS).text(
      'Cada evento del expediente lleva el hash del anterior. Cambiar uno solo obliga a ' +
      'rehacer todos los siguientes, y el hash raíz de arriba deja de coincidir.',
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
         .text(`MiFirma · certificado de finalización · plantilla v${d.version_plantilla} · ` +
               `${d.circuito.instancia_id}`, izq, y, { width: ancho - 60, lineBreak: false });
      doc.text(`${i + 1} / ${total}`, izq + ancho - 60, y, { width: 60, align: 'right', lineBreak: false });
      doc.page.margins.bottom = guardado;
    }

    doc.end();
  });
}

