import type { Signer } from '@signpdf/utils';

/**
 * Un adaptador de firma: lo único que hace es conseguir una firma criptográfica.
 *
 * ═══ POR QUÉ ES TAN CHICO ═══
 *
 * Los proveedores de firma avanzada no firman PDF: firman hashes y devuelven un
 * PKCS#7. El PAdES —ByteRange, incremental update, DocMDP, DSS— lo arma nuestro
 * ensamblador, igual para todos. Así que un adaptador es "el componente que
 * consigue una firma sobre unos bytes", no un subsistema.
 *
 * De ahí que la firma simple entre por la misma puerta que SERPRO o tuID: no
 * hay bifurcación de arquitectura, cambia únicamente quién responde. El sello de
 * plataforma es un adaptador más, y el día que se habilite firma avanzada en un
 * país, lo que cambia es qué adaptador se usa — no el motor.
 */
export interface Firmante {
  /** Código del proveedor, tal como va en el catálogo y en el expediente. */
  readonly codigo: string;
  /** Qué nivel de firma produce. Lo consume el expediente, no el ensamblador. */
  readonly nivel: 'simple' | 'avanzada' | 'cualificada';
  /** Nombre legible del titular del certificado, para el panel de firmas. */
  readonly titular: string;

  /**
   * Devuelve un firmante listo para UN uso.
   *
   * ⚠ Una instancia por firma, no una compartida. `P12Signer` guarda el
   * certificado en un buffer de node-forge que se CONSUME al parsearlo: la
   * segunda firma con la misma instancia recibe cero bytes y falla con "Too few
   * bytes to parse DER". Se descubrió probándolo, no leyéndolo.
   */
  signer(): Signer;
}
