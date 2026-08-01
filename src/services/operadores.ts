import { operadorDb } from '../db/pool';
import { HttpError } from '../http/errors';
import { hashPassword, verifyPassword } from '../operador/password';
import { emitirTokenOperador } from '../operador/sesion';

// Catálogo de privilegios de operador (lo conoce el código y lo muestra la consola).
// `gestionar_mensajeria` es nueva: correo y Twilio guardan las credenciales con
// las que sale TODO —códigos de acceso, invitaciones, avisos de firma—. Quien la
// tiene puede redirigir los códigos de acceso de la plataforma entera, así que
// merece ser un privilegio propio y no colgar de "gestionar_pagos".
// `operador_capacidad.capacidad` es texto libre (migración 010): agregarla no
// necesita migración.
export const CAPACIDADES = ['gestionar_planes', 'gestionar_empresas', 'gestionar_operadores', 'gestionar_pagos', 'gestionar_mensajeria', 'gestionar_ofertas', 'gestionar_firma', 'gestionar_industrias', 'gestionar_creditos', 'ver_auditoria'] as const;
export type Capacidad = (typeof CAPACIDADES)[number];

function filtrarCaps(caps: string[]): string[] {
  return caps.filter((c) => (CAPACIDADES as readonly string[]).includes(c));
}

async function capacidadesDe(operadorId: string, esSuperadmin: boolean): Promise<string[]> {
  if (esSuperadmin) return [...CAPACIDADES]; // el superadmin tiene todo
  const filas = await operadorDb()
    .selectFrom('operador_capacidad')
    .select('capacidad')
    .where('operador_id', '=', operadorId)
    .execute();
  return filas.map((f) => f.capacidad);
}

const UMBRAL_BLOQUEO_OPERADOR = 5;
const LOCKOUT_OPERADOR_MIN = 15;

export async function loginOperador(usuario: string, password: string) {
  const db = operadorDb();
  const op = await db
    .selectFrom('operador')
    .select(['id', 'usuario', 'nombre', 'password_hash', 'es_superadmin', 'activo', 'intentos_fallidos', 'bloqueado_hasta'])
    .where('usuario', '=', usuario)
    .executeTakeFirst();

  // Cuenta bloqueada por intentos fallidos: cortamos antes de comparar la contraseña.
  if (op && op.bloqueado_hasta && new Date(op.bloqueado_hasta).getTime() > Date.now()) {
    throw new HttpError(429, 'Demasiados intentos fallidos. Probá de nuevo en unos minutos.');
  }

  const ok = !!op && op.activo && (await verifyPassword(password, op.password_hash));
  if (!ok) {
    // Contamos el fallo y, si se pasa del umbral, bloqueamos la cuenta por un rato. Solo
    // si el usuario existe (no creamos cuentas fantasma); el mensaje es el mismo igual.
    if (op) {
      const intentos = (op.intentos_fallidos ?? 0) + 1;
      const bloquear = intentos >= UMBRAL_BLOQUEO_OPERADOR;
      await db
        .updateTable('operador')
        .set({
          intentos_fallidos: bloquear ? 0 : intentos,
          bloqueado_hasta: bloquear ? new Date(Date.now() + LOCKOUT_OPERADOR_MIN * 60000) : op.bloqueado_hasta,
        })
        .where('id', '=', op.id)
        .execute();
    }
    // Mismo mensaje exista o no el usuario, para no filtrar cuáles existen.
    throw new HttpError(401, 'Usuario o contraseña incorrectos.');
  }

  // Login correcto: limpiamos contador y bloqueo si quedó algo de intentos previos.
  if ((op.intentos_fallidos ?? 0) !== 0 || op.bloqueado_hasta) {
    await db.updateTable('operador').set({ intentos_fallidos: 0, bloqueado_hasta: null }).where('id', '=', op.id).execute();
  }

  const capacidades = await capacidadesDe(op.id, op.es_superadmin);
  const token = await emitirTokenOperador({
    operadorId: op.id,
    usuario: op.usuario,
    esSuperadmin: op.es_superadmin,
    capacidades,
  });
  return {
    token,
    operador: { usuario: op.usuario, nombre: op.nombre, es_superadmin: op.es_superadmin, capacidades },
  };
}

interface DatosNuevoOperador {
  usuario: string;
  nombre: string;
  password: string;
  esSuperadmin: boolean;
  capacidades: string[];
}

async function crearOperadorInterno(d: DatosNuevoOperador) {
  if (d.password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  const existe = await operadorDb()
    .selectFrom('operador')
    .select('id')
    .where('usuario', '=', d.usuario)
    .executeTakeFirst();
  if (existe) throw new HttpError(409, `Ya existe un operador con usuario "${d.usuario}".`);

  const caps = filtrarCaps(d.capacidades);
  const hash = await hashPassword(d.password);
  return operadorDb()
    .transaction()
    .execute(async (trx) => {
      const fila = await trx
        .insertInto('operador')
        .values({ usuario: d.usuario, nombre: d.nombre, password_hash: hash, es_superadmin: d.esSuperadmin })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      if (!d.esSuperadmin && caps.length) {
        await trx
          .insertInto('operador_capacidad')
          .values(caps.map((c) => ({ operador_id: fila.id, capacidad: c })))
          .execute();
      }
      return {
        id: fila.id,
        usuario: d.usuario,
        es_superadmin: d.esSuperadmin,
        capacidades: d.esSuperadmin ? [...CAPACIDADES] : caps,
      };
    });
}

/** Bootstrap del primer superadmin (desde la línea de comando). */
export async function crearSuperadmin(usuario: string, password: string, nombre: string) {
  return crearOperadorInterno({ usuario, nombre, password, esSuperadmin: true, capacidades: [] });
}

/** Alta de operador desde la consola (la hace un superadmin / quien gestione operadores). */
export async function crearOperador(d: {
  usuario: string;
  nombre: string;
  password: string;
  esSuperadmin?: boolean;
  capacidades?: string[];
}) {
  return crearOperadorInterno({
    usuario: d.usuario,
    nombre: d.nombre,
    password: d.password,
    esSuperadmin: !!d.esSuperadmin,
    capacidades: d.capacidades ?? [],
  });
}

export async function listarOperadores() {
  const ops = await operadorDb()
    .selectFrom('operador')
    .select(['id', 'usuario', 'nombre', 'es_superadmin', 'activo', 'creado_en'])
    .orderBy('usuario')
    .execute();
  const caps = await operadorDb().selectFrom('operador_capacidad').select(['operador_id', 'capacidad']).execute();
  const mapa = new Map<string, string[]>();
  for (const c of caps) {
    const a = mapa.get(c.operador_id) ?? [];
    a.push(c.capacidad);
    mapa.set(c.operador_id, a);
  }
  return {
    operadores: ops.map((o) => ({
      ...o,
      capacidades: o.es_superadmin ? [...CAPACIDADES] : mapa.get(o.id) ?? [],
    })),
  };
}

export async function setOperadorActivo(id: string, activo: boolean) {
  // No dejar la plataforma sin ningún superadmin activo.
  if (!activo) {
    const op = await operadorDb().selectFrom('operador').select(['es_superadmin']).where('id', '=', id).executeTakeFirst();
    if (op?.es_superadmin) {
      const r = await operadorDb()
        .selectFrom('operador')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('es_superadmin', '=', true)
        .where('activo', '=', true)
        .executeTakeFirst();
      if (Number(r?.n ?? 0) <= 1) throw new HttpError(400, 'No podés desactivar al último superadmin activo.');
    }
  }
  await operadorDb().updateTable('operador').set({ activo }).where('id', '=', id).execute();
  return { ok: true };
}

export async function editarCapacidades(id: string, capacidades: string[]) {
  const caps = filtrarCaps(capacidades);
  return operadorDb()
    .transaction()
    .execute(async (trx) => {
      await trx.deleteFrom('operador_capacidad').where('operador_id', '=', id).execute();
      if (caps.length) {
        await trx
          .insertInto('operador_capacidad')
          .values(caps.map((c) => ({ operador_id: id, capacidad: c })))
          .execute();
      }
      return { ok: true, capacidades: caps };
    });
}

// Cambio de la propia contraseña por un operador autenticado. Self-scoped al
// operador del token; pide la contraseña actual (reautenticación).
export async function cambiarPasswordOperador(operadorId: string, actual: unknown, nueva: unknown) {
  if (typeof actual !== 'string' || typeof nueva !== 'string') {
    throw new HttpError(400, 'Faltan datos.');
  }
  if (nueva.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (nueva.length > 200) throw new HttpError(400, 'La contraseña es demasiado larga.');

  const op = await operadorDb()
    .selectFrom('operador')
    .select(['id', 'password_hash', 'activo'])
    .where('id', '=', operadorId)
    .executeTakeFirst();
  if (!op || !op.activo) throw new HttpError(401, 'Operador no válido.');
  if (!(await verifyPassword(actual, op.password_hash))) {
    throw new HttpError(400, 'La contraseña actual no es correcta.');
  }
  if (await verifyPassword(nueva, op.password_hash)) {
    throw new HttpError(400, 'La nueva contraseña debe ser distinta de la actual.');
  }

  await operadorDb().updateTable('operador').set({ password_hash: await hashPassword(nueva) }).where('id', '=', operadorId).execute();
  return { ok: true };
}

function validarClaveOperador(nueva: unknown): string {
  if (typeof nueva !== 'string') throw new HttpError(400, 'Falta la nueva contraseña.');
  if (nueva.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (nueva.length > 200) throw new HttpError(400, 'La contraseña es demasiado larga.');
  return nueva;
}

// Reset de contraseña de OTRO operador, hecho por quien gestiona operadores
// (superadmin). No pide la actual: es una acción administrativa.
export async function setPasswordOperador(id: string, nueva: unknown) {
  const clave = validarClaveOperador(nueva);
  const op = await operadorDb().selectFrom('operador').select(['id']).where('id', '=', id).executeTakeFirst();
  if (!op) throw new HttpError(404, 'Operador no encontrado.');
  await operadorDb().updateTable('operador').set({ password_hash: await hashPassword(clave) }).where('id', '=', id).execute();
  return { ok: true };
}

// Reset por usuario, para la línea de comando (caso de bloqueo total: nadie puede
// entrar a la consola). Uso: npm run operador -- reset-password <usuario> <nueva>
export async function resetPasswordOperadorPorUsuario(usuario: string, nueva: string) {
  const clave = validarClaveOperador(nueva);
  const op = await operadorDb().selectFrom('operador').select(['id', 'usuario']).where('usuario', '=', usuario).executeTakeFirst();
  if (!op) throw new HttpError(404, `No existe un operador con usuario "${usuario}".`);
  await operadorDb().updateTable('operador').set({ password_hash: await hashPassword(clave) }).where('id', '=', op.id).execute();
  return { ok: true, usuario: op.usuario };
}
