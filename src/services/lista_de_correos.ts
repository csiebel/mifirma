/**
 * Una lista de correos —pegada a mano o leída de una planilla— convertida en
 * direcciones, con el nombre de cada uno si venía.
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
 *
 * ═══ ⚠ EL CAMPO «PARA» DECÍA QUE ANDABA, Y NO ANDABA ═══
 *
 * El párrafo de arriba prometía «nombres entre <>» **desde el primer día, y era
 * mentira**. La versión anterior partía todo por espacios antes de mirar nada,
 * así que `Ana Pérez <ana@empresa.com>` se volvía tres pedazos y contestaba
 * *«Estos no parecen correos: Ana, Pérez»* — sobre el caso más común que hay,
 * que es reenviar un correo y copiar el Para. Nadie lo reportó porque el que lo
 * probó una vez supuso que estaba prohibido y borró los nombres a mano.
 *
 * > **Regla:** un comentario que promete una capacidad es una afirmación sobre
 * > el programa, y hay que probarla como se prueba cualquier otra. Éste vivió
 * > meses diciendo algo falso a un metro del código que lo desmentía.
 *
 * Ahora se lee **renglón por renglón**, buscando primero las formas
 * `Nombre <correo>`, y recién con lo que sobra se hace el partido por espacios
 * de siempre. Todo lo que funcionaba antes sigue dando exactamente lo mismo.
 */

/** Lo mismo que valida la ruta y el resto del sistema. Un solo criterio. */
const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * `Nombre Apellido <correo@dominio>`, la forma del campo «Para» de cualquier
 * cliente de correo — y la que arma la lectura de planillas para no perder la
 * columna del nombre.
 *
 * ⚠ El nombre **no puede contener coma ni punto y coma**, porque ésos son los
 * que separan un renglón del siguiente. La primera versión de esta expresión
 * los admitía, y sobre `ana@empresa.com, Ana <a@empresa.com>` el nombre se
 * comía la dirección de al lado: quedaba una sola persona, llamada
 * «ana@empresa.com, Ana». **Un destinatario desaparecía en silencio.**
 *
 * Para el nombre que sí lleva coma —`Pérez, Ana`— está la primera rama: Outlook
 * y Gmail los mandan entre comillas, y ahí la coma es parte del nombre.
 */
const CON_NOMBRE = /(?:"([^"]*)"|([^<>,;"]*))\s*<([^<>]*)>/g;

/** Tope del `nombre` en la ruta de firmantes. Un solo criterio, otra vez. */
const MAX_NOMBRE = 120;

export interface Persona {
  /** La dirección, tal como la escribió el emisor. */
  correo: string;
  /** Cómo se llama, si el renglón lo traía. `null` si no. */
  nombre: string | null;
}

export interface ListaPartida {
  /** Las direcciones buenas, sin repetidos, en el orden en que venían. */
  correos: string[];
  /** Lo mismo, con el nombre al lado. Mismo orden y mismo largo que `correos`. */
  personas: Persona[];
  /** Lo que no parece un correo, tal como venía escrito. */
  malos: string[];
  /** Los que aparecen más de una vez en la misma lista. */
  repetidos: string[];
}

/**
 * Limpia lo que quedó a la izquierda del `<`.
 *
 * ⚠ Devuelve `null` y no `''` cuando no queda nada: `<ana@empresa.com>` a secas
 * es una dirección sin nombre, no una persona que se llama «».
 */
function limpiarNombre(crudo: string): string | null {
  const n = String(crudo || '')
    // Lo que separa este renglón del anterior en la misma línea.
    .replace(/^[\s,;]+/, '')
    .replace(/[\s,;]+$/, '')
    // Las comillas con que Outlook envuelve los nombres que llevan coma.
    .replace(/^["']+/, '')
    .replace(/["']+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return null;
  return n.length > MAX_NOMBRE ? n.slice(0, MAX_NOMBRE) : n;
}

export function partirLista(crudo: string): ListaPartida {
  const correos: string[] = [];
  const personas: Persona[] = [];
  const malos: string[] = [];
  const repetidos: string[] = [];
  const vistos = new Set<string>();

  /** Un candidato ya aislado: se valida, se deduplica y entra o no entra. */
  const sumar = (dir: string, nombre: string | null) => {
    const p = dir
      .trim()
      // La basura que viaja pegada: comillas de una planilla, y la coma o el
      // punto que quedó al final del renglón.
      .replace(/^["']+/, '')
      .replace(/["',.;]+$/, '');
    if (!p) return;
    if (!CORREO.test(p)) { malos.push(p); return; }
    // ⚠ Se comparan en minúscula pero se guarda lo que escribió el emisor: el
    // buzón no distingue mayúsculas, y el nombre que la persona ve en el correo
    // sí. Comparar como el buzón y mostrar como la persona.
    const clave = p.toLowerCase();
    if (vistos.has(clave)) { repetidos.push(p); return; }
    vistos.add(clave);
    correos.push(p);
    personas.push({ correo: p, nombre });
  };

  /** El partido de siempre, para el texto que no venía con `< >`. */
  const sueltos = (texto: string) => {
    for (const t of texto.split(/[\s,;]+/)) {
      // El `<` y el `>` sueltos ya no pueden aparecer acá, pero se sacan igual
      // por si llega un renglón con uno solo, sin cerrar.
      const limpio = t.trim().replace(/^[<]+/, '').replace(/[>]+$/, '');
      if (limpio) sumar(limpio, null);
    }
  };

  // ⚠ Renglón por renglón. Un `<>` no cruza de una línea a la otra, y si
  // alguien dejó un `<` sin cerrar eso tiene que arruinar SU renglón y no
  // tragarse el resto de la lista.
  for (const linea of String(crudo || '').split(/\r?\n/)) {
    CON_NOMBRE.lastIndex = 0;
    let desde = 0;
    let m: RegExpExecArray | null;
    while ((m = CON_NOMBRE.exec(linea)) !== null) {
      // Lo que había antes de este `Nombre <correo>` y no forma parte de él.
      if (m.index > desde) sueltos(linea.slice(desde, m.index));
      // m[1] es el nombre entrecomillado y m[2] el suelto: viene uno u otro.
      sumar(m[3] ?? '', limpiarNombre(m[1] ?? m[2] ?? ''));
      desde = m.index + m[0].length;
    }
    if (desde < linea.length) sueltos(linea.slice(desde));
  }

  return { correos, personas, malos, repetidos };
}
