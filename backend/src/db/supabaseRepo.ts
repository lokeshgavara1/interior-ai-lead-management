import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ConversationMessage, Lead, LeadSource, ProcessingStatus, Tenant } from '../domain/types.js';
import { ACTIVE_SALES_STATUSES, AI_FOLLOWUP_STATUSES } from '../domain/types.js';
import type { LeadKey, NewInboundMessage, NewNotification, NewOutboundMessage, Repo, SheetSnapshot } from './repo.js';

function check<T>(res: { data: T; error: { message: string } | null }, op: string): T {
  if (res.error) throw new Error(`${op}: ${res.error.message}`);
  return res.data;
}

export function createSupabaseRepo(url: string, serviceRoleKey: string): Repo {
  const db: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async listTenants() {
      const res = await db.from('tenants').select('*');
      return (check(res, 'listTenants') as Tenant[] | null) ?? [];
    },

    async getTenantByPageId(pageId) {
      const res = await db.from('tenants').select('*').eq('facebook_page_id', pageId).maybeSingle();
      return check(res, 'getTenantByPageId') as Tenant | null;
    },

    async getTenantByInstagramId(igId) {
      const res = await db.from('tenants').select('*').eq('instagram_account_id', igId).maybeSingle();
      return check(res, 'getTenantByInstagramId') as Tenant | null;
    },

    async getPageAccessToken(tenantId) {
      const res = await db.from('tenant_secrets').select('page_access_token').eq('tenant_id', tenantId).maybeSingle();
      const row = check(res, 'getPageAccessToken') as { page_access_token: string | null } | null;
      return row?.page_access_token ?? null;
    },

    async isEventProcessed(key) {
      const res = await db.from('processed_events').select('event_key').eq('event_key', key).maybeSingle();
      return check(res, 'isEventProcessed') != null;
    },

    async markEventProcessed(key, tenantId) {
      check(
        await db.from('processed_events').upsert({ event_key: key, tenant_id: tenantId }, { onConflict: 'event_key', ignoreDuplicates: true }),
        'markEventProcessed',
      );
    },

    async getSheetSnapshot(tenantId) {
      const res = await db.from('sheet_sync_state').select('snapshot').eq('tenant_id', tenantId).maybeSingle();
      const row = check(res, 'getSheetSnapshot') as { snapshot: SheetSnapshot } | null;
      return row?.snapshot ?? {};
    },

    async saveSheetSnapshot(tenantId, snapshot) {
      check(
        await db
          .from('sheet_sync_state')
          .upsert({ tenant_id: tenantId, snapshot, synced_at: new Date().toISOString() }, { onConflict: 'tenant_id' }),
        'saveSheetSnapshot',
      );
    },

    async overdueLeads(now, limit) {
      const iso = now.toISOString();
      const [due, followups] = await Promise.all([
        db
          .from('leads')
          .select('*')
          .lte('contact_due_at', iso)
          .in('lead_status', ['new', 'information_pending', 'qualified'])
          .limit(limit),
        db
          .from('leads')
          .select('*')
          .lte('next_followup', iso)
          .in('lead_status', [...ACTIVE_SALES_STATUSES])
          .limit(limit),
      ]);
      const rows = [
        ...((check(due, 'overdueLeads.contact') as Lead[] | null) ?? []),
        ...((check(followups, 'overdueLeads.followup') as Lead[] | null) ?? []),
      ];
      return [...new Map(rows.map((l) => [l.lead_id, l])).values()];
    },

    async getTenant(id) {
      const res = await db.from('tenants').select('*').eq('id', id).maybeSingle();
      return check(res, 'getTenant') as Tenant | null;
    },

    async getTenantByPhoneNumberId(phoneNumberId) {
      const res = await db.from('tenants').select('*').eq('whatsapp_phone_number_id', phoneNumberId).maybeSingle();
      return check(res, 'getTenantByPhoneNumberId') as Tenant | null;
    },

    async getTenantBySlug(slug) {
      const res = await db.from('tenants').select('*').eq('slug', slug).maybeSingle();
      return check(res, 'getTenantBySlug') as Tenant | null;
    },

    async findOrCreateLead(tenantId: string, key: LeadKey, source: LeadSource) {
      // ignoreDuplicates => ON CONFLICT DO NOTHING; the unique constraints
      // (tenant_id, phone_number) / (tenant_id, instagram_id) guarantee no duplicate leads even under races.
      const [column, value] = 'phone_number' in key ? ['phone_number', key.phone_number] : ['instagram_id', key.instagram_id];
      const inserted = check(
        await db
          .from('leads')
          .upsert({ tenant_id: tenantId, [column]: value, lead_source: source }, {
            onConflict: `tenant_id,${column}`,
            ignoreDuplicates: true,
          })
          .select('*'),
        'findOrCreateLead.upsert',
      ) as Lead[] | null;
      if (inserted?.[0]) return { lead: inserted[0], created: true };
      const res = await db.from('leads').select('*').eq('tenant_id', tenantId).eq(column, value).single();
      return { lead: check(res, 'findOrCreateLead.select') as Lead, created: false };
    },

    async findLeadByPhone(tenantId, phone) {
      const res = await db.from('leads').select('*').eq('tenant_id', tenantId).eq('phone_number', phone).maybeSingle();
      return check(res, 'findLeadByPhone') as Lead | null;
    },

    async listLeads(tenantId, limit) {
      const res = await db
        .from('leads')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(limit);
      return (check(res, 'listLeads') as Lead[] | null) ?? [];
    },

    async openAssignmentCounts(tenantId) {
      const res = await db
        .from('leads')
        .select('assigned_salesperson')
        .eq('tenant_id', tenantId)
        .not('assigned_salesperson', 'is', null)
        .not('lead_status', 'in', '(converted,lost)');
      const rows = (check(res, 'openAssignmentCounts') as { assigned_salesperson: string }[] | null) ?? [];
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.assigned_salesperson] = (counts[r.assigned_salesperson] ?? 0) + 1;
      return counts;
    },

    async getLead(leadId) {
      const res = await db.from('leads').select('*').eq('lead_id', leadId).maybeSingle();
      return check(res, 'getLead') as Lead | null;
    },

    async updateLead(leadId, patch) {
      const { lead_id: _id, tenant_id: _t, created_at: _c, updated_at: _u, ...rest } = patch;
      const res = await db.from('leads').update(rest).eq('lead_id', leadId).select('*').single();
      return check(res, 'updateLead') as Lead;
    },

    async insertInboundMessage(msg: NewInboundMessage) {
      const row = {
        tenant_id: msg.tenant_id,
        lead_id: msg.lead_id,
        phone_number: msg.phone_number,
        channel: msg.channel,
        incoming_message: msg.text,
        sender_type: 'customer',
        external_message_id: msg.external_message_id,
        message_timestamp: msg.message_timestamp,
        processing_status: 'pending',
      };
      const res = await db
        .from('interior_conversations')
        .upsert(row, { onConflict: 'tenant_id,channel,external_message_id', ignoreDuplicates: true })
        .select('conversation_id');
      const data = check(res, 'insertInboundMessage') as { conversation_id: string }[] | null;
      return (data?.length ?? 0) > 0;
    },

    async insertOutboundMessage(msg: NewOutboundMessage) {
      const res = await db
        .from('interior_conversations')
        .insert({
          tenant_id: msg.tenant_id,
          lead_id: msg.lead_id,
          phone_number: msg.phone_number,
          channel: msg.channel,
          outgoing_message: msg.text,
          sender_type: msg.sender_type,
          intent: msg.intent ?? null,
          external_message_id: msg.external_message_id ?? null,
          delivery_status: msg.delivery_status ?? null,
          processing_status: 'done',
        })
        .select('*')
        .single();
      return check(res, 'insertOutboundMessage') as ConversationMessage;
    },

    async claimPendingMessages(leadId) {
      const res = await db.rpc('claim_pending_messages', { p_lead_id: leadId });
      const rows = (check(res, 'claimPendingMessages') as ConversationMessage[] | null) ?? [];
      return rows.sort((a, b) => a.message_timestamp.localeCompare(b.message_timestamp));
    },

    async setProcessingStatus(ids: string[], status: ProcessingStatus) {
      if (ids.length === 0) return;
      check(
        await db.from('interior_conversations').update({ processing_status: status }).in('conversation_id', ids),
        'setProcessingStatus',
      );
    },

    async recentMessages(leadId, limit) {
      const res = await db
        .from('interior_conversations')
        .select('*')
        .eq('lead_id', leadId)
        .order('message_timestamp', { ascending: false })
        .limit(limit);
      const rows = (check(res, 'recentMessages') as ConversationMessage[] | null) ?? [];
      return rows.reverse();
    },

    async updateDeliveryStatus(tenantId, externalMessageId, status) {
      check(
        await db
          .from('interior_conversations')
          .update({ delivery_status: status })
          .eq('tenant_id', tenantId)
          .eq('external_message_id', externalMessageId),
        'updateDeliveryStatus',
      );
    },

    async setOutboundExternalId(conversationId, externalMessageId, status) {
      check(
        await db
          .from('interior_conversations')
          .update({ external_message_id: externalMessageId, delivery_status: status })
          .eq('conversation_id', conversationId),
        'setOutboundExternalId',
      );
    },

    async leadsWithStalePending(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const res = await db
        .from('interior_conversations')
        .select('lead_id')
        .eq('processing_status', 'pending')
        .lt('created_at', cutoff)
        .limit(200);
      const rows = (check(res, 'leadsWithStalePending') as { lead_id: string }[] | null) ?? [];
      return [...new Set(rows.map((r) => r.lead_id))];
    },

    async resetStaleProcessing(olderThanMs) {
      const res = await db.rpc('reset_stale_processing', { p_older_than: `${Math.round(olderThanMs / 1000)} seconds` });
      const rows = (check(res, 'resetStaleProcessing') as string[] | null) ?? [];
      return [...new Set(rows)];
    },

    async dueFollowups(now, limit) {
      const res = await db
        .from('leads')
        .select('*')
        .lte('next_followup', now.toISOString())
        .eq('opted_out', false)
        .eq('ai_paused', false)
        .in('lead_status', [...AI_FOLLOWUP_STATUSES])
        .order('next_followup', { ascending: true })
        .limit(limit);
      return (check(res, 'dueFollowups') as Lead[] | null) ?? [];
    },

    async createNotification(n: NewNotification) {
      const res = await db
        .from('notifications')
        .upsert(n, { onConflict: 'dedupe_key', ignoreDuplicates: true })
        .select('id');
      const rows = (check(res, 'createNotification') as { id: string }[] | null) ?? [];
      return rows[0]?.id ?? null;
    },

    async setNotificationStatus(id, status, error) {
      check(await db.from('notifications').update({ status, error: error ?? null }).eq('id', id), 'setNotificationStatus');
    },

    async logError(entry) {
      // Never let logging failures crash the caller.
      const { error } = await db.from('error_log').insert({
        tenant_id: entry.tenant_id ?? null,
        lead_id: entry.lead_id ?? null,
        operation: entry.operation,
        message: entry.message,
        details: entry.details ?? {},
      });
      if (error) console.error('error_log insert failed', error.message, entry);
    },

    async audit(entry) {
      const { error } = await db.from('audit_log').insert({
        tenant_id: entry.tenant_id ?? null,
        actor: entry.actor,
        action: entry.action,
        entity: entry.entity,
        entity_id: entry.entity_id ?? null,
        details: entry.details ?? {},
      });
      if (error) console.error('audit_log insert failed', error.message);
    },
  };
}
