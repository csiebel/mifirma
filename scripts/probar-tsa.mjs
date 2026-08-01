/**
 * Sonda de autoridades de sellado de tiempo (RFC 3161).
 *
 * No escribe nada ni toca la base: pide un sello sobre un dato de prueba y
 * cuenta qué contestó cada TSA. Se corre a mano, desde una máquina con salida
 * a internet.
 *
 *   node scripts/probar-tsa.mjs                 # la lista de abajo
 *   node scripts/probar-tsa.mjs http://otra/tsa # una en particular
 *
 * ═══ QUÉ SE BUSCA ═══
 *
 * 1. Cuáles responden de verdad. Una lista de URLs sacada de internet no es un
 *    hecho: la mitad exigen contrato, otras filtran por origen.
 * 2. CUÁNTO OCUPA EL TOKEN. Es el dato que decide `LARGO_FIRMA` en pades.ts. El
 *    sello va como atributo NO firmado adentro del PKCS#7, o sea que agranda la
 *    firma después de haber reservado el hueco. Si el hueco quedó chico, la
 *    firma no entra y el documento se rompe — y se rompe en producción, con un
 *    documento real, el día que la TSA elegida devuelva una cadena más larga.
 * 3. Si el `genTime` que devuelven está cerca de la hora real. Una TSA
 *    desfasada sella con una hora que no sirve.
 *
 * ⚠ Lo que este script NO hace: verificar la cadena del certificado de la TSA.
 * Eso necesita los anclajes de confianza de cada país, que son dato del paquete
 * de país verificado por un abogado local, no conocimiento de este programa.
 */
import forge from 'node-forge';
import { createHash, randomBytes } from 'node:crypto';

const asn1 = forge.asn1;
const U = asn1.Class.UNIVERSAL;
const T = asn1.Type;
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_CT_TSTINFO = '1.2.840.113549.1.9.16.1.4';

const int = (b) => asn1.create(U, T.INTEGER, false, b.toString('binary'));
const intN = (n) => asn1.create(U, T.INTEGER, false, asn1.integerToDer(n).getBytes());
const oid = (o) => asn1.create(U, T.OID, false, asn1.oidToDer(o).getBytes());
const seq = (v) => asn1.create(U, T.SEQUENCE, true, v);
const oct = (b) => asn1.create(U, T.OCTETSTRING, false, b.toString('binary'));

function pedido(hash, nonce, pedirCert) {
  const v = [
    intN(1),
    seq([
      seq([oid(OID_SHA256), asn1.create(U, T.NULL, false, '')]),
      oct(hash),
    ]),
  ];
  if (nonce) v.push(int(nonce));
  if (pedirCert) v.push(asn1.create(U, T.BOOLEAN, false, String.fromCharCode(0xff)));
  return Buffer.from(asn1.toDer(seq(v)).getBytes(), 'binary');
}

function leerToken(nodo) {
  const encap = nodo.value[1].value[0].value[2];
  const tipo = asn1.derToOid(encap.value[0].value);
  const o = encap.value[1].value[0];
  const bytes = typeof o.value === 'string' ? o.value : asn1.toDer(o.value[0]).getBytes();
  const tst = asn1.fromDer(bytes);
  let nonce = null;
  for (const x of tst.value.slice(5)) {
    if (x.tagClass === U && x.type === T.INTEGER) { nonce = Buffer.from(x.value, 'binary'); break; }
  }
  return {
    tipo,
    hash: Buffer.from(tst.value[2].value[1].value, 'binary'),
    politica: asn1.derToOid(tst.value[1].value),
    genTime: tst.value[4].value,
    nonce,
    bytes: Buffer.from(asn1.toDer(nodo).getBytes(), 'binary').length,
  };
}

function leerRespuesta(buf, esperado, nonceEnviado) {
  const r = asn1.fromDer(buf.toString('binary'));
  const codigo = r.value[0].value[0].value.charCodeAt(0);
  if (codigo !== 0 && codigo !== 1) throw new Error('la TSA rechazó el pedido (status ' + codigo + ')');
  if (!r.value[1]) throw new Error('la TSA no devolvió token');
  const t = leerToken(r.value[1]);
  if (t.tipo !== OID_CT_TSTINFO) throw new Error('el contenido no es un TSTInfo: ' + t.tipo);
  if (!t.hash.equals(esperado)) throw new Error('EL SELLO ES DE OTRO DATO: el imprint no coincide');
  if (nonceEnviado && (!t.nonce || !t.nonce.equals(nonceEnviado))) {
    throw new Error('nonce distinto: puede ser una respuesta reusada');
  }
  return t;
}

function fechaTst(g) {
  // GeneralizedTime: AAAAMMDDHHMMSS[.f]Z
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(g);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

const TSAS = process.argv[2]
  ? [['argumento', process.argv[2]]]
  : [
      ['digicert', 'http://timestamp.digicert.com'],
      ['sectigo', 'http://timestamp.sectigo.com'],
      ['globalsign', 'http://timestamp.globalsign.com/tsa/r6advanced1'],
      ['apple', 'http://timestamp.apple.com/ts01'],
      ['certum', 'http://time.certum.pl'],
      ['freetsa', 'https://freetsa.org/tsr'],
      ['entrust', 'http://timestamp.entrust.net/TSS/RFC3161sha2TS'],
    ];

const datos = Buffer.from('MiFirma · sonda de sellado de tiempo');
const hash = createHash('sha256').update(datos).digest();

console.log('Hora de esta máquina:', new Date().toISOString());
console.log('Dato sellado: sha256 =', hash.toString('hex').slice(0, 24) + '…\n');
console.log('TSA           certReq  token    desvío     política / genTime');
console.log('─'.repeat(96));

const tamanos = [];
for (const [nombre, url] of TSAS) {
  for (const pedirCert of [true, false]) {
    const nonce = randomBytes(8);
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/timestamp-query' },
        body: pedido(hash, nonce, pedirCert),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        console.log(nombre.padEnd(13), String(pedirCert).padEnd(8), 'HTTP ' + r.status);
        break;
      }
      const t = leerRespuesta(Buffer.from(await r.arrayBuffer()), hash, nonce);
      const f = fechaTst(t.genTime);
      const desvio = f ? Math.round((f.getTime() - Date.now()) / 1000) : null;
      if (pedirCert) tamanos.push([nombre, t.bytes]);
      console.log(
        nombre.padEnd(13),
        String(pedirCert).padEnd(8),
        (t.bytes + 'B').padEnd(8),
        (desvio === null ? '?' : (desvio > 0 ? '+' : '') + desvio + 's').padEnd(10),
        t.politica + '  ' + t.genTime + '  (' + (Date.now() - t0) + 'ms)'
      );
    } catch (e) {
      console.log(nombre.padEnd(13), String(pedirCert).padEnd(8), '✗ ' + e.message);
      break;
    }
  }
}

if (tamanos.length) {
  const max = Math.max(...tamanos.map((x) => x[1]));
  console.log('\n─'.repeat(1) + '\nToken más grande con certificado: ' + max + ' bytes (' +
    tamanos.filter((x) => x[1] === max).map((x) => x[0]).join(', ') + ')');
  console.log('LARGO_FIRMA hoy es 16384. Firma sin sello ≈ 2300 B; con sello ≈ ' + (2300 + max) + ' B.');
  console.log(max + 2300 > 16384
    ? '⚠ NO ENTRA: hay que agrandar LARGO_FIRMA antes de sellar.'
    : '✓ Entra con margen. Igual conviene revisarlo cuando se elija la TSA definitiva.');
}
