import { sql } from 'kysely';
import { db } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { validarPassword } from '../auth/password';
import { provisionarCuenta } from '../admin/provisioning';
import { emitirSesion } from '../auth/identity';
import { HttpError } from '../http/errors';

/**
 * Que el firmante se quede con su repositorio.
 *
 * ═══ POR QUÉ ACÁ Y NO EN EL FORMULARIO DE ALTA ═══
 *
 * Porque acá **ya sabemos quién es**, y en el formulario de alta no.
 *
 * Quien llega por el enlace de firma probó que controla ese correo: le llegó
 * ahí y sólo ahí. `firma.ts` lo registra como `verificacion_email` de nivel
 * bajo, y ese anclaje queda en el expediente. Así que crear su cuenta desde
 * esta pantalla no necesita otro correo de confirmación: sería pedirle que
 * pruebe dos veces lo mismo, en el único momento de toda su relación con el
 * producto en que nos está prestando atención.
 *
 * Es la inversión exacta del problema del alta en frío: allá el peligro era
 * dejar que alguien escribiera el correo de otro; acá el correo no se escribe,
 * **sale del otorgamiento**. Nadie elige a quién le crea la cuenta.
 *
 * ═══ QUÉ HABILITA ═══
 *
 * `provisionarCuenta` ubica en la bandeja de entrada TODO lo que esa identidad
 * ya tenía otorgado — o sea, cada documento que firmó antes de tener cuenta.
 * La promesa es literal y es inmediata: se registra y aparece todo.
 */

/** Lo que la pantalla necesita para decidir qué ofrecer. No crea nada. */
export async function estadoDeCuenta(token: string) {
  const e = await verificarEnlaceFirma(token);

  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'sistema' });

    const r = await sql<{
      email: string; nombre: string | null; tiene_password: boolean;
      cuenta_persona: string | null; pais_emisor: string | null;
    }>`
      select i.email_mostrado                              as email,
             i.nombre_mostrado                             as nombre,
             (c.identidad_id is not null)                  as tiene_password,
             (select cu.id from cuenta cu
               where cu.tipo = 'persona' and cu.estado <> 'cerrada'
                 and cu.identidad_titular_id = i.id
               limit 1)                                    as cuenta_persona,
             -- ⚠ cuenta_otorgante_id, no cuenta_id.
             --
             -- En otorgamiento, cuenta_id es el SUJETO cuando el
             -- otorgamiento es a una empresa, y el CHECK
             -- num_nonnulls(identidad_id, cuenta_id) = 1 garantiza que sea
             -- null cuando el sujeto es una persona — que es siempre, acá.
             -- Quien emitió el documento está en cuenta_otorgante_id.
             --
             -- El join contra la columna equivocada no fallaba: devolvía null y
             -- el país sugerido caía al 'UY' del coalesce. Un brasileño que
             -- firmaba un documento de una empresa brasileña veía Uruguay
             -- preseleccionado, y el país decide qué ley y qué certificadores
             -- aplican. Un error que se disfraza de valor por omisión.
             (select emi.pais from otorgamiento o
                join cuenta emi on emi.id = o.cuenta_otorgante_id
               where o.id = ${e.otorgamientoId}::uuid)     as pais_emisor
        from identidad i
        left join credencial c on c.identidad_id = i.id
       where i.id = ${e.identidadId}::uuid
    `.execute(trx);

    const f = r.rows[0];
    if (!f) throw new HttpError(404, 'No encontramos tu identidad.');

    return {
      email: f.email,
      nombre: f.nombre,
      ya_tiene: !!f.cuenta_persona,
      // Si ya entra al sistema por otro lado, no hay contraseña nueva que elegir.
      necesita_password: !f.tiene_password,
      // ⚠ Se SUGIERE el país del emisor, no se impone: es lo más probable y
      // ahorra un clic, pero el país decide qué ley y qué certificadores
      // aplican, así que la última palabra la tiene quien abre la cuenta.
      pais_sugerido: f.pais_emisor ?? 'UY',
    };
  });
}

/**
 * Crea la cuenta personal del firmante y lo deja adentro.
 *
 * ⚠ El correo NO viene del pedido: sale de la identidad del otorgamiento. Es la
 * diferencia entre esto y el alta en frío, y no se negocia.
 */
export async function crearCuentaDesdeFirma(
  token: string,
  input: { pais: string; password?: string },
) {
  const e = await verificarEnlaceFirma(token);
  const estado = await estadoDeCuenta(token);

  if (estado.ya_tiene) {
    throw new HttpError(409, 'Ya tenés tu cuenta personal. Entrá con tu correo.');
  }
  if (!/^[A-Z]{2}$/.test(input.pais)) throw new HttpError(400, 'Elegí un país.');
  if (estado.necesita_password) {
    if (!input.password) throw new HttpError(400, 'Elegí una contraseña.');
    const err = validarPassword(input.password);
    if (err) throw new HttpError(400, err);
  }

  // Una cuenta de persona se llama como la persona. Si nunca dijo su nombre
  // —puede pasar: al invitarla a firmar alcanzaba con el correo— se usa la
  // parte de antes del arroba, que es lo que ella misma escribiría.
  const nombre = (estado.nombre || '').trim() || estado.email.split('@')[0]!;

  const r = await provisionarCuenta({
    nombre,
    tipo: 'persona',
    pais: input.pais,
    admin: {
      email: estado.email,
      nombre,
      ...(estado.necesita_password ? { password: input.password! } : {}),
    },
  });

  // El anclaje de correo ya lo creó `abrirParaFirmar` cuando abrió el enlace:
  // no se vuelve a probar nada, se reusa el hecho que ya está en el expediente.
  const anclaje = await db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'sistema' });
    const q = await sql<{ id: string }>`
      select id from anclaje_identidad
       where identidad_id = ${e.identidadId}::uuid and tipo = 'email'
         and revocado_en is null
       order by probado_en desc limit 1
    `.execute(trx);
    return q.rows[0]?.id ?? null;
  });

  const jwt = await emitirSesion(r.cuentaId, r.adminIdentidadId, {
    anclajesProbados: anclaje ? [anclaje] : [],
    nivelGarantia: 'bajo',
  });

  return {
    token: jwt,
    cuenta_id: r.cuentaId,
    identidad_id: r.adminIdentidadId,
    cuenta_nombre: nombre,
    email: estado.email,
  };
}
