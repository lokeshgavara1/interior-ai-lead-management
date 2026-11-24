/**
 * Small/open models (e.g. Mistral 7B via Ollama) return "almost right" JSON:
 * code fences, "Not provided" instead of null, "Apartment" instead of "apartment",
 * "8 lakhs" instead of 800000, missing keys. This normalises such output BEFORE strict
 * validation, so we fix formatting slips without ever accepting invented structure.
 */
import { PROJECT_TYPES, PROPERTY_STATUSES, PROPERTY_TYPES } from '../domain/types.js';
import { parseBudgetInr, toEnum } from '../lib/parse.js';
import { INTENTS } from './schema.js';

/** Values that mean "unknown". */
const PLACEHOLDER = /^(n\/?a|na|nil|none|null|unknown|not (provided|specified|mentioned|given|available|known|required|applicable|sure)|no(t)? (info|information|data|details?)|tbd|tbc|-+|\?+|customer|user|client|sir|madam|not required|no reason|nothing)\.?$/i;

/** Pull the first JSON object out of a reply (handles ```json fences and leading chatter). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('no JSON object found');
}

function cleanString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' || PLACEHOLDER.test(s) ? null : s;
}

function cleanBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true', 'yes', 'y', '1'].includes(v.trim().toLowerCase());
  return v === 1;
}

const PROPERTY_ALIASES = { flat: 'apartment', bhk: 'apartment', villa: 'villa', house: 'independent_house', bungalow: 'independent_house', duplex: 'independent_house', office: 'commercial', shop: 'commercial' } as const;
const PROJECT_ALIASES = { full: 'full_home', entire: 'full_home', whole: 'full_home', complete: 'full_home', kitchen: 'kitchen', wardrobe: 'wardrobe', living: 'living_room', hall: 'living_room', bed: 'bedroom', renov: 'renovation', remodel: 'renovation' } as const;
const STATUS_ALIASES = { construct: 'under_construction', not_ready: 'under_construction', ready: 'ready', complete: 'ready', possession: 'ready' } as const;

export function repairAiOutput(raw: unknown): Record<string, unknown> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // Some models rename "reply" or leave it empty. Keep the extracted facts anyway with a
  // neutral acknowledgement; reply steering then adds the next question.
  const reply = cleanString(o.reply ?? o.response ?? o.message ?? o.answer ?? o.Assistant ?? o.assistant) ?? 'Thank you!';

  const intentRaw = cleanString(o.intent)?.toLowerCase().replace(/[\s-]+/g, '_');
  const intent = intentRaw && (INTENTS as readonly string[]).includes(intentRaw) ? intentRaw : 'other';

  const budgetRaw = o.budget;
  const budget =
    typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) && budgetRaw > 0
      ? budgetRaw
      : typeof budgetRaw === 'string'
        ? parseBudgetInr(budgetRaw)
        : null;

  const date = cleanString(o.expected_start_date);
  const missing = Array.isArray(o.missing_information)
    ? o.missing_information.filter((x): x is string => typeof x === 'string' && !PLACEHOLDER.test(x))
    : [];

  return {
    reply,
    intent,
    customer_name: cleanString(o.customer_name),
    phone_number: cleanString(o.phone_number),
    email: cleanString(o.email),
    location: cleanString(o.location),
    property_type: toEnum(cleanString(o.property_type), PROPERTY_TYPES, PROPERTY_ALIASES),
    property_size: cleanString(o.property_size),
    project_type: toEnum(cleanString(o.project_type), PROJECT_TYPES, PROJECT_ALIASES),
    budget,
    property_status: toEnum(cleanString(o.property_status), PROPERTY_STATUSES, STATUS_ALIASES),
    timeline_text: cleanString(o.timeline_text ?? o.timeline),
    expected_start_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    requirements: cleanString(o.requirements),
    site_visit_requested: cleanBool(o.site_visit_requested),
    needs_human: cleanBool(o.needs_human),
    human_reason: cleanString(o.human_reason),
    missing_information: missing,
  };
}
