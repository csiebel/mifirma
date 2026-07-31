import { z } from 'zod';
import { withUsuario } from '../auth/authz';
import * as consultas from '../repositories/consultas';
import { saldoLicencias } from '../services/licencias';
import { variableDeEmpleado, listarPlanesVariables } from '../services/planes_variables';
import { getAyudas } from '../ayuda/textos';

/**
 * Herramientas que la IA puede invocar (tool use). Son de SOLO LECTURA y cada
 * una se ejecuta a través de withUsuario, de modo que RLS aplica el aislamiento
 * por empresa y el alcance jerárquico. La IA recibe únicamente lo que el usuario
 * ya podía ver; la autorización NO depende de la IA.
 */
export const HERRAMIENTAS = [
  {
    name: 'buscar_empleados',
    description:
      'Busca empleados por (parte del) nombre dentro de la empresa del usuario. Devuelve relacion_id, nombre y documento. Usá el relacion_id para luego pedir un recibo.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Parte del nombre del empleado a buscar' },
      },
      required: ['texto'],
    },
  },
  {
    name: 'obtener_recibo',
    description:
      'Devuelve el recibo de sueldo YA CALCULADO de un empleado para un período (YYYY-MM): neto, moneda y el detalle de líneas (conceptos). Las cifras provienen del motor de liquidación; no las calcules ni las estimes vos.',
    input_schema: {
      type: 'object',
      properties: {
        relacion_id: { type: 'string', description: 'ID de la relación laboral (de buscar_empleados)' },
        periodo: { type: 'string', description: 'Período en formato YYYY-MM' },
      },
      required: ['relacion_id', 'periodo'],
    },
  },
  {
    name: 'listar_recibos',
    description:
      'Lista los recibos de un período (YYYY-MM) que el usuario tiene permitido ver según su alcance. Devuelve nombre, neto y moneda por empleado.',
    input_schema: {
      type: 'object',
      properties: {
        periodo: { type: 'string', description: 'Período en formato YYYY-MM' },
      },
      required: ['periodo'],
    },
  },
  {
    name: 'certificaciones_por_vencer',
    description:
      'Lista estudios/certificaciones que vencen en o antes de una fecha (YYYY-MM-DD), dentro del alcance del usuario. Sirve para alertas de vencimiento. Si no se indica fecha, usa un horizonte de 90 días.',
    input_schema: {
      type: 'object',
      properties: {
        antes_de: { type: 'string', description: 'Fecha límite YYYY-MM-DD (opcional)' },
      },
      required: [],
    },
  },
  {
    name: 'ver_evaluaciones',
    description:
      'Devuelve evaluaciones de desempeño que el usuario puede ver según su alcance. Si se pasa relacion_id, solo las de ese empleado. Es información sensible: solo llega lo que el usuario tiene permitido ver.',
    input_schema: {
      type: 'object',
      properties: {
        relacion_id: { type: 'string', description: 'ID de relación laboral (opcional)' },
      },
      required: [],
    },
  },
  {
    name: 'ver_capacitaciones',
    description:
      'Lista las capacitaciones e inscripciones de un empleado (estado y fecha de completado), dentro del alcance del usuario.',
    input_schema: {
      type: 'object',
      properties: {
        relacion_id: { type: 'string', description: 'ID de relación laboral' },
      },
      required: ['relacion_id'],
    },
  },
  {
    name: 'consultar_saldo_licencias',
    description:
      'Devuelve el saldo de licencia de un empleado para un año: días que le corresponden por antigüedad, días ya gozados y saldo. La cifra la calcula el sistema (regla del país menos lo gozado); no la estimes vos. Si no se indica el año, usa el actual.',
    input_schema: {
      type: 'object',
      properties: {
        relacion_id: { type: 'string', description: 'ID de relación laboral (de buscar_empleados)' },
        anio: { type: 'number', description: 'Año a consultar (opcional; por defecto el actual)' },
      },
      required: ['relacion_id'],
    },
  },
  {
    name: 'consultar_variable_empleado',
    description:
      'Devuelve la remuneración variable de un empleado YA CALCULADA por el sistema: los planes de incentivo que tiene asignados (sueldo variable, comisiones, bonos) con su "variable al 100%", y por período (YYYY-MM) el cumplimiento, el monto y el estado (abierto/cerrado/liquidado) de cada objetivo. El cumplimiento y el monto los calcula el motor al cerrar el período; reportalos tal cual, no los estimes ni los recalcules. El monto, una vez volcado, también aparece en el recibo del empleado. Solo disponible para RRHH/administración; si el usuario no tiene ese permiso la herramienta lo indica. Pasá el relacion_id (de buscar_empleados); si indicás período, filtra a ese mes.',
    input_schema: {
      type: 'object',
      properties: {
        relacion_id: { type: 'string', description: 'ID de relación laboral (de buscar_empleados)' },
        periodo: { type: 'string', description: 'Mes a consultar YYYY-MM (opcional; por defecto todos)' },
      },
      required: ['relacion_id'],
    },
  },
  {
    name: 'listar_planes_variable',
    description:
      'Lista los planes de remuneración variable (esquemas de incentivo: sueldo variable, comisiones, bonos por objetivos) definidos en la empresa, con su cantidad de objetivos. Es el catálogo de configuración, sin cifras de empleados concretos. Solo para RRHH/administración. No requiere parámetros.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'ayuda_sistema',
    description:
      'Devuelve la guía de uso del sistema: para qué sirve cada pantalla, campo y opción, y cómo hacer cada tarea (dónde y cómo cargar novedades y horas, agregar premios/viáticos/descuentos, correr la liquidación, ver o descargar un recibo, dar de alta un empleado, manejar licencias, etc.). Usala SIEMPRE que te pregunten cómo usar la app, qué es o para qué sirve algo, dónde se hace una acción, o qué significa una pantalla u opción. Es texto de producto (sin cifras ni reglas de cálculo). No requiere parámetros.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
] as const;

const PERIODO = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'Período inválido (YYYY-MM)');
const FECHA = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, 'Fecha inválida (YYYY-MM-DD)');

const esquemas = {
  buscar_empleados: z.object({ texto: z.string().min(1) }),
  obtener_recibo: z.object({ relacion_id: z.string().uuid(), periodo: PERIODO }),
  listar_recibos: z.object({ periodo: PERIODO }),
  certificaciones_por_vencer: z.object({ antes_de: FECHA.optional() }),
  ver_evaluaciones: z.object({ relacion_id: z.string().uuid().optional() }),
  ver_capacitaciones: z.object({ relacion_id: z.string().uuid() }),
  consultar_saldo_licencias: z.object({ relacion_id: z.string().uuid(), anio: z.number().int().min(2000).max(2100).optional() }),
  consultar_variable_empleado: z.object({ relacion_id: z.string().uuid(), periodo: PERIODO.optional() }),
};

/**
 * Ejecuta una herramienta por nombre, validando su input y corriendo la consulta
 * bajo el contexto del usuario (withUsuario => RLS). Devuelve datos serializables.
 */
export async function ejecutarHerramienta(
  cuentaId: string,
  usuarioId: string,
  nombre: string,
  input: unknown,
): Promise<unknown> {
  switch (nombre) {
    case 'buscar_empleados': {
      const { texto } = esquemas.buscar_empleados.parse(input);
      return withUsuario(cuentaId, usuarioId, (trx) => consultas.buscarEmpleados(trx, texto));
    }
    case 'obtener_recibo': {
      const { relacion_id, periodo } = esquemas.obtener_recibo.parse(input);
      return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
        const recibo = await consultas.obtenerRecibo(trx, autz, relacion_id, periodo);
        return (
          recibo ?? {
            aviso: 'No hay un recibo visible para ese empleado y período: o no existe, o no tenés acceso.',
          }
        );
      });
    }
    case 'listar_recibos': {
      const { periodo } = esquemas.listar_recibos.parse(input);
      return withUsuario(cuentaId, usuarioId, (trx, autz) => consultas.listarRecibos(trx, autz, periodo));
    }
    case 'certificaciones_por_vencer': {
      const { antes_de } = esquemas.certificaciones_por_vencer.parse(input);
      const limite = antes_de ?? new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      return withUsuario(cuentaId, usuarioId, (trx) => consultas.certificacionesPorVencer(trx, limite));
    }
    case 'ver_evaluaciones': {
      const { relacion_id } = esquemas.ver_evaluaciones.parse(input);
      return withUsuario(cuentaId, usuarioId, (trx, autz) => consultas.verEvaluaciones(trx, autz, relacion_id));
    }
    case 'ver_capacitaciones': {
      const { relacion_id } = esquemas.ver_capacitaciones.parse(input);
      return withUsuario(cuentaId, usuarioId, (trx) => consultas.inscripcionesDe(trx, relacion_id));
    }
    case 'consultar_saldo_licencias': {
      const { relacion_id, anio } = esquemas.consultar_saldo_licencias.parse(input);
      const year = anio ?? new Date().getFullYear();
      // El servicio ya corre bajo withUsuario (alcance) y usa la regla del país.
      return saldoLicencias(cuentaId, usuarioId, relacion_id, year);
    }
    case 'consultar_variable_empleado': {
      const { relacion_id, periodo } = esquemas.consultar_variable_empleado.parse(input);
      return variableDeEmpleado(cuentaId, usuarioId, relacion_id, periodo);
    }
    case 'listar_planes_variable': {
      return listarPlanesVariables(cuentaId, usuarioId);
    }
    case 'ayuda_sistema': {
      return { secciones: getAyudas('es') };
    }
    default:
      return { error: `Herramienta desconocida: ${nombre}` };
  }
}
