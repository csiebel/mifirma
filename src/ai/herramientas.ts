import { z } from 'zod';
import { getAyudas } from '../ayuda/textos';

/**
 * Herramientas que la IA puede invocar (tool use). SIEMPRE de solo lectura y
 * ejecutadas a través de withUsuario, de modo que la RLS aplique el aislamiento
 * por cuenta y los otorgamientos. La IA recibe únicamente lo que el usuario ya
 * podía ver: la autorización NO depende de la IA.
 *
 * El catálogo de payroll (empleados, recibos, licencias, evaluaciones) se
 * descartó. Las herramientas del dominio de firma —estado de un circuito,
 * buscar documentos, quién falta firmar— se agregan cuando exista el motor
 * de flujo.
 */
export const HERRAMIENTAS = [
  {
    name: 'ayuda_sistema',
    description:
      'Devuelve los textos de ayuda del sistema para explicarle al usuario cómo hacer algo en la aplicación.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
] as const;

const esquemas = { ayuda_sistema: z.object({}) };

export async function ejecutarHerramienta(
  _cuentaId: string,
  _usuarioId: string,
  nombre: string,
  input: unknown,
): Promise<unknown> {
  switch (nombre) {
    case 'ayuda_sistema': {
      esquemas.ayuda_sistema.parse(input ?? {});
      return getAyudas();
    }
    default:
      throw new Error(`Herramienta desconocida: ${nombre}`);
  }
}
