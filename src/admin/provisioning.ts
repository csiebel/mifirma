import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { db } from '../db/pool';
import type { DB } from '../db/schema';
import { fijarContexto } from '../db/contexto';
import { hashPassword } from '../auth/password';
import { HttpError } from '../http/errors';

/**
 * Alta de una cuenta nueva.
 *
 * ═══ NO USA CONEXIÓN PRIVILEGIADA ═══
 *
 * En payroll esto corría con `DATABASE_OWNER_URL`, un rol que evade RLS, porque
 * había que insertar la empresa antes de que existiera contexto de empresa.
 * Acá no hace falta: las políticas de `cuenta` admiten INSERT del actor
 * 'sistema' (migración 009), así que el alta corre con el pool normal.
 *
 * Es más que una simplificación. Mientras exista una conexión que evade RLS,
 * existe la tentación de usarla "un momentito" para resolver otra cosa, y ese
 * es el camino por el que la autorización se escapa de la base. Si el alta
 * —que es el caso más privilegiado que hay— se puede hacer sin evadir nada,
 * no queda excusa para el resto.
 *
 * ═══ QUÉ CREA ═══
 *
 * La cuenta, su detalle fiscal si es empresa, tres roles base, el árbol de
 * carpetas mínimo, y la membresía del primer administrador — que puede ser una
 * identidad que YA EXISTA, porque a esa persona la invitaron a firmar algo el
 * año pasado. En ese caso no se crea nada nuevo: se le agrega la membresía y
 * conserva todo lo suyo.
 */

export interface ProvisionInput {
  nombre: string;
  tipo?: 'empresa' | 'persona';
  pais: string;
  moneda: string;
  idioma?: string;
  razonSocial?: string | null;
  idFiscal?: string | null;
  domicilio?: string | null;
  industriaId?: string | null;
  planId?: string | null;
  admin: { email: string; nombre?: string; password?: string };
}

export interface ProvisionResult {
  cuentaId: string;
  adminIdentidadId: string;
  roles: Record<string, string>;
  carpetaRaizId: string;
}

/**
 * Roles base. Tres, no cinco: en payroll los roles se derivaban del organigrama
 * (jefe, rrhh, liquidador). Acá la pregunta es qué hacés con documentos.
 *
 * `admin` es `sistema: true` — no se borra ni se edita desde el panel del
 * cliente. Es la red que impide que alguien se deje afuera de su propia cuenta.
 */
const ROLES_BASE = [
  {
    codigo: 'admin',
    nombre: { es: 'Administrador', pt: 'Administrador', en: 'Administrator' },
    sistema: true,
    capacidades: [
      ['documento', 'crear'], ['documento', 'leer'],
      ['circuito', 'crear'], ['circuito', 'enviar'], ['circuito', 'cancelar'], ['circuito', 'prorrogar'],
      ['plantilla', 'administrar'],
      ['carpeta', 'organizar'], ['carpeta', 'permisos'],
      ['evidencia', 'leer'],
      ['lote', 'despachar'],
      ['cuenta', 'administrar'],
      ['usuario', 'administrar'],
      ['facturacion', 'leer'],
      ['bitacora', 'leer'],
    ],
  },
  {
    codigo: 'emisor',
    nombre: { es: 'Emisor', pt: 'Emissor', en: 'Sender' },
    sistema: false,
    capacidades: [
      ['documento', 'crear'], ['documento', 'leer'],
      ['circuito', 'crear'], ['circuito', 'enviar'], ['circuito', 'cancelar'], ['circuito', 'prorrogar'],
      ['evidencia', 'leer'],
      ['lote', 'despachar'],
    ],
  },
  {
    codigo: 'lector',
    nombre: { es: 'Lector', pt: 'Leitor', en: 'Viewer' },
    sistema: false,
    capacidades: [['documento', 'leer'], ['evidencia', 'leer']],
  },
] as const;

/** Carpetas del sistema. Se crean siempre: un repositorio vacío sin estructura
 *  obliga a cada cliente a inventar la suya en el primer minuto de uso. */
const CARPETAS = [
  { sistema: 'raiz' as const, ruta: 'raiz', nombre: { es: 'Documentos', pt: 'Documentos', en: 'Documents' } },
  { sistema: 'entrada' as const, ruta: 'raiz.entrada', nombre: { es: 'Recibidos', pt: 'Recebidos', en: 'Inbox' } },
  { sistema: 'borradores' as const, ruta: 'raiz.borradores', nombre: { es: 'Borradores', pt: 'Rascunhos', en: 'Drafts' } },
  { sistema: 'papelera' as const, ruta: 'raiz.papelera', nombre: { es: 'Papelera', pt: 'Lixeira', en: 'Trash' } },
];

async function enSistema<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'sistema' });
    return fn(trx);
  });
}

export async function provisionarCuenta(input: ProvisionInput): Promise<ProvisionResult> {
  const email = input.admin.email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'El correo del administrador no es válido.');
  if (!input.nombre?.trim()) throw new HttpError(400, 'Falta el nombre de la cuenta.');
  if (!/^[A-Z]{2}$/.test(input.pais)) throw new HttpError(400, 'El país va en ISO 3166-1 alfa-2, por ejemplo UY.');
  if (!/^[A-Z]{3}$/.test(input.moneda)) throw new HttpError(400, 'La moneda va en ISO 4217, por ejemplo UYU.');

  // El id se genera acá y se pasa al contexto ANTES de insertar: así el WITH
  // CHECK de las políticas se cumple sobre la fila que se está creando.
  const cuentaId = randomUUID();
  const tipo = input.tipo ?? 'empresa';

  return enSistema(async (trx) => {
    // ⚠ ORDEN. La identidad se resuelve con el contexto SIN cuenta, y recién
    // después se fija la cuenta.
    //
    // `app.resolver_identidad` estampa `creada_por_cuenta_id` con la cuenta del
    // contexto. Si la fijáramos antes de insertarla, la identidad apuntaría a
    // una cuenta que todavía no existe y la clave foránea rechaza el alta
    // entera. Y no se puede invertir sin más: una cuenta de tipo persona exige
    // titular, así que la identidad tiene que existir primero. La salida es
    // esta: identidad sin cuenta, después cuenta, después el contexto.
    //
    // Que `creada_por_cuenta_id` quede en null es además lo correcto: en el
    // alta, la identidad existe antes que la cuenta.
    const identidadAdmin = await resolverIdentidad(trx, email, input.admin.nombre);

    await fijarContexto(trx, { actor: 'sistema', cuentaId });

    await trx
      .insertInto('cuenta')
      .values({
        id: cuentaId,
        tipo,
        nombre_mostrado: input.nombre.trim(),
        pais: input.pais,
        moneda: input.moneda,
        idioma: input.idioma ?? idiomaPorPais(input.pais),
        plan_id: input.planId ?? null,
        // Una cuenta de tipo persona necesita titular; una de empresa, no.
        identidad_titular_id: tipo === 'persona' ? identidadAdmin : null,
      })
      .execute();

    if (tipo === 'empresa') {
      await trx
        .insertInto('empresa')
        .values({
          cuenta_id: cuentaId,
          razon_social: input.razonSocial?.trim() || input.nombre.trim(),
          identificacion_fiscal: input.idFiscal ?? null,
          domicilio: input.domicilio ?? null,
          industria_id: input.industriaId ?? null,
        })
        .execute();
    }

    const roles = await crearRolesBase(trx, cuentaId);
    const carpetas = await crearCarpetas(trx, cuentaId, roles, identidadAdmin);

    await trx
      .insertInto('membresia')
      .values({ identidad_id: identidadAdmin, cuenta_id: cuentaId })
      .execute();

    await trx
      .insertInto('usuario_rol')
      .values({ identidad_id: identidadAdmin, cuenta_id: cuentaId, rol_id: roles.admin })
      .execute();

    // La contraseña es opcional: el camino normal es la invitación por correo,
    // que además prueba que el correo existe. Fijarla acá es para el alta manual
    // del operador y para las pruebas.
    if (input.admin.password) {
      await trx
        .insertInto('credencial')
        .values({
          identidad_id: identidadAdmin,
          hash_password: hashPassword(input.admin.password),
          password_cambiada_en: new Date(),
        })
        .onConflict((oc) => oc.column('identidad_id').doNothing())
        .execute();
      await trx.updateTable('identidad').set({ estado: 'activa' }).where('id', '=', identidadAdmin).execute();
    }

    await trx.insertInto('bitacora_plataforma').values({
      cuenta_id: cuentaId,
      identidad_id: identidadAdmin,
      actor_tipo: 'sistema',
      accion: 'cuenta.creada',
      recurso_tipo: 'cuenta',
      recurso_id: cuentaId,
      despues: JSON.stringify({ nombre: input.nombre, pais: input.pais, tipo }),
    }).execute();

    return { cuentaId, adminIdentidadId: identidadAdmin, roles, carpetaRaizId: carpetas.raiz };
  });
}

/**
 * Idioma por defecto del país. Es una conveniencia del alta, no una regla: la
 * cuenta lo cambia cuando quiere, y cada persona tiene el suyo.
 */
function idiomaPorPais(pais: string): string {
  return pais === 'BR' ? 'pt-BR' : 'es';
}

async function resolverIdentidad(
  trx: Transaction<DB>,
  email: string,
  nombre?: string,
): Promise<string> {
  const r = await sql<{ id: string }>`select app.resolver_identidad(${email}) as id`.execute(trx);
  const id = r.rows[0]?.id;
  if (!id) throw new HttpError(500, 'No se pudo resolver la identidad del administrador.');
  if (nombre?.trim()) {
    // Sólo si no tenía: el alta de una cuenta no le renombra la identidad a
    // alguien que ya existe en el sistema.
    await trx
      .updateTable('identidad')
      .set({ nombre_mostrado: nombre.trim() })
      .where('id', '=', id)
      .where('nombre_mostrado', 'is', null)
      .execute();
  }
  return id;
}

async function crearRolesBase(trx: Transaction<DB>, cuentaId: string): Promise<Record<string, string>> {
  const catalogo = await trx.selectFrom('capacidad').select(['id', 'recurso', 'accion']).execute();
  const idDe = new Map(catalogo.map((c) => [`${c.recurso}:${c.accion}`, c.id]));

  const roles: Record<string, string> = {};
  for (const def of ROLES_BASE) {
    const r = await trx
      .insertInto('rol')
      .values({
        cuenta_id: cuentaId,
        codigo: def.codigo,
        nombre_i18n: JSON.stringify(def.nombre),
        sistema: def.sistema,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roles[def.codigo] = r.id;

    const filas = def.capacidades
      .map(([recurso, accion]) => idDe.get(`${recurso}:${accion}`))
      .filter((x): x is string => !!x)
      .map((capacidad_id) => ({ rol_id: r.id, capacidad_id }));

    // Si el catálogo cambió y una capacidad del rol base ya no existe, el alta
    // no se cae: el rol queda con las que sí existen y el faltante se ve en el
    // panel. Caerse acá dejaría cuentas a medio crear.
    if (filas.length) await trx.insertInto('rol_capacidad').values(filas).execute();
  }
  return roles;
}

async function crearCarpetas(
  trx: Transaction<DB>,
  cuentaId: string,
  roles: Record<string, string>,
  creadaPor: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const c of CARPETAS) {
    const padre = c.ruta.includes('.') ? ids.raiz : null;
    const r = await trx
      .insertInto('carpeta')
      .values({
        cuenta_id: cuentaId,
        padre_id: padre,
        nombre_i18n: JSON.stringify(c.nombre),
        ruta: sql`${c.ruta}::ltree` as any,
        sistema: c.sistema,
        creada_por: creadaPor,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids[c.sistema] = r.id;
  }

  // Permisos sobre la raíz. La herencia es aditiva y desciende sola, así que
  // alcanza con otorgar acá: no hay que repetir el permiso en cada subcarpeta.
  await trx
    .insertInto('carpeta_permiso')
    .values([
      {
        carpeta_id: ids.raiz,
        cuenta_id: cuentaId,
        rol_id: roles.admin,
        acciones: ['ver', 'leer', 'crear', 'enviar', 'mover', 'organizar', 'permisos'],
        otorgado_por: creadaPor,
      },
      {
        carpeta_id: ids.raiz,
        cuenta_id: cuentaId,
        rol_id: roles.emisor,
        acciones: ['ver', 'leer', 'crear', 'enviar', 'mover'],
        otorgado_por: creadaPor,
      },
      {
        carpeta_id: ids.raiz,
        cuenta_id: cuentaId,
        rol_id: roles.lector,
        acciones: ['ver', 'leer'],
        otorgado_por: creadaPor,
      },
    ])
    .execute();

  return ids;
}
