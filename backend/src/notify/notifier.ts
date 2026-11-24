import nodemailer from 'nodemailer';
import type { Lead, Tenant } from '../domain/types.js';
import type { Repo } from '../db/repo.js';
import type { WhatsAppSender } from '../channels/whatsapp.js';

export type AlertKind =
  | 'new_lead'
  | 'hot_lead'
  | 'site_visit'
  | 'human_needed'
  | 'high_value'
  | 'ready_to_proceed'
  | 'followup_overdue'
  | 'ai_failure';

const TITLES: Record<AlertKind, string> = {
  new_lead: 'NEW LEAD – INTERIOR ENQUIRY',
  hot_lead: 'NEW HOT LEAD – INTERIOR ENQUIRY',
  site_visit: 'SITE VISIT REQUESTED',
  human_needed: 'CUSTOMER NEEDS A HUMAN',
  high_value: 'HIGH-VALUE ENQUIRY',
  ready_to_proceed: 'CUSTOMER READY TO PROCEED',
  followup_overdue: 'FOLLOW-UP OVERDUE',
  ai_failure: 'AI COULD NOT RESPOND – PLEASE CHECK',
};

const ACTIONS: Record<AlertKind, string> = {
  new_lead: 'Call the customer to understand the requirement.',
  hot_lead: 'Contact customer and arrange a site visit.',
  site_visit: 'Call the customer to confirm a site-visit slot.',
  human_needed: 'Reply to the customer personally. AI is paused for this lead.',
  high_value: 'Prioritise: senior designer should call.',
  ready_to_proceed: 'Call now to confirm next steps (site visit / quotation).',
  followup_overdue: 'Contact the customer today and update the lead status.',
  ai_failure: 'Reply to the customer manually.',
};

const LABELS: Record<string, string> = {
  apartment: 'Apartment',
  villa: 'Villa',
  independent_house: 'Independent House',
  commercial: 'Commercial',
  full_home: 'Full Home Interiors',
  kitchen: 'Kitchen',
  wardrobe: 'Wardrobe',
  living_room: 'Living Room',
  bedroom: 'Bedroom',
  renovation: 'Renovation',
  other: 'Other',
};

const label = (v: string | null) => (v ? (LABELS[v] ?? v) : '—');
const inr = (n: number | null) => (n == null ? '—' : `₹${n.toLocaleString('en-IN')}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Spec §8.2 format. */
export function formatAlert(kind: AlertKind, lead: Lead, reason?: string | null): string {
  const property = [lead.property_size, lead.property_type ? label(lead.property_type) : null].filter(Boolean).join(' ') || '—';
  const lines = [
    TITLES[kind],
    `Customer Name: ${lead.customer_name ?? '—'}`,
    `Phone: ${lead.phone_number ?? (lead.instagram_id ? 'Not shared yet (Instagram DM)' : '—')}`,
    `Location: ${lead.location ?? '—'}`,
    `Property: ${property}`,
    `Project: ${label(lead.project_type)}`,
    `Budget: ${inr(lead.budget)}`,
    `Timeline: ${lead.timeline_text ?? lead.expected_start_date ?? '—'}`,
    `Lead Source: ${cap(lead.lead_source)}`,
    `Lead Score: ${lead.lead_score ?? '—'}/100 (${cap(lead.lead_temperature)})`,
  ];
  if (lead.assigned_salesperson) lines.push(`Assigned To: ${lead.assigned_salesperson}`);
  if (reason) lines.push(`Reason: ${reason}`);
  lines.push(`Recommended Action: ${ACTIONS[kind]}`);
  return lines.join('\n');
}

/** Managers always get alerts; the assigned salesperson gets alerts for their leads. */
export function alertRecipients(tenant: Tenant, lead: Lead): { whatsapp: string[]; emails: string[] } {
  const s = tenant.settings;
  const person = lead.assigned_salesperson ? s.salespeople?.find((p) => p.name === lead.assigned_salesperson) : undefined;
  const whatsapp = [...(s.sales_whatsapp_numbers ?? []), ...(person?.whatsapp ? [person.whatsapp] : [])];
  const emails = [...(s.sales_emails ?? []), ...(person?.email ? [person.email] : [])];
  return { whatsapp: [...new Set(whatsapp)], emails: [...new Set(emails)] };
}

export interface Notifier {
  /** Sends an alert once per dedupeKey. Failures are logged, never thrown. */
  alert(tenant: Tenant, lead: Lead, kind: AlertKind, dedupeKey: string, reason?: string | null): Promise<void>;
}

export interface EmailConfig {
  host?: string;
  port: number;
  user?: string;
  pass?: string;
  from?: string;
}

export function createNotifier(repo: Repo, wa: WhatsAppSender, email: EmailConfig): Notifier {
  const mailer =
    email.host && email.from
      ? nodemailer.createTransport({
          host: email.host,
          port: email.port,
          secure: email.port === 465,
          auth: email.user ? { user: email.user, pass: email.pass } : undefined,
        })
      : null;

  return {
    async alert(tenant, lead, kind, dedupeKey, reason) {
      const text = formatAlert(kind, lead, reason);
      const id = await repo.createNotification({
        tenant_id: tenant.id,
        lead_id: lead.lead_id,
        kind,
        dedupe_key: dedupeKey,
        payload: { text },
      });
      if (!id) return; // already notified

      const s = tenant.settings;
      const errors: string[] = [];
      let delivered = 0;
      const { whatsapp, emails } = alertRecipients(tenant, lead);

      for (const number of whatsapp) {
        try {
          if (!tenant.whatsapp_phone_number_id) throw new Error('tenant has no WhatsApp number configured');
          if (s.alert_template_name) {
            // Template params: {{1}} title, {{2}} name, {{3}} phone, {{4}} summary
            await wa.sendTemplate(tenant.whatsapp_phone_number_id, number, s.alert_template_name, s.alert_template_lang ?? 'en', [
              TITLES[kind],
              lead.customer_name ?? 'Unknown',
              lead.phone_number ?? 'Instagram DM',
              `${label(lead.project_type)}, ${lead.location ?? 'location unknown'}, ${inr(lead.budget)}, score ${lead.lead_score ?? '-'}`,
            ]);
          } else {
            // Free text only reaches staff who messaged the business number in the last 24h.
            await wa.sendText(tenant.whatsapp_phone_number_id, number, text);
          }
          delivered++;
        } catch (err) {
          errors.push(`whatsapp ${number}: ${(err as Error).message}`);
        }
      }

      if (mailer && emails.length > 0) {
        try {
          await mailer.sendMail({
            from: email.from,
            to: emails,
            subject: `${TITLES[kind]} – ${lead.customer_name ?? lead.phone_number ?? 'Instagram lead'}`,
            text,
          });
          delivered++;
        } catch (err) {
          errors.push(`email: ${(err as Error).message}`);
        }
      }

      if (delivered > 0) {
        await repo.setNotificationStatus(id, 'sent', errors.length ? errors.join('; ') : undefined);
      } else {
        const msg = errors.length ? errors.join('; ') : 'no notification channel configured';
        await repo.setNotificationStatus(id, 'failed', msg);
        await repo.logError({ tenant_id: tenant.id, lead_id: lead.lead_id, operation: 'notify', message: msg, details: { kind } });
      }
    },
  };
}
