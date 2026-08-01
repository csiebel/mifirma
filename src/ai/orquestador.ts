import Anthropic from '@anthropic-ai/sdk';
import { withUsuario } from '../auth/authz';
import { HERRAMIENTAS, ejecutarHerramienta } from './herramientas';
import { asistenteHabilitado, registrarConsumoIA } from '../services/consumo_ia';

// Modelo configurable por entorno (ANTHROPIC_MODEL). Por defecto Opus; mirá los
// modelos vigentes en docs.claude.com. Si tu cuenta usa otro id de Opus, ponelo en .env.
const MODELO = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';
const MAX_VUELTAS = 6;

const SISTEMA = `Sos el asistente de un sistema de liquidación de sueldos y RRHH. El motor de liquidación calcula las cifras y define las reglas; vos solo recuperás datos con herramientas y los explicás. Reglas estrictas:

- NUNCA inventes ni calcules cifras (sueldos, aportes, impuestos, netos, días). Todas salen de las herramientas, que las leen del motor. Si una cifra no está disponible por una herramienta, decílo claramente en vez de estimarla.

- NUNCA expliques de memoria CÓMO se calcula algo ni cuáles son las reglas locales: la fórmula del aguinaldo, las tasas de aportes, los tramos o topes del impuesto a la renta, las reglas de licencias, las indemnizaciones por despido, etc. Esas reglas viven en el motor, dependen del país de la empresa y cambian por fecha. No las sabés vos; no las repitas desde tu conocimiento general.

- NUNCA asumas un país ni traslades reglas de otro país (por ejemplo Argentina, España u otro). Cada empresa tiene su propio país y sus propias reglas; vos solo conocés lo que devuelven las herramientas para ESTA empresa.

- Si te preguntan por una REGLA DE CÁLCULO o de liquidación ("cómo se calcula X", "cuánto es la tasa de Y", "cuántos días de licencia me corresponden", "cómo se computa el aguinaldo"): no respondas de memoria. Explicá que esa regla la define el motor según el país de la empresa, y ofrecé mostrar el resultado real. La mejor forma de explicar una liquidación es traer un recibo ya calculado con obtener_recibo y recorrer sus líneas: la descripción y el monto de cada línea muestran cómo quedó compuesta, para el país correcto (el aguinaldo, por ejemplo, queda en el recibo del mes de pago). Si no tenés un empleado y período concretos, pedilos.

- Cuando expliques un recibo, basate SOLO en las líneas que devolvió la herramienta (descripción, naturaleza, monto). No completes con supuestos.

- En cambio, SÍ podés y debés explicar cómo USAR el sistema: qué es y para qué sirve cada pantalla, campo, opción o botón, y dónde y cómo se hace cada tarea (cargar novedades y horas, agregar premios/viáticos/descuentos, correr la liquidación, ver o descargar un recibo, dar de alta un empleado, manejar licencias, gestionar la remuneración variable, etc.). Para eso tenés la herramienta ayuda_sistema, que trae la guía de uso oficial: consultala antes de responder este tipo de preguntas y basate en ella. No inventes nombres de pantallas ni pasos que no figuren en la guía; si la guía no lo cubre, decílo en vez de suponer. Distinción clave: explicar cómo se USA la app está permitido (sale de ayuda_sistema); explicar cómo se CALCULA una cifra o cuál es una regla local, no (eso vive en el motor y depende del país).

- Las herramientas YA aplican los permisos del usuario: solo recibís datos que la persona tiene derecho a ver. Si una herramienta no devuelve nada o devuelve un aviso de acceso, puede ser que el dato no exista o que el usuario no tenga permiso; no especules ni inventes datos de terceros.

- Para identificar a un empleado, primero buscalo por nombre con buscar_empleados y usá su relacion_id.

- Respondé en el idioma del usuario, de forma clara y concisa. Mostrá los montos con su moneda.`;

/**
 * Responde una pregunta en lenguaje natural. La IA elige qué herramientas
 * llamar; cada llamada se ejecuta contra la capa de aplicación CON la identidad
 * del usuario (withUsuario => RLS). La IA solo recupera y explica: las cifras
 * nacen del motor, y nunca ve datos fuera del alcance del usuario.
 */
export async function responder(
  cuentaId: string,
  identidadId: string,
  pregunta: string,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY en el entorno.');

  // Gate de habilitación (override de la empresa -> plan). Si está apagado, no se gasta nada.
  if (!(await asistenteHabilitado(cuentaId, identidadId))) {
    return 'El asistente conversacional no está habilitado en el plan de tu empresa.';
  }

  const client = new Anthropic({ apiKey });

  const sistema = SISTEMA;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: pregunta }];
  const periodo = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  let inTok = 0;
  let outTok = 0;

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const resp = await client.messages.create({
      model: MODELO,
      max_tokens: 1024,
      system: sistema,
      tools: HERRAMIENTAS as unknown as Anthropic.Tool[],
      messages,
    });

    inTok += resp.usage?.input_tokens ?? 0;
    outTok += resp.usage?.output_tokens ?? 0;

    if (resp.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: resp.content });
      const resultados: Anthropic.ToolResultBlockParam[] = [];
      for (const bloque of resp.content) {
        if (bloque.type === 'tool_use') {
          let contenido: string;
          try {
            const data = await ejecutarHerramienta(cuentaId, identidadId, bloque.name, bloque.input);
            contenido = JSON.stringify(data);
          } catch (e) {
            contenido = JSON.stringify({ error: (e as Error).message });
          }
          resultados.push({ type: 'tool_result', tool_use_id: bloque.id, content: contenido });
        }
      }
      messages.push({ role: 'user', content: resultados });
      continue;
    }

    const texto = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    await registrarConsumoIA(cuentaId, identidadId, { periodo, modelo: MODELO, inputTokens: inTok, outputTokens: outTok });
    return texto;
  }

  await registrarConsumoIA(cuentaId, identidadId, { periodo, modelo: MODELO, inputTokens: inTok, outputTokens: outTok });
  return 'No pude completar la consulta en los pasos disponibles.';
}
