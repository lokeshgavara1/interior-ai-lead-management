/**
 * Safety + small-model support layer (OpenAI-compatible gateway, e.g. mistral:7b on Ollama).
 * Every case here comes from real output seen in live testing against the gateway.
 */
import { describe, expect, it } from 'vitest';
import { askedItem, isParroting, skippedItems, steerReply } from '../src/ai/checklist.js';
import { fillAskedSlot, knownAreas, postProcessTurn, tidyReply } from '../src/ai/grounding.js';
import { AiOutputError, parseAiTurnLenient } from '../src/ai/llm.js';
import { extractJson, repairAiOutput } from '../src/ai/repair.js';
import { guardReply, hasUnapprovedPrice, QUOTE_LINE, sentencesOf, VISIT_LINE } from '../src/ai/replyGuard.js';
import { EMPTY_FACTS, type Lead } from '../src/domain/types.js';
import { HUMAN_HANDOFF_REPLY, processLead } from '../src/engine/conversation.js';
import type { Inbox } from '../src/engine/inbox.js';
import { ingestWhatsAppMessage } from '../src/engine/ingest.js';
import { isHumanRequest } from '../src/engine/optout.js';
import { resolveTimeline } from '../src/lib/timeline.js';
import { aiTurn, makeDeps, NOW } from './support/fakes.js';

const TODAY = '2026-11-23';

describe('repair of almost-right JSON', () => {
  it('extracts JSON from fences and chatter', () => {
    expect(extractJson('```json\n{"reply":"hi"}\n```')).toEqual({ reply: 'hi' });
    expect(extractJson('Sure! {"reply":"hi"} hope this helps')).toEqual({ reply: 'hi' });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('turns placeholders into null and normalises enums / budget (seen live from mistral:7b)', () => {
    const r = repairAiOutput({
      reply: 'Hi',
      intent: 'General Question',
      customer_name: 'Customer',
      phone_number: 'Not provided',
      email: 'N/A',
      property_type: 'Apartment',
      project_type: 'Full Home',
      budget: '8 lakhs',
      property_status: 'Not ready',
      human_reason: 'Not required',
      site_visit_requested: 'yes',
    });
    expect(r).toMatchObject({
      intent: 'general_question',
      customer_name: null,
      phone_number: null,
      email: null,
      property_type: 'apartment',
      project_type: 'full_home',
      budget: 800000,
      property_status: 'under_construction',
      human_reason: null,
      site_visit_requested: true,
      missing_information: [],
    });
  });

  it('keeps extracted facts when the reply is missing', () => {
    const t = parseAiTurnLenient(JSON.stringify({ location: 'Kondapur', budget: 800000 }));
    expect(t.reply).toBe('Thank you!');
    expect(t.location).toBe('Kondapur');
  });

  it('accepts the "Assistant" key some models use, rejects non-JSON', () => {
    expect(parseAiTurnLenient('{"Assistant":"Hello there"}').reply).toBe('Hello there');
    expect(() => parseAiTurnLenient('Hello there')).toThrow(AiOutputError);
  });
});

describe('resolveTimeline', () => {
  it.each([
    ['next month', '2026-12-01'],
    ['I want to start next month.', '2026-12-01'],
    ['immediately', TODAY],
    ['asap please', TODAY],
    ['in 2 weeks', '2026-12-07'],
    ['after 3 months', '2027-02-23'],
    ['in March', '2027-03-01'],
    ['January 2027', '2027-01-01'],
    ['next year', '2027-01-01'],
    ['not now', null],
    ['I may start soon', null],
    ['no idea', null],
  ])('%s -> %s', (text, expected) => expect(resolveTimeline(text, TODAY)).toBe(expected));
});

describe('grounding (LLM_FACT_GROUNDING)', () => {
  const ctx = (customerText: string, extra = {}) => ({ customerText, latestText: customerText, today: TODAY, grounding: true, ...extra });

  it('drops facts the customer never stated (live: mistral invented "ready" and "renovation")', () => {
    const t = postProcessTurn(
      aiTurn({ property_status: 'ready', project_type: 'renovation', property_type: 'apartment', property_size: '3BHK', location: 'Kondapur, Hyderabad', customer_name: 'Customer' }),
      ctx('Hi, I need interiors for my 3BHK flat in Kondapur.'),
    );
    expect(t).toMatchObject({ property_status: null, project_type: null, property_type: 'apartment', property_size: '3BHK', location: 'Kondapur, Hyderabad', customer_name: null });
  });

  it('resolves the start date in code (live: mistral said 2027-01-01 for "next month")', () => {
    const t = postProcessTurn(aiTurn({ timeline_text: 'next month', expected_start_date: '2027-01-01' }), ctx('want to start next month'));
    expect(t.expected_start_date).toBe('2026-12-01');
  });

  it('blocks escalation and sales intents without evidence in the latest message', () => {
    const t = postProcessTurn(aiTurn({ needs_human: true, human_reason: 'needs details', intent: 'ready_to_proceed' }), ctx('It is ready. I want to start next month.'));
    expect(t.needs_human).toBe(false);
    expect(t.intent).toBe('provide_info');
  });

  it('keeps everything when grounding is off (strong models)', () => {
    const t = postProcessTurn(aiTurn({ property_status: 'ready' }), { customerText: 'hi', today: TODAY, grounding: false });
    expect(t.property_status).toBe('ready');
  });

  it('fills the slot that was just asked (live: model missed "Kondapur" and "Rahul")', () => {
    expect(fillAskedSlot(aiTurn(), 'location', 'Hyderabad, Kondapur.').location).toBe('Hyderabad, Kondapur');
    expect(fillAskedSlot(aiTurn(), 'name', "I'm Rahul").customer_name).toBe('Rahul');
    expect(fillAskedSlot(aiTurn(), 'budget', 'Around 8 lakhs.').budget).toBe(800000);
    expect(fillAskedSlot(aiTurn(), 'property_status', 'Yes').property_status).toBe('ready');
    expect(fillAskedSlot(aiTurn(), 'property_status', 'still under construction').property_status).toBe('under_construction');
    expect(fillAskedSlot(aiTurn(), 'site_visit', 'Yes please').site_visit_requested).toBe(true);
  });

  it('never slot-fills from requests or questions (live bug: "talk to a real person" saved as location)', () => {
    expect(fillAskedSlot(aiTurn(), 'location', 'I want to talk to a real person, not a bot').location).toBeNull();
    expect(fillAskedSlot(aiTurn(), 'location', 'How much does it cost?').location).toBeNull();
  });

  it('knows which item a reply asked about', () => {
    expect(askedItem('Thanks! Is your flat ready for interior work, or is construction still going on?')).toBe('property_status');
    expect(askedItem('When would you like our designer to visit your site?')).toBe('site_visit');
    expect(askedItem('Do you have an approximate budget in mind?')).toBe('budget');
    expect(askedItem('Thank you!')).toBeNull();
  });
});

describe('reply tidying', () => {
  it('removes repeated greetings and sentences copied from the previous reply', () => {
    expect(tidyReply('Hello! Welcome to Demo Interiors. Which area is it in?', false)).toBe('Which area is it in?');
    expect(tidyReply('Hello! Which area?', true)).toBe('Hello! Which area?');
    expect(tidyReply('Kondapur noted! Do you have a budget?', false, 'Kondapur noted! Is it ready?')).toBe('Do you have a budget?');
    expect(tidyReply('I apologize for the confusion. May I know your name?', false, 'x')).toBe('May I know your name?');
  });

  it('splits sentences without breaking decimals', () => {
    expect(sentencesOf('Kitchen: INR 1.5 lakhs. May I know your name?')).toEqual(['Kitchen: INR 1.5 lakhs.', 'May I know your name?']);
  });
});

describe('reply guard (all models)', () => {
  const KB = 'Pricing policy: do NOT quote prices.';

  it('blocks invented prices (live: mistral produced a full price list)', () => {
    const reply = "Here's a rough estimate.\n* Kitchen: INR 1.5 lakhs\n* Total: INR 7 lakhs (excluding GST) May I know your name?";
    expect(hasUnapprovedPrice(reply, KB)).toBe(true);
    const g = guardReply(reply, KB, true, [], 'Full home - kitchen, wardrobes');
    expect(g.changed).toBe('price');
    expect(g.reply).not.toMatch(/lakh|INR/);
    expect(g.reply).toContain('May I know your name?');
  });

  it('answers with the approved quotation line when the customer asked about price', () => {
    const g = guardReply('A 2BHK costs around ₹5,00,000. Where is your flat?', KB, true, [], 'How much for a 2BHK?');
    expect(g.reply).toBe(`${QUOTE_LINE} Where is your flat?`);
  });

  it("allows the customer's own budget and amounts in the knowledge base", () => {
    expect(hasUnapprovedPrice('Noted, a budget of ₹8,00,000.', KB, [800000])).toBe(false);
    expect(hasUnapprovedPrice('Kitchens start at ₹1.5 lakh.', 'Modular kitchens start at ₹1.5 lakh.')).toBe(false);
    expect(hasUnapprovedPrice('Get 20% off this month!', KB)).toBe(true);
  });

  it('blocks booking claims (live: "our designer will visit your site on Saturday")', () => {
    for (const r of [
      'Yes, our designer will visit your site on Saturday. Please provide your address.',
      'I will arrange for our designer to visit your property on Saturday.',
      'Your site visit has been booked.',
      'Yes, we can arrange for our designer to visit your site this Saturday.',
    ]) {
      const g = guardReply(r, KB, false);
      expect(g.changed).toBe('booking');
      expect(g.reply).toContain(VISIT_LINE);
    }
  });

  it('trims small-model rambling, but not for strong models', () => {
    const long = 'a'.repeat(200) + '. Something else entirely here that goes on and on. Which area is your property in?';
    expect(guardReply(long, KB, true).changed).toBe('too_long');
    expect(guardReply(long, KB, false).changed).toBeNull();
  });
});

describe('reply steering (small models)', () => {
  const lead = (o: Partial<Lead>) => ({ ...EMPTY_FACTS, site_visit_requested: false, phone_number: '+91', ...o }) as Lead;

  it('replaces a question about something already known with the next missing one', () => {
    const r = steerReply('Great! Which area is your property in?', lead({ location: 'Kondapur' }), 'whatsapp', 'Kondapur');
    expect(r).toBe('Great! Is your property ready for interior work, or is construction still going on?');
  });

  it('replaces off-checklist questions (live: "which design style do you prefer?")', () => {
    const r = steerReply('Great, Rahul! Which design style do you prefer?', lead({ location: 'K' }), 'whatsapp', "I'm Rahul");
    expect(r).toContain('Is your property ready');
  });

  it('adds the next question when the reply asks nothing (live: "It is ready for interiors.")', () => {
    expect(steerReply('Noted.', lead({}), 'whatsapp', 'ok')).toBe('Noted. Which area is your property in?');
  });

  it('closes in code once everything is known (live: model answered as the customer)', () => {
    const all = lead({
      location: 'K',
      property_status: 'ready',
      timeline_text: 'next month',
      budget: 1,
      project_type: 'full_home',
      property_type: 'apartment',
      property_size: '3BHK',
      customer_name: 'Rahul Kumar',
      site_visit_requested: true,
    });
    const r = steerReply('Yes, please. Can your designer visit this Saturday?', all, 'whatsapp', 'Yes please, can your designer visit this Saturday?');
    expect(r).toContain('Thank you, Rahul!');
    expect(r).toContain(VISIT_LINE);
    expect(isParroting('Yes, please. Can your designer visit this Saturday?', 'Yes please, can your designer visit this Saturday?')).toBe(true);
  });

  it('adds the approved quotation line when a price question is sidestepped (live)', () => {
    const r = steerReply('To help you better, is your 2BHK flat located in Hyderabad?', lead({}), 'whatsapp', 'how much does a 2BHK cost?');
    expect(r).toBe(`${QUOTE_LINE} To help you better, is your 2BHK flat located in Hyderabad?`);
  });

  it('a fully repeated previous reply becomes a bare acknowledgement for steering (live)', () => {
    const prev = 'Noted, thanks. Is your property ready for interior work?';
    expect(tidyReply(prev, false, prev, true)).toBe('Thank you!');
    expect(tidyReply(prev, false, prev, false)).toBe(prev); // strong models: left alone
    // "Thanks for reaching out!" counts as a repeated greeting after the first reply
    expect(tidyReply('Thanks for reaching out! Is it ready?', false)).toBe('Is it ready?');
  });

  it('leaves Indic-script conversations alone', () => {
    expect(steerReply('మీ ఫ్లాట్ ఎక్కడ ఉంది?', lead({ location: 'K' }), 'whatsapp', 'నమస్కారం')).toBe('మీ ఫ్లాట్ ఎక్కడ ఉంది?');
  });
});

describe('fixes from the first live test-plan run (24 Nov)', () => {
  it('an essay-length reply is shortened instead of failing the turn (L1-L3 fallback)', () => {
    const essay = `Great! ${'Here is a detailed breakdown of the costs for your home. '.repeat(30)}Which rooms do you need?`;
    const t = parseAiTurnLenient(JSON.stringify({ reply: essay, budget: 800000 }));
    expect(t.reply.length).toBeLessThanOrEqual(900);
    expect(t.budget).toBe(800000);
  });

  it('a refusal that names its topic is never asked again (L4)', () => {
    const h = [
      { sender_type: 'ai', incoming_message: null, outgoing_message: 'Is your property ready for interior work?' },
      { sender_type: 'customer', incoming_message: 'Not sure about the budget yet', outgoing_message: null },
    ];
    expect([...skippedItems(h)]).toEqual(['budget']);
    const h2 = [
      { sender_type: 'ai', incoming_message: null, outgoing_message: 'When would you like to start?' },
      { sender_type: 'customer', incoming_message: "don't know yet", outgoing_message: null },
    ];
    expect([...skippedItems(h2)]).toEqual(['timeline']);
    const lead = { ...EMPTY_FACTS, site_visit_requested: false, location: 'G', property_status: 'ready' } as Lead;
    const r = steerReply('Thanks! Do you have an approximate budget in mind?', lead, 'whatsapp', 'Not sure about the budget yet', new Set(['budget', 'timeline']));
    expect(askedItem(r)).toBe('project_type');
  });

  it('does not split sentences at "e.g." (X1 broken reply)', () => {
    expect(sentencesOf('Could you tell me the type and size (e.g. 3BHK apartment)? Thanks.')).toEqual([
      'Could you tell me the type and size (e.g. 3BHK apartment)?',
      'Thanks.',
    ]);
  });

  it('"Can your designer come tomorrow at 5pm?" is a site-visit request (X1)', () => {
    const t = postProcessTurn(aiTurn(), { customerText: 'Can your designer come tomorrow at 5pm?', latestText: 'Can your designer come tomorrow at 5pm?', today: TODAY, grounding: true });
    expect(t.site_visit_requested).toBe(true);
    const lead = { ...EMPTY_FACTS, site_visit_requested: true, location: 'K' } as Lead;
    const r = steerReply('Thanks for the details! Which type of property is it?', lead, 'whatsapp', 'Can your designer come tomorrow at 5pm?');
    expect(r.startsWith(VISIT_LINE)).toBe(true);
  });

  it('recognises served areas from the knowledge base (X1 re-asked "Kondapur", L6 Hinglish)', () => {
    const kb = 'Areas served: Hyderabad and Secunderabad (Kondapur, Gachibowli, Madhapur and nearby).';
    const areas = knownAreas(kb);
    expect(areas).toEqual(['Hyderabad', 'Secunderabad', 'Kondapur', 'Gachibowli', 'Madhapur']);
    const run = (msg: string) => postProcessTurn(aiTurn(), { customerText: msg, latestText: msg, today: TODAY, grounding: true, areas }).location;
    expect(run('Hi, 3BHK in Kondapur, ready, full home')).toBe('Kondapur');
    expect(run('Namaste, mujhe 2BHK ke liye interiors chahiye, Gachibowli mein')).toBe('Gachibowli');
    expect(run('Kondapur, Hyderabad')).toBe('Kondapur, Hyderabad');
    expect(run('Hi, need a kitchen')).toBeNull();
  });

  it('reads readiness from a message with several facts (X1), but not "ready to start"', () => {
    const run = (msg: string) => postProcessTurn(aiTurn(), { customerText: msg, latestText: msg, today: TODAY, grounding: true });
    expect(run('Hi, 3BHK in Kondapur, ready, full home, budget 8 lakhs, start next month')).toMatchObject({
      property_status: 'ready',
      property_type: 'apartment',
      property_size: '3BHK',
      project_type: 'full_home',
      budget: 800000,
    });
    expect(run('flat is still under construction')).toMatchObject({ property_status: 'under_construction' });
    expect(run('I am ready to start the project').property_status).toBeNull();
  });

  it('reads obvious project/property words from the message (L7b "need wardrobes", X1 "3BHK")', () => {
    const t = postProcessTurn(aiTurn(), { customerText: 'Hi, need wardrobes for my 3BHK flat', latestText: 'Hi, need wardrobes for my 3BHK flat', today: TODAY, grounding: true });
    expect(t).toMatchObject({ project_type: 'wardrobe', property_type: 'apartment', property_size: '3BHK' });
  });
});

describe('explicit human request (all models)', () => {
  it.each(['I want to talk to a real person, not a bot', 'can I speak with someone', 'are you a bot?', 'please call me', 'human please'])(
    'detects "%s"',
    (t) => expect(isHumanRequest(t)).toBe(true),
  );
  it.each(['can your designer visit this Saturday?', 'I need a person to design my kitchen? no, just quotes', 'Hi, 3BHK in Kondapur'])(
    'ignores "%s"',
    (t) => expect(isHumanRequest(t)).toBe(false),
  );

  it('escalates even when the model misses it (live: mistral replied with the next question)', async () => {
    const { deps, repo, llm } = makeDeps();
    const scheduled: string[] = [];
    const inbox = { schedule: (id: string) => scheduled.push(id) } as unknown as Inbox;
    llm.queue.push(aiTurn({ reply: 'Is your property ready for interior work?' }));
    await ingestWhatsAppMessage(deps, inbox, {
      phoneNumberId: 'PNID-1',
      from: '919876543210',
      profileName: null,
      messageId: 'w1',
      timestamp: NOW.toISOString(),
      text: 'I want to talk to a real person, not a bot',
      type: 'text',
    });
    await processLead(deps, scheduled[0]!);
    const lead = repo.leads[0]!;
    expect(lead.ai_paused).toBe(true);
    expect(repo.outbound(lead.lead_id).at(-1)?.outgoing_message).toBe(HUMAN_HANDOFF_REPLY);
    expect(repo.notifications.some((n) => n.kind === 'human_needed')).toBe(true);
  });
});
