import { createHash, randomBytes } from 'node:crypto';
import forge from 'node-forge';

/**
 * Cliente de sellado de tiempo, RFC 3161.
 *
 * ═══ QUÉ RESUELVE, Y POR QUÉ NO ALCANZA CON NUESTRO RELOJ ═══
 *
 * El encadenamiento por hash de la evidencia prueba consistencia interna, no
 * anterioridad: quien tenga escritura sobre la base puede rehacer la cadena
 * entera y fabricar un expediente coherente con fecha de hace dos años. Y ese
 * "quien" incluye a la empresa emisora del documento, que es exactamente la
 * parte con interés en el juicio. `now()` de PostgreSQL sirve para ordenar, no
 * para probar.
 *
 * Un tercero sin relación con las partes afirma la hora, y lo afirma firmado.
 * Eso es lo que se pide acá.
 *
 * ═══ LAS TRES COMPROBACIONES QUE NO SON OPCIONALES ═══
 *
 * Una respuesta de TSA que no se verifica es peor que no pedirla, porque da
 * confianza sin fundamento. Se comprueba:
 *
 * 1. **El estado.** `granted` (0) o `grantedWithMods` (1). Cualquier otro es un
 *    rechazo y hay que tratarlo como tal, no seguir de largo.
 * 2. **El imprint.** Que el sello sea del hash QUE MANDAMOS. Sin esto, una
 *    respuesta de otra operación —cacheada, mezclada, inyectada— pasa por buena
 *    y termina adentro de un documento firmado.
 * 3. **El nonce.** Que sea el de este pedido. Es lo que distingue una respuesta
 *    fresca de una repetida: sin nonce, alguien que pueda interceptar la
 *    conexión devuelve el sello de ayer y la hora que prueba es la de ayer.
 *
 * Probado contra los cuatro casos —respuesta legítima, imprint de otro dato,
 * nonce cambiado, rechazo de la autoridad— antes de escribir esto.
 *
 * ⚠ Lo que NO se verifica todavía: la cadena de certificados de la autoridad.
 * Eso necesita los anclajes de confianza de cada país, que son dato del paquete
 * de país verificado por un abogado local. Hasta que estén, el sello prueba que
 * *alguien* con esa clave afirmó la hora; que ese alguien esté acreditado en
 * Uruguay es una afirmación que todavía no podemos hacer, y por eso no se hace.
 */

const asn1 = forge.asn1;
const U = asn1.Class.UNIVERSAL;
const C = asn1.Class.CONTEXT_SPECIFIC;
const T = asn1.Type;

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_CT_TSTINFO = '1.2.840.113549.1.9.16.1.4';

const intBuf = (b: Buffer) => asn1.create(U, T.INTEGER, false, b.toString('binary'));
const intNum = (n: number) => asn1.create(U, T.INTEGER, false, asn1.integerToDer(n).getBytes());
const oid = (o: string) => asn1.create(U, T.OID, false, asn1.oidToDer(o).getBytes());
const seq = (v: any[]) => asn1.create(U, T.SEQUENCE, true, v);
const oct = (b: Buffer) => asn1.create(U, T.OCTETSTRING, false, b.toString('binary'));
const nulo = () => asn1.create(U, T.NULL, false, '');
export const der = (n: any) => Buffer.from(asn1.toDer(n).getBytes(), 'binary');

export interface ConfigTsa {
  id: string;
  nombre: string;
  url: string;
  politicaOid: string | null;
  usuario: string | null;
  password: string | null;
  timeoutMs: number;
}

export interface SelloObtenido {
  /** El TimeStampToken crudo (un ContentInfo DER). Es lo que se embebe y lo que
   *  un verificador externo necesita: sin el token, la fecha es palabra nuestra. */
  token: Buffer;
  /** El mismo token ya parseado, para no volver a hacerlo. */
  nodo: any;
  /** La hora que afirma la AUTORIDAD, no la nuestra. */
  selladoEn: Date;
  politica: string;
  serie: string;
  tsaId: string;
  tsaNombre: string;
}

/** El pedido. `certReq` siempre en true: sin el certificado de la autoridad
 *  adentro, el sello no se puede verificar sin ir a buscarlo, y dentro de diez
 *  años puede no estar. Cuesta unos 5 KB y compra independencia. */
function armarPedido(hash: Buffer, nonce: Buffer, politicaOid: string | null) {
  const v: any[] = [
    intNum(1),
    seq([seq([oid(OID_SHA256), nulo()]), oct(hash)]),
  ];
  if (politicaOid) v.push(oid(politicaOid));
  v.push(intBuf(nonce));
  v.push(asn1.create(U, T.BOOLEAN, false, String.fromCharCode(0xff)));
  return der(seq(v));
}

function fechaGeneralizada(g: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(g);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  return isNaN(d.getTime()) ? null : d;
}

/** Lee el TSTInfo de adentro del token, que es donde vive lo que importa. */
function leerTstInfo(token: any) {
  // ⚠ `any` a propósito: node-forge tipa `value` como `string | Asn1[]` en todos
  // los nodos, así que recorrer un ASN.1 concreto con tipos exige un cast por
  // campo y no gana nada — la estructura la garantiza el RFC, no TypeScript.
  const v = (x: any): any => x;
  const encap = token.value[1].value[0].value[2];
  const tipo = asn1.derToOid(encap.value[0].value);
  const o = encap.value[1].value[0];
  const bytes = typeof o.value === 'string' ? o.value : asn1.toDer(o.value[0]).getBytes();
  const tst = asn1.fromDer(bytes);

  // El nonce es opcional y va después de campos opcionales: se busca, no se
  // indexa. Indexarlo funciona con la autoridad con la que se probó y falla con
  // la siguiente, que es el peor tipo de error.
  let nonce: Buffer | null = null;
  for (const x of v(tst.value).slice(5)) {
    if (x.tagClass === U && x.type === T.INTEGER) { nonce = Buffer.from(x.value, 'binary'); break; }
  }
  return {
    tipo,
    politica: asn1.derToOid(v(tst.value)[1].value),
    hash: Buffer.from(v(tst.value)[2].value[1].value, 'binary'),
    serie: Buffer.from(v(tst.value)[3].value, 'binary').toString('hex'),
    genTime: String(v(tst.value)[4].value),
    nonce,
  };
}

/**
 * Pide un sello sobre `datos` a UNA autoridad. Tira si algo no cierra.
 *
 * `datos` es lo que se quiere anclar en el tiempo: para el sello de una firma,
 * el valor de la firma; para el anclaje por lote, la raíz del árbol.
 */
export async function pedirSello(datos: Buffer, tsa: ConfigTsa): Promise<SelloObtenido> {
  const hash = createHash('sha256').update(datos).digest();
  const nonce = randomBytes(8);

  const cabeceras: Record<string, string> = { 'Content-Type': 'application/timestamp-query' };
  if (tsa.usuario && tsa.password) {
    cabeceras.Authorization =
      'Basic ' + Buffer.from(`${tsa.usuario}:${tsa.password}`).toString('base64');
  }

  const r = await fetch(tsa.url, {
    method: 'POST',
    headers: cabeceras,
    body: armarPedido(hash, nonce, tsa.politicaOid),
    signal: AbortSignal.timeout(tsa.timeoutMs),
  });
  if (!r.ok) throw new Error(`${tsa.nombre} respondió HTTP ${r.status}`);

  const cuerpo = Buffer.from(await r.arrayBuffer());
  let resp: any;
  try {
    resp = asn1.fromDer(cuerpo.toString('binary'));
  } catch {
    throw new Error(`${tsa.nombre} devolvió algo que no es una respuesta RFC 3161`);
  }

  const estado = (resp.value[0].value[0].value as string).charCodeAt(0);
  if (estado !== 0 && estado !== 1) {
    throw new Error(`${tsa.nombre} rechazó el pedido (PKIStatus ${estado})`);
  }
  if (!resp.value[1]) throw new Error(`${tsa.nombre} no devolvió token`);

  const token = resp.value[1];
  const info = leerTstInfo(token);

  if (info.tipo !== OID_CT_TSTINFO) {
    throw new Error(`${tsa.nombre} devolvió un contenido que no es TSTInfo (${info.tipo})`);
  }
  if (!info.hash.equals(hash)) {
    throw new Error(`${tsa.nombre} selló OTRO dato: el imprint no coincide`);
  }
  if (!info.nonce || !info.nonce.equals(nonce)) {
    throw new Error(`${tsa.nombre} devolvió otro nonce: la respuesta puede ser reusada`);
  }

  const selladoEn = fechaGeneralizada(info.genTime);
  if (!selladoEn) throw new Error(`${tsa.nombre} devolvió una hora ilegible (${info.genTime})`);

  return {
    token: der(token),
    nodo: token,
    selladoEn,
    politica: info.politica,
    serie: info.serie,
    tsaId: tsa.id,
    tsaNombre: tsa.nombre,
  };
}

/**
 * El desvío entre la hora de la autoridad y la nuestra, en segundos.
 *
 * No invalida nada por sí solo —la hora que vale es la de la TSA— pero un
 * desvío grande dice que nuestro reloj se fue, y eso sí afecta al orden de los
 * eventos del expediente. Se registra para poder mirarlo, que es más de lo que
 * hace R5 de `auditoria-y-evidencias.md` hoy.
 */
export function desvio(sello: SelloObtenido): number {
  return Math.round((sello.selladoEn.getTime() - Date.now()) / 1000);
}

// ============================================================================
// Insertar el sello en el PKCS#7
// ============================================================================

/** id-aa-signatureTimeStampToken. El sello de la FIRMA, no del documento. */
const OID_SIG_TST = '1.2.840.113549.1.9.16.2.14';

function signerInfoDe(cmsDer: Buffer) {
  const ci: any = asn1.fromDer(cmsDer.toString('binary'));
  const signedData: any = ci.value[1].value[0];
  const signerInfos: any = signedData.value[signedData.value.length - 1];
  if (signerInfos.type !== T.SET || !signerInfos.value.length) {
    throw new Error('el PKCS#7 no tiene signerInfos donde debería');
  }
  return { ci, si: signerInfos.value[0] };
}

/**
 * El valor de la firma dentro del SignerInfo.
 *
 * Se busca desde el final y por etiqueta UNIVERSAL: los campos opcionales del
 * SignerInfo —signedAttrs, unsignedAttrs— van con etiqueta de contexto, así que
 * no se confunden con éste. Contar posiciones fijas rompería con el primer
 * proveedor que agregue un opcional.
 */
function valorDeFirma(si: any): Buffer {
  for (let i = si.value.length - 1; i >= 0; i--) {
    const x = si.value[i];
    if (x.tagClass === U && x.type === T.OCTETSTRING) return Buffer.from(x.value, 'binary');
  }
  throw new Error('no encontré el valor de la firma en el PKCS#7');
}

/**
 * Mete el token como atributo NO firmado del SignerInfo.
 *
 * ═══ POR QUÉ ESTO NO ROMPE LA FIRMA ═══
 *
 * Los atributos no firmados quedan fuera de lo que cubre `signature`: por
 * definición se pueden agregar después sin invalidar nada. Comprobado sobre un
 * PDF de tres firmas, no deducido del RFC.
 *
 * ⚠ Y sin embargo el sello NO se puede agregar más tarde, por otra razón: el
 * `/Contents` donde vive este PKCS#7 SÍ está dentro del ByteRange de las firmas
 * POSTERIORES. Tocarlo después rompe las que vinieron después. Se obtiene ahora
 * o no se obtiene nunca. (El sello de DOCUMENTO es otra cosa y ése sí se puede
 * agregar cuando sea — ver migración 028.)
 */
export function insertarSelloEnFirma(cmsDer: Buffer, token: any): Buffer {
  const { ci, si } = signerInfoDe(cmsDer);
  const attr = seq([oid(OID_SIG_TST), asn1.create(U, T.SET, true, [token])]);
  const unsigned = si.value.find((x: any) => x.tagClass === C && x.type === 1);
  if (unsigned) unsigned.value.push(attr);
  else si.value.push(asn1.create(C, 1, true, [attr]));
  return der(ci);
}

/** El hash que hay que sellar para una firma: el valor de la firma misma. */
export function loQueSeSella(cmsDer: Buffer): Buffer {
  return valorDeFirma(signerInfoDe(cmsDer).si);
}

/**
 * El sello de tiempo embebido en un PKCS#7, si lo tiene.
 *
 * Se lee del archivo, no de nuestra base: es la misma comprobación que haría un
 * tercero con el PDF en la mano. Si la pantalla mostrara la fecha que dice
 * nuestra tabla, estaría mostrando nuestra palabra con aspecto de prueba.
 */
export function leerSelloDeFirma(cmsDer: Buffer) {
  try {
    const { si } = signerInfoDe(cmsDer);
    const unsigned: any = si.value.find((x: any) => x.tagClass === C && x.type === 1);
    if (!unsigned) return null;
    const attr = unsigned.value.find(
      (a: any) => asn1.derToOid(a.value[0].value) === OID_SIG_TST,
    );
    if (!attr) return null;
    const info = leerTstInfo(attr.value[1].value[0]);
    const fecha = fechaGeneralizada(info.genTime);
    return {
      sellado_en: fecha ? fecha.toISOString() : null,
      politica: info.politica,
      numero_serie: info.serie,
    };
  } catch {
    return null;
  }
}

/** ¿Este PKCS#7 ya tiene sello de firma? Sirve para verificar sin adivinar. */
export function tieneSello(cmsDer: Buffer): boolean {
  try {
    const { si } = signerInfoDe(cmsDer);
    const unsigned = si.value.find((x: any) => x.tagClass === C && x.type === 1);
    if (!unsigned) return false;
    return unsigned.value.some((a: any) => asn1.derToOid(a.value[0].value) === OID_SIG_TST);
  } catch {
    return false;
  }
}

