import type { Llm } from '../../src/ai/llm.js';
import type { AiTurn } from '../../src/ai/schema.js';
import type { LeadgenData, MetaGraph } from '../../src/channels/meta.js';
import type { SheetsApi } from '../../src/channels/sheets.js';
import type { WhatsAppSender } from '../../src/channels/whatsapp.js';
import { MemoryRepo } from '../../src/db/memoryRepo.js';
import type { Tenant } from '../../src/domain/types.js';
import type { EngineDeps } from '../../src/engine/deps.js';
import { createNotifier } from '../../src/notify/notifier.js';

export { MemoryRepo };

export const NOW = new Date('2026-11-23T06:00:00Z');

export function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'tenant-1',
    slug: 'demo',
    name: 'Demo Interiors',
    whatsapp_phone_number_id: 'PNID-1',
    facebook_page_id: 'PAGE-1',
    instagram_account_id: 'IG-1',
    website_webhook_secret: 'secret',
    timezone: 'Asia/Kolkata',
    default_country_code: '91',
    knowledge_base: 'We do full home interiors in Hyderabad.',
    settings: { sales_whatsapp_numbers: ['+919000000000'], high_value_budget: 1_500_000 },
    ...overrides,
  };
}


export class FakeWhatsApp implements WhatsAppSender {
  sent: { to: string; body: string }[] = [];
  templates: { to: string; template: string; params: string[] }[] = [];
  failNext = false;
  async sendText(_pnid: string, to: string, body: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('WhatsApp API down');
    }
    this.sent.push({ to, body });
    return `wamid.out.${this.sent.length}`;
  }
  async sendTemplate(_pnid: string, to: string, template: string, _lang: string, params: string[]) {
    this.templates.push({ to, template, params });
    return `wamid.tpl.${this.templates.length}`;
  }
}

export function aiTurn(overrides: Partial<AiTurn> = {}): AiTurn {
  return {
    reply: 'Thanks! Which location is your property in?',
    intent: 'provide_info',
    customer_name: null,
    phone_number: null,
    email: null,
    location: null,
    property_type: null,
    property_size: null,
    project_type: null,
    budget: null,
    property_status: null,
    timeline_text: null,
    expected_start_date: null,
    requirements: null,
    site_visit_requested: false,
    needs_human: false,
    human_reason: null,
    missing_information: [],
    ...overrides,
  };
}

export class FakeLlm implements Llm {
  calls: { system: string; messages: { role: string; content: string }[] }[] = [];
  queue: (AiTurn | Error)[] = [];
  async receptionistTurn(system: string, messages: { role: 'user' | 'assistant'; content: string }[]) {
    this.calls.push({ system, messages });
    const next = this.queue.shift() ?? aiTurn();
    if (next instanceof Error) throw next;
    return next;
  }
  async generateText() {
    return 'Hi! Just checking in — when are you planning to start the interiors?';
  }
}

export class FakeMeta implements MetaGraph {
  igSent: { to: string; text: string }[] = [];
  leads: Record<string, LeadgenData> = {};
  async sendInstagramText(_token: string, to: string, text: string) {
    this.igSent.push({ to, text });
    return `mid.out.${this.igSent.length}`;
  }
  async fetchLeadgen(_token: string, id: string) {
    const l = this.leads[id];
    if (!l) throw new Error(`leadgen ${id} not found`);
    return l;
  }
}

/** In-memory spreadsheet: one grid per "spreadsheetId!tab". */
export class FakeSheets implements SheetsApi {
  grid: string[][] = [];
  dropdowns: { col: number; options: string[] }[] = [];
  async ensureTab() {
    return 7;
  }
  async getValues(_id: string, range: string) {
    const start = Number(range.match(/!A(\d+)/)?.[1] ?? 1) - 1;
    return this.grid.slice(start).map((r) => [...r]);
  }
  async updateValues(_id: string, _range: string, values: (string | number)[][]) {
    values.forEach((row, i) => (this.grid[i] = row.map(String)));
  }
  async clearValues(_id: string, range: string) {
    const start = Number(range.match(/!A(\d+)/)?.[1] ?? 1) - 1;
    this.grid.length = Math.min(this.grid.length, start);
  }
  async setDropdown(_id: string, _sheetId: number, col: number, options: string[]) {
    this.dropdowns.push({ col, options });
  }
  async freezeHeader() {}
}

export function makeDeps() {
  const repo = new MemoryRepo();
  repo.tenants.push(makeTenant());
  const wa = new FakeWhatsApp();
  const meta = new FakeMeta();
  const llm = new FakeLlm();
  const silent = { info() {}, warn() {}, error() {} };
  const notifier = createNotifier(repo, wa, { port: 587 });
  let now = NOW;
  const deps: EngineDeps = { repo, llm, wa, meta, notifier, log: silent, now: () => now, historyLimit: 20 };
  const setNow = (d: Date) => (now = d);
  return { deps, repo, wa, meta, llm, setNow };
}
