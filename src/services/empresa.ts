import { withUsuario, exigir } from '../auth/authz';
import { registrar } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * Datos de la cuenta y, si es de tipo empresa, su detalle fiscal.
 *
 * ⚠ `empresa` YA NO es el tenant. El tenant es `cuenta`, que puede ser de tipo
 * empresa o persona; `empresa` es la fila de detalle —razón social,
 * identificación fiscal, domicilio— que existe sólo para las de tipo empresa.
 * Un escribano trabajando solo tiene cuenta y no tiene fila en `empresa`.
 *
 * El nombre que se muestra en pantallas y notificaciones es
 * `cuenta.nombre_mostrado`, no la razón social: "Ferretería del Centro" es lo
 * que la gente reconoce, "COMERCIAL DEL CENTRO S.R.L." es lo que va en la
 * factura.
 */

export interface DatosCuentaInput {
  nombreMostrado?: string;
  razonSocial?: string | null;
  identificacionFiscal?: string | null;
  domicilio?: string | null;
  idioma?: string;
}

export async function verDatosCuenta(cuentaId: string, identidadId: string) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const c = await trx
      .selectFrom('cuenta')
      .select(['id', 'tipo', 'nombre_mostrado', 'pais', 'idioma', 'moneda', 'estado', 'plan_id'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();
    if (!c) throw new HttpError(404, 'Cuenta no encontrada.');

    const e =
      c.tipo === 'empresa'
        ? await trx
            .selectFrom('empresa')
            .select(['razon_social', 'identificacion_fiscal', 'domicilio', 'industria_id'])
            .where('cuenta_id', '=', cuentaId)
            .executeTakeFirst()
        : undefined;

    return {
      cuenta_id: c.id,
      tipo: c.tipo,
      nombre: c.nombre_mostrado,
      pais: c.pais,
      idioma: c.idioma,
      moneda: c.moneda,
      estado: c.estado,
      razon_social: e?.razon_social ?? null,
      identificacion_fiscal: e?.identificacion_fiscal ?? null,
      domicilio: e?.domicilio ?? null,
      industria_id: e?.industria_id ?? null,
    };
  });
}

export async function setDatosCuenta(
  cuentaId: string,
  identidadId: string,
  d: DatosCuentaInput,
): Promise<{ ok: true }> {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'cuenta', 'administrar', 'No tenés permiso para editar los datos de la cuenta.');

    const c = await trx
      .selectFrom('cuenta')
      .select(['tipo', 'nombre_mostrado', 'idioma'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();
    if (!c) throw new HttpError(404, 'Cuenta no encontrada.');

    const nombre = d.nombreMostrado?.trim();
    if (nombre !== undefined && !nombre) throw new HttpError(400, 'El nombre no puede quedar vacío.');

    if (nombre || d.idioma) {
      await trx
        .updateTable('cuenta')
        .set({
          ...(nombre ? { nombre_mostrado: nombre } : {}),
          ...(d.idioma ? { idioma: d.idioma } : {}),
        })
        .where('id', '=', cuentaId)
        .execute();
    }

    if (c.tipo === 'empresa') {
      const razon = d.razonSocial?.trim();
      if (razon !== undefined && !razon) {
        throw new HttpError(400, 'La razón social no puede quedar vacía.');
      }
      await trx
        .insertInto('empresa')
        .values({
          cuenta_id: cuentaId,
          razon_social: razon ?? nombre ?? c.nombre_mostrado,
          identificacion_fiscal: d.identificacionFiscal ?? null,
          domicilio: d.domicilio ?? null,
        })
        .onConflict((oc) =>
          oc.column('cuenta_id').doUpdateSet({
            ...(razon ? { razon_social: razon } : {}),
            ...(d.identificacionFiscal !== undefined
              ? { identificacion_fiscal: d.identificacionFiscal }
              : {}),
            ...(d.domicilio !== undefined ? { domicilio: d.domicilio } : {}),
            actualizada_en: new Date(),
          }),
        )
        .execute();
    } else if (d.razonSocial || d.identificacionFiscal || d.domicilio) {
      throw new HttpError(400, 'Esta cuenta es de tipo persona: no lleva razón social.');
    }

    await registrar(trx, cuentaId, identidadId, {
      accion: 'cuenta.datos',
      recursoTipo: 'cuenta',
      recursoId: cuentaId,
      antes: { nombre: c.nombre_mostrado, idioma: c.idioma },
      despues: { nombre: nombre ?? c.nombre_mostrado, idioma: d.idioma ?? c.idioma },
    });
    return { ok: true as const };
  });
}
