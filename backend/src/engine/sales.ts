import type { Lead, LeadStatus, Salesperson, Tenant } from '../domain/types.js';
import type { EngineDeps } from './deps.js';

/** Before a salesperson has made contact. */
export const PRE_CONTACT_STATUSES: readonly LeadStatus[] = ['new', 'information_pending', 'qualified'];

/** Least-loaded active salesperson; ties go to the one listed first. */
export function pickSalesperson(people: Salesperson[] | undefined, openCounts: Record<string, number>): Salesperson | null {
  const active = (people ?? []).filter((p) => p.active !== false && p.name.trim());
  if (active.length === 0) return null;
  return active.reduce((best, p) => ((openCounts[p.name] ?? 0) < (openCounts[best.name] ?? 0) ? p : best));
}

export interface SalesSignals {
  /** Customer asked for a site visit for the first time in this event. */
  siteVisitNew?: boolean;
  needsHuman?: boolean;
  humanReason?: string | null;
  readyToProceed?: boolean;
  /** Lead arrived through a form (website / Lead Ads) and is new. */
  newFormLead?: boolean;
  /** Unique id of the triggering event (used for per-event alerts). */
  eventKey: string;
}

export function isHighValue(tenant: Tenant, lead: Lead): boolean {
  return lead.budget != null && lead.budget >= (tenant.settings.high_value_budget ?? 1_500_000);
}

/**
 * Spec §7 Workflow 02 (after scoring): decide whether sales attention is needed,
 * assign a salesperson, set a contact deadline, and send the §8.1 notifications.
 * Returns the (possibly updated) lead.
 */
export async function applySalesWorkflow(deps: EngineDeps, tenant: Tenant, lead: Lead, s: SalesSignals): Promise<Lead> {
  const now = deps.now();
  const highValue = isHighValue(tenant, lead);
  const hot = lead.lead_temperature === 'hot';
  const needsAttention =
    hot || lead.lead_status === 'qualified' || highValue || !!s.siteVisitNew || !!s.needsHuman || !!s.readyToProceed || !!s.newFormLead;

  if (needsAttention && PRE_CONTACT_STATUSES.includes(lead.lead_status)) {
    const patch: Partial<Lead> = {};
    if (!lead.assigned_salesperson) {
      const person = pickSalesperson(tenant.settings.salespeople, await deps.repo.openAssignmentCounts(tenant.id));
      if (person) {
        patch.assigned_salesperson = person.name;
        patch.assigned_at = now.toISOString();
      }
    }
    if (!lead.contact_due_at) {
      const hours = tenant.settings.contact_sla_hours ?? 4;
      patch.contact_due_at = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
    }
    if (Object.keys(patch).length > 0) {
      lead = await deps.repo.updateLead(lead.lead_id, patch);
      if (patch.assigned_salesperson) {
        await deps.repo.audit({
          tenant_id: tenant.id,
          actor: 'system',
          action: 'lead_assigned',
          entity: 'lead',
          entity_id: lead.lead_id,
          details: { salesperson: patch.assigned_salesperson },
        });
      }
    }
  }

  // §8.1 notifications — each deduplicated so the team is never spammed.
  const n = deps.notifier;
  const id = lead.lead_id;
  if (hot) await n.alert(tenant, lead, 'hot_lead', `hot_lead:${id}`);
  else if (s.newFormLead) await n.alert(tenant, lead, 'new_lead', `new_lead:${id}`);
  if (s.siteVisitNew) await n.alert(tenant, lead, 'site_visit', `site_visit:${id}`);
  if (s.needsHuman) await n.alert(tenant, lead, 'human_needed', `human_needed:${s.eventKey}`, s.humanReason);
  if (s.readyToProceed) await n.alert(tenant, lead, 'ready_to_proceed', `ready_to_proceed:${id}`);
  if (highValue) await n.alert(tenant, lead, 'high_value', `high_value:${id}`);
  return lead;
}
