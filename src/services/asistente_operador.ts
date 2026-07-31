import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '../http/errors';
import { GUIA_OPERADOR } from '../ayuda/guia_operador';

// Para la ayuda alcanza un modelo rápido; configurable por entorno.
const MODELO = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

const SISTEMA = `Sos el asistente de ayuda de la consola del operador de MiFirma.
Tu único trabajo es explicarle al operador CÓMO hacer las cosas en la consola, paso a paso.

Reglas:
- Respondé en español rioplatense, claro y conciso. Usá pasos numerados cuando ayuden.
- Basate ÚNICAMENTE en la guía de abajo. No inventes secciones, botones ni campos que no figuren en ella.
- Si la guía no cubre lo que preguntan, o no estás seguro, decilo con honestidad y sugerí en qué sección de la consola mirar. No te lo inventes.
- No tenés acceso a datos de empresas ni de personas, ni podés ejecutar acciones por el operador. Solo explicás procedimientos. Si te piden un dato concreto o que hagas algo por ellos, aclaralo amablemente.

--- GUÍA ---
${GUIA_OPERADOR}`;

export interface MensajeChat {
  role: 'user' | 'assistant';
  content: string;
}

export async function asistirOperador(pregunta: string, historial: MensajeChat[] = []): Promise<string> {
  const p = (pregunta || '').trim();
  if (!p) throw new HttpError(400, 'Escribí una pregunta.');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(503, 'El asistente no está disponible (falta configurar la IA).');
  const client = new Anthropic({ apiKey });

  // Historial acotado, para no inflar el contexto ni el costo (últimos 10 turnos).
  const previos: Anthropic.MessageParam[] = historial
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  const messages: Anthropic.MessageParam[] = [...previos, { role: 'user', content: p }];

  try {
    const resp = await client.messages.create({
      model: MODELO,
      max_tokens: 1200,
      system: SISTEMA,
      messages,
    });
    const texto = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return texto || 'No tengo una respuesta para eso. Probá reformular la pregunta.';
  } catch {
    throw new HttpError(502, 'El asistente no pudo responder ahora. Intentá de nuevo en un momento.');
  }
}
