/**
 * Google Sheets CRM view (spec §2.2 "Google Sheets initially", §15 "business owner
 * can access the CRM and track enquiries").
 *
 * Supabase stays the source of truth. Every cycle, per tenant with a google_sheet_id:
 *   1. PULL: read the "Leads" tab; any editable cell that differs from what we last
 *      wrote was changed by a person -> validate and apply it to the database.
 *   2. PUSH: rewrite the whole tab from the database and remember what we wrote.
 * Only the columns marked editable are ever read back; everything else is display-only.
 */
import type { SheetsApi } from '../channels/sheets.js';
import type { SheetSnapshot } from '../db/repo.js';
import { LEAD_STATUSES, type Lead, type LeadStatus, type Tenant } from '../domain/types.js';
import type { EngineDeps } from '../engine/deps.js';
import { toEnum } from '../lib/parse.js';
import { formatLocalDateTime, parseLocalDateTime } from '../lib/time.js';

export const TAB = 'Leads';
const MAX_ROWS = 5000;

type Editable = 'lead_status' | 'assigned_salesperson' | 'next_followup' | 'ai_paused' | 'notes';

interface Column {
  header: string;
  editable?: Editable;
  get(lead: Lead, tz: string): string | number;
}

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

export const COLUMNS: Column[] = [
  { header: 'Lead ID', get: (l) => l.lead_id },
  { header: 'Created', get: (l, tz) => formatLocalDateTime(l.created_at, tz) },
  { header: 'Name', get: (l) => l.customer_name ?? '' },
  { header: 'Phone', get: (l) => l.phone_number ?? '' },
  { header: 'Source', get: (l) => l.lead_source },
  { header: 'Location', get: (l) => l.location ?? '' },
  { header: 'Property Type', get: (l) => l.property_type ?? '' },
  { header: 'Size', get: (l) => l.property_size ?? '' },
  { header: 'Project', get: (l) => l.project_type ?? '' },
  { header: 'Budget (₹)', get: (l) => l.budget ?? '' },
  { header: 'Property Status', get: (l) => l.property_status ?? '' },
  { header: 'Timeline', get: (l) => l.timeline_text ?? l.expected_start_date ?? '' },
  { header: 'Requirements', get: (l) => l.requirements ?? '' },
  { header: 'Site Visit Requested', get: (l) => yesNo(l.site_visit_requested) },
  { header: 'Score', get: (l) => l.lead_score ?? '' },
  { header: 'Temperature', get: (l) => l.lead_temperature },
  { header: 'Status ✎', editable: 'lead_status', get: (l) => l.lead_status },
  { header: 'Assigned To ✎', editable: 'assigned_salesperson', get: (l) => l.assigned_salesperson ?? '' },
  { header: 'Next Follow-up ✎', editable: 'next_followup', get: (l, tz) => formatLocalDateTime(l.next_followup, tz) },
  { header: 'AI Paused ✎', editable: 'ai_paused', get: (l) => (l.ai_paused ? 'TRUE' : 'FALSE') },
  { header: 'Notes ✎', editable: 'notes', get: (l) => l.notes ?? '' },
  { header: 'Needs Human', get: (l) => yesNo(l.needs_human) },
  { header: 'Opted Out', get: (l) => yesNo(l.opted_out) },
  { header: 'Contact Due', get: (l, tz) => formatLocalDateTime(l.contact_due_at, tz) },
  { header: 'Last Customer Message', get: (l, tz) => formatLocalDateTime(l.last_customer_message_at, tz) },
  { header: 'Last Contacted', get: (l, tz) => formatLocalDateTime(l.last_contacted, tz) },
  { header: 'Updated', get: (l, tz) => formatLocalDateTime(l.updated_at, tz) },
];

const ID_COL = 0;

/** 1 -> A, 26 -> Z, 27 -> AA */
export function columnLetter(n: number): string {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
const lastColumnLetter = columnLetter(COLUMNS.length);

export function leadRow(lead: Lead, tz: string): (string | number)[] {
  return COLUMNS.map((c) => c.get(lead, tz));
}

/** Converts a sheet edit into a lead patch. Returns an error string for invalid input. */
export function parseEdit(field: Editable, raw: string, tenant: Tenant): { patch: Partial<Lead> } | { error: string } {
  const value = raw.trim();
  switch (field) {
    case 'lead_status': {
      const status = toEnum<LeadStatus>(value, LEAD_STATUSES);
      return status ? { patch: { lead_status: status } } : { error: `"${value}" is not a valid status (${LEAD_STATUSES.join(', ')})` };
    }
    case 'assigned_salesperson':
      return { patch: { assigned_salesperson: value || null, assigned_at: value ? new Date().toISOString() : null } };
    case 'next_followup': {
      if (!value) return { patch: { next_followup: null } };
      const iso = parseLocalDateTime(value, tenant.timezone);
      return iso ? { patch: { next_followup: iso } } : { error: `"${value}" is not a date (use YYYY-MM-DD or YYYY-MM-DD HH:mm)` };
    }
    case 'ai_paused': {
      const v = value.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(v)) return { patch: { ai_paused: true } };
      if (['false', 'no', 'n', '0', ''].includes(v)) return { patch: { ai_paused: false, needs_human: false } };
      return { error: `"${value}" is not TRUE/FALSE` };
    }
    case 'notes':
      return { patch: { notes: value || null } };
  }
}

const preparedSheets = new Set<string>();

export async function syncTenantSheet(deps: EngineDeps, sheets: SheetsApi, tenant: Tenant): Promise<{ applied: number; rows: number }> {
  const sheetId = tenant.settings.google_sheet_id;
  if (!sheetId) return { applied: 0, rows: 0 };

  const tabId = await sheets.ensureTab(sheetId, TAB);
  if (!preparedSheets.has(sheetId)) {
    const statusCol = COLUMNS.findIndex((c) => c.editable === 'lead_status');
    const pausedCol = COLUMNS.findIndex((c) => c.editable === 'ai_paused');
    await sheets.setDropdown(sheetId, tabId, statusCol, [...LEAD_STATUSES]);
    await sheets.setDropdown(sheetId, tabId, pausedCol, ['TRUE', 'FALSE']);
    await sheets.freezeHeader(sheetId, tabId);
    preparedSheets.add(sheetId);
  }

  // 1. PULL human edits
  const snapshot = await deps.repo.getSheetSnapshot(tenant.id);
  const current = await sheets.getValues(sheetId, `${TAB}!A2:${lastColumnLetter}`);
  let applied = 0;
  for (const row of current) {
    const leadId = row[ID_COL]?.trim();
    const last = leadId ? snapshot[leadId] : undefined;
    if (!leadId || !last) continue;
    const patch: Partial<Lead> = {};
    const edits: Record<string, string> = {};
    COLUMNS.forEach((col, i) => {
      if (!col.editable) return;
      const cell = (row[i] ?? '').toString();
      if (cell.trim() === (last[col.editable] ?? '').trim()) return;
      const res = parseEdit(col.editable, cell, tenant);
      if ('error' in res) {
        void deps.repo.logError({ tenant_id: tenant.id, lead_id: leadId, operation: 'sheet_edit', message: res.error });
        return;
      }
      Object.assign(patch, res.patch);
      edits[col.editable] = cell;
    });
    if (Object.keys(patch).length === 0) continue;
    try {
      await deps.repo.updateLead(leadId, patch);
      await deps.repo.audit({ tenant_id: tenant.id, actor: 'google_sheet', action: 'lead_edited', entity: 'lead', entity_id: leadId, details: edits });
      applied++;
    } catch (err) {
      await deps.repo.logError({ tenant_id: tenant.id, lead_id: leadId, operation: 'sheet_edit', message: (err as Error).message });
    }
  }

  // 2. PUSH database state
  const leads = await deps.repo.listLeads(tenant.id, MAX_ROWS);
  const rows = leads.map((l) => leadRow(l, tenant.timezone));
  await sheets.updateValues(sheetId, `${TAB}!A1`, [COLUMNS.map((c) => c.header), ...rows]);
  await sheets.clearValues(sheetId, `${TAB}!A${rows.length + 2}:${lastColumnLetter}`);

  const next: SheetSnapshot = {};
  for (const lead of leads) {
    const entry: Record<string, string> = {};
    for (const col of COLUMNS) if (col.editable) entry[col.editable] = String(col.get(lead, tenant.timezone));
    next[lead.lead_id] = entry;
  }
  await deps.repo.saveSheetSnapshot(tenant.id, next);
  return { applied, rows: rows.length };
}

export async function runSheetSync(deps: EngineDeps, sheets: SheetsApi): Promise<void> {
  for (const tenant of await deps.repo.listTenants()) {
    if (!tenant.settings.google_sheet_id) continue;
    try {
      const res = await syncTenantSheet(deps, sheets, tenant);
      if (res.applied) deps.log.info({ tenant: tenant.slug, ...res }, 'applied Google Sheet edits');
    } catch (err) {
      deps.log.error({ err, tenant: tenant.slug }, 'Google Sheet sync failed');
      await deps.repo.logError({ tenant_id: tenant.id, operation: 'sheet_sync', message: (err as Error).message });
    }
  }
}
