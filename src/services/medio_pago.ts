import type { Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { withUsuario, puede, alcanceEscritura, alcanceMaximoLectura, relacionEnAlcance } from '../auth/authz';
import { HttpError } from '../http/errors';
import { registrar } from './auditoria';

// Medios de pago del sueldo (empresa -> empleado). No participa del cálculo: el motor da el
// neto; esto sólo registra cómo se le paga. Un medio por relación laboral (1:1). Los bancos y
// tipos de cuenta son catálogos de plataforma por país; el medio de cada empleado vive con RLS.

const TIPOS = ['efectivo', 'cheque', 'cuenta_bancaria'] as const;

export interface MedioPagoInput {
  tipo: string;
  bancoId?: string | null;
  tipoCuentaId?: string | null;
  numeroCuenta?: string | null;
  moneda?: string | null;
  titular?: string | null;
}

function leerMedio(trx: Transaction<DB>, relacionId: string) {
  return trx
    .selectFrom('medio_pago as mp')
    .leftJoin('banco as b', 'b.id', 'mp.banco_id')
    .leftJoin('tipo_cuenta_bancaria as tc', 'tc.id', 'mp.tipo_cuenta_id')
    .select([
      'mp.tipo as tipo',
      'mp.banco_id as banco_id',
      'b.nombre as banco_nombre',
      'mp.tipo_cuenta_id as tipo_cuenta_id',
      'tc.nombre as tipo_cuenta_nombre',
      'mp.numero_cuenta as numero_cuenta',
      'mp.moneda as moneda',
      'mp.titular as titular',
    ])
    .where('mp.relacion_id', '=', relacionId)
    .executeTakeFirst();
}

/** Bancos y tipos de cuenta del país de la empresa (para los selectores). */
export async function listarCatalogosPago(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'empleado', 'leer')) throw new HttpError(403, 'No tenés permiso para ver empleados.');
    const empresa = await trx.selectFrom('empresa').select(['pais']).where('id', '=', cuentaId).executeTakeFirst();
    const pais = empresa?.pais ?? '';
    const bancos = await trx
      .selectFrom('banco')
      .select(['id', 'nombre'])
      .where('pais', '=', pais)
      .where('activo', '=', true)
      .orderBy('orden')
      .orderBy('nombre')
      .execute();
    const tiposCuenta = await trx
      .selectFrom('tipo_cuenta_bancaria')
      .select(['id', 'nombre'])
      .where('pais', '=', pais)
      .where('activo', '=', true)
      .orderBy('orden')
      .orderBy('nombre')
      .execute();
    return { bancos, tiposCuenta };
  });
}

/** Medio de pago de un empleado (lectura; gateado por empleado:leer + alcance). */
export async function verMedioPago(cuentaId: string, usuarioId: string, relacionId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'empleado', 'leer')) throw new HttpError(403, 'No tenés permiso para ver empleados.');
    if (!(await relacionEnAlcance(trx, relacionId, alcanceMaximoLectura(autz))))
      throw new HttpError(403, 'Ese empleado está fuera de tu alcance.');
    const medio = (await leerMedio(trx, relacionId)) ?? null;
    return { medio };
  });
}

/** Guarda/reemplaza el medio de pago de un empleado (gateado por empleado:escribir + alcance). */
export async function guardarMedioPago(
  cuentaId: string,
  usuarioId: string,
  relacionId: string,
  input: MedioPagoInput,
): Promise<{ ok: true }> {
  const tipo = (input.tipo || '').trim();
  if (!TIPOS.includes(tipo as (typeof TIPOS)[number])) throw new HttpError(400, 'Tipo de pago inválido.');
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'empleado', 'escribir')) throw new HttpError(403, 'No tenés permiso para editar empleados.');
    if (!(await relacionEnAlcance(trx, relacionId, alcanceEscritura(autz, 'empleado'))))
      throw new HttpError(403, 'Ese empleado está fuera de tu alcance.');

    const rel = await trx.selectFrom('relacion_laboral').select(['id']).where('id', '=', relacionId).executeTakeFirst();
    if (!rel) throw new HttpError(404, 'Empleado no encontrado.');

    let bancoId: string | null = null;
    let tipoCuentaId: string | null = null;
    let numero: string | null = null;
    let moneda: string | null = null;
    const titular: string | null = (input.titular || '').trim() || null;

    if (tipo === 'cuenta_bancaria') {
      const empresa = await trx.selectFrom('empresa').select(['pais']).where('id', '=', cuentaId).executeTakeFirst();
      const pais = empresa?.pais ?? '';
      if (!input.bancoId) throw new HttpError(400, 'Elegí el banco.');
      const banco = await trx
        .selectFrom('banco')
        .select(['id'])
        .where('id', '=', input.bancoId)
        .where('pais', '=', pais)
        .executeTakeFirst();
      if (!banco) throw new HttpError(400, 'El banco elegido no es válido para tu país.');
      if (!input.tipoCuentaId) throw new HttpError(400, 'Elegí el tipo de cuenta.');
      const tc = await trx
        .selectFrom('tipo_cuenta_bancaria')
        .select(['id'])
        .where('id', '=', input.tipoCuentaId)
        .where('pais', '=', pais)
        .executeTakeFirst();
      if (!tc) throw new HttpError(400, 'El tipo de cuenta no es válido.');
      numero = (input.numeroCuenta || '').trim();
      if (!numero) throw new HttpError(400, 'Ingresá el número de cuenta.');
      bancoId = input.bancoId;
      tipoCuentaId = input.tipoCuentaId;
      moneda = (input.moneda || '').trim() || null;
    }

    await trx
      .insertInto('medio_pago')
      .values({
        cuenta_id: cuentaId,
        relacion_id: relacionId,
        tipo,
        banco_id: bancoId,
        tipo_cuenta_id: tipoCuentaId,
        numero_cuenta: numero,
        moneda,
        titular,
      })
      .onConflict((oc) =>
        oc.column('relacion_id').doUpdateSet({
          tipo,
          banco_id: bancoId,
          tipo_cuenta_id: tipoCuentaId,
          numero_cuenta: numero,
          moneda,
          titular,
        }),
      )
      .execute();

    await registrar(trx, cuentaId, usuarioId, {
      accion: 'medio_pago.guardar',
      recurso: 'empleado',
      objetoId: relacionId,
      detalle: { tipo },
    });
    return { ok: true };
  });
}

/** Medio de pago del propio empleado (read-only, para /mi). */
export async function miMedioPago(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const u = await trx.selectFrom('usuario').select(['persona_id']).where('id', '=', usuarioId).executeTakeFirst();
    if (!u?.persona_id) return { medio: null };
    const rel = await trx
      .selectFrom('relacion_laboral')
      .select(['id'])
      .where('persona_id', '=', u.persona_id)
      .orderBy('fecha_ingreso', 'desc')
      .executeTakeFirst();
    if (!rel) return { medio: null };
    const medio = (await leerMedio(trx, rel.id)) ?? null;
    return { medio };
  });
}
