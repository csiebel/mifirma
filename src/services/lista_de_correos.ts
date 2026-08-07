/**
 * Una lista de correos pegada a mano, convertida en direcciones.
 *
 * ═══ POR QUÉ ESTO ES UN ARCHIVO APARTE ═══
 *
 * Porque no toca la base ni sabe nada del dominio: entra un texto, sale una
 * lista. Eso se puede probar solo, sin levantar Postgres ni el servidor, y una
 * función que se puede probar sola conviene poder probarla sola.
 *
 * ═══ QUÉ ACEPTA, Y POR QUÉ TANTO ═══
 *
 * Lo que el emisor tiene en la mano no es una lista prolija: es una columna
 * copiada de Excel (saltos de línea), el campo «Para» de un correo reenviado
 * (comas y nombres entre <>), o algo tipeado a las apuradas (punto y coma,
 * espacios de más, una coma final). Pedirle que lo formatee es pedirle que
 * haga el trabajo que tiene que hacer el programa.
 *
 * ⚠ Lo que NO hace es adivinar. Un correo mal escrito se devuelve como malo,
 * no se «corrige»: mandarle el documento a una dirección que nosotros
 * inventamos es peor que no mandarlo.
 */

/** Lo mismo que valida la ruta y el resto del sistema. Un solo criterio. */
const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface ListaPartida {
  /** Las direcciones buenas, sin repetidos, en el orden en que venían. */
  correos: string[];
  /** Lo que no parece un correo, tal como venía escrito. */
  malos: string[];
  /** Los que aparecen más de una vez en la misma lista. */
  repetidos: string[];
}

export function partirLista(crudo: string): ListaPartida {
  const partes = String(crudo || '')
    // Separadores: salto de línea, tabulación, espacio, coma, punto y coma.
    .split(/[\s,;]+/)
    // Y la basura que viaja pegada: los <> del campo Para, comillas de una
    // planilla, y la coma o el punto que quedó al final del renglón.
    .map((s) => s.trim().replace(/^[<"']+/, '').replace(/[>"',.;]+$/, ''))
    .filter(Boolean);

  const correos: string[] = [];
  const malos: string[] = [];
  const repetidos: string[] = [];
  const vistos = new Set<string>();

  for (const p of partes) {
    if (!CORREO.test(p)) { malos.push(p); continue; }
    // ⚠ Se comparan en minúscula pero se guarda lo que escribió el emisor: el
    // buzón no distingue mayúsculas, y el nombre que la persona ve en el correo
    // sí. Comparar como el buzón y mostrar como la persona.
    const clave = p.toLowerCase();
    if (vistos.has(clave)) { repetidos.push(p); continue; }
    vistos.add(clave);
    correos.push(p);
  }

  return { correos, malos, repetidos };
}
