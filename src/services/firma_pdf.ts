import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Limpia un texto a lo que las fuentes estándar (WinAnsi/Latin-1) saben dibujar,
// para que un carácter raro en un nombre no rompa la generación del PDF.
function wa(s: string | null | undefined): string {
  return (s || '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

// Toma el formulario en blanco del banco (PDF o imagen) y le agrega al final una hoja de
// "Constancia de firma electrónica" con la firma del empleado incrustada y el rastro de
// auditoría (firmante, fecha/hora, IP, hash SHA-256 del documento original). Es firma
// electrónica simple: la imagen es la firma manuscrita digitalizada; el documento original
// no se modifica, sólo se le anexa la constancia.
export async function agregarHojaDeFirma(
  blanco: Buffer,
  blancoMime: string,
  datos: {
    firmante: string;
    documento?: string | null;
    formulario: string;
    fecha: Date;
    ip?: string | null;
    hash: string;
    firma: { bytes: Buffer; mime: string };
  },
): Promise<Buffer> {
  let doc: PDFDocument;
  if (blancoMime === 'application/pdf') {
    doc = await PDFDocument.load(blanco, { ignoreEncryption: true });
  } else {
    // El "formulario en blanco" es una imagen: la ponemos como primera página de un PDF nuevo.
    doc = await PDFDocument.create();
    const img = blancoMime === 'image/png' ? await doc.embedPng(blanco) : await doc.embedJpg(blanco);
    const pg = doc.addPage([img.width, img.height]);
    pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontB = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]); // A4
  const M = 56;
  let y = 841.89 - 70;
  const ink = rgb(0.06, 0.16, 0.15);
  const gray = rgb(0.36, 0.42, 0.41);
  const line = rgb(0.84, 0.88, 0.87);

  page.drawText('Constancia de firma electronica', { x: M, y, size: 18, font: fontB, color: ink });
  y -= 12;
  page.drawLine({ start: { x: M, y }, end: { x: 595.28 - M, y }, thickness: 1, color: line });
  y -= 32;

  const fila = (etq: string, val: string) => {
    page.drawText(etq, { x: M, y, size: 10, font: fontB, color: gray });
    page.drawText(wa(val), { x: M + 135, y, size: 10, font, color: ink });
    y -= 22;
  };
  const f = datos.fecha;
  const fecha =
    f.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' +
    f.toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
  fila('Documento', datos.formulario);
  fila('Firmante', datos.firmante + (datos.documento ? ' (' + datos.documento + ')' : ''));
  fila('Fecha y hora', fecha);
  if (datos.ip) fila('IP de origen', datos.ip);
  fila('Tipo de firma', 'Firma electronica simple (firma manuscrita digitalizada)');

  page.drawText('Hash SHA-256 del documento', { x: M, y, size: 10, font: fontB, color: gray });
  y -= 16;
  page.drawText(datos.hash.slice(0, 64), { x: M, y, size: 8.5, font, color: ink });
  y -= 34;

  page.drawText('Firma:', { x: M, y, size: 10, font: fontB, color: gray });
  y -= 14;
  try {
    const fImg = datos.firma.mime === 'image/jpeg' ? await doc.embedJpg(datos.firma.bytes) : await doc.embedPng(datos.firma.bytes);
    const fw = 180;
    const fh = fw * (fImg.height / fImg.width);
    page.drawImage(fImg, { x: M, y: y - fh, width: fw, height: fh });
    y -= fh + 8;
  } catch {
    y -= 8;
  }
  page.drawLine({ start: { x: M, y }, end: { x: M + 220, y }, thickness: 1, color: ink });
  y -= 26;

  page.drawText('Esta hoja certifica que el firmante aplico su firma electronica al documento', { x: M, y, size: 8.5, font, color: gray });
  y -= 12;
  page.drawText('identificado por el hash indicado. El documento original no fue modificado.', { x: M, y, size: 8.5, font, color: gray });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
