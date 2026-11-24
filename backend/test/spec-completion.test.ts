/**
 * Tests for: salesperson assignment (§7 WF02), §8.1 alerts (ready to proceed, overdue
 * follow-ups), Instagram DMs (§3.3), Facebook Lead Ads (§3.4), Google Sheets CRM (§15).
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseInstagramWebhook, parseLeadgenWebhook } from '../src/channels/meta.js';
import { processLead } from '../src/engine/conversation.js';
import type { Inbox } from '../src/engine/inbox.js';
import { ingestInstagramMessage, ingestLeadgen, ingestWhatsAppMessage, mapLeadgenFields } from '../src/engine/ingest.js';
import { pickSalesperson } from '../src/engine/sales.js';
import { runOverdueCheck } from '../src/jobs/overdue.js';
import { columnLetter, COLUMNS, parseEdit, syncTenantSheet } from '../src/jobs/sheetSync.js';
import { parseBudgetInr, toEnum } from '../src/lib/parse.js';
import { formatLocalDateTime, parseLocalDateTime } from '../src/lib/time.js';
import { buildServer } from '../src/server.js';
import { PROPERTY_TYPES } from '../src/domain/types.js';
import { aiTurn, FakeSheets, makeDeps, makeTenant, NOW } from './support/fakes.js';

const SALES = [
  { name: 'Priya', whatsapp: '+919111111111' },
  { name: 'Arjun', whatsapp: '+919222222222' },
];

let seq = 0;
function setup() {
  const ctx = makeDeps();
  ctx.repo.tenants[0]!.settings = { ...ctx.repo.tenants[0]!.settings, salespeople: SALES, contact_sla_hours: 4 };
  const scheduled: string[] = [];
  const inbox = { schedule: (id: string) => scheduled.push(id) } as unknown as Inbox;
  const receiveWa = async (text: string, from = '919876543210') => {
    seq++;
    await ingestWhatsAppMessage(ctx.deps, inbox, {
      phoneNumberId: 'PNID-1',
      from,
      profileName: null,
      messageId: `wamid.${seq}`,
      timestamp: new Date(NOW.getTime() - 60_000 + seq).toISOString(),
      text,
      type: 'text',
    });
    const id = scheduled.at(-1)!;
    await processLead(ctx.deps, id);
    return ctx.repo.leads.find((l) => l.lead_id === id)!;
  };
  const receiveIg = async (text: string, sender = 'IGSID-1') => {
    seq++;
    await ingestInstagramMessage(ctx.deps, inbox, {
      igAccountId: 'IG-1',
      senderId: sender,
      messageId: `mid.${seq}`,
      timestamp: new Date(NOW.getTime() - 60_000 + seq).toISOString(),
      text,
    });
    const id = scheduled.at(-1)!;
    await processLead(ctx.deps, id);
    return ctx.repo.leads.find((l) => l.lead_id === id)!;
  };
  return { ...ctx, inbox, scheduled, receiveWa, receiveIg };
}

const HOT = aiTurn({
  budget: 800000,
  property_status: 'ready',
  expected_start_date: '2026-12-01',
  project_type: 'full_home',
  location: 'Kondapur',
  property_type: 'apartment',
  timeline_text: 'next month',
});

// ---------------------------------------------------------------------------
describe('salesperson assignment (§7 Workflow 02)', () => {
  it('picks the least-loaded active salesperson', () => {
    expect(pickSalesperson(SALES, {})?.name).toBe('Priya');
    expect(pickSalesperson(SALES, { Priya: 3, Arjun: 1 })?.name).toBe('Arjun');
    expect(pickSalesperson([{ name: 'Priya', active: false }, { name: 'Arjun' }], {})?.name).toBe('Arjun');
    expect(pickSalesperson([], {})).toBeNull();
    expect(pickSalesperson(undefined, {})).toBeNull();
  });

  it('assigns a hot lead, sets a contact deadline, and alerts the assigned salesperson', async () => {
    const { repo, wa, llm, receiveWa } = setup();
    llm.queue.push(HOT);
    const lead = await receiveWa('Ready flat, full home, 8L, next month, Kondapur');
    expect(lead.assigned_salesperson).toBe('Priya');
    expect(lead.contact_due_at).toBe('2026-11-23T10:00:00.000Z'); // NOW + 4h
    const toPriya = wa.sent.filter((s) => s.to === '+919111111111');
    expect(toPriya).toHaveLength(1);
    expect(toPriya[0]!.body).toContain('Assigned To: Priya');
    expect(repo.audits.some((a) => a.action === 'lead_assigned')).toBe(true);
  });

  it('balances load across salespeople', async () => {
    const { llm, receiveWa } = setup();
    llm.queue.push(HOT);
    const a = await receiveWa('hot lead one', '919800000001');
    llm.queue.push(HOT);
    const b = await receiveWa('hot lead two', '919800000002');
    expect([a.assigned_salesperson, b.assigned_salesperson]).toEqual(['Priya', 'Arjun']);
  });

  it('does not assign leads that do not need sales attention yet', async () => {
    const { llm, receiveWa } = setup();
    llm.queue.push(aiTurn({ location: 'Kondapur' }));
    const lead = await receiveWa('Kondapur');
    expect(lead.assigned_salesperson).toBeNull();
    expect(lead.contact_due_at).toBeNull();
  });

  it('alerts when the customer is ready to proceed (§8.1)', async () => {
    const { repo, llm, receiveWa } = setup();
    llm.queue.push(aiTurn({ intent: 'ready_to_proceed' }));
    const lead = await receiveWa("Let's go ahead with the project");
    expect(repo.notifications.map((n) => n.kind)).toContain('ready_to_proceed');
    expect(lead.assigned_salesperson).toBe('Priya');
  });

  it("customer messages don't wipe a salesperson's own follow-up date", async () => {
    const { repo, llm, receiveWa } = setup();
    llm.queue.push(aiTurn({ location: 'Kondapur' }));
    const lead = await receiveWa('Kondapur');
    await repo.updateLead(lead.lead_id, { lead_status: 'quotation_sent', next_followup: '2026-11-30T05:00:00.000Z' });
    llm.queue.push(aiTurn());
    const after = await receiveWa('Any update on the quote?');
    expect(after.lead_status).toBe('quotation_sent');
    expect(after.next_followup).toBe('2026-11-30T05:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
describe('overdue follow-up alerts (§8.1)', () => {
  it('alerts once when a lead is not contacted by its deadline', async () => {
    const { deps, repo, llm, receiveWa, setNow } = setup();
    llm.queue.push(HOT);
    await receiveWa('hot lead');
    setNow(new Date('2026-11-23T11:00:00Z')); // past the 10:00 deadline
    await runOverdueCheck(deps);
    await runOverdueCheck(deps);
    const overdue = repo.notifications.filter((n) => n.kind === 'followup_overdue');
    expect(overdue).toHaveLength(1);
    expect(String(overdue[0]!.payload.text)).toContain('Not contacted yet');
  });

  it('stays quiet once the lead is marked contacted', async () => {
    const { deps, repo, llm, receiveWa, setNow } = setup();
    llm.queue.push(HOT);
    const lead = await receiveWa('hot lead');
    await repo.updateLead(lead.lead_id, { lead_status: 'contacted' });
    setNow(new Date('2026-11-23T11:00:00Z'));
    await runOverdueCheck(deps);
    expect(repo.notifications.filter((n) => n.kind === 'followup_overdue')).toHaveLength(0);
  });

  it("alerts when a salesperson's follow-up date passes", async () => {
    const { deps, repo, llm, receiveWa } = setup();
    llm.queue.push(aiTurn());
    const lead = await receiveWa('hi');
    await repo.updateLead(lead.lead_id, { lead_status: 'negotiation', next_followup: '2026-11-22T05:00:00.000Z', assigned_salesperson: 'Arjun' });
    await runOverdueCheck(deps);
    const n = repo.notifications.find((x) => x.kind === 'followup_overdue');
    expect(n?.dedupe_key).toBe(`overdue_followup:${lead.lead_id}:2026-11-22T05:00:00.000Z`);
  });
});

// ---------------------------------------------------------------------------
describe('Instagram DMs (§3.3)', () => {
  const webhook = {
    object: 'instagram',
    entry: [
      {
        id: 'IG-1',
        messaging: [
          { sender: { id: 'IGSID-1' }, recipient: { id: 'IG-1' }, timestamp: 1763877600000, message: { mid: 'm1', text: 'Hi, need wardrobe' } },
          { sender: { id: 'IG-1' }, recipient: { id: 'IGSID-1' }, timestamp: 1763877601000, message: { mid: 'm2', text: 'echo', is_echo: true } },
          { sender: { id: 'IGSID-1' }, recipient: { id: 'IG-1' }, timestamp: 1763877602000, message: { mid: 'm3', attachments: [{ type: 'image' }] } },
          { sender: { id: 'IGSID-1' }, recipient: { id: 'IG-1' }, timestamp: 1763877603000, read: { mid: 'm1' } },
        ],
      },
    ],
  };

  it('parses messages and skips echoes / read receipts', () => {
    const msgs = parseInstagramWebhook(webhook);
    expect(msgs.map((m) => m.text)).toEqual(['Hi, need wardrobe', '[Customer sent an image]']);
    expect(msgs[0]).toMatchObject({ igAccountId: 'IG-1', senderId: 'IGSID-1', messageId: 'm1' });
  });

  it('creates a lead without a phone, replies on Instagram, and tells the AI to ask for a phone', async () => {
    const { repo, wa, meta, llm, receiveIg } = setup();
    llm.queue.push(aiTurn({ project_type: 'wardrobe', reply: 'Sure! Which area is your home in?' }));
    const lead = await receiveIg('Hi, need wardrobe');
    expect(lead.instagram_id).toBe('IGSID-1');
    expect(lead.phone_number).toBeNull();
    expect(lead.lead_source).toBe('instagram');
    expect(lead.last_customer_channel).toBe('instagram');
    expect(meta.igSent).toEqual([{ to: 'IGSID-1', text: 'Sure! Which area is your home in?' }]);
    expect(wa.sent).toHaveLength(0);
    expect(llm.calls[0]!.system).toContain('Instagram Direct Messages');
    expect(repo.messages.find((m) => m.sender_type === 'customer')?.channel).toBe('instagram');
  });

  it('saves a phone number the customer types in the chat', async () => {
    const { llm, receiveIg } = setup();
    llm.queue.push(aiTurn({ phone_number: '98765 43210' }));
    const lead = await receiveIg('my number is 98765 43210');
    expect(lead.phone_number).toBe('+919876543210');
  });

  it('flags (not merges) a phone that belongs to another lead', async () => {
    const { repo, llm, receiveWa, receiveIg } = setup();
    llm.queue.push(aiTurn());
    const waLead = await receiveWa('hi');
    llm.queue.push(aiTurn({ phone_number: '9876543210' }));
    const igLead = await receiveIg('call me on 9876543210');
    expect(igLead.phone_number).toBeNull();
    expect(igLead.notes).toContain(waLead.lead_id);
    expect(repo.audits.some((a) => a.action === 'duplicate_suspected')).toBe(true);
  });

  it('logs an error if the page token is missing', async () => {
    const { repo, llm, receiveIg } = setup();
    delete repo.pageTokens['tenant-1'];
    llm.queue.push(aiTurn());
    await receiveIg('hi');
    expect(repo.errors.some((e) => e.message.includes('page access token'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Facebook Lead Ads (§3.4)', () => {
  const event = {
    object: 'page',
    entry: [{ id: 'PAGE-1', changes: [{ field: 'leadgen', value: { leadgen_id: 'LG-1', page_id: 'PAGE-1', form_id: 'F-1' } }] }],
  };
  const leadData = {
    created_time: '2026-11-23T05:00:00+0000',
    field_data: [
      { name: 'full_name', values: ['Rahul Kumar'] },
      { name: 'phone_number', values: ['+919876543210'] },
      { name: 'email', values: ['rahul@example.com'] },
      { name: 'city', values: ['Hyderabad'] },
      { name: 'what_type_of_property?', values: ['Flat'] },
      { name: 'your_budget', values: ['8-10 lakhs'] },
      { name: 'preferred_call_time', values: ['Evening'] },
    ],
  };
  const fieldMap = { 'what_type_of_property?': 'property_type', your_budget: 'budget' };

  it('parses leadgen webhooks', () => {
    expect(parseLeadgenWebhook(event)).toEqual([{ pageId: 'PAGE-1', leadgenId: 'LG-1', formId: 'F-1' }]);
    expect(parseLeadgenWebhook({ object: 'instagram' })).toEqual([]);
  });

  it('maps standard + custom questions, keeping unmapped answers as notes', () => {
    const { phone, facts, note } = mapLeadgenFields(leadData, fieldMap);
    expect(phone).toBe('+919876543210');
    expect(facts).toMatchObject({ customer_name: 'Rahul Kumar', email: 'rahul@example.com', location: 'Hyderabad', property_type: 'apartment', budget: 900000 });
    expect(note).toBe('Lead form answers — preferred call time: Evening');
  });

  it('creates the lead, alerts sales, sends the consented ack template, and is idempotent', async () => {
    const { deps, repo, wa, meta } = setup();
    repo.tenants[0]!.settings = { ...repo.tenants[0]!.settings, lead_ads_field_map: fieldMap, lead_ads_whatsapp_ack: true, ack_template_name: 'enquiry_received' };
    meta.leads['LG-1'] = leadData;
    await ingestLeadgen(deps, { pageId: 'PAGE-1', leadgenId: 'LG-1', formId: 'F-1' });
    await ingestLeadgen(deps, { pageId: 'PAGE-1', leadgenId: 'LG-1', formId: 'F-1' });
    expect(repo.leads).toHaveLength(1);
    const lead = repo.leads[0]!;
    expect(lead.lead_source).toBe('facebook');
    expect(lead.budget).toBe(900000);
    expect(lead.assigned_salesperson).toBe('Priya');
    expect(lead.notes).toContain('preferred call time');
    expect(repo.notifications.filter((n) => n.kind === 'new_lead')).toHaveLength(1);
    expect(wa.templates).toEqual([{ to: '+919876543210', template: 'enquiry_received', params: ['Rahul Kumar'] }]);
  });

  it('ignores leads for unknown pages', async () => {
    const { deps, repo } = setup();
    await ingestLeadgen(deps, { pageId: 'OTHER', leadgenId: 'LG-9', formId: null });
    expect(repo.leads).toHaveLength(0);
  });

  it('routes signed page and instagram webhooks through /webhooks/meta', async () => {
    const { deps, repo, meta } = setup();
    const scheduled: string[] = [];
    const app = buildServer({ deps, inbox: { schedule: (id: string) => scheduled.push(id) } as unknown as Inbox, metaAppSecret: 's', metaVerifyToken: 'v' });
    meta.leads['LG-1'] = leadData;
    const post = (body: unknown) => {
      const raw = JSON.stringify(body);
      return app.inject({
        method: 'POST',
        url: '/webhooks/meta',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 's').update(raw).digest('hex') },
        payload: raw,
      });
    };
    expect((await post(event)).statusCode).toBe(200);
    expect(repo.leads.some((l) => l.lead_source === 'facebook')).toBe(true);
    expect((await post({ object: 'instagram', entry: [{ id: 'IG-1', messaging: [{ sender: { id: 'X' }, timestamp: 1, message: { mid: 'q', text: 'hi' } }] }] })).statusCode).toBe(200);
    expect(scheduled).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('parsing helpers', () => {
  it.each([
    ['8 lakhs', 800000],
    ['₹8,00,000', 800000],
    ['Rs. 800000', 800000],
    ['10-15 lakhs', 1250000],
    ['10 to 15 lakh', 1250000],
    ['1.2 cr', 12000000],
    ['50k', 50000],
    ['not sure', null],
  ])('parseBudgetInr(%s) = %s', (text, expected) => expect(parseBudgetInr(text)).toBe(expected));

  it('toEnum', () => {
    expect(toEnum('Independent House', PROPERTY_TYPES)).toBe('independent_house');
    expect(toEnum('3BHK Flat', PROPERTY_TYPES, { flat: 'apartment' })).toBe('apartment');
    expect(toEnum('castle', PROPERTY_TYPES)).toBeNull();
  });

  it('local time round-trip in IST', () => {
    expect(formatLocalDateTime('2026-11-23T06:00:00Z', 'Asia/Kolkata')).toBe('2026-11-23 11:30');
    expect(parseLocalDateTime('2026-11-23 11:30', 'Asia/Kolkata')).toBe('2026-11-23T06:00:00.000Z');
    expect(parseLocalDateTime('2026-11-25', 'Asia/Kolkata')).toBe('2026-11-25T04:30:00.000Z'); // 10:00 IST
    expect(parseLocalDateTime('tomorrow', 'Asia/Kolkata')).toBeNull();
    expect(parseLocalDateTime('2026-13-01', 'Asia/Kolkata')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('Google Sheets CRM (§15)', () => {
  const sheetTenant = () => makeTenant({ settings: { google_sheet_id: 'SHEET-1' } });
  const col = (editable: string) => COLUMNS.findIndex((c) => c.editable === editable);

  async function seeded() {
    const ctx = setup();
    ctx.repo.tenants[0] = { ...sheetTenant(), settings: { ...sheetTenant().settings, salespeople: SALES } };
    ctx.llm.queue.push(aiTurn({ location: 'Kondapur' }));
    const lead = await ctx.receiveWa('Kondapur');
    const sheets = new FakeSheets();
    await syncTenantSheet(ctx.deps, sheets, ctx.repo.tenants[0]!);
    return { ...ctx, lead, sheets };
  }

  it('column letters', () => {
    expect([columnLetter(1), columnLetter(26), columnLetter(27), columnLetter(COLUMNS.length)]).toEqual(['A', 'Z', 'AA', 'AA']);
  });

  it('pushes a header + one row per lead, with dropdowns on editable columns', async () => {
    const { sheets, lead } = await seeded();
    expect(sheets.grid[0]![0]).toBe('Lead ID');
    expect(sheets.grid).toHaveLength(2);
    expect(sheets.grid[1]![0]).toBe(lead.lead_id);
    expect(sheets.grid[1]![col('lead_status')]).toBe('information_pending');
    expect(sheets.dropdowns.map((d) => d.col)).toEqual([col('lead_status'), col('ai_paused')]);
  });

  it('applies human edits (status, follow-up date, notes) and audits them', async () => {
    const { deps, repo, sheets, lead } = await seeded();
    const row = sheets.grid[1]!;
    row[col('lead_status')] = 'Site Visit Scheduled';
    row[col('next_followup')] = '2026-11-25 16:00';
    row[col('notes')] = 'Visit booked Tue 4pm';
    const res = await syncTenantSheet(deps, sheets, repo.tenants[0]!);
    expect(res.applied).toBe(1);
    const updated = (await repo.getLead(lead.lead_id))!;
    expect(updated.lead_status).toBe('site_visit_scheduled');
    expect(updated.next_followup).toBe('2026-11-25T10:30:00.000Z');
    expect(updated.notes).toBe('Visit booked Tue 4pm');
    expect(repo.audits.some((a) => a.action === 'lead_edited')).toBe(true);
    expect(sheets.grid[1]![col('lead_status')]).toBe('site_visit_scheduled'); // normalised on push
  });

  it('un-pausing the AI from the sheet clears needs_human', async () => {
    const { deps, repo, sheets, lead } = await seeded();
    await repo.updateLead(lead.lead_id, { ai_paused: true, needs_human: true });
    await syncTenantSheet(deps, sheets, repo.tenants[0]!); // push TRUE
    sheets.grid[1]![col('ai_paused')] = 'FALSE';
    await syncTenantSheet(deps, sheets, repo.tenants[0]!);
    const updated = (await repo.getLead(lead.lead_id))!;
    expect(updated.ai_paused).toBe(false);
    expect(updated.needs_human).toBe(false);
  });

  it('rejects invalid edits, logs them, and restores the database value', async () => {
    const { deps, repo, sheets, lead } = await seeded();
    sheets.grid[1]![col('lead_status')] = 'maybe later';
    const res = await syncTenantSheet(deps, sheets, repo.tenants[0]!);
    expect(res.applied).toBe(0);
    expect(repo.errors.some((e) => e.operation === 'sheet_edit')).toBe(true);
    expect((await repo.getLead(lead.lead_id))!.lead_status).toBe('information_pending');
    expect(sheets.grid[1]![col('lead_status')]).toBe('information_pending');
  });

  it('does not overwrite system changes with stale sheet values', async () => {
    const { deps, repo, sheets, lead } = await seeded();
    // The AI qualifies the lead between syncs; the untouched sheet cell must not revert it.
    await repo.updateLead(lead.lead_id, { lead_status: 'qualified' });
    await syncTenantSheet(deps, sheets, repo.tenants[0]!);
    expect((await repo.getLead(lead.lead_id))!.lead_status).toBe('qualified');
  });

  it('parseEdit validation', () => {
    const t = sheetTenant();
    expect(parseEdit('ai_paused', 'maybe', t)).toHaveProperty('error');
    expect(parseEdit('next_followup', '', t)).toEqual({ patch: { next_followup: null } });
    expect(parseEdit('assigned_salesperson', '', t)).toEqual({ patch: { assigned_salesperson: null, assigned_at: null } });
  });
});
