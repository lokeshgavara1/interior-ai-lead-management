import { skippedItems, steerReply } from '../ai/checklist.js';
import { knownAreas, postProcessTurn } from '../ai/grounding.js';
import { guardReply } from '../ai/replyGuard.js';
import type { AiTurn } from '../ai/schema.js';
import { buildSystemPrompt, toChatMessages } from '../ai/prompt.js';
import type { Channel, Lead, LeadFacts, SenderType, Tenant } from '../domain/types.js';
import { AI_FOLLOWUP_STATUSES, SALES_OWNED_STATUSES } from '../domain/types.js';
import { normalizePhone } from '../lib/phone.js';
import { DAY_MS, localDate, type EngineDeps } from './deps.js';
import { mergeFacts } from './merge.js';
import { isHumanRequest, isOptOut, OPT_OUT_CONFIRMATION } from './optout.js';
import { applySalesWorkflow } from './sales.js';
import { deriveStatus, missingFacts, scoreLead } from './scoring.js';

export const FALLBACK_REPLY = 'Thank you for your message! Our team will get back to you shortly.';
export const HUMAN_HANDOFF_REPLY = "Of course! I've informed our team — a team member will reach out to you shortly.";

function factsFromTurn(t: AiTurn): Partial<LeadFacts> {
  return {
    customer_name: t.customer_name,
    email: t.email,
    location: t.location,
    property_type: t.property_type,
    property_size: t.property_size,
    project_type: t.project_type,
    budget: t.budget,
    property_status: t.property_status,
    timeline_text: t.timeline_text,
    expected_start_date: t.expected_start_date,
    requirements: t.requirements,
  };
}

/** Send a message to the customer on the given channel and record it in history. Never throws. */
export async function sendAndRecord(
  deps: EngineDeps,
  tenant: Tenant,
  lead: Lead,
  channel: Channel,
  text: string,
  sender: Exclude<SenderType, 'customer'>,
  intent: string | null = null,
): Promise<boolean> {
  const row = await deps.repo.insertOutboundMessage({
    tenant_id: tenant.id,
    lead_id: lead.lead_id,
    phone_number: lead.phone_number,
    channel,
    text,
    sender_type: sender,
    intent,
    delivery_status: 'queued',
  });
  try {
    let externalId: string;
    if (channel === 'whatsapp') {
      if (!tenant.whatsapp_phone_number_id) throw new Error('Tenant has no WhatsApp phone_number_id');
      if (!lead.phone_number) throw new Error('Lead has no phone number');
      externalId = await deps.wa.sendText(tenant.whatsapp_phone_number_id, lead.phone_number, text);
    } else if (channel === 'instagram') {
      if (!lead.instagram_id) throw new Error('Lead has no Instagram id');
      const token = await deps.repo.getPageAccessToken(tenant.id);
      if (!token) throw new Error('Tenant has no page access token (tenant_secrets)');
      externalId = await deps.meta.sendInstagramText(token, lead.instagram_id, text);
    } else {
      throw new Error(`Sending on channel "${channel}" is not supported`);
    }
    await deps.repo.setOutboundExternalId(row.conversation_id, externalId || null, 'sent');
    return true;
  } catch (err) {
    await deps.repo.setOutboundExternalId(row.conversation_id, null, 'failed');
    await deps.repo.logError({
      tenant_id: tenant.id,
      lead_id: lead.lead_id,
      operation: 'send_message',
      message: (err as Error).message,
      details: { channel },
    });
    deps.log.error({ err, leadId: lead.lead_id }, 'failed to send message');
    return false;
  }
}

/**
 * A phone number typed in an Instagram chat: attach it to the lead unless it
 * already belongs to another lead (then flag it for the team instead of merging).
 */
async function phonePatch(deps: EngineDeps, tenant: Tenant, lead: Lead, raw: string | null): Promise<Partial<Lead>> {
  if (!raw || lead.phone_number) return {};
  const phone = normalizePhone(raw, tenant.default_country_code);
  if (!phone) return {};
  const other = await deps.repo.findLeadByPhone(tenant.id, phone);
  if (other && other.lead_id !== lead.lead_id) {
    await deps.repo.audit({
      tenant_id: tenant.id,
      actor: 'system',
      action: 'duplicate_suspected',
      entity: 'lead',
      entity_id: lead.lead_id,
      details: { phone, existing_lead_id: other.lead_id },
    });
    const note = `Shared phone ${phone}, which already belongs to lead ${other.lead_id}.`;
    return { notes: lead.notes ? `${lead.notes}\n${note}` : note };
  }
  return { phone_number: phone };
}

/**
 * Workflow 01 + 02 for one lead: take every pending customer message (a merged
 * burst), run the AI receptionist, update CRM, score, reply, assign, notify.
 */
export async function processLead(deps: EngineDeps, leadId: string): Promise<void> {
  const { repo, log } = deps;
  const claimed = await repo.claimPendingMessages(leadId);
  if (claimed.length === 0) return;
  const ids = claimed.map((m) => m.conversation_id);
  const channel = claimed[claimed.length - 1]!.channel;
  const combinedText = claimed.map((m) => m.incoming_message ?? '').join('\n');
  const now = deps.now();

  let lead = await repo.getLead(leadId);
  const tenant = lead ? await repo.getTenant(lead.tenant_id) : null;
  if (!lead || !tenant) {
    await repo.setProcessingStatus(ids, 'failed');
    await repo.logError({ lead_id: leadId, operation: 'process_lead', message: 'lead or tenant not found' });
    return;
  }

  try {
    // Customer activity opens the messaging window and resets the AI follow-up
    // cycle. A salesperson's own follow-up date (later statuses) is left alone.
    // A customer who writes to us again has re-engaged, so opt-out is lifted.
    const activity: Partial<Lead> = {
      last_customer_message_at: claimed[claimed.length - 1]!.message_timestamp,
      last_customer_channel: channel,
      opted_out: false,
    };
    if (AI_FOLLOWUP_STATUSES.includes(lead.lead_status)) {
      activity.followup_count = 0;
      activity.next_followup = null;
    }
    lead = await repo.updateLead(leadId, activity);

    // 1. Hard opt-out check — before the AI, so it works even if the AI is down.
    if (isOptOut(combinedText)) {
      await optOut(deps, tenant, lead, channel, ids);
      return;
    }

    // 2. Human takeover: store the message, stay silent.
    if (lead.ai_paused) {
      await repo.setProcessingStatus(ids, 'done');
      return;
    }

    // 3. AI receptionist
    const history = await repo.recentMessages(leadId, deps.historyLimit);
    // The last thing we said; for slot filling, skip over a fallback/system message so the
    // customer's answer is matched to the last real question.
    const ours = [...history].reverse().filter((m) => m.sender_type === 'ai' || m.sender_type === 'system');
    const previousReply = ours.find((m) => m.outgoing_message?.includes('?'))?.outgoing_message ?? ours[0]?.outgoing_message ?? null;
    const isFirstReply = !history.some((m) => m.sender_type === 'ai');
    const skipped = skippedItems(history);
    const system = buildSystemPrompt(tenant, lead, localDate(now, tenant.timezone), channel, isFirstReply, skipped);
    const customerText = history
      .filter((m) => m.sender_type === 'customer')
      .map((m) => m.incoming_message ?? '')
      .join('\n');
    let turn: AiTurn;
    try {
      const raw = await deps.llm.receptionistTurn(system, toChatMessages(history));
      turn = postProcessTurn(raw, {
        customerText,
        latestText: combinedText,
        today: localDate(now, tenant.timezone),
        grounding: deps.factGrounding ?? false,
        isFirstReply,
        previousReply,
        areas: knownAreas(tenant.knowledge_base),
      });
    } catch (err) {
      log.error({ err, leadId }, 'AI turn failed');
      await repo.logError({ tenant_id: tenant.id, lead_id: leadId, operation: 'ai_turn', message: (err as Error).message });
      await sendAndRecord(deps, tenant, lead, channel, FALLBACK_REPLY, 'system');
      await repo.setProcessingStatus(ids, 'failed');
      await deps.notifier.alert(tenant, lead, 'ai_failure', `ai_failure:${ids[0]}`, (err as Error).message);
      return;
    }

    if (turn.intent === 'opt_out') {
      await optOut(deps, tenant, lead, channel, ids);
      return;
    }

    // 4. Merge facts (never erase known data), score, classify
    const changes = mergeFacts(lead, factsFromTurn(turn));
    const merged: Lead = { ...lead, ...changes };
    const siteVisit = lead.site_visit_requested || turn.site_visit_requested || turn.intent === 'site_visit_request';
    const explicitHuman = isHumanRequest(combinedText);
    const needsHuman = explicitHuman || turn.needs_human || turn.intent === 'human_request' || turn.intent === 'complaint';
    if (explicitHuman && !turn.needs_human) {
      turn.reply = HUMAN_HANDOFF_REPLY;
      turn.human_reason = turn.human_reason ?? 'Customer asked to speak to a person';
    }
    const score = scoreLead({ ...merged, site_visit_requested: siteVisit }, now);
    const status = deriveStatus(lead.lead_status, merged);
    // Never send invented prices (all models); trim small-model rambling.
    const guarded = guardReply(
      turn.reply,
      `${tenant.knowledge_base}\n${customerText}`,
      deps.factGrounding ?? false,
      merged.budget != null ? [merged.budget] : [],
      combinedText,
    );
    if (guarded.changed) {
      await repo.audit({
        tenant_id: tenant.id,
        actor: 'system',
        action: `reply_guard_${guarded.changed}`,
        entity: 'lead',
        entity_id: leadId,
        details: { original: turn.reply, sent: guarded.reply },
      });
      turn.reply = guarded.reply;
    }
    // Small-model assist: make sure the reply asks the next missing detail, not an answered one.
    if (deps.factGrounding && !needsHuman) {
      turn.reply = steerReply(turn.reply, { ...merged, site_visit_requested: siteVisit }, channel, combinedText, skipped);
    }

    const patch: Partial<Lead> = {
      ...changes,
      ...(await phonePatch(deps, tenant, lead, turn.phone_number)),
      site_visit_requested: siteVisit,
      lead_score: score.score,
      lead_temperature: score.temperature,
      lead_status: status,
      missing_information: missingFacts(merged),
      needs_human: lead.needs_human || needsHuman,
      ai_paused: needsHuman ? true : lead.ai_paused,
      last_contacted: now.toISOString(),
    };
    // AI follow-ups only while the lead is still being qualified by the AI.
    if (!SALES_OWNED_STATUSES.includes(status)) {
      patch.next_followup =
        !needsHuman && AI_FOLLOWUP_STATUSES.includes(status) ? new Date(now.getTime() + DAY_MS).toISOString() : null;
    }
    const updated = await repo.updateLead(leadId, patch);

    // 5. Reply
    await sendAndRecord(deps, tenant, updated, channel, turn.reply, 'ai', turn.intent);
    await repo.setProcessingStatus(ids, 'done');
    await repo.audit({
      tenant_id: tenant.id,
      actor: 'ai',
      action: 'lead_updated',
      entity: 'lead',
      entity_id: leadId,
      details: { changes, intent: turn.intent, score: score.score, temperature: score.temperature, status },
    });

    // 6. Workflow 02: assignment + notifications
    await applySalesWorkflow(deps, tenant, updated, {
      siteVisitNew: siteVisit && !lead.site_visit_requested,
      needsHuman,
      humanReason: turn.human_reason,
      readyToProceed: turn.intent === 'ready_to_proceed',
      eventKey: ids[0]!,
    });
  } catch (err) {
    log.error({ err, leadId }, 'processLead failed');
    await repo.setProcessingStatus(ids, 'failed');
    await repo.logError({ tenant_id: tenant.id, lead_id: leadId, operation: 'process_lead', message: (err as Error).message });
  }
}

async function optOut(deps: EngineDeps, tenant: Tenant, lead: Lead, channel: Channel, ids: string[]) {
  const updated = await deps.repo.updateLead(lead.lead_id, { opted_out: true, next_followup: null });
  await sendAndRecord(deps, tenant, updated, channel, OPT_OUT_CONFIRMATION, 'system', 'opt_out');
  await deps.repo.setProcessingStatus(ids, 'done');
  await deps.repo.audit({ tenant_id: tenant.id, actor: 'system', action: 'opted_out', entity: 'lead', entity_id: lead.lead_id });
}
