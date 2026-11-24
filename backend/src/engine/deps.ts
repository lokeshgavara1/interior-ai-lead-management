import type { Llm } from '../ai/llm.js';
import type { MetaGraph } from '../channels/meta.js';
import type { WhatsAppSender } from '../channels/whatsapp.js';
import type { Repo } from '../db/repo.js';
import type { Notifier } from '../notify/notifier.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Everything the engine needs, injected so it can be tested with fakes. */
export interface EngineDeps {
  repo: Repo;
  llm: Llm;
  wa: WhatsAppSender;
  meta: MetaGraph;
  notifier: Notifier;
  log: Logger;
  now: () => Date;
  historyLimit: number;
  /** Keep only facts the customer actually stated (recommended for small models). */
  factGrounding?: boolean;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD in the tenant's timezone. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
