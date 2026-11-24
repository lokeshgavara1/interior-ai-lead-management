/**
 * Talk to the AI receptionist from your terminal, with the real prompt, engine,
 * scoring, assignment and alerts, but an in-memory database and no WhatsApp/Meta.
 * Only the AI settings in .env are needed.
 *
 *   npm run chat                                # interactive
 *   npm run chat -- "Hi, 3BHK in Kondapur" "Budget 8 lakhs"   # scripted, then exit
 *
 * Commands (interactive): /lead  /history  /reset  /quit
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createOpenAiLlm } from '../ai/llm.js';
import type { MetaGraph } from '../channels/meta.js';
import type { WhatsAppSender } from '../channels/whatsapp.js';
import { loadLlmConfig } from '../config.js';
import { MemoryRepo } from '../db/memoryRepo.js';
import type { Tenant } from '../domain/types.js';
import { processLead } from '../engine/conversation.js';
import type { EngineDeps } from '../engine/deps.js';
import type { Inbox } from '../engine/inbox.js';
import { ingestWhatsAppMessage } from '../engine/ingest.js';
import { createNotifier } from '../notify/notifier.js';

const CUSTOMER = '919876543210';
const SALES_MANAGER = '+919000000000';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function demoTenant(): Tenant {
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
      salespeople: [{ name: 'Priya', whatsapp: '+919111111111' }],
      contact_sla_hours: 4,
    },
  };
}

function setup() {
  const cfg = loadLlmConfig();
  const repo = new MemoryRepo();
  repo.tenants.push(demoTenant());
  // Show when a safety guard rewrote the AI's reply.
  const audit = repo.audit.bind(repo);
  repo.audit = async (e: { action: string; details?: unknown }) => {
    if (e.action.startsWith('reply_guard_')) {
      const d = e.details as { original?: string } | undefined;
      console.log(c.dim(`  [${e.action}] model wrote: ${JSON.stringify(d?.original ?? '').slice(0, 200)}`));
    }
    return audit(e);
  };

  const wa: WhatsAppSender = {
    async sendText(_p, to, body) {
      if (to === `+${CUSTOMER}`) console.log(`${c.green('AI  ›')} ${body}`);
      else console.log(c.yellow(`\n[ALERT → ${to}]\n${body}\n`));
      return 'local';
    },
    async sendTemplate(_p, to, template, _l, params) {
      console.log(c.yellow(`[TEMPLATE ${template} → ${to}] ${params.join(' | ')}`));
      return 'local';
    },
  };
  const meta: MetaGraph = {
    async sendInstagramText() {
      return 'local';
    },
    async fetchLeadgen() {
      throw new Error('not available in chat CLI');
    },
  };
  const llm = createOpenAiLlm({
    apiKey: cfg.OPENAI_API_KEY,
    model: cfg.OPENAI_MODEL,
    baseURL: cfg.OPENAI_BASE_URL,
    jsonMode: cfg.LLM_JSON_MODE,
    timeoutMs: cfg.LLM_TIMEOUT_MS,
  });
  const quiet = { info() {}, warn() {}, error: (o: unknown, m?: string) => console.error(c.yellow(`[error] ${m ?? ''}`), o) };
  const deps: EngineDeps = {
    repo,
    llm,
    wa,
    meta,
    notifier: createNotifier(repo, wa, { port: 587 }),
    log: quiet,
    now: () => new Date(),
    historyLimit: 20,
    factGrounding: cfg.LLM_FACT_GROUNDING,
  };
  const scheduled: string[] = [];
  const inbox = { schedule: (id: string) => scheduled.push(id) } as unknown as Inbox;
  console.log(
    c.dim(`AI: ${cfg.OPENAI_MODEL} @ ${cfg.OPENAI_BASE_URL ?? 'api.openai.com'} | json=${cfg.LLM_JSON_MODE} | grounding=${cfg.LLM_FACT_GROUNDING}`),
  );
  return { repo, deps, inbox, scheduled };
}

function leadSummary(repo: MemoryRepo): string {
  const l = repo.leads[0];
  if (!l) return '(no lead yet)';
  const pick = {
    name: l.customer_name,
    location: l.location,
    property: [l.property_size, l.property_type].filter(Boolean).join(' ') || null,
    project: l.project_type,
    status_of_property: l.property_status,
    budget: l.budget,
    timeline: l.timeline_text,
    start_date: l.expected_start_date,
    requirements: l.requirements,
    site_visit: l.site_visit_requested,
    score: l.lead_score,
    temperature: l.lead_temperature,
    lead_status: l.lead_status,
    assigned: l.assigned_salesperson,
    needs_human: l.needs_human,
    ai_paused: l.ai_paused,
    opted_out: l.opted_out,
    missing: l.missing_information,
  };
  return Object.entries(pick)
    .map(([k, v]) => `  ${k.padEnd(18)} ${v === null || v === '' ? c.dim('—') : JSON.stringify(v)}`)
    .join('\n');
}

async function main() {
  let ctx = setup();
  let seq = 0;

  const send = async (text: string) => {
    seq++;
    await ingestWhatsAppMessage(ctx.deps, ctx.inbox, {
      phoneNumberId: 'DEMO-PNID',
      from: CUSTOMER,
      profileName: null,
      messageId: `local-${seq}`,
      timestamp: new Date().toISOString(),
      text,
      type: 'text',
    });
    const leadId = ctx.scheduled.at(-1)!;
    const t = Date.now();
    await processLead(ctx.deps, leadId);
    console.log(c.dim(`  (${((Date.now() - t) / 1000).toFixed(1)}s)`));
  };

  const scripted = process.argv.slice(2);
  if (scripted.length > 0) {
    for (const text of scripted) {
      console.log(`${c.cyan('You ›')} ${text}`);
      await send(text);
    }
    console.log(c.dim('\nLead record:'));
    console.log(leadSummary(ctx.repo));
    const errors = ctx.repo.errors;
    if (errors.length) console.log(c.yellow(`\nErrors: ${JSON.stringify(errors, null, 2)}`));
    return;
  }

  console.log(c.dim('Type as the customer. Commands: /lead  /history  /reset  /quit\n'));
  const rl = createInterface({ input: stdin, output: stdout });
  for (;;) {
    const line = (await rl.question(c.cyan('You › '))).trim();
    if (!line) continue;
    if (line === '/quit' || line === '/exit') break;
    if (line === '/lead') {
      console.log(leadSummary(ctx.repo));
      continue;
    }
    if (line === '/history') {
      for (const m of ctx.repo.messages) console.log(c.dim(`  ${m.sender_type.padEnd(8)} ${m.incoming_message ?? m.outgoing_message}`));
      continue;
    }
    if (line === '/reset') {
      ctx = setup();
      console.log(c.dim('Started a new conversation.'));
      continue;
    }
    await send(line);
  }
  rl.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
