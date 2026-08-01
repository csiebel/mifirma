import { sql, type Transaction } from 'kysely';
import type { DB } from './schema';

/**
 * El contexto RLS de MiFirma.
 *
 * Payroll necesitaba un solo dato — de qué empresa sos — porque la empresa era
 * una frontera dura. Acá los documentos cruzan cuentas y llegan a firmantes sin
 * cuenta, así que la base necesita saber siete cosas para poder decidir. Este
 * módulo es el ÚNICO lugar donde se setean: si alguien las setea en otro lado,
 * el modelo de autorización deja de ser auditable.
 *
 * Reglas que no se negocian:
 *
 * 1. SIEMPRE con set_config(..., is_local => true), que equivale a SET LOCAL:
 *    vive dentro de la transacción y se revierte al COMMIT. Un SET de sesión
 *    con pool de conexiones filtra el contexto de un usuario a la request
 *    siguiente — el bug más peligroso y más fácil de cometer de todo el diseño.
 *
 * 2. Los valores van como PARÁMETRO, nunca concatenados. Una inyección acá no
 *    es "leer una tabla": es convertirse en cualquier persona.
 *
 * 3. El nivel de garantía es de la SESIÓN, no de la identidad. La misma persona
 *    entrando por tuID tiene nivel alto; con mail y contraseña, bajo. En la
 *    segunda sesión no debe ver lo que está atado a su documento de identidad.
 */
export type Actor = 'cuenta' | 'externo' | 'operador' | 'sistema' | 'anonimo';
export type NivelGarantia = 'ninguno' | 'bajo' | 'sustancial' | 'alto';

export interface ContextoRls {
  actor: Actor;
  cuentaId?: string | null;
  identidadId?: string | null;
  /** Anclajes que ESTA sesión acreditó (no los que la identidad tiene). */
  anclajesProbados?: string[];
  nivelGarantia?: NivelGarantia;
  idioma?: string;
  /** Solo para actor 'externo': el enlace es un puntero a una fila, no un permiso. */
  otorgamientoId?: string | null;
}

export async function fijarContexto(trx: Transaction<DB>, ctx: ContextoRls): Promise<void> {
  const v = (x: string | null | undefined) => x ?? '';

  await sql`select
    set_config('app.actor',             ${ctx.actor}, true),
    set_config('app.cuenta_id',         ${v(ctx.cuentaId)}, true),
    set_config('app.identidad_id',      ${v(ctx.identidadId)}, true),
    set_config('app.anclajes_probados', ${(ctx.anclajesProbados ?? []).join(',')}, true),
    set_config('app.nivel_garantia',    ${ctx.nivelGarantia ?? 'ninguno'}, true),
    set_config('app.idioma',            ${ctx.idioma ?? 'es'}, true),
    set_config('app.otorgamiento_id',   ${v(ctx.otorgamientoId)}, true)
  `.execute(trx);
}
