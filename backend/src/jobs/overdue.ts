import { ACTIVE_SALES_STATUSES } from '../domain/types.js';
import type { EngineDeps } from '../engine/deps.js';
import { PRE_CONTACT_STATUSES } from '../engine/sales.js';

export function formatLocal(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

/**
 * Spec §8.1 "An important follow-up is overdue":
 *  - a lead needing attention was not contacted by its contact deadline, or
 *  - a salesperson's own follow-up date (next_followup on an active lead) has passed.
 * Each deadline alerts once (dedupe key includes the deadline).
 */
export async function runOverdueCheck(deps: EngineDeps, batchSize = 100): Promise<number> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const leads = await deps.repo.overdueLeads(now, batchSize);
  let alerts = 0;

  for (const lead of leads) {
    const tenant = await deps.repo.getTenant(lead.tenant_id);
    if (!tenant) continue;
    if (lead.contact_due_at && lead.contact_due_at <= nowIso && PRE_CONTACT_STATUSES.includes(lead.lead_status)) {
      await deps.notifier.alert(
        tenant,
        lead,
        'followup_overdue',
        `overdue_contact:${lead.lead_id}:${lead.contact_due_at}`,
        `Not contacted yet — deadline was ${formatLocal(lead.contact_due_at, tenant.timezone)}`,
      );
      alerts++;
    }
    if (lead.next_followup && lead.next_followup <= nowIso && ACTIVE_SALES_STATUSES.includes(lead.lead_status)) {
      await deps.notifier.alert(
        tenant,
        lead,
        'followup_overdue',
        `overdue_followup:${lead.lead_id}:${lead.next_followup}`,
        `Follow-up was due ${formatLocal(lead.next_followup, tenant.timezone)} (status: ${lead.lead_status.replace(/_/g, ' ')})`,
      );
      alerts++;
    }
  }
  return alerts;
}
