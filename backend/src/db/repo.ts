import type { Channel, ConversationMessage, Lead, LeadSource, ProcessingStatus, SenderType, Tenant } from '../domain/types.js';

export interface NewInboundMessage {
  tenant_id: string;
  lead_id: string;
  phone_number: string | null;
  channel: Channel;
  text: string;
  external_message_id: string | null;
  message_timestamp: string;
}

export interface NewOutboundMessage {
  tenant_id: string;
  lead_id: string;
  phone_number: string | null;
  channel: Channel;
  text: string;
  sender_type: Exclude<SenderType, 'customer'>;
  intent?: string | null;
  external_message_id?: string | null;
  delivery_status?: string | null;
}

export interface NewNotification {
  tenant_id: string;
  lead_id: string | null;
  kind: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
}

/** How a customer is identified: phone (WhatsApp, forms) or Instagram user id. */
export type LeadKey = { phone_number: string } | { instagram_id: string };

/** Map of lead_id -> { column -> value last written to the Google Sheet }. */
export type SheetSnapshot = Record<string, Record<string, string>>;

/**
 * Persistence boundary. The Supabase implementation is used in production;
 * an in-memory implementation backs the tests.
 */
export interface Repo {
  listTenants(): Promise<Tenant[]>;
  getTenant(id: string): Promise<Tenant | null>;
  getTenantByPhoneNumberId(phoneNumberId: string): Promise<Tenant | null>;
  getTenantBySlug(slug: string): Promise<Tenant | null>;
  getTenantByPageId(pageId: string): Promise<Tenant | null>;
  getTenantByInstagramId(igAccountId: string): Promise<Tenant | null>;
  getPageAccessToken(tenantId: string): Promise<string | null>;

  /** Returns the existing lead for (tenant, key) or creates one. Never duplicates. */
  findOrCreateLead(tenantId: string, key: LeadKey, source: LeadSource): Promise<{ lead: Lead; created: boolean }>;
  findLeadByPhone(tenantId: string, phone: string): Promise<Lead | null>;
  getLead(leadId: string): Promise<Lead | null>;
  updateLead(leadId: string, patch: Partial<Lead>): Promise<Lead>;
  listLeads(tenantId: string, limit: number): Promise<Lead[]>;
  /** Number of open (not converted/lost) leads per assigned salesperson name. */
  openAssignmentCounts(tenantId: string): Promise<Record<string, number>>;

  /** Inserts a customer message as 'pending'. Returns false if it was a duplicate delivery. */
  insertInboundMessage(msg: NewInboundMessage): Promise<boolean>;
  insertOutboundMessage(msg: NewOutboundMessage): Promise<ConversationMessage>;
  claimPendingMessages(leadId: string): Promise<ConversationMessage[]>;
  setProcessingStatus(conversationIds: string[], status: ProcessingStatus): Promise<void>;
  recentMessages(leadId: string, limit: number): Promise<ConversationMessage[]>;
  updateDeliveryStatus(tenantId: string, externalMessageId: string, status: string): Promise<void>;
  setOutboundExternalId(conversationId: string, externalMessageId: string | null, status: string): Promise<void>;

  /** Lead ids with pending messages older than `olderThanMs` (missed by the debouncer). */
  leadsWithStalePending(olderThanMs: number): Promise<string[]>;
  /** Resets messages stuck in 'processing' for longer than `olderThanMs`. Returns affected lead ids. */
  resetStaleProcessing(olderThanMs: number): Promise<string[]>;

  /** Leads due an automated AI follow-up (status new / information_pending). */
  dueFollowups(now: Date, limit: number): Promise<Lead[]>;
  /** Leads whose contact deadline or salesperson follow-up date has passed. */
  overdueLeads(now: Date, limit: number): Promise<Lead[]>;

  isEventProcessed(key: string): Promise<boolean>;
  markEventProcessed(key: string, tenantId: string | null): Promise<void>;

  getSheetSnapshot(tenantId: string): Promise<SheetSnapshot>;
  saveSheetSnapshot(tenantId: string, snapshot: SheetSnapshot): Promise<void>;

  /** Records a notification once per dedupe_key. Returns its id, or null if already recorded. */
  createNotification(n: NewNotification): Promise<string | null>;
  setNotificationStatus(id: string, status: 'sent' | 'failed', error?: string): Promise<void>;

  logError(entry: { tenant_id?: string | null; lead_id?: string | null; operation: string; message: string; details?: unknown }): Promise<void>;
  audit(entry: { tenant_id?: string | null; actor: string; action: string; entity: string; entity_id?: string | null; details?: unknown }): Promise<void>;
}
