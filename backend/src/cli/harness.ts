/**
 * Local harness: the real prompt, engine, scoring, assignment and alerts, wired to an
 * in-memory database and a fake WhatsApp that records messages instead of sending them.
 * Only the AI settings in .env are needed. Used by `npm run chat` and `npm run test:live`.
 */
import { createOpenAiLlm } from '../ai/llm.js';
import type { MetaGraph } from '../channels/meta.js';
import type { WhatsAppSender } from '../channels/whatsapp.js';
import { loadLlmConfig, type LlmConfig } from '../config.js';
import { MemoryRepo } from '../db/memoryRepo.js';
import type { Lead, Tenant } from '../domain/types.js';
import { processLead } from '../engine/conversation.js';
import type { EngineDeps } from '../engine/deps.js';
import type { Inbox } from '../engine/inbox.js';
import { ingestWhatsAppMessage } from '../engine/ingest.js';
import { createNotifier } from '../notify/notifier.js';

export const CUSTOMER = '919876543210';
export const SALES_MANAGER = '+919000000000';
export const SALESPERSON = '+919111111111';

export const color = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export function demoTenant(): Tenant {
  return {
    id: 'demo-tenant',
    slug: 'demo',
    name: 'Demo Interiors',
    whatsapp_phone_number_id: 'DEMO-PNID',
    facebook_page_id: null,
    instagram_account_id: null,
    website_webhook_secret: 'demo',
    timezone: 'Asia/Kolkata',
    default_country_code: '91',
    knowledge_base: `Company: Demo Interiors, Hyderabad.
Services: full home interiors, modular kitchens, wardrobes, living room and bedroom interiors, renovation.
Areas served: Hyderabad and Secunderabad (Kondapur, Gachibowli, Madhapur, Kukatpally, Miyapur and nearby).
Process: free consultation -> site visit and measurement -> 3D design -> quotation -> execution (typically 45-60 days for a 3BHK).
Pricing policy: do NOT quote prices. Say our designer will share a detailed quotation after the site visit.
Working hours: Mon-Sat, 10am-7pm IST.`,
    settings: {
      sales_whatsapp_numbers: [SALES_MANAGER],
      salespeople: [{ name: 'Priya', whatsapp: SALESPERSON }],
      contact_sla_hours: 4,
    },
  };
}

export interface Turn {
  customer: string;
  replies: string[];
  alerts: { to: string; text: string }[];
  guards: { action: string; original: string }[];
  seconds: number;
}

export interface Harness {
  cfg: LlmConfig;
  repo: MemoryRepo;
  /** Customer sends one message; the receptionist processes it immediately. */
  send(text: string): Promise<Turn>;
  lead(): Lead | undefined;
}

export interface HarnessOptions {
  /** Print the conversation as it happens. */
  echo?: boolean;
}

export function createHarness(opts: HarnessOptions = {}): Harness {
  const cfg = loadLlmConfig();
  const repo = new MemoryRepo();
  repo.tenants.push(demoTenant());
  const c = color;

  let current: Turn | null = null;

  // Record (and optionally print) when a safety guard rewrote the AI's reply.
  const audit = repo.audit.bind(repo);
  repo.audit = async (e: { action: string; details?: unknown }) => {
    if (e.action.startsWith('reply_guard_')) {
      const original = String((e.details as { original?: string } | undefined)?.original ?? '');
      current?.guards.push({ action: e.action, original });
      if (opts.echo) console.log(c.dim(`  [${e.action}] model wrote: ${JSON.stringify(original).slice(0, 200)}`));
    }
    return audit(e as Parameters<typeof audit>[0]);
  };

  const wa: WhatsAppSender = {
    async sendText(_p, to, body) {
      if (to === `+${CUSTOMER}`) {
        current?.replies.push(body);
        if (opts.echo) console.log(`${c.green('AI  ›')} ${body}`);
      } else {
        current?.alerts.push({ to, text: body });
        if (opts.echo) console.log(c.yellow(`  [ALERT → ${to}] ${body.split('\n')[0]}`));
      }
      return 'local';
    },
    async sendTemplate(_p, to, template, _l, params) {
      if (opts.echo) console.log(c.yellow(`  [TEMPLATE ${template} → ${to}] ${params.join(' | ')}`));
      return 'local';
    },
  };
  const meta: MetaGraph = {
    async sendInstagramText() {
      return 'local';
    },
    async fetchLeadgen() {
      throw new Error('not available locally');
    },
  };
  const llm = createOpenAiLlm({
    apiKey: cfg.OPENAI_API_KEY,
    model: cfg.OPENAI_MODEL,
    baseURL: cfg.OPENAI_BASE_URL,
    jsonMode: cfg.LLM_JSON_MODE,
    timeoutMs: cfg.LLM_TIMEOUT_MS,
  });
  const log = {
    info() {},
    warn() {},
    error: (o: unknown, m?: string) => {
      if (!opts.echo) return;
      const err = (o as { err?: Error } | undefined)?.err;
      console.log(c.red(`  [error] ${m ?? ''}${err ? `: ${err.message}` : ''}`));
    },
  };
  const deps: EngineDeps = {
    repo,
    llm,
    wa,
    meta,
    notifier: createNotifier(repo, wa, { port: 587 }),
    log,
    now: () => new Date(),
    historyLimit: 20,
    factGrounding: cfg.LLM_FACT_GROUNDING,
  };
  const scheduled: string[] = [];
  const inbox = { schedule: (id: string) => scheduled.push(id) } as unknown as Inbox;
  let seq = 0;

  return {
    cfg,
    repo,
    lead: () => repo.leads[0],
    async send(text) {
      seq++;
      current = { customer: text, replies: [], alerts: [], guards: [], seconds: 0 };
      if (opts.echo) console.log(`${c.cyan('You ›')} ${text}`);
      await ingestWhatsAppMessage(deps, inbox, {
        phoneNumberId: 'DEMO-PNID',
        from: CUSTOMER,
        profileName: null,
        messageId: `local-${seq}`,
        timestamp: new Date().toISOString(),
        text,
        type: 'text',
      });
      const t = Date.now();
      await processLead(deps, scheduled.at(-1)!);
      current.seconds = (Date.now() - t) / 1000;
      if (opts.echo) console.log(c.dim(`  (${current.seconds.toFixed(1)}s)`));
      const done = current;
      current = null;
      return done;
    },
  };
}

export function leadSummary(l: Lead | undefined): string {
  if (!l) return '(no lead yet)';
  const pick = {
    name: l.customer_name,
    location: l.location,
    property: [l.property_size, l.property_type].filter(Boolean).join(' ') || null,
    project: l.project_type,
    property_status: l.property_status,
    budget: l.budget,
    timeline: l.timeline_text,
    start_date: l.expected_start_date,
    site_visit: l.site_visit_requested,
    score: l.lead_score,
    temperature: l.lead_temperature,
    lead_status: l.lead_status,
    assigned: l.assigned_salesperson,
    needs_human: l.needs_human,
    ai_paused: l.ai_paused,
    opted_out: l.opted_out,
  };
  return Object.entries(pick)
    .map(([k, v]) => `  ${k.padEnd(16)} ${v === null || v === '' ? color.dim('—') : JSON.stringify(v)}`)
    .join('\n');
}
