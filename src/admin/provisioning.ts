import { randomUUID } from 'node:crypto';
import { withProvision } from '../db/owner';
import { hashPassword } from '../auth/password';
import type { AlcanceDato } from '../db/schema';

export interface ProvisionInput {
  nombre: string;
  pais: string; // 'UY' | 'PY'
  moneda: string; // 'UYU' | 'PYG'
  razonSocial?: string;
  idFiscal?: string;
  numSeguridadSocial?: string;
  domicilio?: string;
  industriaId?: string;
  admin: { email: string; nombre: string; documento: string; password?: string };
}

export interface ProvisionResult {
  cuentaId: string;
  adminUsuarioId: string;
  adminPersonaId: string;
  roles: Record<string, string>;
}

// Recursos por sujeto (heredan alcance jerárquico) y el catálogo de capacitaciones.
const RECURSOS_SUJETO = ['recibo', 'evaluacion', 'estudio_cert', 'legajo', 'inscripcion'];

/**
 * Onboarding de un tenant: crea la empresa, su persona+usuario admin, un set de
 * roles base (admin / empleado / jefe / rrhh / liquidador) con capacidades de
 * lectura, y le asigna el rol admin al usuario. Corre con la conexión
 * privilegiada (withProvision). Devuelve los ids para poder loguearse.
 */
export async function provisionarEmpresa(input: ProvisionInput): Promise<ProvisionResult> {
  const cuentaId = randomUUID();

  return withProvision(cuentaId, async (trx) => {
    // Empresa (id explícito para cumplir el WITH CHECK del contexto).
    await trx
      .insertInto('empresa')
      .values({
        id: cuentaId,
        nombre: input.nombre,
        pais: input.pais,
        moneda: input.moneda,
        razon_social: input.razonSocial ?? null,
        id_fiscal: input.idFiscal ?? null,
        num_seguridad_social: input.numSeguridadSocial ?? null,
        domicilio: input.domicilio ?? null,
        industria_id: input.industriaId ?? null,
      })
      .execute();

    // Persona + usuario admin.
    const persona = await trx
      .insertInto('persona')
      .values({ cuenta_id: cuentaId, documento: input.admin.documento, nombre: input.admin.nombre })
      .returning('id')
      .executeTakeFirstOrThrow();
    const usuario = await trx
      .insertInto('usuario')
      .values({
        cuenta_id: cuentaId,
        persona_id: persona.id,
        email: input.admin.email,
        password_hash: input.admin.password ? hashPassword(input.admin.password) : null,
        password_actualizado: input.admin.password ? new Date() : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Roles base.
    const roles: Record<string, string> = {};
    for (const nombre of ['admin', 'empleado', 'jefe', 'rrhh', 'liquidador']) {
      const r = await trx
        .insertInto('rol')
        .values({ cuenta_id: cuentaId, nombre, protegido: nombre === 'admin' })
        .returning('id')
        .executeTakeFirstOrThrow();
      roles[nombre] = r.id;
    }

    // Capacidades de lectura (el alcance es lo que aplica RLS).
    const caps: { rol_id: string; recurso: string; accion: string; alcance: AlcanceDato }[] = [];
    for (const rec of RECURSOS_SUJETO) {
      caps.push({ rol_id: roles.empleado, recurso: rec, accion: 'leer', alcance: 'propio' });
      caps.push({ rol_id: roles.jefe, recurso: rec, accion: 'leer', alcance: 'area' });
      caps.push({ rol_id: roles.admin, recurso: rec, accion: 'leer', alcance: 'empresa' });
    }
    for (const rec of ['evaluacion', 'estudio_cert', 'legajo', 'inscripcion', 'capacitacion']) {
      caps.push({ rol_id: roles.rrhh, recurso: rec, accion: 'leer', alcance: 'empresa' });
    }
    caps.push({ rol_id: roles.liquidador, recurso: 'recibo', accion: 'leer', alcance: 'empresa' });
    // Ver los importes del recibo (campo sensible): liquidador y admin.
    caps.push({ rol_id: roles.liquidador, recurso: 'recibo', accion: 'ver_monto', alcance: 'empresa' });
    caps.push({ rol_id: roles.admin, recurso: 'recibo', accion: 'ver_monto', alcance: 'empresa' });
    caps.push({ rol_id: roles.admin, recurso: 'evaluacion', accion: 'ver_detalle', alcance: 'empresa' });
    caps.push({ rol_id: roles.rrhh, recurso: 'evaluacion', accion: 'ver_detalle', alcance: 'empresa' });
    // Ver documentos sensibles del legajo (campo sensible): admin y rrhh.
    caps.push({ rol_id: roles.admin, recurso: 'legajo', accion: 'ver_detalle', alcance: 'empresa' });
    caps.push({ rol_id: roles.rrhh, recurso: 'legajo', accion: 'ver_detalle', alcance: 'empresa' });
    // Correr y emitir liquidaciones: nómina (liquidador) y admin.
    caps.push({ rol_id: roles.liquidador, recurso: 'corrida', accion: 'escribir', alcance: 'empresa' });
    caps.push({ rol_id: roles.admin, recurso: 'corrida', accion: 'escribir', alcance: 'empresa' });
    // El admin además puede dar de alta y editar empleados; el jefe, los de su área.
    caps.push({ rol_id: roles.admin, recurso: 'empleado', accion: 'escribir', alcance: 'empresa' });
    caps.push({ rol_id: roles.jefe, recurso: 'empleado', accion: 'escribir', alcance: 'area' });
    for (const rol of ['empleado', 'jefe', 'admin']) {
      caps.push({ rol_id: roles[rol], recurso: 'capacitacion', accion: 'leer', alcance: 'empresa' });
    }
    // Escritura de RRHH. rrhh y admin: todo, alcance empresa. jefe: evaluar e
    // inscribir a su equipo (area). empleado: cargar sus propios estudios (propio).
    for (const rec of ['evaluacion', 'estudio_cert', 'legajo', 'capacitacion', 'inscripcion']) {
      caps.push({ rol_id: roles.rrhh, recurso: rec, accion: 'escribir', alcance: 'empresa' });
      caps.push({ rol_id: roles.admin, recurso: rec, accion: 'escribir', alcance: 'empresa' });
    }
    caps.push({ rol_id: roles.jefe, recurso: 'evaluacion', accion: 'escribir', alcance: 'area' });
    caps.push({ rol_id: roles.jefe, recurso: 'inscripcion', accion: 'escribir', alcance: 'area' });
    // El admin gestiona accesos (crear usuarios y asignarles roles).
    caps.push({ rol_id: roles.admin, recurso: 'usuario', accion: 'escribir', alcance: 'empresa' });
    caps.push({ rol_id: roles.admin, recurso: 'auditoria', accion: 'leer', alcance: 'empresa' });
    // (El rol empleado queda estrictamente de lectura: ve lo suyo, no modifica.)
    await trx
      .insertInto('capacidad')
      .values(caps.map((c) => ({ cuenta_id: cuentaId, ...c })))
      .execute();

    // El admin recibe el rol admin.
    await trx
      .insertInto('usuario_rol')
      .values({ cuenta_id: cuentaId, usuario_id: usuario.id, rol_id: roles.admin })
      .execute();

    // Catálogo de categorías de comunicados por defecto (la empresa puede editarlo).
    await trx
      .insertInto('comunicado_categoria')
      .values([
        { cuenta_id: cuentaId, nombre: 'Novedad', orden: 0 },
        { cuenta_id: cuentaId, nombre: 'Evento', orden: 1 },
        { cuenta_id: cuentaId, nombre: 'Política', orden: 2 },
      ])
      .execute();

    // Conceptos de ausencia por defecto (la empresa puede editarlos). 'sin_goce' descuenta.
    await trx
      .insertInto('concepto_ausencia')
      .values([
        { cuenta_id: cuentaId, codigo: 'vacaciones', etiqueta: 'Vacaciones', descuenta: false, orden: 1 },
        { cuenta_id: cuentaId, codigo: 'enfermedad', etiqueta: 'Enfermedad', descuenta: false, orden: 2 },
        { cuenta_id: cuentaId, codigo: 'estudio', etiqueta: 'Estudio', descuenta: false, orden: 3 },
        { cuenta_id: cuentaId, codigo: 'personal', etiqueta: 'Licencia personal', descuenta: false, orden: 4 },
        { cuenta_id: cuentaId, codigo: 'sin_goce', etiqueta: 'Licencia sin goce', descuenta: true, orden: 5 },
      ])
      .execute();

    // Estructura mínima para que el alta de empleados funcione apenas se crea la
    // empresa, sin obligar a configurar nada primero: un local, un área y un cargo
    // por defecto. La empresa puede renombrarlos, desactivarlos o sumar más desde
    // Estructura. (El cargo cuelga del área General; queda sin nivel de franja.)
    await trx
      .insertInto('establecimiento')
      .values({ cuenta_id: cuentaId, nombre: 'Casa Central' })
      .execute();
    const areaGeneral = await trx
      .insertInto('unidad_org')
      .values({ cuenta_id: cuentaId, nombre: 'General' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('cargo')
      .values({ cuenta_id: cuentaId, unidad_org_id: areaGeneral.id, nombre: 'Empleado' })
      .execute();

    return { cuentaId, adminUsuarioId: usuario.id, adminPersonaId: persona.id, roles };
  });
}
