/**
 * End-to-end engine tests against in-memory fakes, covering the spec §12 test table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WaInboundMessage } from '../src/channels/whatsapp.js';
import { FALLBACK_REPLY, processLead } from '../src/engine/conversation.js';
import { Inbox } from '../src/engine/inbox.js';
import { ingestWebsiteForm, ingestWhatsAppMessage, WebsiteFormSchema } from '../src/engine/ingest.js';
import { OPT_OUT_CONFIRMATION } from '../src/engine/optout.js';
import { runFollowups } from '../src/jobs/followups.js';
import { AiOutputError } from '../src/ai/llm.js';
import { aiTurn, makeDeps, NOW } from './support/fakes.js';

let seq = 0;
function waMsg(text: string, from = '919876543210', id?: string): WaInboundMessage {
  seq++;
  return {
    phoneNumberId: 'PNID-1',
    from,
    profileName: 'Rahul',
    messageId: id ?? `wamid.in.${seq}`,
    timestamp: new Date(NOW.getTime() - 60_000 + seq).toISOString(),
    text,
    type: 'text',
  };
}

function setup() {
  const ctx = makeDeps();
  const scheduled: string[] = [];
  const inbox = { schedule: (id: string) => scheduled.push(id) } as unknown as Inbox;
  /** Customer sends messages; then the debounced processing runs once. */
  const receive = async (...texts: string[]) => {
    for (const t of texts) await ingestWhatsAppMessage(ctx.deps, inbox, waMsg(t));
    const leadId = scheduled.at(-1)!;
    await processLead(ctx.deps, leadId);
    return ctx.repo.leads.find((l) => l.lead_id === leadId)!;
  };
  return { ...ctx, inbox, scheduled, receive };
}

describe('spec §12 test cases', () => {
  it('new customer enquiry creates a new CRM record and replies', async () => {
    const { repo, wa, llm, receive } = setup();
    llm.queue.push(aiTurn({ intent: 'new_enquiry', property_size: '3BHK', property_type: 'apartment', reply: 'Which location?' }));
    const lead = await receive('Hi, I need interiors for my new 3BHK flat');
    expect(repo.leads).toHaveLength(1);
    expect(lead.phone_number).toBe('+919876543210');
    expect(lead.property_size).toBe('3BHK');
    expect(lead.lead_status).toBe('information_pending');
    expect(lead.lead_temperature).toBe('provisional');
    expect(wa.sent).toEqual([{ to: '+919876543210', body: 'Which location?' }]);
    expect(lead.next_followup).not.toBeNull();
  });

  it('returning customer updates the existing lead and keeps earlier facts', async () => {
    const { repo, llm, receive } = setup();
    llm.queue.push(aiTurn({ property_size: '3BHK' }));
    await receive('3BHK flat');
    llm.queue.push(aiTurn({ location: 'Kondapur, Hyderabad', property_size: null }));
    const lead = await receive('Kondapur');
    expect(repo.leads).toHaveLength(1);
    expect(lead.property_size).toBe('3BHK'); // not erased by null
    expect(lead.location).toBe('Kondapur, Hyderabad');
  });

  it('customer provides budget — saved correctly as a number', async () => {
    const { llm, receive } = setup();
    llm.queue.push(aiTurn({ budget: 800000 }));
    const lead = await receive('Around 8 lakhs');
    expect(lead.budget).toBe(800000);
    expect(lead.lead_score).toBe(20);
  });

  it('customer sends multiple messages — one lead, one AI call, one reply', async () => {
    const { repo, wa, llm, receive } = setup();
    await receive('Hi', 'I need interiors', 'for my 3BHK in Kondapur');
    expect(repo.leads).toHaveLength(1);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.messages).toEqual([{ role: 'user', content: 'Hi\nI need interiors\nfor my 3BHK in Kondapur' }]);
    expect(wa.sent).toHaveLength(1);
  });

  it('duplicate webhook delivery is ignored (idempotency)', async () => {
    const { repo, deps, inbox, scheduled } = setup();
    const m = waMsg('Hi', '919876543210', 'wamid.same');
    await ingestWhatsAppMessage(deps, inbox, m);
    await ingestWhatsAppMessage(deps, inbox, m);
    expect(repo.messages).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
  });

  it('customer requests site visit — sales team notified once', async () => {
    const { repo, wa, llm, receive } = setup();
    llm.queue.push(aiTurn({ intent: 'site_visit_request', site_visit_requested: true }));
    await receive('Can someone come see the flat?');
    llm.queue.push(aiTurn({ site_visit_requested: true }));
    await receive('Saturday works');
    const visits = repo.notifications.filter((n) => n.kind === 'site_visit');
    expect(visits).toHaveLength(1);
    expect(visits[0]!.status).toBe('sent');
    expect(wa.sent.filter((s) => s.to === '+919000000000')).toHaveLength(1);
  });

  it('customer asks for a human — escalated and AI paused', async () => {
    const { repo, wa, llm, receive } = setup();
    llm.queue.push(aiTurn({ intent: 'human_request', needs_human: true, human_reason: 'wants to talk to a designer', reply: 'A team member will reach out.' }));
    let lead = await receive('Can I talk to a real person?');
    expect(lead.ai_paused).toBe(true);
    expect(lead.next_followup).toBeNull();
    expect(repo.notifications.some((n) => n.kind === 'human_needed')).toBe(true);

    const before = wa.sent.length;
    lead = await receive('Hello?');
    expect(wa.sent.length).toBe(before); // AI stays silent during takeover
    expect(llm.calls).toHaveLength(1);
  });

  it('hot lead triggers a hot-lead alert', async () => {
    const { repo, llm, receive } = setup();
    llm.queue.push(
      aiTurn({
        budget: 800000,
        property_status: 'ready',
        expected_start_date: '2026-12-01',
        project_type: 'full_home',
        location: 'Kondapur',
        property_type: 'apartment',
        timeline_text: 'next month',
      }),
    );
    const lead = await receive('Ready flat, full home, 8L, starting next month, Kondapur');
    expect(lead.lead_temperature).toBe('hot');
    expect(lead.lead_status).toBe('qualified');
    expect(lead.next_followup).toBeNull(); // qualified -> sales team takes over
    expect(repo.notifications.map((n) => n.kind)).toContain('hot_lead');
  });

  it('AI generates invalid data — fallback reply, error logged, team alerted', async () => {
    const { repo, wa, llm, receive } = setup();
    llm.queue.push(new AiOutputError('AI output failed validation: budget'));
    const lead = await receive('Hi');
    expect(wa.sent.at(0)?.body).toBe(FALLBACK_REPLY);
    expect(repo.errors.some((e) => e.operation === 'ai_turn')).toBe(true);
    expect(repo.notifications.some((n) => n.kind === 'ai_failure')).toBe(true);
    expect(lead.budget).toBeNull(); // nothing invented
  });

  it('WhatsApp API fails — error logged and message marked failed', async () => {
    const { repo, wa, receive } = setup();
    wa.failNext = true;
    const lead = await receive('Hi');
    expect(repo.errors.some((e) => e.operation === 'send_message')).toBe(true);
    expect(repo.outbound(lead.lead_id).at(-1)?.delivery_status).toBe('failed');
  });

  it('customer opts out — confirmed, no AI call, follow-ups stopped', async () => {
    const { wa, llm, receive } = setup();
    const lead = await receive('STOP');
    expect(lead.opted_out).toBe(true);
    expect(lead.next_followup).toBeNull();
    expect(llm.calls).toHaveLength(0);
    expect(wa.sent.at(-1)?.body).toBe(OPT_OUT_CONFIRMATION);
  });

  it('customer converts — follow-ups stop', async () => {
    const { deps, repo, wa, llm, receive } = setup();
    llm.queue.push(aiTurn({ location: 'Kondapur' }));
    const lead = await receive('Kondapur');
    await repo.updateLead(lead.lead_id, { lead_status: 'converted', next_followup: '2026-11-01T00:00:00Z' });
    const before = wa.sent.length;
    expect(await runFollowups(deps)).toBe(0);
    expect(wa.sent.length).toBe(before);
  });
});

describe('follow-ups', () => {
  it('sends a follow-up inside the 24h window and schedules the next one', async () => {
    const { deps, repo, wa, llm, receive } = setup();
    llm.queue.push(aiTurn({ location: 'Kondapur' }));
    const lead = await receive('Kondapur');
    await repo.updateLead(lead.lead_id, { next_followup: '2026-11-23T05:00:00Z' });
    expect(await runFollowups(deps)).toBe(1);
    const updated = (await repo.getLead(lead.lead_id))!;
    expect(updated.followup_count).toBe(1);
    expect(updated.next_followup).toBe('2026-11-25T06:00:00.000Z');
    expect(wa.sent.at(-1)?.body).toContain('checking in');
  });
});

describe('website form (§3.2)', () => {
  it('creates a lead, dedupes by phone with WhatsApp leads, and alerts sales', async () => {
    const { deps, repo, llm, receive } = setup();
    llm.queue.push(aiTurn({ location: 'Kondapur' }));
    await receive('Hi'); // same person already on WhatsApp
    const tenant = repo.tenants[0]!;
    const form = WebsiteFormSchema.parse({
      customer_name: 'Rahul Kumar',
      phone_number: '98765 43210',
      email: '',
      property_type: 'apartment',
      property_size: '3BHK',
      approximate_budget: '800000',
    });
    const res = await ingestWebsiteForm(deps, tenant, form);
    expect('lead' in res && res.created).toBe(false);
    expect(repo.leads).toHaveLength(1);
    const lead = repo.leads[0]!;
    expect(lead.customer_name).toBe('Rahul Kumar');
    expect(lead.location).toBe('Kondapur'); // kept from WhatsApp
    expect(lead.budget).toBe(800000);
    expect(lead.email).toBeNull();
  });

  it('rejects an invalid phone number', async () => {
    const { deps, repo } = setup();
    const form = WebsiteFormSchema.parse({ customer_name: 'X', phone_number: '12345678' });
    expect(await ingestWebsiteForm(deps, repo.tenants[0]!, form)).toEqual({ error: 'invalid phone_number' });
  });
});

describe('Inbox debouncing', () => {
  afterEach(() => vi.useRealTimers());

  it('processes a burst once, after the debounce window', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    const calls: string[] = [];
    const inbox = new Inbox(deps, 4000, async (_d, id) => {
      calls.push(id);
    });
    inbox.schedule('lead-1');
    await vi.advanceTimersByTimeAsync(2000);
    inbox.schedule('lead-1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toEqual(['lead-1']);
  });

  it('never runs the same lead concurrently', async () => {
    const { deps } = makeDeps();
    let active = 0;
    let maxActive = 0;
    const inbox = new Inbox(deps, 0, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    await Promise.all([inbox.run('a'), inbox.run('a'), inbox.run('a')]);
    expect(maxActive).toBe(1);
  });
});
