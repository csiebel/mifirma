import { AsyncLocalStorage } from 'node:async_hooks';
import type { NivelGarantia } from '../db/contexto';

/**
 * La sesión del pedido en curso, disponible sin pasarla de mano en mano.
 *
 * ═══ POR QUÉ EXISTE ESTO ═══
 *
 * El token de sesión trae, firmados, los ANCLAJES que esta sesión probó y su
 * NIVEL DE GARANTÍA. La base los necesita: `app.identidad_probada()` y
 * `app.nivel_garantia()` son la mitad del modelo de autorización — lo que
 * distingue "decís que sos vos" de "lo probaste en esta sesión", y lo que hace
 * que entrar con tuID abra documentos que con contraseña no se ven.
 *
 * `withUsuario` siempre supo recibirlos, en un cuarto parámetro opcional. Y en
 * los 56 lugares donde se lo llama, NADIE se lo pasaba nunca. O sea:
 * `app.anclajes_probados()` devolvía el conjunto vacío en todos los pedidos del
 * sistema, `app.identidad_probada()` era falso siempre, y cualquier política
 * que dependiera de eso estaba muerta sin que nada lo dijera.
 *
 * Se descubrió el 1/8/2026 al escribir la primera política que dependía SÓLO de
 * esa rama —`firma_visual`—: falló con 500 en el primer intento. Las anteriores
 * tenían otras ramas que las tapaban, así que el hueco venía funcionando de
 * casualidad.
 *
 * ═══ POR QUÉ CONTEXTO IMPLÍCITO Y NO UN PARÁMETRO MÁS ═══
 *
 * Porque un parámetro opcional que hay que acordarse de pasar en 56 lugares
 * NO ES UN INVARIANTE, es una convención — y ya sabemos cómo termina eso. Con
 * `AsyncLocalStorage` no hay nada que olvidar: el dato está porque el pedido
 * está.
 *
 * Verificado antes de escribirlo: el contexto atraviesa los hooks de Fastify,
 * los `await`, los cortes de tick, y NO se cruza entre pedidos concurrentes.
 * Tres pedidos simultáneos con identidades distintas conservaron cada uno la
 * suya.
 */

export interface SesionDelPedido {
  anclajesProbados?: string[];
  nivelGarantia?: NivelGarantia;
  idioma?: string;
}

const almacen = new AsyncLocalStorage<SesionDelPedido>();

/**
 * Abre el contexto para este pedido. Se llama UNA vez, en el hook más temprano.
 *
 * El objeto se crea vacío y se completa después, cuando la autenticación
 * resuelve quién es: así no importa el orden de los hooks, que es justo el tipo
 * de detalle que se rompe cuando alguien agrega uno nuevo.
 */
export function abrirContextoPedido<T>(fn: () => T): T {
  return almacen.run({}, fn);
}

/** Carga los datos de la sesión en el contexto ya abierto. */
export function fijarSesionDelPedido(s: SesionDelPedido): void {
  const actual = almacen.getStore();
  if (!actual) return;   // fuera de un pedido —un job, un test— y está bien
  actual.anclajesProbados = s.anclajesProbados;
  actual.nivelGarantia = s.nivelGarantia;
  actual.idioma = s.idioma;
}

/**
 * La sesión del pedido en curso, o undefined si no hay pedido.
 *
 * ⚠ `undefined` significa "no hay sesión que declarar", no "no probó nada". Un
 * job de la cola corre sin pedido y va por `withTenant`, que fija actor
 * 'sistema'. Esta función no es un control de acceso: es un transporte.
 */
export function sesionDelPedido(): SesionDelPedido | undefined {
  return almacen.getStore();
}
