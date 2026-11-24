/**
 * The details the receptionist collects, in order (spec §4.2 / §4.3 sample conversation).
 * Shared by the prompt (tells the model what is known) and by reply steering (fixes
 * small-model replies that re-ask answered questions or ask nothing).
 */
import type { Channel, Lead } from '../domain/types.js';
import { dropDangling, fixRunOn, PRICE_QUESTION, QUOTE_LINE, sentencesOf, VISIT_LINE } from './replyGuard.js';

const CLOSING_OR_VISIT = /contact you|call you|reach out|get in touch|confirm a convenient time/i;

export interface ChecklistItem {
  id: string;
  /** Description for the prompt. */
  item: string;
  /** Fallback question when steering a reply (English). */
  question: string;
  /** Different wording, used when the same question must be asked again. */
  rephrase: string;
  /** Recognises a reply sentence that asks about this item. */
  asks: RegExp;
  known: (lead: Lead) => boolean;
  channels?: Channel[];
}

export const CHECKLIST: ChecklistItem[] = [
  {
    id: 'location',
    item: 'property location (area, city)',
    question: 'Which area is your property in?',
    rephrase: 'Could you tell me the area or locality of your property?',
    asks: /\b(where|location|located|area|locality|which part|city)\b/i,
    known: (l) => !!l.location,
  },
  {
    id: 'property_status',
    item: 'is the property ready for interiors or under construction',
    question: 'Is your property ready for interior work, or is construction still going on?',
    rephrase: 'Is the property ready to start interiors, or still under construction?',
    asks: /\b(ready|construction|possession|handed over|handover)\b/i,
    known: (l) => !!l.property_status,
  },
  {
    id: 'timeline',
    item: 'when they want to start',
    question: 'When would you like to start the interior work?',
    rephrase: 'Roughly when are you planning to start: this month, next month, or later?',
    asks: /\b(when|start|timeline|begin)\b/i,
    known: (l) => !!(l.timeline_text || l.expected_start_date),
  },
  {
    id: 'budget',
    item: 'approximate budget',
    question: 'Do you have an approximate budget in mind for the interiors?',
    rephrase: 'Do you have a rough budget range in mind?',
    asks: /\b(budget|spend|cost|price range|lakh)\b/i,
    known: (l) => l.budget != null,
  },
  {
    id: 'project_type',
    item: 'full home interiors or specific rooms (kitchen, wardrobes, etc.)',
    question: 'Are you looking for full home interiors, or specific areas like the kitchen or wardrobes?',
    rephrase: 'Which areas would you like us to design: the full home, or specific rooms?',
    asks: /\b(full home|entire|whole|specific (rooms?|areas?)|which rooms?|kitchen|wardrobe|rooms? would you like)\b/i,
    known: (l) => !!l.project_type,
  },
  {
    id: 'property_details',
    item: 'property type and size (e.g. 3BHK apartment, villa)',
    question: 'What type and size is the property — for example a 3BHK apartment or a villa?',
    rephrase: 'Is it an apartment, villa or independent house, and how many bedrooms?',
    asks: /\b(type of (property|home|house)|size|bhk|sq\.? ?ft|square feet|villa|apartment|independent house)\b/i,
    known: (l) => !!(l.property_type && l.property_size),
  },
  {
    id: 'name',
    item: 'their name',
    question: 'May I know your name, please?',
    rephrase: 'Could you share your name so our team knows whom to call?',
    asks: /\b(your name|may i know who|who am i speaking)\b/i,
    known: (l) => !!l.customer_name,
  },
  {
    id: 'phone',
    item: 'a phone/WhatsApp number for the design team',
    question: 'Could you share a phone or WhatsApp number so our design team can call you?',
    rephrase: 'What is the best number for our designer to reach you on?',
    asks: /\b(phone|number|whatsapp|contact)\b/i,
    known: (l) => !!l.phone_number,
    channels: ['instagram'],
  },
  {
    id: 'site_visit',
    item: 'whether they would like a site visit',
    question: 'Would you like our designer to visit your site?',
    rephrase: 'Would a site visit help, so our designer can see the space and take measurements?',
    asks: /\b(site visit|visit (your|the) (site|home|flat|property)|come and see)\b/i,
    known: (l) => l.site_visit_requested,
  },
];

export function itemsFor(channel: Channel): ChecklistItem[] {
  return CHECKLIST.filter((i) => !i.channels || i.channels.includes(channel));
}

/** The customer declined to answer ("not sure yet", "prefer not to say", "later"). */
const DECLINE =
  /\b(not sure|no idea|don'?t know|dont know|not decided|haven'?t decided|undecided|later|skip|prefer not|rather not|not now|no budget|depends|will tell|let me think|no clue|pata nahi|maloom nahi)\b/i;

/**
 * Items the customer skipped: an AI question about the item followed by a customer
 * reply that declines it. Spec §12: "Customer skips a question -> continue naturally",
 * so these are never asked again.
 */
/** A refusal that names its topic: "not sure about the budget", "don't know when". */
const DECLINED_TOPIC: [string, RegExp][] = [
  ['budget', /\b(budget|cost|spend|amount|price)\b/i],
  ['timeline', /\b(when|start|date|timeline|month)\b/i],
  ['name', /\bname\b/i],
  ['project_type', /\b(rooms?|which areas?|full home|scope)\b/i],
  ['site_visit', /\b(visit|site)\b/i],
  ['phone', /\b(number|phone|contact)\b/i],
];

export function skippedItems(history: { sender_type: string; incoming_message: string | null; outgoing_message: string | null }[]): Set<string> {
  const skipped = new Set<string>();
  let lastAsked: string | null = null;
  for (const m of history) {
    if (m.sender_type !== 'customer') {
      if (m.outgoing_message?.includes('?')) lastAsked = askedItem(m.outgoing_message);
      continue;
    }
    const text = m.incoming_message ?? '';
    if (!DECLINE.test(text)) continue;
    const named = DECLINED_TOPIC.find(([, re]) => re.test(text))?.[0];
    const item = named ?? lastAsked;
    if (item) skipped.add(item);
  }
  return skipped;
}

export const CLOSING_LINE = 'Our design team will contact you shortly to discuss the design and arrange the next steps.';

/** Scripts we don't have English fallback questions for — never overwrite those replies. */
const INDIC_SCRIPT = /[ऀ-෿]/;

/**
 * Fix a small-model reply after facts are merged:
 *  - it asks about something already known      -> swap that question for the next missing one
 *  - it asks nothing while details are missing  -> append the next missing question
 *  - it asks nothing and everything is known    -> append the closing line if it has none
 * Returns the reply unchanged when it is fine, or when the customer writes in an Indic script.
 */
const CUSTOMER_QUESTION = /\?|\b(do you|can you|could you|is it|are you|what|which|how|why|where|when|price|cost)\b/i;
const VISIT_QUESTION = /\b(visit|come (and )?(see|check)|come over|site|come (by|tomorrow|today|on|at|this|next))\b|\b(designer|someone|team) (can |could |to )?come\b/i;

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** The model repeated the customer's message back as if it were the customer. */
export function isParroting(reply: string, customerLatest: string): boolean {
  const r = words(reply);
  const c = new Set(words(customerLatest));
  if (r.length === 0 || c.size < 3) return false;
  return r.filter((w) => c.has(w)).length / r.length >= 0.7;
}

/**
 * Small models sometimes answer AS the customer or as the designer
 * ("I am Rahul. I will design the full home..."). Drop such sentences; steering then
 * supplies an acknowledgement and the next question.
 */
export function dropRoleConfusion(reply: string, merged: Lead, customerLatest: string): string {
  const name = merged.customer_name?.split(/\s+/)[0];
  const asCustomer = new RegExp(`\\b(i am|i'm|im|my name is|this is)\\s+${name ? name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\0'}\\b`, 'i');
  const firstPersonWork = /\b(i|we)\s*('ll| will| shall)\s+(design|build|create|make|do|handle|complete|deliver|start|finish|renovate)\b|\bi (want|need|would like|prefer|am looking)\b|\bmy (flat|home|house|budget|property)\b/i;
  const kept = sentencesOf(reply).filter((s) => !asCustomer.test(s) && !firstPersonWork.test(s) && !/^let'?s get started!?$/i.test(s));
  const result = kept.join(' ').trim();
  return result || 'Thank you!';
}

/**
 * Small-model reply steering (see steerReplyCore), plus two polish rules:
 *  - if the customer declined something, the reply opens with "No problem!" rather than "Thank you!"
 *  - a question identical to the one we just asked is reworded instead of repeated
 */
export function steerReply(
  reply: string,
  merged: Lead,
  channel: Channel,
  customerLatest: string,
  skipped: Set<string> = new Set(),
  previousReply: string | null = null,
): string {
  if (!INDIC_SCRIPT.test(customerLatest)) reply = dropRoleConfusion(reply, merged, customerLatest);
  let out = steerReplyCore(reply, merged, channel, customerLatest, skipped);
  if (INDIC_SCRIPT.test(customerLatest) || INDIC_SCRIPT.test(out)) return out;

  if (DECLINE.test(customerLatest)) {
    const parts = sentencesOf(out);
    const first = parts[0] ?? '';
    if (/^(thank you|thanks|great|perfect|wonderful|noted)[^?]*[.!]$/i.test(first) && first.length <= 40) parts[0] = 'No problem!';
    else if (!/^no problem/i.test(first)) parts.unshift('No problem!');
    out = parts.join(' ');
  }

  if (previousReply) {
    const lastAsked = [...sentencesOf(previousReply)].reverse().find((s) => s.endsWith('?'));
    const parts = sentencesOf(out);
    const qi = parts.findIndex((s) => s.endsWith('?'));
    if (lastAsked && qi >= 0 && parts[qi]!.toLowerCase() === lastAsked.toLowerCase()) {
      const id = askedItem(lastAsked);
      const item = CHECKLIST.find((i) => i.id === id);
      if (item && item.rephrase.toLowerCase() !== lastAsked.toLowerCase()) {
        parts[qi] = item.rephrase;
        out = parts.join(' ');
      }
    }
  }
  return out;
}

function steerReplyCore(
  reply: string,
  merged: Lead,
  channel: Channel,
  customerLatest: string,
  skipped: Set<string>,
): string {
  if (INDIC_SCRIPT.test(customerLatest) || INDIC_SCRIPT.test(reply)) return reply;
  // A skipped item counts as "done" for asking purposes.
  const items = itemsFor(channel).map((i) => (skipped.has(i.id) ? { ...i, known: () => true } : i));
  const next = items.find((i) => !i.known(merged));
  const first = merged.customer_name ? `, ${merged.customer_name.split(' ')[0]}` : '';
  reply = dropDangling(fixRunOn(reply)) || 'Thank you!';
  // A price question must get the approved answer, even if the model sidestepped it.
  if (PRICE_QUESTION.test(customerLatest) && !/quot|designer will share|after (the )?site visit/i.test(reply)) {
    const q = sentencesOf(reply).find((s) => s.endsWith('?'));
    reply = [QUOTE_LINE, q ?? ''].join(' ').trim();
  }

  // Everything collected: close the conversation in code (small models tend to drift
  // or even answer as the customer at this point), unless the customer asked something
  // other than a site-visit request.
  if (!next) {
    if (!CUSTOMER_QUESTION.test(customerLatest) || isParroting(reply, customerLatest)) {
      const visit = VISIT_QUESTION.test(customerLatest) ? `${VISIT_LINE} ` : '';
      return `Thank you${first}! ${visit}${CLOSING_LINE}`;
    }
    if (VISIT_QUESTION.test(customerLatest) && !CLOSING_OR_VISIT.test(reply)) return `Thank you${first}! ${VISIT_LINE} ${CLOSING_LINE}`;
  } else if (isParroting(reply, customerLatest)) {
    return `Thank you${first}! ${next.question}`;
  } else if (VISIT_QUESTION.test(customerLatest) && /\?|\b(can|could|come)\b/i.test(customerLatest) && !CLOSING_OR_VISIT.test(reply)) {
    // They asked for a visit while details are still missing: acknowledge it, then continue.
    return `${VISIT_LINE} ${next.question}`;
  }

  const sentences = sentencesOf(reply);
  const qIndex = sentences.findIndex((s) => s.endsWith('?'));

  if (qIndex === -1) {
    if (next) return `${reply.trim()} ${next.question}`.trim();
    return /contact|reach out|call you|get in touch/i.test(reply) ? reply : `${reply.trim()} ${CLOSING_LINE}`.trim();
  }

  // Ask in checklist order: if the question is not about the next missing item
  // (already answered, or off-topic like "which design style?"), swap it.
  const question = sentences[qIndex]!;
  const kept = sentences.slice(0, qIndex).join(' ') || 'Thank you!';
  if (!next) {
    // Most specific topics first: "When would you like a site visit?" is about the visit, not the timeline.
    const asked = DETECT_ORDER.map((id) => items.find((i) => i.id === id)).find((i) => i?.asks.test(question));
    return asked ? `${kept} ${CLOSING_LINE}`.trim() : reply;
  }
  return next.asks.test(question) ? sentences.slice(0, qIndex + 1).join(' ') : `${kept} ${next.question}`.trim();
}

/** Which checklist item the (last) question in an AI reply asks about. */
export function askedItem(reply: string): string | null {
  const question = [...sentencesOf(reply)].reverse().find((s) => s.endsWith('?'));
  if (!question) return null;
  return DETECT_ORDER.find((id) => CHECKLIST.find((i) => i.id === id)?.asks.test(question)) ?? null;
}

const DETECT_ORDER = ['site_visit', 'phone', 'name', 'budget', 'property_status', 'project_type', 'property_details', 'location', 'timeline'];
