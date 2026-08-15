import { sql } from 'kysely';
import { withUsuario, exigir } from '../auth/authz';
import { enviarInvitacionPorCorreo } from './auth_reset';
import { registrar } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * Gestión de accesos: quién de tu empresa puede entrar y con qué rol.
 *
 * ═══ CÓMO CAMBIÓ RESPECTO DE PAYROLL NG ═══
 *
 * Allá "crear un usuario" era literalmente insertar una fila en `usuario`
 * dentro de la empresa, colgada de una `relacion_laboral`. Acá son tres cosas
 * distintas que conviene no confundir:
 *
 *   · `identidad`  — quién es la persona. GLOBAL, no pertenece a tu empresa.
 *   · `membresia`  — que esa persona esté habilitada en TU cuenta.
 *   · `usuario_rol`— qué puede hacer dentro de tu cuenta.
 *
 * Dar acceso es crear la membresía y el rol. La identidad puede existir desde
 * antes: alguien a quien otra empresa invitó a firmar hace un año ya tiene la
 * suya, en estado 'latente'. No se duplica ni se migra nada — se le agrega una
 * membresía y listo, y sus documentos viejos siguen siendo suyos.
 *
 * ═══ LO QUE UN ADMIN DE EMPRESA NO PUEDE HACER ═══
 *
 * En payroll el admin editaba el teléfono y el canal de OTP del usuario. Acá
 * eso NO existe, a propósito: el teléfono es un dato de la identidad, que es
 * global. Si el admin de la empresa A pudiera cambiarlo, estaría tocando el
 * segundo factor que esa misma persona usa para entrar a la empresa B — y en el
 * peor caso, redirigiéndose los códigos a su propio teléfono.
 *
 * Cada persona administra su teléfono y sus anclajes en su perfil. El admin da
 * y quita acceso a SU cuenta; no administra personas.
 */

/** Capacidad que gatea todo este archivo. Ver el catálogo en la migración 004. */
const CAP = ['usuario', 'administrar'] as const;

// ---------------------------------------------------------------------------
// Roles disponibles
// ---------------------------------------------------------------------------

export async function listarRoles(cuentaId: string, identidadId: string) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para gestionar accesos.');
    const roles = await trx
      .selectFrom('rol')
      .select(['id', 'codigo', 'nombre_i18n', 'sistema'])
      .execute();
    return roles.map((r) => ({
      id: r.id,
      codigo: r.codigo,
      nombre: textoI18n(r.nombre_i18n) ?? r.codigo,
      sistema: r.sistema,
    }));
  });
}

/**
 * Los nombres de rol son `jsonb` por idioma. La resolución "de verdad" la hace
 * `app.t()` en la base con el idioma de la sesión; esto es el equivalente del
 * lado del servidor para armar respuestas JSON.
 */
function textoI18n(v: unknown, idioma = 'es'): string | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, string>;
  return m[idioma] ?? m.es ?? m.en ?? Object.values(m)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Dar acceso
// ---------------------------------------------------------------------------

export interface DarAccesoInput {
  email: string;
  rolId: string;
  /** Legajo dentro de la cuenta, opcional: no toda cuenta lleva organigrama. */
  personaId?: string | null;
  nombre?: string | null;
  /**
   * El celular que PROPONE el administrador (migración 061).
   *
   * ⚠⚠ Va a `telefono_propuesto_e164` y **no habilita nada**. Escribirlo en
   * `telefono_e164` sería regalar la cuenta: el login lee esa columna derecho
   * para mandar el código de acceso, así que un admin podría poner su propio
   * número y entrar como cualquiera de su gente. La persona lo confirma desde
   * «Tu acceso», con su contraseña y un código que le llega a ese teléfono.
   */
  telefonoPropuesto?: string | null;
}

export interface AccesoCreado {
  identidad_id: string;
  email: string;
  ya_existia: boolean;
}

export async function darAcceso(
  cuentaId: string,
  identidadId: string,
  input: DarAccesoInput,
): Promise<AccesoCreado> {
  const email = input.email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, 'El correo no es válido.');
  }

  const r = await withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para gestionar accesos.');

    const rol = await trx.selectFrom('rol').select(['id']).where('id', '=', input.rolId).executeTakeFirst();
    if (!rol) throw new HttpError(400, 'Ese rol no existe en tu cuenta.');

    // Resuelve o crea la identidad. Es `security definer` y anti-enumeración:
    // devuelve lo mismo exista o no, así que dar acceso no sirve para averiguar
    // quién más está en el sistema.
    const res = await sql<{ id: string }>`select app.resolver_identidad(${email}) as id`.execute(trx);
    const destino = res.rows[0]?.id;
    if (!destino) throw new HttpError(500, 'No se pudo resolver la identidad.');

    const previa = await trx
      .selectFrom('membresia')
      .select(['id', 'estado'])
      .where('identidad_id', '=', destino)
      .where('cuenta_id', '=', cuentaId)
      .where('hasta', 'is', null)
      .executeTakeFirst();

    const yaExistia = !!previa;

    if (previa) {
      if (previa.estado === 'activa') {
        throw new HttpError(409, 'Esa persona ya tiene acceso a tu cuenta.');
      }
      // Reactivar una membresía suspendida en vez de crear otra: el histórico
      // de esa persona en la cuenta no se parte en dos.
      await trx
        .updateTable('membresia')
        .set({ estado: 'activa', persona_id: input.personaId ?? null })
        .where('id', '=', previa.id)
        .execute();
    } else {
      await trx
        .insertInto('membresia')
        .values({ identidad_id: destino, cuenta_id: cuentaId, persona_id: input.personaId ?? null })
        .execute();
    }

    await trx
      .insertInto('usuario_rol')
      .values({ identidad_id: destino, cuenta_id: cuentaId, rol_id: input.rolId, asignado_por: identidadId })
      .onConflict((oc) => oc.columns(['identidad_id', 'cuenta_id', 'rol_id']).doNothing())
      .execute();

    // Nombre para mostrar, sólo si la identidad todavía no tiene uno propio: el
    // admin de una cuenta no le renombra la identidad a nadie.
    if (input.nombre) {
      await trx
        .updateTable('identidad')
        .set({ nombre_mostrado: input.nombre })
        .where('id', '=', destino)
        .where('nombre_mostrado', 'is', null)
        .execute();
    }

    // El celular que propone el admin. ⚠ A la columna de PROPUESTA, y sólo si
    // esa persona todavía no tiene un teléfono confirmado: si ya confirmó uno,
    // una propuesta nueva no pinta nada — el suyo manda, y el trigger de la 061
    // rechazaría tener las dos cosas si alguien intentara el atajo.
    if (input.telefonoPropuesto) {
      const tel = input.telefonoPropuesto.trim().replace(/[\s-]/g, '');
      if (!/^\+[1-9][0-9]{7,14}$/.test(tel)) {
        throw new HttpError(400, 'El celular va en formato internacional, por ejemplo +59899123456.');
      }
      await trx
        .updateTable('credencial')
        .set({ telefono_propuesto_e164: tel })
        .where('identidad_id', '=', destino)
        .where('telefono_e164', 'is', null)
        .execute();
    }

    await registrar(trx, cuentaId, identidadId, {
      accion: 'acceso.otorgado',
      recursoTipo: 'membresia',
      recursoId: destino,
      despues: {
        email,
        rol_id: input.rolId,
        reactivada: yaExistia,
        // Que quede en la bitácora QUIÉN propuso el número: es el dato que
        // contesta «¿de dónde salió este teléfono?» si algún día hay que
        // preguntarlo.
        telefono_propuesto: !!input.telefonoPropuesto,
      },
    });

    return { identidad_id: destino, email, ya_existia: yaExistia };
  });

  await enviarInvitacionPorCorreo(cuentaId, r.identidad_id, r.email, input.rolId);
  return r;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface UsuarioListado {
  identidad_id: string;
  email: string;
  nombre: string | null;
  estado: string;
  tiene_password: boolean;
  roles: { rol_id: string; nombre: string }[];
}

export async function listarUsuarios(cuentaId: string, identidadId: string): Promise<UsuarioListado[]> {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para gestionar accesos.');

    const filas = await trx
      .selectFrom('membresia as m')
      .innerJoin('identidad as i', 'i.id', 'm.identidad_id')
      .leftJoin('credencial as c', 'c.identidad_id', 'i.id')
      .select([
        'i.id as identidad_id',
        'i.email_mostrado as email',
        'i.nombre_mostrado as nombre',
        'm.estado as estado',
        'c.hash_password as hash',
      ])
      .where('m.cuenta_id', '=', cuentaId)
      .where('m.hasta', 'is', null)
      .orderBy('i.email_mostrado')
      .execute();

    const roles = await trx
      .selectFrom('usuario_rol as ur')
      .innerJoin('rol as r', 'r.id', 'ur.rol_id')
      .select(['ur.identidad_id as identidad_id', 'r.id as rol_id', 'r.codigo as codigo', 'r.nombre_i18n as nombre_i18n'])
      .where('ur.cuenta_id', '=', cuentaId)
      .execute();

    const porIdentidad = new Map<string, { rol_id: string; nombre: string }[]>();
    for (const r of roles) {
      const a = porIdentidad.get(r.identidad_id) ?? [];
      a.push({ rol_id: r.rol_id, nombre: textoI18n(r.nombre_i18n) ?? r.codigo });
      porIdentidad.set(r.identidad_id, a);
    }

    return filas.map((f) => ({
      identidad_id: f.identidad_id,
      email: f.email,
      nombre: f.nombre ?? null,
      estado: f.estado,
      tiene_password: !!f.hash,
      roles: porIdentidad.get(f.identidad_id) ?? [],
    }));
  });
}

// ---------------------------------------------------------------------------
// Roles de una persona
// ---------------------------------------------------------------------------

export async function asignarRol(
  cuentaId: string,
  identidadId: string,
  objetivoId: string,
  rolId: string,
) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para gestionar accesos.');
    await exigirMiembro(trx, cuentaId, objetivoId);

    const rol = await trx.selectFrom('rol').select('id').where('id', '=', rolId).executeTakeFirst();
    if (!rol) throw new HttpError(404, 'Rol no encontrado.');

    await trx
      .insertInto('usuario_rol')
      .values({ identidad_id: objetivoId, cuenta_id: cuentaId, rol_id: rolId, asignado_por: identidadId })
      .onConflict((oc) => oc.columns(['identidad_id', 'cuenta_id', 'rol_id']).doNothing())
      .execute();

    await registrar(trx, cuentaId, identidadId, {
      accion: 'rol.asignado',
      recursoTipo: 'usuario_rol',
      recursoId: objetivoId,
      despues: { rol_id: rolId },
    });
    return { ok: true };
  });
}

export async function quitarRol(
  cuentaId: string,
  identidadId: string,
  objetivoId: string,
  rolId: string,
) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para gestionar accesos.');

    // No dejarse a uno mismo sin poder administrar: si se va el último rol con
    // `usuario.administrar`, la cuenta queda sin nadie que pueda dar acceso y
    // hay que entrar a arreglarlo por la consola del operador.
    if (objetivoId === identidadId) {
      const quedan = await contarAdministradores(trx, cuentaId, { excluyendoRol: rolId, deIdentidad: identidadId });
      if (quedan === 0) {
        throw new HttpError(
          400,
          'No podés quitarte el último rol que administra accesos: la cuenta quedaría sin administrador.',
        );
      }
    }

    await trx
      .deleteFrom('usuario_rol')
      .where('identidad_id', '=', objetivoId)
      .where('cuenta_id', '=', cuentaId)
      .where('rol_id', '=', rolId)
      .execute();

    await registrar(trx, cuentaId, identidadId, {
      accion: 'rol.quitado',
      recursoTipo: 'usuario_rol',
      recursoId: objetivoId,
      antes: { rol_id: rolId },
    });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Alta y baja de acceso
// ---------------------------------------------------------------------------

export type EstadoAcceso = 'activa' | 'suspendida' | 'terminada';

/**
 * Suspender o terminar el acceso de alguien a TU cuenta.
 *
 * ⚠ No desactiva a la persona: la identidad es global y sigue existiendo, con
 * sus documentos, sus otorgamientos y su acceso a otras empresas. Lo único que
 * se corta es la membresía en esta cuenta.
 *
 * Los otorgamientos que esa persona ya tenía sobre documentos NO se tocan.
 * Alguien que firmó un contrato el año pasado conserva su copia aunque haya
 * dejado la empresa — eso es deliberado y está en `propiedad-y-otorgamientos.md`.
 */
export async function setEstadoAcceso(
  cuentaId: string,
  identidadId: string,
  objetivoId: string,
  estado: EstadoAcceso,
) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para gestionar accesos.');

    if (objetivoId === identidadId && estado !== 'activa') {
      throw new HttpError(400, 'No podés darte de baja a vos mismo.');
    }

    const m = await exigirMiembro(trx, cuentaId, objetivoId);

    await trx
      .updateTable('membresia')
      .set(estado === 'terminada' ? { estado, hasta: new Date().toISOString().slice(0, 10) } : { estado })
      .where('id', '=', m.id)
      .execute();

    await registrar(trx, cuentaId, identidadId, {
      accion: 'acceso.estado',
      recursoTipo: 'membresia',
      recursoId: objetivoId,
      antes: { estado: m.estado },
      despues: { estado },
    });
    return { ok: true, estado };
  });
}

export async function reenviarInvitacion(cuentaId: string, identidadId: string, objetivoId: string) {
  const email = await withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para gestionar accesos.');
    await exigirMiembro(trx, cuentaId, objetivoId);
    const i = await trx
      .selectFrom('identidad')
      .select(['email_mostrado'])
      .where('id', '=', objetivoId)
      .executeTakeFirst();
    if (!i) throw new HttpError(404, 'Usuario no encontrado.');
    await registrar(trx, cuentaId, identidadId, {
      accion: 'acceso.reinvitado',
      recursoTipo: 'membresia',
      recursoId: objetivoId,
    });
    return i.email_mostrado;
  });
  await enviarInvitacionPorCorreo(cuentaId, objetivoId, email);
  return { ok: true, email };
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

/**
 * Verifica que el objetivo sea miembro de ESTA cuenta.
 *
 * La RLS ya lo garantiza —`membresia` filtra por cuenta— pero sin esto un id de
 * otra cuenta devolvería "no encontrado" recién en el paso siguiente, o peor,
 * un update de cero filas que parece haber funcionado.
 */
async function exigirMiembro(trx: any, cuentaId: string, objetivoId: string) {
  const m = await trx
    .selectFrom('membresia')
    .select(['id', 'estado'])
    .where('identidad_id', '=', objetivoId)
    .where('cuenta_id', '=', cuentaId)
    .where('hasta', 'is', null)
    .executeTakeFirst();
  if (!m) throw new HttpError(404, 'Esa persona no tiene acceso a tu cuenta.');
  return m as { id: string; estado: string };
}

/** Cuántas identidades quedarían con la capacidad `usuario.administrar`. */
async function contarAdministradores(
  trx: any,
  cuentaId: string,
  opts: { excluyendoRol?: string; deIdentidad?: string } = {},
): Promise<number> {
  let qb = trx
    .selectFrom('usuario_rol as ur')
    .innerJoin('rol_capacidad as rc', 'rc.rol_id', 'ur.rol_id')
    .innerJoin('capacidad as c', 'c.id', 'rc.capacidad_id')
    .innerJoin('membresia as m', (j: any) =>
      j.onRef('m.identidad_id', '=', 'ur.identidad_id').onRef('m.cuenta_id', '=', 'ur.cuenta_id'),
    )
    .select(({ fn }: any) => [fn.count('ur.identidad_id').distinct().as('n')])
    .where('ur.cuenta_id', '=', cuentaId)
    .where('c.recurso', '=', 'usuario')
    .where('c.accion', '=', 'administrar')
    .where('m.estado', '=', 'activa')
    .where('m.hasta', 'is', null);

  if (opts.excluyendoRol && opts.deIdentidad) {
    qb = qb.where((eb: any) =>
      eb.not(eb.and([eb('ur.identidad_id', '=', opts.deIdentidad), eb('ur.rol_id', '=', opts.excluyendoRol)])),
    );
  }

  const r = await qb.executeTakeFirst();
  return Number(r?.n ?? 0);
}
