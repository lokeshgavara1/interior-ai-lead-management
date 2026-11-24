/**
 * In-memory Repo with the same semantics as the Supabase one (unique keys, atomic claims).
 * Used by the tests and by the local chat CLI (`npm run chat`). Not for production.
 */
import { randomUUID } from 'node:crypto';
import type { ConversationMessage, Lead, LeadSource, Tenant } from '../domain/types.js';
import { ACTIVE_SALES_STATUSES, AI_FOLLOWUP_STATUSES, EMPTY_FACTS } from '../domain/types.js';
import type { LeadKey, NewInboundMessage, NewNotification, NewOutboundMessage, Repo, SheetSnapshot } from './repo.js';

export class MemoryRepo implements Repo {
  tenants: Tenant[] = [];
  leads: Lead[] = [];
  messages: (ConversationMessage & { created_at: string })[] = [];
  notifications: (NewNotification & { id: string; status: string; error?: string })[] = [];
  errors: { operation: string; message: string }[] = [];
  audits: { action: string }[] = [];

  async getTenant(id: string) {
    return this.tenants.find((t) => t.id === id) ?? null;
  }
  async getTenantByPhoneNumberId(id: string) {
    return this.tenants.find((t) => t.whatsapp_phone_number_id === id) ?? null;
  }
  async getTenantBySlug(slug: string) {
    return this.tenants.find((t) => t.slug === slug) ?? null;
  }
  async listTenants() {
    return [...this.tenants];
  }
  async getTenantByPageId(id: string) {
    return this.tenants.find((t) => t.facebook_page_id === id) ?? null;
  }
  async getTenantByInstagramId(id: string) {
    return this.tenants.find((t) => t.instagram_account_id === id) ?? null;
  }
  pageTokens: Record<string, string> = { 'tenant-1': 'PAGE-TOKEN' };
  async getPageAccessToken(tenantId: string) {
    return this.pageTokens[tenantId] ?? null;
  }
  async findLeadByPhone(tenantId: string, phone: string) {
    const l = this.leads.find((x) => x.tenant_id === tenantId && x.phone_number === phone);
    return l ? { ...l } : null;
  }
  async listLeads(tenantId: string, limit: number) {
    return this.leads
      .filter((l) => l.tenant_id === tenantId)
      .slice(0, limit)
      .map((l) => ({ ...l }));
  }
  async openAssignmentCounts(tenantId: string) {
    const counts: Record<string, number> = {};
    for (const l of this.leads) {
      if (l.tenant_id !== tenantId || !l.assigned_salesperson || ['converted', 'lost'].includes(l.lead_status)) continue;
      counts[l.assigned_salesperson] = (counts[l.assigned_salesperson] ?? 0) + 1;
    }
    return counts;
  }
  events = new Set<string>();
  async isEventProcessed(key: string) {
    return this.events.has(key);
  }
  async markEventProcessed(key: string) {
    this.events.add(key);
  }
  snapshots: Record<string, SheetSnapshot> = {};
  async getSheetSnapshot(tenantId: string) {
    return structuredClone(this.snapshots[tenantId] ?? {});
  }
  async saveSheetSnapshot(tenantId: string, s: SheetSnapshot) {
    this.snapshots[tenantId] = structuredClone(s);
  }
  async overdueLeads(now: Date) {
    const iso = now.toISOString();
    return this.leads.filter(
      (l) =>
        (l.contact_due_at && l.contact_due_at <= iso && ['new', 'information_pending', 'qualified'].includes(l.lead_status)) ||
        (l.next_followup && l.next_followup <= iso && ACTIVE_SALES_STATUSES.includes(l.lead_status)),
    );
  }

  async findOrCreateLead(tenantId: string, key: LeadKey, source: LeadSource) {
    const phone = 'phone_number' in key ? key.phone_number : null;
    const ig = 'instagram_id' in key ? key.instagram_id : null;
    const existing = this.leads.find((l) => l.tenant_id === tenantId && (phone ? l.phone_number === phone : l.instagram_id === ig));
    if (existing) return { lead: { ...existing }, created: false };
    const ts = new Date().toISOString();
    const lead: Lead = {
      ...EMPTY_FACTS,
      lead_id: randomUUID(),
      tenant_id: tenantId,
      phone_number: phone,
      instagram_id: ig,
      last_customer_channel: null,
      assigned_at: null,
      contact_due_at: null,
      site_visit_requested: false,
      lead_source: source,
      lead_score: null,
      lead_temperature: 'provisional',
      lead_status: 'new',
      missing_information: [],
      needs_human: false,
      ai_paused: false,
      opted_out: false,
      assigned_salesperson: null,
      last_customer_message_at: null,
      last_contacted: null,
      next_followup: null,
      followup_count: 0,
      notes: null,
      created_at: ts,
      updated_at: ts,
    };
    this.leads.push(lead);
    return { lead: { ...lead }, created: true };
  }
  async getLead(id: string) {
    const l = this.leads.find((x) => x.lead_id === id);
    return l ? { ...l } : null;
  }
  async updateLead(id: string, patch: Partial<Lead>) {
    const l = this.leads.find((x) => x.lead_id === id);
    if (!l) throw new Error('lead not found');
    Object.assign(l, patch, { updated_at: new Date().toISOString() });
    return { ...l };
  }
  async insertInboundMessage(m: NewInboundMessage) {
    if (m.external_message_id && this.messages.some((x) => x.tenant_id === m.tenant_id && x.channel === m.channel && x.external_message_id === m.external_message_id)) {
      return false;
    }
    this.messages.push({
      conversation_id: randomUUID(),
      tenant_id: m.tenant_id,
      lead_id: m.lead_id,
      phone_number: m.phone_number,
      incoming_message: m.text,
      outgoing_message: null,
      sender_type: 'customer',
      intent: null,
      message_timestamp: m.message_timestamp,
      channel: m.channel,
      delivery_status: null,
      external_message_id: m.external_message_id,
      processing_status: 'pending',
      created_at: new Date().toISOString(),
    });
    return true;
  }
  async insertOutboundMessage(m: NewOutboundMessage) {
    const row = {
      conversation_id: randomUUID(),
      tenant_id: m.tenant_id,
      lead_id: m.lead_id,
      phone_number: m.phone_number,
      incoming_message: null,
      outgoing_message: m.text,
      sender_type: m.sender_type,
      intent: m.intent ?? null,
      message_timestamp: new Date(Date.now() + this.messages.length).toISOString(),
      channel: m.channel,
      delivery_status: m.delivery_status ?? null,
      external_message_id: m.external_message_id ?? null,
      processing_status: 'done' as const,
      created_at: new Date().toISOString(),
    };
    this.messages.push(row);
    return { ...row };
  }
  async claimPendingMessages(leadId: string) {
    const rows = this.messages.filter((m) => m.lead_id === leadId && m.processing_status === 'pending');
    rows.forEach((r) => (r.processing_status = 'processing'));
    return rows.map((r) => ({ ...r }));
  }
  async setProcessingStatus(ids: string[], status: ConversationMessage['processing_status']) {
    this.messages.filter((m) => ids.includes(m.conversation_id)).forEach((m) => (m.processing_status = status));
  }
  async recentMessages(leadId: string, limit: number) {
    return this.messages
      .filter((m) => m.lead_id === leadId)
      .sort((a, b) => a.message_timestamp.localeCompare(b.message_timestamp))
      .slice(-limit)
      .map((m) => ({ ...m }));
  }
  async updateDeliveryStatus(tenantId: string, ext: string, status: string) {
    this.messages.filter((m) => m.tenant_id === tenantId && m.external_message_id === ext).forEach((m) => (m.delivery_status = status));
  }
  async setOutboundExternalId(id: string, ext: string | null, status: string) {
    const m = this.messages.find((x) => x.conversation_id === id);
    if (m) Object.assign(m, { external_message_id: ext, delivery_status: status });
  }
  async leadsWithStalePending() {
    return [...new Set(this.messages.filter((m) => m.processing_status === 'pending').map((m) => m.lead_id))];
  }
  async resetStaleProcessing() {
    return [];
  }
  async dueFollowups(now: Date) {
    return this.leads.filter(
      (l) =>
        l.next_followup &&
        l.next_followup <= now.toISOString() &&
        !l.opted_out &&
        !l.ai_paused &&
        AI_FOLLOWUP_STATUSES.includes(l.lead_status),
    );
  }
  async createNotification(n: NewNotification) {
    if (this.notifications.some((x) => x.dedupe_key === n.dedupe_key)) return null;
    const id = randomUUID();
    this.notifications.push({ ...n, id, status: 'pending' });
    return id;
  }
  async setNotificationStatus(id: string, status: 'sent' | 'failed', error?: string) {
    const n = this.notifications.find((x) => x.id === id);
    if (n) Object.assign(n, { status, error });
  }
  async logError(e: { operation: string; message: string }) {
    this.errors.push({ operation: e.operation, message: e.message });
  }
  async audit(e: { action: string }) {
    this.audits.push({ action: e.action });
  }

  outbound(leadId: string) {
    return this.messages.filter((m) => m.lead_id === leadId && m.sender_type !== 'customer');
  }
}
