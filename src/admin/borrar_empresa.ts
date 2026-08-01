import { sql, type Transaction } from 'kysely';
import { db } from '../db/pool';
import type { DB } from '../db/schema';
import { fijarContexto } from '../db/contexto';
import { HttpError } from '../http/errors';

/**
 * Borrado total de una cuenta. Herramienta del operador para cuentas de prueba.
 *
 * ═══ EL CANDADO QUE IMPORTA ═══
 *
 * Si la cuenta tiene UNA sola instancia firmada, no se borra. Punto.
 *
 * No es prudencia excesiva: un documento firmado no es sólo de quien lo emitió.
 * El firmante tiene su copia y su otorgamiento perpetuo sobre ella
 * (`propiedad-y-otorgamientos.md`), y el expediente de evidencias es la prueba
 * que sostiene esa firma en un juicio. Borrar la cuenta emisora destruiría
 * prueba ajena — de alguien que ni siquiera es cliente nuestro y que confió en
 * que su firma iba a seguir valiendo.
 *
 * Para una cuenta con documentos firmados, la operación correcta es cerrarla
 * (`cuenta.estado = 'cerrada'`), no borrarla. Los plazos de conservación son
 * dato del paquete de país y los define el abogado local.
 *
 * ═══ MECÁNICA ═══
 *
 * Borra en orden hijo → padre dentro de UNA transacción: o se va todo o no se va
 * nada. Un borrado parcial deja una cuenta rota que nadie puede ni usar ni
 * limpiar.
 */

/**
 * Orden de borrado. Cada tabla va antes que aquella a la que referencia.
 *
 * ⚠ Si agregás una tabla con `cuenta_id`, agregala acá. La consulta de
 * verificación de abajo lo detecta y falla en vez de dejar filas huérfanas.
 */
const ORDEN_BORRADO = [
  'carpeta_permiso',
  'otorgamiento',
  'participacion',
  'instancia',
  'circuito',
  'archivo',
  'ubicacion',
  'carpeta',
  'usuario_rol',
  'rol_capacidad',
  'rol',
  'bloque_mensaje',
  'factura_linea',
  'factura_plataforma',
  'suscripcion',
  'consumo_ia',
  'medio_pago',
  'marca',
  'api_token',
  'token_acceso',
  'membresia',
  'persona',
  'empresa',
  'bitacora_plataforma',
] as const;

export interface ResultadoBorrado {
  cuentaId: string;
  nombre: string;
  filasBorradas: Record<string, number>;
}

export async function borrarCuenta(
  cuentaId: string,
  confirmacionNombre: string,
): Promise<ResultadoBorrado> {
  return db.transaction().execute(async (trx) => {
    // Actor 'sistema' con la cuenta fijada: las políticas de borrado lo admiten
    // y el contexto acota todo lo que se toca a esta cuenta. No hace falta —ni
    // conviene— una conexión que evada RLS.
    await fijarContexto(trx, { actor: 'sistema', cuentaId });

    const cuenta = await trx
      .selectFrom('cuenta')
      .select(['id', 'nombre_mostrado', 'estado'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();
    if (!cuenta) throw new HttpError(404, 'Esa cuenta no existe.');

    // Confirmación por nombre exacto: el operador tiene que tipearlo. Es la
    // diferencia entre borrar la cuenta que quería y la que tenía al lado en la
    // lista.
    if (confirmacionNombre.trim() !== cuenta.nombre_mostrado) {
      throw new HttpError(
        400,
        `Para borrarla hay que escribir su nombre exacto: "${cuenta.nombre_mostrado}".`,
      );
    }

    await verificarSinFirmas(trx, cuentaId);
    await verificarCoberturaDelOrden(trx);

    const filasBorradas: Record<string, number> = {};
    for (const tabla of ORDEN_BORRADO) {
      const r = await sql<{ n: string }>`
        with borradas as (
          delete from ${sql.table(tabla)} where cuenta_id = ${cuentaId}::uuid returning 1
        ) select count(*)::text as n from borradas
      `.execute(trx);
      const n = Number(r.rows[0]?.n ?? 0);
      if (n) filasBorradas[tabla] = n;
    }

    await trx.deleteFrom('cuenta').where('id', '=', cuentaId).execute();

    return { cuentaId, nombre: cuenta.nombre_mostrado, filasBorradas };
  });
}

/**
 * Nada firmado, ni en curso.
 *
 * También frena si hay circuitos despachados sin terminar: hay gente esperando
 * firmar algo que desaparecería de su bandeja sin explicación.
 */
async function verificarSinFirmas(trx: Transaction<DB>, cuentaId: string): Promise<void> {
  const r = await sql<{ firmadas: string; en_curso: string }>`
    select
      count(*) filter (where estado in ('firmada','completada'))::text as firmadas,
      count(*) filter (where estado in ('en_curso','despachada'))::text as en_curso
    from instancia
    where cuenta_propietaria_id = ${cuentaId}::uuid
  `.execute(trx);

  const firmadas = Number(r.rows[0]?.firmadas ?? 0);
  const enCurso = Number(r.rows[0]?.en_curso ?? 0);

  if (firmadas > 0) {
    throw new HttpError(
      409,
      `Esta cuenta tiene ${firmadas} documento(s) firmado(s). No se borra: el firmante tiene su copia y su evidencia, y borrarla destruiría prueba ajena. Si la cuenta ya no opera, cerrala en vez de borrarla.`,
    );
  }
  if (enCurso > 0) {
    throw new HttpError(
      409,
      `Esta cuenta tiene ${enCurso} circuito(s) en curso. Cancelalos primero: hay firmantes esperando.`,
    );
  }
}

/**
 * Toda tabla con `cuenta_id` tiene que estar en ORDEN_BORRADO.
 *
 * Sin esto, agregar una tabla en una migración futura y olvidarse de esta lista
 * deja filas huérfanas apuntando a una cuenta que ya no existe — y como el
 * borrado corre en transacción, el `delete from cuenta` fallaría por FK con un
 * mensaje que no le dice nada a nadie. Mejor fallar acá, con el nombre de la
 * tabla que falta.
 */
async function verificarCoberturaDelOrden(trx: Transaction<DB>): Promise<void> {
  const r = await sql<{ tabla: string }>`
    select c.table_name as tabla
      from information_schema.columns c
      join pg_class pc on pc.relname = c.table_name
     where c.table_schema = 'public'
       and c.column_name = 'cuenta_id'
       and not pc.relispartition
       and c.table_name <> 'cuenta'
  `.execute(trx);

  const faltan = r.rows
    .map((x) => x.tabla)
    .filter((t) => !(ORDEN_BORRADO as readonly string[]).includes(t));

  if (faltan.length) {
    throw new HttpError(
      500,
      `El borrado de cuentas está desactualizado: faltan tablas en ORDEN_BORRADO (${faltan.join(', ')}). Agregalas antes de borrar nada.`,
    );
  }
}
