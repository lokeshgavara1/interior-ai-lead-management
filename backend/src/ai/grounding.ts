/**
 * Post-processing of every AI turn, before anything is saved or scored.
 *
 * 1. Timeline: the start date is resolved in code from the customer's words, so the
 *    30-day scoring rule never depends on model arithmetic (always on).
 * 2. Grounding (LLM_FACT_GROUNDING=true, recommended for small models): a fact is kept
 *    only if the customer's own messages contain evidence for it. Small models tend to
 *    "fill in" plausible values (e.g. property_status "ready"), which would inflate
 *    lead scores and trigger false hot-lead alerts.
 *
 * Grounding uses English/Hinglish keywords. Facts stated only in Telugu/Hindi script
 * are dropped when it is on (the conversation still works; those fields stay empty).
 */
import type { AiTurn } from './schema.js';
import { askedItem } from './checklist.js';
import { sentencesOf } from './replyGuard.js';
import { PROJECT_TYPES, PROPERTY_TYPES } from '../domain/types.js';
import { parseBudgetInr } from '../lib/parse.js';
import { resolveTimeline } from '../lib/timeline.js';

const EVIDENCE = {
  property_type: {
    apartment: /\b(flat|apartment|apt|gated|tower|society|condo)\b|bhk\b/,
    villa: /\bvilla/,
    independent_house: /\b(independent|house|duplex|bungalow|individual|g\+\d)\b/,
    commercial: /\b(office|shop|commercial|showroom|restaurant|clinic|store|cafe)\b/,
    other: /./,
  },
  project_type: {
    full_home: /\b(full|entire|complete|whole|all rooms|end to end|turnkey|everything|full home|full house)\b/,
    kitchen: /\bkitchen/,
    wardrobe: /\b(wardrobe|closet|cupboard)/,
    living_room: /\b(living|hall|lounge)\b/,
    bedroom: /\bbed ?rooms?\b/,
    renovation: /\b(renovat|remodel|redo|refurbish|makeover)/,
    other: /./,
  },
  property_status: {
    ready: /\b(ready|possession|handed over|handover done|completed|moved in|move in|vacant|living there|staying)\b/,
    under_construction: /\b(construction|not ready|being built|under construction|handover (in|next|by)|possession (in|next|by)|not yet (handed|ready))\b/,
  },
} as const;

const SITE_VISIT =
  /\b(visit|come (and )?(see|check)|come over|come home|come (by|tomorrow|today|on|at|this|next)|inspect|measure|measurement|site)\b|\b(designer|someone|team|you) (can |could |to )?come\b/i;
const BUDGET_HINT = /\d|lakh|lac|crore|\bcr\b|\bk\b|₹|\brs\b/;

/** Money amounts the customer wrote ("8 lakhs", "₹8,00,000", "10-15 lakh", "50k", "800000"). */
const MONEY_PHRASE =
  /(?:₹|\brs\.?|\binr\b)\s*[\d,.]+(?:\s*(?:lakhs?|lacs?|crores?|cr|k))?|\b\d+(?:\.\d+)?(?:\s*(?:-|to|–)\s*\d+(?:\.\d+)?)?\s*(?:lakhs?|lacs?|l\b|crores?|cr\b|k\b|thousand)|\b\d{1,3}(?:,\d{2,3})+\b|\b\d{5,9}\b/gi;
export function statedBudgets(customerText: string): number[] {
  return (customerText.match(MONEY_PHRASE) ?? []).map((m) => parseBudgetInr(m)).filter((v): v is number => v != null && v >= 10_000);
}

function digits(s: string) {
  return s.replace(/\D/g, '');
}

function mentioned(value: string, text: string): boolean {
  const words = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  return words.length > 0 && words.some((w) => text.includes(w));
}

/** The customer is asking for a person, complaining, or raising something the AI shouldn't handle. */
const HUMAN_EVIDENCE =
  /\b(human|real person|a person|agent|manager|owner|executive|representative|call me|give me a call|phone me|talk to|speak to|speak with|talk with|not a bot|are you a bot|complain|complaint|unhappy|not happy|disappointed|angry|worst|legal|lawyer|contract|agreement|warranty|guarantee|refund|cancel|dispute|court|police)\b/;

const PROCEED_EVIDENCE =
  /\b(go ahead|proceed|let'?s (start|begin|do it)|start the work|ready to start|finali[sz]e|confirm(ed)?|book(ing)?|sign|advance|payment|pay|deal|done deal|go for it|interested to start)\b/;
const OPT_OUT_EVIDENCE = /\b(stop|unsubscribe|don'?t (message|text|contact)|do not (message|text|contact)|not interested|remove|leave me)\b/;

const FILLER = /^\s*(i )?(apologi[sz]e|sorry) for (the|any) (confusion|inconvenience)/i;

/** Greeting / company-intro sentences small models repeat on every turn. */
const GREETING_SENTENCE =
  /^\s*(hi|hello|hey|greetings|namaste|welcome|good (morning|afternoon|evening)|(thank you|thanks) for (contacting|reaching|choosing|getting in touch)|we specialize|we specialise|it'?s (great|nice) to (hear|connect)|i'?m (the|an|your) (ai )?receptionist)[^.!?\n]*[.!?]+\s*/i;

/**
 * Remove repeated greetings after the first reply, and an opening sentence copied from
 * the previous AI reply ("Kondapur noted!" on every turn). Keeps at least one sentence.
 */
export function tidyReply(reply: string, isFirstReply: boolean, previousReply?: string | null, smallModel = false): string {
  let out = reply.trim();
  if (!isFirstReply) {
    for (let i = 0; i < 3; i++) {
      const next = out.replace(GREETING_SENTENCE, '');
      if (next === out || next.trim().length < 10) break;
      out = next.trim();
    }
    // Drop sentences copied from the previous reply, and filler apologies.
    const previous = new Set((previousReply ? sentencesOf(previousReply) : []).map((s) => s.toLowerCase()));
    const parts = sentencesOf(out);
    const fresh = parts.filter((s) => !previous.has(s.toLowerCase()) && !FILLER.test(s));
    if (fresh.length > 0 && fresh.length < parts.length) out = fresh.join(' ');
    // The whole previous reply repeated: small-model steering will add the right question.
    else if (fresh.length === 0 && smallModel) out = 'Thank you!';
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const YES = /^\s*(yes|yeah|yep|sure|ok(ay)?|please|definitely|of course|haan|ha|ji|yes please)\b/i;
const NAME_PREFIX = /^\s*(hi|hello)?[,! ]*(i am|i'm|im|my name is|this is|it's|its|name is|me)\s+/i;

/** Fill the field for `itemId` from the customer's answer, only where the model left it empty. */
/** Messages that are requests/complaints/questions, not answers — never slot-fill from these. */
const NOT_AN_ANSWER =
  /\?|\b(talk|speak|chat|connect) (to|with)\b|\b(real|actual|live) (person|human)|\b(bot|robot|stop|unsubscribe|complain|complaint|not happy|call me|how much|what is|can you|do you|could you|why)\b/i;

export function fillAskedSlot(turn: AiTurn, itemId: string | null, answer: string): AiTurn {
  if (!itemId || NOT_AN_ANSWER.test(answer)) return turn;
  const t = { ...turn };
  const a = answer.trim();
  const lower = a.toLowerCase();
  const short = a.length <= 80 && !a.includes('?');
  switch (itemId) {
    case 'location':
      if (!t.location && short && /[a-z]{3,}/i.test(a) && !/\b(not sure|don'?t know|no idea)\b/i.test(a)) t.location = a.replace(/[.!]+$/, '');
      break;
    case 'property_status':
      if (!t.property_status) {
        if (EVIDENCE.property_status.under_construction.test(lower)) t.property_status = 'under_construction';
        else if (EVIDENCE.property_status.ready.test(lower) || YES.test(a)) t.property_status = 'ready';
      }
      break;
    case 'timeline':
      if (!t.timeline_text && short && resolveTimeline(a, '2000-01-01')) t.timeline_text = a;
      break;
    case 'budget':
      if (t.budget == null && BUDGET_HINT.test(lower)) t.budget = parseBudgetInr(a);
      break;
    case 'project_type':
      if (!t.project_type) {
        const found = (Object.entries(EVIDENCE.project_type) as [(typeof PROJECT_TYPES)[number], RegExp][]).find(
          ([k, re]) => k !== 'other' && re.test(lower),
        );
        if (found) t.project_type = found[0];
      }
      if (!t.requirements && short) t.requirements = a;
      break;
    case 'property_details':
      if (!t.property_type) {
        const found = (Object.entries(EVIDENCE.property_type) as [(typeof PROPERTY_TYPES)[number], RegExp][]).find(
          ([k, re]) => k !== 'other' && re.test(lower),
        );
        if (found) t.property_type = found[0];
      }
      if (!t.property_size) t.property_size = a.match(/\b\d\s*bhk\b|\b\d{3,5}\s*(sq\.?\s*ft|sqft|square feet)\b/i)?.[0] ?? null;
      break;
    case 'name':
      if (!t.customer_name && short) {
        const name = a.replace(NAME_PREFIX, '').replace(/[.!]+$/, '').trim();
        if (/^[\p{L} .'-]{2,40}$/u.test(name) && name.split(/\s+/).length <= 4) t.customer_name = name;
      }
      break;
    case 'site_visit':
      if (!t.site_visit_requested && (YES.test(a) || SITE_VISIT.test(lower))) t.site_visit_requested = true;
      break;
  }
  return t;
}

/**
 * Facts that are safe to read straight from any customer message: timeline phrases,
 * explicit rupee amounts, and clear project / property words ("full home", "wardrobes",
 * "3BHK flat"). Only fills what the model left empty.
 */
/**
 * Area names the business serves, read from the knowledge base line that lists them
 * ("Areas served: Hyderabad and Secunderabad (Kondapur, Gachibowli, ...)").
 */
export function knownAreas(knowledgeBase: string): string[] {
  const line = knowledgeBase.split('\n').find((l) => /\b(areas?|locations?|localities|cities)\b[^:]*:/i.test(l));
  if (!line) return [];
  return [
    ...new Set(
      line
        .slice(line.indexOf(':') + 1)
        .split(/[,()/;]|\band\b|\bnearby\b/i)
        .map((s) => s.trim())
        .filter((s) => /^[A-Z][\p{L} .'-]{2,30}$/u.test(s)),
    ),
  ];
}

function fillObviousSlots(turn: AiTurn, latest: string, today: string, areas: string[] = []): AiTurn {
  const t = { ...turn };
  const lower = latest.toLowerCase();
  if (!t.location) {
    // Most specific first (Kondapur before Hyderabad); combine locality + city if both named.
    const found = areas.filter((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(latest));
    if (found.length) t.location = found.sort((a, b) => areas.indexOf(b) - areas.indexOf(a)).join(', ');
  }
  if (!NOT_AN_ANSWER.test(latest) || /\b(need|want|looking for|interested in)\b/i.test(latest)) {
    if (!t.project_type) {
      const order = ['full_home', 'kitchen', 'wardrobe', 'living_room', 'bedroom', 'renovation'] as const;
      t.project_type = order.find((k) => EVIDENCE.project_type[k].test(lower) && !(k === 'full_home' && /\bfull (budget|payment)\b/.test(lower))) ?? null;
    }
    if (!t.property_type) {
      const order = ['villa', 'independent_house', 'commercial', 'apartment'] as const;
      t.property_type = order.find((k) => EVIDENCE.property_type[k].test(lower)) ?? null;
    }
    if (!t.property_size) t.property_size = latest.match(/\b\d\s*bhk\b/i)?.[0].toUpperCase().replace(/\s+/, '') ?? null;
    if (!t.property_status) {
      // "ready to start / go ahead" is about the customer, not the property.
      const aboutProperty = lower.replace(/\bready to (start|go|proceed|begin|book|sign)\b/g, '');
      if (EVIDENCE.property_status.under_construction.test(aboutProperty)) t.property_status = 'under_construction';
      else if (EVIDENCE.property_status.ready.test(aboutProperty)) t.property_status = 'ready';
    }
  }
  // "Can your designer come tomorrow at 5pm?" is a site-visit request even if the model missed it.
  if (!t.site_visit_requested && SITE_VISIT.test(lower) && /\?|\b(can|could|please|want|would like|need)\b/i.test(latest)) {
    t.site_visit_requested = true;
  }
  if (!t.timeline_text) {
    const s = sentencesOf(latest).find((x) => resolveTimeline(x, today));
    if (s) t.timeline_text = s.replace(/[.!]+$/, '');
  }
  if (t.budget == null && /lakh|lac\b|crore|\bcr\b|₹|\brs\b/i.test(latest)) t.budget = parseBudgetInr(latest);
  return t;
}

export interface GroundingContext {
  /** Everything the customer has written in this conversation. */
  customerText: string;
  /** The customer's newest message(s) — what this reply responds to. */
  latestText?: string;
  /** YYYY-MM-DD in the business's timezone. */
  today: string;
  grounding: boolean;
  /** False once the AI has already replied in this conversation. */
  isFirstReply?: boolean;
  /** The AI's previous message, if any. */
  previousReply?: string | null;
  /** Areas the business serves (from its knowledge base), for location detection. */
  areas?: string[];
}

export function postProcessTurn(turn: AiTurn, ctx: GroundingContext): AiTurn {
  let t: AiTurn = { ...turn };
  const text = ctx.customerText.toLowerCase();
  t.reply = tidyReply(t.reply, ctx.isFirstReply ?? true, ctx.previousReply, ctx.grounding);

  // Slot filling: the customer's latest message usually answers the question we just
  // asked. Fill that one field from their words if the model missed it.
  if (ctx.grounding && ctx.latestText) {
    if (ctx.previousReply) t = fillAskedSlot(t, askedItem(ctx.previousReply), ctx.latestText);
    t = fillObviousSlots(t, ctx.latestText, ctx.today, ctx.areas);
  }

  if (ctx.grounding) {
    // Escalation only when the customer's latest message gives a reason to.
    const latest = (ctx.latestText ?? ctx.customerText).toLowerCase();
    const humanEvidence = HUMAN_EVIDENCE.test(latest);
    if (!humanEvidence) {
      t.needs_human = false;
      t.human_reason = null;
      if (t.intent === 'human_request' || t.intent === 'complaint') t.intent = 'other';
    }
    // Intents that trigger sales alerts also need evidence in the latest message.
    if (t.intent === 'ready_to_proceed' && !PROCEED_EVIDENCE.test(latest)) t.intent = 'provide_info';
    if (t.intent === 'site_visit_request' && !SITE_VISIT.test(latest)) t.intent = 'provide_info';
    if (t.intent === 'opt_out' && !OPT_OUT_EVIDENCE.test(latest)) t.intent = 'other';
    if (t.customer_name && !mentioned(t.customer_name, text)) t.customer_name = null;
    if (t.location && !mentioned(t.location, text)) t.location = null;
    if (t.property_size && !mentioned(t.property_size, text) && !digits(t.property_size)) t.property_size = null;
    if (t.property_size && digits(t.property_size) && !text.includes(digits(t.property_size))) t.property_size = null;
    if (t.email && !text.includes(t.email.toLowerCase())) t.email = null;
    if (t.phone_number && (digits(t.phone_number).length < 8 || !digits(text).includes(digits(t.phone_number).slice(-8)))) {
      t.phone_number = null;
    }
    if (t.property_type && !EVIDENCE.property_type[t.property_type].test(text)) t.property_type = null;
    if (t.project_type && !EVIDENCE.project_type[t.project_type].test(text)) t.project_type = null;
    if (t.property_status && !EVIDENCE.property_status[t.property_status].test(text)) t.property_status = null;
    // Budget: keep only if the customer actually stated an amount close to it
    // (any digit is not enough: "3BHK" let a guessed budget through in live testing).
    // If the model's figure doesn't match, use the latest amount the customer wrote.
    const stated = statedBudgets(ctx.customerText);
    if (t.budget != null && !stated.some((b) => Math.abs(b - t.budget!) <= b * 0.2)) t.budget = stated.at(-1) ?? null;
    if (t.site_visit_requested && !SITE_VISIT.test(text)) t.site_visit_requested = false;
    if (t.timeline_text && !mentioned(t.timeline_text, text)) t.timeline_text = null;
  }

  // Start date: our resolver wins; otherwise keep the model's date only if plausible.
  const resolved = resolveTimeline(t.timeline_text, ctx.today) ?? (ctx.grounding ? null : t.expected_start_date);
  if (resolved) {
    const days = (Date.parse(resolved) - Date.parse(ctx.today)) / 86_400_000;
    t.expected_start_date = days >= -31 && days <= 730 ? resolved : null;
  } else {
    t.expected_start_date = null;
  }
  return t;
}
