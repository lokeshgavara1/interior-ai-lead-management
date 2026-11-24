import { z } from 'zod';
import type { IgInboundMessage, LeadgenData, LeadgenEvent } from '../channels/meta.js';
import type { WaInboundMessage, WaStatusUpdate } from '../channels/whatsapp.js';
import {
  PROJECT_TYPES,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  type Lead,
  type LeadFacts,
  type LeadSource,
  type Tenant,
} from '../domain/types.js';
import { parseBudgetInr, toEnum } from '../lib/parse.js';
import { normalizePhone } from '../lib/phone.js';
import type { EngineDeps } from './deps.js';
import type { Inbox } from './inbox.js';
import { mergeFacts } from './merge.js';
import { applySalesWorkflow } from './sales.js';
import { deriveStatus, missingFacts, scoreLead } from './scoring.js';

// ---------------------------------------------------------------------------
// Chat channels: store durably, then schedule AI processing (debounced)
// ---------------------------------------------------------------------------

/** Called before acknowledging the webhook, so nothing is lost if we crash. */
export async function ingestWhatsAppMessage(deps: EngineDeps, inbox: Inbox, msg: WaInboundMessage): Promise<void> {
  const tenant = await deps.repo.getTenantByPhoneNumberId(msg.phoneNumberId);
  if (!tenant) {
    deps.log.warn({ phoneNumberId: msg.phoneNumberId }, 'message for unknown phone_number_id — no tenant configured');
    return;
  }
  const phone = normalizePhone(`+${msg.from}`, tenant.default_country_code);
  if (!phone) {
    await deps.repo.logError({ tenant_id: tenant.id, operation: 'ingest_whatsapp', message: `invalid sender ${msg.from}` });
    return;
  }
  const { lead } = await deps.repo.findOrCreateLead(tenant.id, { phone_number: phone }, 'whatsapp');
  const inserted = await deps.repo.insertInboundMessage({
    tenant_id: tenant.id,
    lead_id: lead.lead_id,
    phone_number: phone,
    channel: 'whatsapp',
    text: msg.text,
    external_message_id: msg.messageId,
    message_timestamp: msg.timestamp,
  });
  if (inserted) inbox.schedule(lead.lead_id);
  else deps.log.info({ messageId: msg.messageId }, 'duplicate webhook delivery ignored');
}

export async function ingestWhatsAppStatus(deps: EngineDeps, s: WaStatusUpdate): Promise<void> {
  const tenant = await deps.repo.getTenantByPhoneNumberId(s.phoneNumberId);
  if (tenant) await deps.repo.updateDeliveryStatus(tenant.id, s.messageId, s.status);
}

/** Spec §3.3: Instagram DM -> lead identified by Instagram-scoped id. */
export async function ingestInstagramMessage(deps: EngineDeps, inbox: Inbox, msg: IgInboundMessage): Promise<void> {
  const tenant = await deps.repo.getTenantByInstagramId(msg.igAccountId);
  if (!tenant) {
    deps.log.warn({ igAccountId: msg.igAccountId }, 'Instagram message for unknown account — no tenant configured');
    return;
  }
  const { lead } = await deps.repo.findOrCreateLead(tenant.id, { instagram_id: msg.senderId }, 'instagram');
  const inserted = await deps.repo.insertInboundMessage({
    tenant_id: tenant.id,
    lead_id: lead.lead_id,
    phone_number: lead.phone_number,
    channel: 'instagram',
    text: msg.text,
    external_message_id: msg.messageId,
    message_timestamp: msg.timestamp,
  });
  if (inserted) inbox.schedule(lead.lead_id);
}

// ---------------------------------------------------------------------------
// Form leads (website §3.2, Facebook Lead Ads §3.4) — no AI conversation
// ---------------------------------------------------------------------------

export interface FormLeadInput {
  phone: string;
  facts: Partial<LeadFacts>;
  source: LeadSource;
  /** Customer agreed to be contacted on WhatsApp -> send the ack template. */
  whatsappConsent: boolean;
  eventKey: string;
  extraNote?: string | null;
}

export async function ingestFormLead(
  deps: EngineDeps,
  tenant: Tenant,
  input: FormLeadInput,
): Promise<{ lead: Lead; created: boolean } | { error: string }> {
  const phone = normalizePhone(input.phone, tenant.default_country_code);
  if (!phone) return { error: 'invalid phone_number' };

  const { lead: existing, created } = await deps.repo.findOrCreateLead(tenant.id, { phone_number: phone }, input.source);
  const changes = mergeFacts(existing, input.facts);
  const merged: Lead = { ...existing, ...changes };
  const score = scoreLead(merged, deps.now());
  const status = deriveStatus(existing.lead_status, merged);
  const notes = input.extraNote ? [existing.notes, input.extraNote].filter(Boolean).join('\n') : existing.notes;

  let lead = await deps.repo.updateLead(existing.lead_id, {
    ...changes,
    notes,
    lead_score: score.score,
    lead_temperature: score.temperature,
    lead_status: status,
    missing_information: missingFacts(merged),
  });
  await deps.repo.audit({
    tenant_id: tenant.id,
    actor: 'system',
    action: created ? 'lead_created' : 'lead_updated',
    entity: 'lead',
    entity_id: lead.lead_id,
    details: { source: input.source, changes },
  });

  // Acknowledge on WhatsApp — only with consent and an approved template
  // (business-initiated messages outside the 24h window require templates).
  const s = tenant.settings;
  if (created && input.whatsappConsent && s.ack_template_name && tenant.whatsapp_phone_number_id) {
    try {
      await deps.wa.sendTemplate(tenant.whatsapp_phone_number_id, phone, s.ack_template_name, s.ack_template_lang ?? 'en', [
        lead.customer_name ?? 'there',
      ]);
      await deps.repo.insertOutboundMessage({
        tenant_id: tenant.id,
        lead_id: lead.lead_id,
        phone_number: phone,
        channel: 'whatsapp',
        text: `[template:${s.ack_template_name}]`,
        sender_type: 'system',
        intent: 'acknowledgement',
        delivery_status: 'sent',
      });
      lead = await deps.repo.updateLead(lead.lead_id, { last_contacted: deps.now().toISOString() });
    } catch (err) {
      await deps.repo.logError({ tenant_id: tenant.id, lead_id: lead.lead_id, operation: 'form_ack', message: (err as Error).message });
    }
  }

  lead = await applySalesWorkflow(deps, tenant, lead, { newFormLead: created, eventKey: input.eventKey });
  return { lead, created };
}

// --- Website form ---

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optText = z.preprocess(blankToNull, z.string().trim().max(500).nullish());

export const WebsiteFormSchema = z.object({
  customer_name: z.string().trim().min(1).max(120),
  phone_number: z.string().trim().min(8).max(20),
  email: z.preprocess(blankToNull, z.string().trim().email().nullish()),
  property_type: z.preprocess(blankToNull, z.enum(PROPERTY_TYPES).nullish()),
  property_location: optText,
  property_size: optText,
  project_type: z.preprocess(blankToNull, z.enum(PROJECT_TYPES).nullish()),
  property_status: z.preprocess(blankToNull, z.enum(PROPERTY_STATUSES).nullish()),
  project_requirements: z.preprocess(blankToNull, z.string().trim().max(2000).nullish()),
  approximate_budget: z.preprocess(blankToNull, z.coerce.number().nonnegative().nullish()),
  expected_start_date: z.preprocess(blankToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish()),
  whatsapp_consent: z.coerce.boolean().default(false),
});
export type WebsiteForm = z.infer<typeof WebsiteFormSchema>;

export function ingestWebsiteForm(deps: EngineDeps, tenant: Tenant, form: WebsiteForm) {
  return ingestFormLead(deps, tenant, {
    phone: form.phone_number,
    source: 'website',
    whatsappConsent: form.whatsapp_consent,
    eventKey: `website:${form.phone_number}:${deps.now().getTime()}`,
    facts: {
      customer_name: form.customer_name,
      email: form.email ?? null,
      location: form.property_location ?? null,
      property_type: form.property_type ?? null,
      property_size: form.property_size ?? null,
      project_type: form.project_type ?? null,
      property_status: form.property_status ?? null,
      budget: form.approximate_budget ?? null,
      expected_start_date: form.expected_start_date ?? null,
      requirements: form.project_requirements ?? null,
    },
  });
}

// --- Facebook Lead Ads ---

const PROPERTY_TYPE_ALIASES = { flat: 'apartment', villa: 'villa', house: 'independent_house', office: 'commercial', shop: 'commercial' } as const;
const PROJECT_TYPE_ALIASES = { full: 'full_home', complete: 'full_home', kitchen: 'kitchen', wardrobe: 'wardrobe', living: 'living_room', bed: 'bedroom', renov: 'renovation' } as const;
const STATUS_ALIASES = { ready: 'ready', complete: 'ready', possession: 'ready', construction: 'under_construction', progress: 'under_construction' } as const;

/** Maps Lead Ads field_data onto lead facts. Unknown questions become notes for the team. */
export function mapLeadgenFields(data: LeadgenData, fieldMap: Record<string, string> = {}) {
  const get = (name: string) => data.field_data.find((f) => f.name === name)?.values?.[0]?.trim() || null;
  const facts: Partial<LeadFacts> = {};
  const extras: string[] = [];
  const first = get('first_name');
  const last = get('last_name');
  facts.customer_name = get('full_name') ?? ([first, last].filter(Boolean).join(' ') || null);
  facts.email = get('email');
  facts.location = get('city');
  const phone = get('phone_number') ?? get('phone');

  const standard = new Set(['full_name', 'first_name', 'last_name', 'email', 'city', 'phone_number', 'phone']);
  for (const field of data.field_data) {
    if (standard.has(field.name)) continue;
    const value = field.values?.join(', ').trim();
    if (!value) continue;
    const target = fieldMap[field.name];
    switch (target) {
      case 'location':
      case 'property_size':
      case 'timeline_text':
      case 'requirements':
        facts[target] = value;
        break;
      case 'property_type':
        facts.property_type = toEnum(value, PROPERTY_TYPES, PROPERTY_TYPE_ALIASES);
        if (!facts.property_type) extras.push(`${field.name}: ${value}`);
        break;
      case 'project_type':
        facts.project_type = toEnum(value, PROJECT_TYPES, PROJECT_TYPE_ALIASES);
        if (!facts.project_type) extras.push(`${field.name}: ${value}`);
        break;
      case 'property_status':
        facts.property_status = toEnum(value, PROPERTY_STATUSES, STATUS_ALIASES);
        if (!facts.property_status) extras.push(`${field.name}: ${value}`);
        break;
      case 'budget':
        facts.budget = parseBudgetInr(value);
        if (facts.budget == null) extras.push(`${field.name}: ${value}`);
        break;
      default:
        extras.push(`${field.name.replace(/_/g, ' ')}: ${value}`);
    }
  }
  return { phone, facts, note: extras.length ? `Lead form answers — ${extras.join('; ')}` : null };
}

/**
 * Spec §3.4. Safe to run twice for the same leadgen id (lead upsert by phone,
 * idempotent merge, deduplicated alerts), so we mark it processed only after success.
 */
export async function ingestLeadgen(deps: EngineDeps, ev: LeadgenEvent): Promise<void> {
  const key = `leadgen:${ev.leadgenId}`;
  if (await deps.repo.isEventProcessed(key)) return;
  const tenant = await deps.repo.getTenantByPageId(ev.pageId);
  if (!tenant) {
    deps.log.warn({ pageId: ev.pageId }, 'leadgen for unknown page — no tenant configured');
    return;
  }
  const token = await deps.repo.getPageAccessToken(tenant.id);
  if (!token) throw new Error(`Tenant ${tenant.slug} has no page access token`);

  const data = await deps.meta.fetchLeadgen(token, ev.leadgenId);
  const { phone, facts, note } = mapLeadgenFields(data, tenant.settings.lead_ads_field_map);
  if (!phone) {
    await deps.repo.logError({ tenant_id: tenant.id, operation: 'leadgen', message: `lead ${ev.leadgenId} has no phone number` });
  } else {
    const res = await ingestFormLead(deps, tenant, {
      phone,
      facts,
      source: 'facebook',
      whatsappConsent: tenant.settings.lead_ads_whatsapp_ack === true,
      eventKey: key,
      extraNote: note,
    });
    if ('error' in res) {
      await deps.repo.logError({ tenant_id: tenant.id, operation: 'leadgen', message: `lead ${ev.leadgenId}: ${res.error}` });
    }
  }
  await deps.repo.markEventProcessed(key, tenant.id);
}
