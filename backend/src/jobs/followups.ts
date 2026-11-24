import { isWithinServiceWindow } from '../channels/whatsapp.js';
import type { Channel, Lead, Tenant } from '../domain/types.js';
import { SALES_OWNED_STATUSES } from '../domain/types.js';
import { sendAndRecord } from '../engine/conversation.js';
import { DAY_MS, type EngineDeps } from '../engine/deps.js';

/** Days to wait before the next follow-up, indexed by follow-ups already sent. */
export const FOLLOWUP_GAPS_DAYS = [1, 2, 4];

export type FollowupDecision =
  | { action: 'stop'; reason: string }
  | { action: 'free_text'; channel: Channel }
  | { action: 'template'; name: string; lang: string }
  | { action: 'skip'; reason: string };

/** The channel the customer last used with us. */
export function leadChannel(lead: Lead): Channel {
  return lead.last_customer_channel ?? (lead.phone_number ? 'whatsapp' : 'instagram');
}

/** Pure decision logic (spec §7 Workflow 03) — easy to test. */
export function decideFollowup(lead: Lead, tenant: Tenant, now: Date): FollowupDecision {
  const max = tenant.settings.max_followups ?? 3;
  if (lead.opted_out) return { action: 'stop', reason: 'opted out' };
  if (lead.ai_paused) return { action: 'stop', reason: 'handled by a human' };
  if (SALES_OWNED_STATUSES.includes(lead.lead_status)) return { action: 'stop', reason: `status ${lead.lead_status}` };
  if (lead.lead_status === 'qualified') return { action: 'stop', reason: 'qualified — sales team follows up' };
  if (lead.followup_count >= max) return { action: 'stop', reason: 'max follow-ups reached' };
  if (lead.last_customer_message_at && lead.last_contacted && lead.last_customer_message_at > lead.last_contacted) {
    return { action: 'stop', reason: 'customer replied' };
  }
  const channel = leadChannel(lead);
  // WhatsApp and Instagram both only allow free-form messages within 24h of the customer's last message.
  if (isWithinServiceWindow(lead.last_customer_message_at, now)) return { action: 'free_text', channel };
  if (channel === 'instagram' || !lead.phone_number) {
    return { action: 'skip', reason: 'Instagram messaging window (24h) has closed — sales team should follow up' };
  }
  const t = tenant.settings.followup_template_name;
  if (t) return { action: 'template', name: t, lang: tenant.settings.followup_template_lang ?? 'en' };
  return { action: 'skip', reason: 'outside 24h window and no approved follow-up template configured' };
}

const FOLLOWUP_SYSTEM = `You write a short, friendly WhatsApp follow-up for an interior design company's enquiry.
One or two sentences. No pressure, no prices, no offers. Ask for at most ONE missing detail.
Reply in the same language the customer used. Output only the message text.`;

export async function runFollowups(deps: EngineDeps, batchSize = 50): Promise<number> {
  const now = deps.now();
  const due = await deps.repo.dueFollowups(now, batchSize);
  let sent = 0;

  for (const lead of due) {
    const tenant = await deps.repo.getTenant(lead.tenant_id);
    if (!tenant) continue;
    const decision = decideFollowup(lead, tenant, now);
    try {
      if (decision.action === 'stop' || decision.action === 'skip') {
        await deps.repo.updateLead(lead.lead_id, { next_followup: null });
        if (decision.action === 'skip') {
          await deps.repo.logError({ tenant_id: tenant.id, lead_id: lead.lead_id, operation: 'followup', message: decision.reason });
        }
        continue;
      }

      if (decision.action === 'free_text') {
        const history = await deps.repo.recentMessages(lead.lead_id, 6);
        const transcript = history
          .map((m) => `${m.sender_type === 'customer' ? 'Customer' : 'Us'}: ${m.incoming_message ?? m.outgoing_message}`)
          .join('\n');
        const text = await deps.llm.generateText(
          FOLLOWUP_SYSTEM,
          `Customer name: ${lead.customer_name ?? 'unknown'}\nStill missing: ${lead.missing_information.join(', ') || 'nothing'}\n\nRecent chat:\n${transcript}`,
        );
        const ok = await sendAndRecord(deps, tenant, lead, decision.channel, text, 'ai', 'followup');
        if (!ok) throw new Error('send failed');
      } else {
        if (!tenant.whatsapp_phone_number_id) throw new Error('tenant has no WhatsApp number');
        if (!lead.phone_number) throw new Error('lead has no phone number');
        await deps.wa.sendTemplate(tenant.whatsapp_phone_number_id, lead.phone_number, decision.name, decision.lang, [
          lead.customer_name ?? 'there',
        ]);
        await deps.repo.insertOutboundMessage({
          tenant_id: tenant.id,
          lead_id: lead.lead_id,
          phone_number: lead.phone_number,
          channel: 'whatsapp',
          text: `[template:${decision.name}]`,
          sender_type: 'system',
          intent: 'followup',
          delivery_status: 'sent',
        });
      }

      const count = lead.followup_count + 1;
      const gap = FOLLOWUP_GAPS_DAYS[count];
      await deps.repo.updateLead(lead.lead_id, {
        followup_count: count,
        last_contacted: now.toISOString(),
        next_followup: gap ? new Date(now.getTime() + gap * DAY_MS).toISOString() : null,
      });
      sent++;
    } catch (err) {
      deps.log.error({ err, leadId: lead.lead_id }, 'follow-up failed');
      await deps.repo.logError({ tenant_id: tenant.id, lead_id: lead.lead_id, operation: 'followup', message: (err as Error).message });
      // Retry in an hour rather than hammering.
      await deps.repo.updateLead(lead.lead_id, { next_followup: new Date(now.getTime() + 60 * 60 * 1000).toISOString() });
    }
  }
  return sent;
}
