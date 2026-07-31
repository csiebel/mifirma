import { ownerDb } from '../db/owner';
import { HttpError } from '../http/errors';

// Borrado total de una empresa (herramienta de operador para empresas de prueba/descarte).
//
// CANDADOS (la ruta exige además: solo superadmin):
//   1. Confirmación por nombre exacto (el operador tiene que tipear el nombre).
//   2. Se NIEGA si la empresa tiene recibos emitidos (inmutable=true): retención legal.
//      Además, la base tiene un trigger que impide borrar recibos inmutables, así que
//      aunque se intentara, la transacción haría rollback (sin borrado parcial).
//
// Mecánica: borra las 27 tablas de tenant en orden hijo->padre dentro de una
// transacción. Las 4 que referencian empresa con ON DELETE CASCADE
// (api_token, suscripcion, factura_plataforma, recibo_plantilla) se borran solas
// al eliminar la fila de empresa. El self-FK de unidad_org (parent_id, RESTRICT)
// se neutraliza poniéndolo en NULL antes de borrar esa tabla.

const TABLAS_BORRADO = [
  'linea_recibo',
  'envio_recibo',
  'recibo',
  'retencion_aplicada',
  'retencion',
  'corrida_liquidacion',
  'novedad',
  'ausencia_licencia',
  'evaluacion',
  'inscripcion',
  'capacitacion',
  'relacion_laboral_version',
  'relacion_laboral',
  'cargo',
  'unidad_org',
  'legajo_doc',
  'estudio_cert',
  'usuario_rol',
  'capacidad',
  'otp_login',
  'dispositivo_confiable',
  'token_acceso',
  'usuario',
  'rol',
  'persona',
  'establecimiento',
  'auditoria',
];

export interface ResumenBorrado {
  ok: true;
  cuenta_id: string;
  empresa_nombre: string;
  filas_borradas: number;
}

export async function borrarEmpresa(cuentaId: string, nombreTipeado: string): Promise<ResumenBorrado> {
  const db = ownerDb();

  const emp = await db
    .selectFrom('empresa')
    .select(['id', 'nombre'])
    .where('id', '=', cuentaId)
    .executeTakeFirst();
  if (!emp) throw new HttpError(404, 'La empresa no existe (quizás ya fue borrada).');

  // Candado 1: confirmación por nombre exacto.
  if ((nombreTipeado || '').trim() !== emp.nombre) {
    throw new HttpError(400, 'El nombre tipeado no coincide con el de la empresa. No se borró nada.');
  }

  // Candado 2: nunca borrar una empresa con recibos emitidos (inmutables).
  const emitido = await db
    .selectFrom('recibo')
    .select('id')
    .where('cuenta_id', '=', cuentaId)
    .where('inmutable', '=', true)
    .limit(1)
    .executeTakeFirst();
  if (emitido) {
    throw new HttpError(
      409,
      'La empresa tiene recibos emitidos y no se puede borrar (retención legal). Cancelá la suscripción en vez de borrar.',
    );
  }

  let filas = 0;
  await db.transaction().execute(async (trx) => {
    // Rompe el self-FK de unidad_org (parent_id RESTRICT) antes de borrar la tabla.
    await trx.updateTable('unidad_org').set({ parent_id: null }).where('cuenta_id', '=', cuentaId).execute();

    for (const tabla of TABLAS_BORRADO) {
      const res = await (trx as any).deleteFrom(tabla).where('cuenta_id', '=', cuentaId).execute();
      filas += Number(res?.[0]?.numDeletedRows ?? 0n);
    }
    // La empresa al final: arrastra (CASCADE) api_token, suscripcion, factura_plataforma y recibo_plantilla.
    const res = await trx.deleteFrom('empresa').where('id', '=', cuentaId).execute();
    filas += Number(res?.[0]?.numDeletedRows ?? 0n);
  });

  return { ok: true, cuenta_id: emp.id, empresa_nombre: emp.nombre, filas_borradas: filas };
}
