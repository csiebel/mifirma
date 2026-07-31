import { withUsuario, puede } from '../auth/authz';
import { ownerDb } from '../db/owner';
import { HttpError } from '../http/errors';

// Datos de la empresa editables por su administrador. El país y la moneda NO se tocan
// acá (definen el paquete de reglas de liquidación y la moneda de los recibos). El
// nombre es el identificador de login, así que debe ser único entre empresas.

export interface DatosEmpresaInput {
  nombre?: string;
  razon_social?: string | null;
  id_fiscal?: string | null;
  num_seguridad_social?: string | null;
  domicilio?: string | null;
}

export async function verDatosEmpresa(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const e = await trx
      .selectFrom('empresa')
      .select(['nombre', 'pais', 'moneda', 'razon_social', 'id_fiscal', 'num_seguridad_social', 'domicilio'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();
    return e ?? null;
  });
}

export async function setDatosEmpresa(
  cuentaId: string,
  usuarioId: string,
  input: DatosEmpresaInput,
): Promise<{ ok: true }> {
  const nombre = (input.nombre ?? '').trim();
  if (!nombre) throw new HttpError(400, 'El nombre de la empresa no puede quedar vacío.');

  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir')) {
      throw new HttpError(403, 'No tenés permiso para editar los datos de la empresa.');
    }
    // El nombre es el identificador de login: no puede coincidir con el de otra empresa.
    // Se verifica con la conexión privilegiada porque la RLS oculta las demás empresas.
    const choque = await ownerDb()
      .selectFrom('empresa')
      .select(['id'])
      .where('nombre', '=', nombre)
      .where('id', '!=', cuentaId)
      .executeTakeFirst();
    if (choque) throw new HttpError(409, 'Ya existe otra empresa con ese nombre. Elegí uno distinto.');

    await trx
      .updateTable('empresa')
      .set({
        nombre,
        razon_social: (input.razon_social ?? '').trim() || null,
        id_fiscal: (input.id_fiscal ?? '').trim() || null,
        num_seguridad_social: (input.num_seguridad_social ?? '').trim() || null,
        domicilio: (input.domicilio ?? '').trim() || null,
      })
      .where('id', '=', cuentaId)
      .execute();
    return { ok: true };
  });
}
