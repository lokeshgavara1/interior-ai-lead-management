import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseAiTurn, AiOutputError } from '../src/ai/llm.js';
import { AI_TURN_JSON_SCHEMA, AiTurnSchema } from '../src/ai/schema.js';
import { toChatMessages } from '../src/ai/prompt.js';
import { isWithinServiceWindow, parseWhatsAppWebhook } from '../src/channels/whatsapp.js';
import { EMPTY_FACTS, type Lead } from '../src/domain/types.js';
import { mergeFacts } from '../src/engine/merge.js';
import { isOptOut } from '../src/engine/optout.js';
import { deriveStatus, missingFacts, scoreLead } from '../src/engine/scoring.js';
import { decideFollowup } from '../src/jobs/followups.js';
import { normalizePhone } from '../src/lib/phone.js';
import { verifyMetaSignature } from '../src/lib/signature.js';
import { formatAlert } from '../src/notify/notifier.js';
import { aiTurn, makeTenant, NOW } from './support/fakes.js';

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['+919876543210', '+919876543210'],
    ['0091 98765 43210', '+919876543210'],
    ['+14155552671', '+14155552671'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', '12345', 'abc', '+91 12345 67890', null])('rejects %s', (input) => {
    expect(normalizePhone(input as string)).toBeNull();
  });
});

describe('verifyMetaSignature', () => {
  const body = '{"object":"whatsapp_business_account"}';
  const sig = 'sha256=' + createHmac('sha256', 'app-secret').update(body).digest('hex');
  it('accepts a valid signature', () => expect(verifyMetaSignature(body, sig, 'app-secret')).toBe(true));
  it('rejects a wrong secret', () => expect(verifyMetaSignature(body, sig, 'other')).toBe(false));
  it('rejects a tampered body', () => expect(verifyMetaSignature(body + ' ', sig, 'app-secret')).toBe(false));
  it('rejects a missing header', () => expect(verifyMetaSignature(body, undefined, 'app-secret')).toBe(false));
});

describe('scoreLead (spec §6)', () => {
  const base = { budget: null, property_status: null, expected_start_date: null, project_type: null, site_visit_requested: false } as const;

  it('scores the spec example as hot (100)', () => {
    const r = scoreLead(
      { budget: 800000, property_status: 'ready', expected_start_date: '2026-12-01', project_type: 'full_home', site_visit_requested: true },
      NOW,
    );
    expect(r.score).toBe(100);
    expect(r.temperature).toBe('hot');
  });

  it('keeps a lead provisional when unknowns could change the band', () => {
    const r = scoreLead({ ...base, budget: 500000 }, NOW);
    expect(r.score).toBe(20);
    expect(r.temperature).toBe('provisional'); // NOT cold — not enough information yet
  });

  it('marks cold only when all facts are known', () => {
    const r = scoreLead(
      { budget: 200000, property_status: 'under_construction', expected_start_date: '2027-06-01', project_type: 'kitchen', site_visit_requested: false },
      NOW,
    );
    expect(r.score).toBe(20);
    expect(r.temperature).toBe('cold');
  });

  it('is hot as soon as the known score reaches 70', () => {
    const r = scoreLead({ ...base, budget: 1, property_status: 'ready', expected_start_date: '2026-12-10' }, NOW);
    expect(r.score).toBe(65);
    expect(r.temperature).toBe('provisional');
    const r2 = scoreLead({ ...base, budget: 1, property_status: 'ready', expected_start_date: '2026-12-10', site_visit_requested: true }, NOW);
    expect(r2.score).toBe(85);
    expect(r2.temperature).toBe('hot');
  });

  it('does not award the 30-day points for a far start date', () => {
    expect(scoreLead({ ...base, expected_start_date: '2027-03-01' }, NOW).breakdown.startsWithin30Days).toBe(0);
  });
});

describe('deriveStatus / missingFacts', () => {
  const full = {
    ...EMPTY_FACTS,
    location: 'Kondapur',
    property_type: 'apartment' as const,
    project_type: 'full_home' as const,
    property_status: 'ready' as const,
    budget: 800000,
    timeline_text: 'next month',
  };
  it('qualified when all required facts are known', () => {
    expect(missingFacts(full)).toEqual([]);
    expect(deriveStatus('information_pending', full)).toBe('qualified');
  });
  it('information_pending when partially known', () => {
    expect(deriveStatus('new', { ...EMPTY_FACTS, location: 'Kondapur' })).toBe('information_pending');
  });
  it('never overrides a status set by sales', () => {
    expect(deriveStatus('site_visit_scheduled', EMPTY_FACTS)).toBe('site_visit_scheduled');
    expect(deriveStatus('converted', full)).toBe('converted');
  });
});

describe('mergeFacts', () => {
  it('never erases known data with nulls or blanks', () => {
    const existing = { ...EMPTY_FACTS, location: 'Kondapur', budget: 800000 };
    expect(mergeFacts(existing, { location: null, budget: null, customer_name: '  ' })).toEqual({});
  });
  it('returns only changed fields, trimmed', () => {
    const existing = { ...EMPTY_FACTS, location: 'Kondapur' };
    expect(mergeFacts(existing, { location: 'Kondapur', customer_name: ' Rahul ' })).toEqual({ customer_name: 'Rahul' });
  });
  it('accepts corrections', () => {
    expect(mergeFacts({ ...EMPTY_FACTS, budget: 800000 }, { budget: 1000000 })).toEqual({ budget: 1000000 });
  });
});

describe('isOptOut', () => {
  it.each(['STOP', 'stop.', 'Unsubscribe', 'please stop messaging me', "don't message me again", 'remove my number'])('detects "%s"', (t) =>
    expect(isOptOut(t)).toBe(true),
  );
  it.each(['When can you stop by for a site visit?', 'bus stop near my flat', 'Hi, I need interiors'])('ignores "%s"', (t) =>
    expect(isOptOut(t)).toBe(false),
  );
});

describe('AI output validation (§9.2)', () => {
  it('accepts a valid turn', () => {
    const t = aiTurn({ budget: 800000, property_type: 'apartment' });
    expect(parseAiTurn(JSON.stringify(t))).toEqual(t);
  });
  it('rejects non-JSON', () => expect(() => parseAiTurn('hello')).toThrow(AiOutputError));
  it('rejects invented enum values', () => {
    expect(() => parseAiTurn(JSON.stringify({ ...aiTurn(), property_type: 'castle' }))).toThrow(AiOutputError);
  });
  it('rejects missing fields', () => {
    const { reply: _r, ...rest } = aiTurn();
    expect(() => parseAiTurn(JSON.stringify(rest))).toThrow(AiOutputError);
  });
  it('JSON schema sent to OpenAI matches the zod schema keys', () => {
    const zodKeys = Object.keys(AiTurnSchema.shape).sort();
    expect([...AI_TURN_JSON_SCHEMA.required].sort()).toEqual(zodKeys);
    expect(Object.keys(AI_TURN_JSON_SCHEMA.properties).sort()).toEqual(zodKeys);
  });
});

describe('toChatMessages', () => {
  it('merges a burst of customer messages into one turn', () => {
    const mk = (sender: 'customer' | 'ai', text: string) =>
      ({ sender_type: sender, incoming_message: sender === 'customer' ? text : null, outgoing_message: sender === 'ai' ? text : null }) as never;
    expect(toChatMessages([mk('customer', 'Hi'), mk('customer', 'need interiors'), mk('ai', 'Sure!')])).toEqual([
      { role: 'user', content: 'Hi\nneed interiors' },
      { role: 'assistant', content: 'Sure!' },
    ]);
  });
});

describe('parseWhatsAppWebhook', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'PNID-1' },
              contacts: [{ wa_id: '919876543210', profile: { name: 'Rahul' } }],
              messages: [
                { from: '919876543210', id: 'wamid.1', timestamp: '1763877600', type: 'text', text: { body: 'Hi' } },
                { from: '919876543210', id: 'wamid.2', timestamp: '1763877601', type: 'image', image: { caption: 'my kitchen' } },
              ],
              statuses: [{ id: 'wamid.out.1', status: 'delivered' }],
            },
          },
        ],
      },
    ],
  };
  it('extracts messages, names and statuses', () => {
    const { messages, statuses } = parseWhatsAppWebhook(payload);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ phoneNumberId: 'PNID-1', from: '919876543210', profileName: 'Rahul', messageId: 'wamid.1', text: 'Hi' });
    expect(messages[1]!.text).toBe('[Customer sent an image: my kitchen]');
    expect(statuses).toEqual([{ phoneNumberId: 'PNID-1', messageId: 'wamid.out.1', status: 'delivered' }]);
  });
  it('ignores other objects', () => expect(parseWhatsAppWebhook({ object: 'page' }).messages).toEqual([]));
});

describe('formatAlert (§8.2)', () => {
  it('renders the spec format', () => {
    const lead = {
      ...EMPTY_FACTS,
      customer_name: 'Rahul Kumar',
      phone_number: '+919876543210',
      location: 'Kondapur, Hyderabad',
      property_type: 'apartment',
      property_size: '3BHK',
      project_type: 'full_home',
      budget: 800000,
      timeline_text: 'Next Month',
      lead_source: 'instagram',
      lead_score: 85,
      lead_temperature: 'hot',
    } as Lead;
    const text = formatAlert('hot_lead', lead);
    expect(text).toContain('NEW HOT LEAD – INTERIOR ENQUIRY');
    expect(text).toContain('Property: 3BHK Apartment');
    expect(text).toContain('Budget: ₹8,00,000');
    expect(text).toContain('Lead Score: 85/100 (Hot)');
    expect(text).toContain('Lead Source: Instagram');
  });
});

describe('decideFollowup (§7 Workflow 03)', () => {
  const tenant = makeTenant();
  const lead = (o: Partial<Lead>) =>
    ({
      ...EMPTY_FACTS,
      phone_number: '+919876543210',
      instagram_id: null,
      last_customer_channel: 'whatsapp',
      lead_status: 'information_pending',
      opted_out: false,
      ai_paused: false,
      followup_count: 0,
      last_customer_message_at: '2026-11-23T01:00:00Z',
      last_contacted: '2026-11-23T01:00:05Z',
      ...o,
    }) as Lead;

  it('free text inside the 24h window', () => expect(decideFollowup(lead({}), tenant, NOW).action).toBe('free_text'));
  it('stops when opted out', () => expect(decideFollowup(lead({ opted_out: true }), tenant, NOW).action).toBe('stop'));
  it('stops when converted', () => expect(decideFollowup(lead({ lead_status: 'converted' }), tenant, NOW).action).toBe('stop'));
  it('stops when a human took over', () => expect(decideFollowup(lead({ ai_paused: true }), tenant, NOW).action).toBe('stop'));
  it('stops after max follow-ups', () => expect(decideFollowup(lead({ followup_count: 3 }), tenant, NOW).action).toBe('stop'));
  it('needs a template outside the window', () => {
    const old = lead({ last_customer_message_at: '2026-11-20T00:00:00Z', last_contacted: '2026-11-20T00:00:05Z' });
    expect(decideFollowup(old, tenant, NOW).action).toBe('skip');
    const withTpl = makeTenant({ settings: { followup_template_name: 'lead_followup' } });
    expect(decideFollowup(old, withTpl, NOW)).toMatchObject({ action: 'template', name: 'lead_followup' });
  });
  it('Instagram leads get free text in the window and nothing after it', () => {
    const ig = { phone_number: null, instagram_id: 'IGSID', last_customer_channel: 'instagram' as const };
    expect(decideFollowup(lead(ig), tenant, NOW)).toEqual({ action: 'free_text', channel: 'instagram' });
    const old = lead({ ...ig, last_customer_message_at: '2026-11-20T00:00:00Z', last_contacted: '2026-11-20T00:00:05Z' });
    const withTpl = makeTenant({ settings: { followup_template_name: 'lead_followup' } });
    expect(decideFollowup(old, withTpl, NOW).action).toBe('skip');
  });
  it('service window helper', () => {
    expect(isWithinServiceWindow('2026-11-22T07:00:00Z', NOW)).toBe(true);
    expect(isWithinServiceWindow('2026-11-22T05:00:00Z', NOW)).toBe(false);
    expect(isWithinServiceWindow(null, NOW)).toBe(false);
  });
});
