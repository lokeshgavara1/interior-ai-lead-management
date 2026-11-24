/**
 * Live AI test plan (docs/TESTING_REPORT.md §4, L1–L8) against the REAL model in .env.
 * Each scenario plays a customer conversation through the real engine (in-memory
 * database, fake WhatsApp), prints the transcript, and checks the outcome.
 *
 *   npm run test:live              # all scenarios
 *   npm run test:live -- price     # only scenarios whose name contains "price"
 *   npm run test:live -- L6 X1     # several filters
 *
 * Exit code 1 if any required check fails. "info" checks are reported but never fail.
 */
import { askedItem } from '../ai/checklist.js';
import { hasBookingClaim, hasUnapprovedPrice } from '../ai/replyGuard.js';
import type { Lead } from '../domain/types.js';
import { FALLBACK_REPLY, HUMAN_HANDOFF_REPLY } from '../engine/conversation.js';
import { OPT_OUT_CONFIRMATION } from '../engine/optout.js';
import { color as c, createHarness, demoTenant, leadSummary, type Harness, type Turn } from './harness.js';

interface Check {
  name: string;
  ok: boolean;
  /** Informational: reported, never fails the run. */
  info?: boolean;
  detail?: string;
}

interface Scenario {
  id: string;
  name: string;
  messages: string[];
  checks: (ctx: { lead: Lead | undefined; turns: Turn[]; h: Harness }) => Check[];
}

const KB = demoTenant().knowledge_base;

function firstOfNextMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/** Checks every scenario gets. */
function common(turns: Turn[], lead: Lead | undefined): Check[] {
  const replies = turns.flatMap((t) => t.replies);
  const allCustomer = turns.map((t) => t.customer).join('\n');
  const priced = replies.filter((r) => hasUnapprovedPrice(r, `${KB}\n${allCustomer}`, lead?.budget != null ? [lead.budget] : []));
  const booked = replies.filter(hasBookingClaim);
  const multiQ = replies.filter((r) => (r.match(/\?/g) ?? []).length > 1);
  const fallbacks = replies.filter((r) => r === FALLBACK_REPLY).length;
  const avg = turns.reduce((s, t) => s + t.seconds, 0) / Math.max(1, turns.length);
  return [
    { name: 'No invented prices sent', ok: priced.length === 0, detail: priced[0] },
    { name: 'No booking claims sent', ok: booked.length === 0, detail: booked[0] },
    { name: 'At most one question per reply', ok: multiQ.length === 0, detail: multiQ[0] },
    { name: 'No AI failures (fallback replies)', ok: fallbacks === 0, detail: fallbacks ? `${fallbacks} fallback(s)` : undefined },
    { name: 'Average reply time under 15s', ok: avg < 15, detail: `${avg.toFixed(1)}s`, info: true },
  ];
}

const kinds = (h: Harness) => h.repo.notifications.map((n) => n.kind);
const count = (h: Harness, kind: string) => kinds(h).filter((k) => k === kind).length;

const SCENARIOS: Scenario[] = [
  {
    id: 'L1-L3',
    name: 'Full qualification (spec §4.3 sample conversation)',
    messages: [
      'Hi, I need interiors for my new 3BHK flat.',
      'Hyderabad, Kondapur.',
      'It is ready. I want to start next month.',
      'Around 8 lakhs.',
      'Full home - kitchen, wardrobes, living room',
      "I'm Rahul",
      'Yes please, can your designer visit this Saturday?',
    ],
    checks: ({ lead, h }) => [
      { name: 'Location = Kondapur', ok: /kondapur/i.test(lead?.location ?? ''), detail: String(lead?.location) },
      { name: 'Property ready', ok: lead?.property_status === 'ready', detail: String(lead?.property_status) },
      { name: `Start date = ${firstOfNextMonth()}`, ok: lead?.expected_start_date === firstOfNextMonth(), detail: String(lead?.expected_start_date) },
      { name: 'Budget = ₹8,00,000', ok: lead?.budget === 800000, detail: String(lead?.budget) },
      { name: 'Project = full home', ok: lead?.project_type === 'full_home', detail: String(lead?.project_type) },
      { name: 'Name = Rahul', ok: /rahul/i.test(lead?.customer_name ?? ''), detail: String(lead?.customer_name) },
      { name: 'Site visit requested', ok: lead?.site_visit_requested === true },
      { name: 'Hot lead, score ≥ 70', ok: lead?.lead_temperature === 'hot' && (lead?.lead_score ?? 0) >= 70, detail: `${lead?.lead_score} ${lead?.lead_temperature}` },
      { name: 'Status = qualified', ok: lead?.lead_status === 'qualified', detail: String(lead?.lead_status) },
      { name: 'Assigned to a salesperson', ok: !!lead?.assigned_salesperson, detail: String(lead?.assigned_salesperson) },
      { name: 'Hot-lead alert sent exactly once', ok: count(h, 'hot_lead') === 1, detail: `${count(h, 'hot_lead')}` },
      { name: 'Site-visit alert sent exactly once', ok: count(h, 'site_visit') === 1, detail: `${count(h, 'site_visit')}` },
      { name: 'Not escalated to a human', ok: lead?.needs_human === false },
    ],
  },
  {
    id: 'L4',
    name: 'Customer skips a question',
    messages: ['Hi, I need interiors for my 2BHK flat in Gachibowli', 'It is ready', 'Not sure about the budget yet'],
    checks: ({ lead, turns }) => {
      const last = turns.at(-1)?.replies.at(-1) ?? '';
      return [
        { name: 'Budget left empty (nothing invented)', ok: lead?.budget == null, detail: String(lead?.budget) },
        { name: 'Does not ask for the budget again', ok: askedItem(last) !== 'budget', detail: last },
        { name: 'Conversation continues with a question', ok: last.includes('?'), detail: last },
      ];
    },
  },
  {
    id: 'L5',
    name: 'Price question',
    messages: ['Hi, how much does a 2BHK full home interior cost?'],
    checks: ({ turns }) => {
      const r = turns[0]?.replies.join(' ') ?? '';
      return [{ name: 'Answers with the approved quotation policy', ok: /quotation/i.test(r), detail: r }];
    },
  },
  {
    id: 'L6',
    name: 'Multilingual (Hinglish) — informational',
    messages: ['Namaste, mujhe apne 2BHK flat ke liye interiors chahiye, Gachibowli mein'],
    checks: ({ lead, turns }) => [
      { name: 'Location captured (Gachibowli)', ok: /gachibowli/i.test(lead?.location ?? ''), info: true, detail: String(lead?.location) },
      { name: 'Replied (any language)', ok: (turns[0]?.replies.length ?? 0) > 0, detail: turns[0]?.replies[0] },
    ],
  },
  {
    id: 'L7',
    name: 'Customer asks for a human',
    messages: ['Hi, need a modular kitchen', 'I want to talk to a real person, not a bot'],
    checks: ({ lead, turns, h }) => [
      { name: 'Handoff reply sent', ok: turns.at(-1)?.replies.at(-1) === HUMAN_HANDOFF_REPLY, detail: turns.at(-1)?.replies.at(-1) },
      { name: 'AI paused for this lead', ok: lead?.ai_paused === true },
      { name: 'Team alerted ("needs a human")', ok: count(h, 'human_needed') >= 1 },
    ],
  },
  {
    id: 'L7b',
    name: 'AI stays silent after handoff',
    messages: ['Hi, need wardrobes', 'Can I speak with someone from your team?', 'Hello? Anyone there?'],
    checks: ({ turns }) => [{ name: 'No AI reply after the handoff', ok: (turns.at(-1)?.replies.length ?? 0) === 0, detail: turns.at(-1)?.replies[0] }],
  },
  {
    id: 'L8',
    name: 'Customer opts out',
    messages: ['Hi, looking for wardrobes', 'STOP'],
    checks: ({ lead, turns }) => [
      { name: 'Opt-out confirmed', ok: turns.at(-1)?.replies.at(-1) === OPT_OUT_CONFIRMATION },
      { name: 'Lead marked opted out', ok: lead?.opted_out === true },
      { name: 'No follow-up scheduled', ok: lead?.next_followup == null },
    ],
  },
  {
    id: 'X1',
    name: 'Customer tries to book a time directly',
    messages: ['Hi, 3BHK in Kondapur, ready, full home, budget 8 lakhs, start next month', 'Can your designer come tomorrow at 5pm?'],
    checks: ({ lead, turns }) => {
      const last = turns.at(-1)?.replies.join(' ') ?? '';
      return [
        { name: 'Site visit requested recorded', ok: lead?.site_visit_requested === true },
        { name: 'Says the team will confirm (no booking)', ok: /confirm|contact|call you/i.test(last), detail: last },
      ];
    },
  },
];

async function run() {
  const filters = process.argv.slice(2).map((f) => f.toLowerCase());
  const scenarios = SCENARIOS.filter((s) => filters.length === 0 || filters.some((f) => `${s.id} ${s.name}`.toLowerCase().includes(f)));
  const probe = createHarness();
  console.log(c.bold('\nLIVE AI TEST PLAN'));
  console.log(c.dim(`Model: ${probe.cfg.OPENAI_MODEL} @ ${probe.cfg.OPENAI_BASE_URL ?? 'api.openai.com'} | json=${probe.cfg.LLM_JSON_MODE} | grounding=${probe.cfg.LLM_FACT_GROUNDING}`));
  console.log(c.dim(`Started ${new Date().toLocaleString()} — ${scenarios.length} scenario(s)\n`));

  const summary: { id: string; name: string; passed: number; failed: number; info: number }[] = [];
  for (const s of scenarios) {
    console.log(c.bold(c.cyan(`━━━ ${s.id}  ${s.name} ━━━`)));
    const h = createHarness({ echo: true });
    const turns: Turn[] = [];
    for (const m of s.messages) turns.push(await h.send(m));
    const checks = [...s.checks({ lead: h.lead(), turns, h }), ...common(turns, h.lead())];
    console.log(c.dim('  Lead record:'));
    console.log(c.dim(leadSummary(h.lead())));
    console.log(c.dim('  Checks:'));
    for (const ch of checks) {
      const mark = ch.ok ? c.green('✅') : ch.info ? c.yellow('ℹ️ ') : c.red('❌');
      const detail = !ch.ok && ch.detail ? c.dim(`  → ${ch.detail.slice(0, 160)}`) : '';
      console.log(`   ${mark} ${ch.name}${ch.info && !ch.ok ? c.dim(' (info)') : ''}${detail}`);
    }
    summary.push({
      id: s.id,
      name: s.name,
      passed: checks.filter((x) => x.ok).length,
      failed: checks.filter((x) => !x.ok && !x.info).length,
      info: checks.filter((x) => !x.ok && x.info).length,
    });
    console.log();
  }

  console.log(c.bold('━━━ SUMMARY ━━━'));
  for (const r of summary) {
    const status = r.failed === 0 ? c.green('PASS') : c.red('FAIL');
    console.log(`  ${status}  ${r.id.padEnd(6)} ${r.name.padEnd(52)} ${r.passed} passed${r.failed ? c.red(`, ${r.failed} failed`) : ''}${r.info ? c.yellow(`, ${r.info} info`) : ''}`);
  }
  const failed = summary.reduce((s, r) => s + r.failed, 0);
  const total = summary.reduce((s, r) => s + r.passed + r.failed, 0);
  console.log(`\n  ${failed === 0 ? c.green('ALL REQUIRED CHECKS PASSED') : c.red(`${failed} REQUIRED CHECK(S) FAILED`)} — ${total - failed}/${total}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
