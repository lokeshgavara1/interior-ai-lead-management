import OpenAI from 'openai';
import { extractJson, repairAiOutput } from './repair.js';
import { AI_TURN_JSON_SCHEMA, AiTurnSchema, type AiTurn } from './schema.js';
import type { ChatMessage } from './prompt.js';

/** Provider-agnostic interface so the model/provider can be swapped later. */
export interface Llm {
  /** One receptionist turn: reply + structured extraction. Throws if output stays invalid. */
  receptionistTurn(system: string, messages: ChatMessage[]): Promise<AiTurn>;
  /** Short free-text generation (follow-ups). */
  generateText(system: string, user: string): Promise<string>;
}

export class AiOutputError extends Error {}

export type JsonMode = 'json_schema' | 'json_object' | 'prompt';

/** Strict parse: valid JSON that already matches the schema exactly. */
export function parseAiTurn(raw: string): AiTurn {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AiOutputError('AI returned non-JSON output');
  }
  const parsed = AiTurnSchema.safeParse(json);
  if (!parsed.success) {
    throw new AiOutputError(`AI output failed validation: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  return parsed.data;
}

/**
 * Lenient parse for open models: extract the JSON object, repair formatting slips
 * (placeholders, casing, "8 lakhs"), then validate strictly. A reply is mandatory.
 */
export function parseAiTurnLenient(raw: string): AiTurn {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch {
    throw new AiOutputError('AI returned non-JSON output');
  }
  const parsed = AiTurnSchema.safeParse(repairAiOutput(json));
  if (!parsed.success) {
    throw new AiOutputError(`AI output failed validation: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  return parsed.data;
}

/** Schema described in words, for servers that can't enforce a JSON schema. */
export const JSON_INSTRUCTIONS = `

OUTPUT FORMAT
Respond with ONE JSON object and nothing else, with exactly these keys:
${Object.entries(AI_TURN_JSON_SCHEMA.properties)
  .map(([key, spec]) => {
    type Part = { type?: string; enum?: readonly string[]; description?: string };
    const s = spec as Part & { anyOf?: Part[] };
    const inner = s.anyOf?.[0] ?? s;
    const type = inner.enum ? `one of ${inner.enum.map((e) => `"${e}"`).join(' | ')}` : (inner.type ?? 'string');
    return `- "${key}": ${type}${s.anyOf ? ' or null' : ''}${inner.description || s.description ? ` — ${inner.description ?? s.description}` : ''}`;
  })
  .join('\n')}
Use null for anything the customer has not said. Never write "Not provided" or similar.`;

export interface LlmOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  jsonMode?: JsonMode;
  timeoutMs?: number;
  maxAttempts?: number;
}

export function createOpenAiLlm(opts: LlmOptions): Llm {
  const { model, jsonMode = 'json_schema', maxAttempts = 2 } = opts;
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2, timeout: opts.timeoutMs ?? 60_000 });

  const responseFormat =
    jsonMode === 'json_schema'
      ? ({
          type: 'json_schema',
          json_schema: { name: 'receptionist_turn', strict: true, schema: AI_TURN_JSON_SCHEMA as unknown as Record<string, unknown> },
        } as const)
      : jsonMode === 'json_object'
        ? ({ type: 'json_object' } as const)
        : undefined;

  return {
    async receptionistTurn(system, messages) {
      // Describe the format in the prompt too unless the server enforces the schema.
      const sys = jsonMode === 'json_schema' ? system : system + JSON_INSTRUCTIONS;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await client.chat.completions.create({
          model,
          temperature: 0.3,
          messages: [{ role: 'system', content: sys }, ...messages],
          ...(responseFormat ? { response_format: responseFormat } : {}),
        });
        const choice = res.choices[0];
        if (choice?.message.refusal) throw new AiOutputError(`AI refused: ${choice.message.refusal}`);
        try {
          return parseAiTurnLenient(choice?.message.content ?? '');
        } catch (err) {
          lastError = err; // retry once on invalid output (§12: "reject or retry safely")
        }
      }
      throw lastError;
    },

    async generateText(system, user) {
      const res = await client.chat.completions.create({
        model,
        temperature: 0.5,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const text = res.choices[0]?.message.content?.trim().replace(/^["']|["']$/g, '');
      if (!text) throw new AiOutputError('Empty AI text output');
      return text;
    },
  };
}
