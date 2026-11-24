import 'dotenv/config';
import { z } from 'zod';

const boolEnv = z
  .string()
  .optional()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase()));

/** AI settings: any OpenAI-compatible chat API (OpenAI, Ollama, vLLM, private gateways). */
const LlmEnv = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1),
  /** Leave empty for api.openai.com; set for OpenAI-compatible servers, e.g. https://host/v1 */
  OPENAI_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  /**
   * How JSON is requested: json_schema (server enforces our schema — best),
   * json_object (JSON only, schema described in the prompt), prompt (no response_format).
   */
  LLM_JSON_MODE: z.enum(['json_schema', 'json_object', 'prompt']).default('json_schema'),
  /** Keep only facts the customer actually stated (recommended for small models like 7B). */
  LLM_FACT_GROUNDING: boolEnv,
  LLM_TIMEOUT_MS: z.coerce.number().default(60_000),
});
export type LlmConfig = z.infer<typeof LlmEnv>;

/** Only the AI settings — used by the local chat CLI, which needs no database or Meta keys. */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const parsed = LlmEnv.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid AI configuration:\n${issues}`);
  }
  return parsed.data;
}

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  ...LlmEnv.shape,

  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  META_GRAPH_VERSION: z.string().default('v23.0'),

  DEBOUNCE_MS: z.coerce.number().default(4000),
  HISTORY_LIMIT: z.coerce.number().default(20),
  FOLLOWUP_INTERVAL_MS: z.coerce.number().default(15 * 60 * 1000),
  OVERDUE_INTERVAL_MS: z.coerce.number().default(10 * 60 * 1000),

  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().optional(),
  SHEETS_SYNC_INTERVAL_MS: z.coerce.number().default(2 * 60 * 1000),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\nCopy .env.example to .env and fill it in.`);
  }
  return parsed.data;
}
