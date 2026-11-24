/**
 * Last line of defence on every outgoing AI reply (spec §4.4: "Never invent prices,
 * discounts or project completion dates").
 *
 * - Prices: any money amount in the reply that does not appear in the business's
 *   approved knowledge base -> the reply is replaced with the approved quotation line.
 * - Small-model rambling (lists, very long replies) -> trimmed to a short reply.
 */

import { parseBudgetInr } from '../lib/parse.js';

export const QUOTE_LINE = 'Our designer will share a detailed quotation after understanding your requirements and visiting the site.';

/** Money amounts: ₹/Rs/INR amounts, "1.5 lakhs", "2 crore", "50,000". */
const MONEY = /(?:₹|\brs\.?|\binr\b)\s*[\d,.]+(?:\s*(?:lakhs?|lacs?|l|crores?|cr|k))?|\b\d+(?:[.,]\d+)*\s*(?:lakhs?|lacs?|crores?|cr)\b|\b\d{1,3}(?:,\d{2,3})+\b/gi;

const DISCOUNT = /\b(\d+\s*%\s*(off|discount)|discount of|flat \d+|special offer|free (of cost|installation|design))\b/i;

function normaliseAmount(s: string): string {
  return s.toLowerCase().replace(/₹|\brs\.?|\binr\b|\s|,/g, '');
}

/**
 * True if the reply quotes an amount or discount the business has not approved.
 * Allowed: amounts written in the knowledge base or by the customer, and the customer's
 * own budget repeated back in any format ("8 lakhs" -> "₹8,00,000").
 */
export function hasUnapprovedPrice(reply: string, allowedText: string, allowedValues: number[] = []): boolean {
  const allowed = normaliseAmount(allowedText);
  const amounts = reply.match(MONEY) ?? [];
  const unapproved = amounts.some((a) => {
    if (allowed.includes(normaliseAmount(a))) return false;
    const value = parseBudgetInr(a);
    return value == null || !allowedValues.includes(value);
  });
  if (unapproved) return true;
  return DISCOUNT.test(reply) && !DISCOUNT.test(allowedText);
}

/** "Kondapur, Hyderabad Is your flat ready?" -> "Kondapur, Hyderabad. Is your flat ready?" */
export function fixRunOn(reply: string): string {
  return reply.replace(/([a-z0-9)])\s+(Is|Are|Do|Does|Could|Would|May|What|When|Which|Where|How|Can|Will)\s/g, '$1. $2 ');
}

/** Abbreviations that end with a dot but don't end a sentence. */
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|approx|rs|no|sq|ft|mr|mrs|ms|dr|vs)\.(?=\s)/gi;

/** Split into sentences without breaking decimals ("1.5") or abbreviations ("e.g. 3BHK"). */
export function sentencesOf(text: string): string[] {
  return text
    .replace(ABBREVIATIONS, (m) => m.replace(/\./g, '․'))
    .split(/(?<=[.!?])\s+(?=["'(\p{Lu}\d])/u)
    .map((s) => s.replace(/․/g, '.').trim())
    .filter(Boolean);
}

const LISTY = /(^|\n)\s*([*•-]|\d+[.)])\s+/;

/** "I will arrange the visit on Saturday", "your appointment is booked" — the AI can't book anything. */
const BOOKING_CLAIM =
  /\b(i|we)('ll| will| have| shall|'ve)\s+(arrange|schedule|book|fix|confirm|send)[^.?!]*\b(visit|appointment|meeting|designer)\b|\b(visit|appointment|meeting)\s+(is|has been|was)\s+(booked|scheduled|confirmed|fixed|arranged)\b|\b(designer|team|we|i|someone)\s*('ll| will| shall| can)\s+(visit|come|be there|meet you)\b[^.?!]*\b(on|this|tomorrow|today|at|by)\b|\b(we|i) can (arrange|schedule|book|fix)[^.?!]*\b(visit|appointment|meeting)\b[^.?!]*\b(on|this|tomorrow|today|at|by)\b/i;

/** Sentences that only make sense next to the (removed) amounts. */
const ESTIMATE_TALK = /\b(estimate|breakdown|approximate costs?|rough (cost|idea|figure)|costs? (may|will|might) vary|excluding gst|including gst)\b/i;

/** Customer asked about money -> the quotation line is the right answer. */
export const PRICE_QUESTION = /\b(price|pricing|cost|costs|rate|rates|charges?|quote|quotation|estimate|how much|budget range|per sq)/i;
export function hasBookingClaim(reply: string): boolean {
  return BOOKING_CLAIM.test(reply);
}
export const VISIT_LINE = 'Our team will call you to confirm a convenient time for the site visit.';

export interface GuardResult {
  reply: string;
  /** Why the reply was changed (for the audit log), or null. */
  changed: 'price' | 'booking' | 'too_long' | null;
}

/**
 * @param allowedText    approved knowledge base + everything the customer wrote
 * @param customerLatest the customer's newest message (decides the wording of fixes)
 */
export function guardReply(
  reply: string,
  allowedText: string,
  smallModel: boolean,
  allowedValues: number[] = [],
  customerLatest = '',
): GuardResult {
  if (BOOKING_CLAIM.test(reply)) {
    const kept = sentencesOf(reply).filter((s) => !BOOKING_CLAIM.test(s) && !s.endsWith('?') && !/contact details|phone number|address/i.test(s));
    const ack = kept[0] && kept[0].length <= 100 && !hasUnapprovedPrice(kept[0], allowedText, allowedValues) ? `${kept[0]} ` : '';
    return { reply: `${ack}${VISIT_LINE}`.trim(), changed: 'booking' };
  }
  if (hasUnapprovedPrice(reply, allowedText, allowedValues)) {
    // Strip bullet markers (a question can hide on a list line), then drop every sentence
    // that has an amount or introduces an estimate.
    const lines = reply
      .split(/\n+/)
      .map((l) => l.replace(/^\s*([*•-]|\d+[.)])\s+/, ''))
      .join(' ');
    const clean = sentencesOf(fixRunOn(lines)).filter((s) => !hasUnapprovedPrice(s, allowedText, allowedValues) && !ESTIMATE_TALK.test(s));
    if (PRICE_QUESTION.test(customerLatest)) {
      // They asked about price: answer with the approved line (+ any price-free question).
      const question = clean.find((s) => s.endsWith('?'));
      return { reply: [QUOTE_LINE, question].filter(Boolean).join(' '), changed: 'price' };
    }
    // They didn't ask: just drop the sentences with amounts.
    return { reply: clean.join(' ') || 'Thank you!', changed: 'price' };
  }
  if (smallModel && (reply.length > 240 || LISTY.test(reply))) {
    const sentences = sentencesOf(reply.replace(/\n+/g, ' ')).filter((s) => !LISTY.test(s));
    const question = sentences.find((s) => s.endsWith('?'));
    const first = sentences[0] && !sentences[0].endsWith('?') && sentences[0].length <= 100 ? sentences[0] : '';
    // If they asked about price, the approved answer must survive the trim.
    const quote = PRICE_QUESTION.test(customerLatest) ? QUOTE_LINE : '';
    return { reply: [first, quote, question].filter(Boolean).join(' ') || 'Thank you!', changed: 'too_long' };
  }
  return { reply, changed: null };
}
