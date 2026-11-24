export const PROPERTY_TYPES = ['apartment', 'villa', 'independent_house', 'commercial', 'other'] as const;
export const PROJECT_TYPES = ['full_home', 'kitchen', 'wardrobe', 'living_room', 'bedroom', 'renovation', 'other'] as const;
export const PROPERTY_STATUSES = ['ready', 'under_construction'] as const;
export const LEAD_SOURCES = ['whatsapp', 'instagram', 'facebook', 'website', 'google_business', 'referral', 'manual'] as const;
export const TEMPERATURES = ['hot', 'warm', 'cold', 'provisional'] as const;
export const LEAD_STATUSES = [
  'new',
  'information_pending',
  'qualified',
  'contacted',
  'site_visit_scheduled',
  'quotation_sent',
  'negotiation',
  'converted',
  'lost',
] as const;
export const CHANNELS = ['whatsapp', 'instagram', 'facebook', 'website'] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];
export type ProjectType = (typeof PROJECT_TYPES)[number];
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];
export type LeadSource = (typeof LEAD_SOURCES)[number];
export type Temperature = (typeof TEMPERATURES)[number];
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type Channel = (typeof CHANNELS)[number];

/** Statuses where the AI may send automated follow-ups. */
export const AI_FOLLOWUP_STATUSES: readonly LeadStatus[] = ['new', 'information_pending'];

/** Statuses where a salesperson is actively working the lead (their next_followup is a reminder). */
export const ACTIVE_SALES_STATUSES: readonly LeadStatus[] = ['contacted', 'site_visit_scheduled', 'quotation_sent', 'negotiation'];

/** Statuses where a salesperson owns the lead — automation must not interfere. */
export const SALES_OWNED_STATUSES: readonly LeadStatus[] = [
  'contacted',
  'site_visit_scheduled',
  'quotation_sent',
  'negotiation',
  'converted',
  'lost',
];

export interface Salesperson {
  name: string;
  whatsapp?: string;
  email?: string;
  active?: boolean; // default true
}

export interface TenantSettings {
  /** Managers / sales inbox: receive every alert. */
  sales_whatsapp_numbers?: string[];
  sales_emails?: string[];
  /** Leads are assigned to these people (least open leads first). */
  salespeople?: Salesperson[];
  /** Hours a salesperson has to contact a lead that needs attention (default 4). */
  contact_sla_hours?: number;
  /** Google Sheet (shared with the service account) used as the owner's CRM view. */
  google_sheet_id?: string;
  /** Facebook Lead Ads: form question key -> lead field. Standard keys are mapped automatically. */
  lead_ads_field_map?: Record<string, string>;
  /** Lead form includes WhatsApp consent: send ack_template_name to new Lead Ads leads. */
  lead_ads_whatsapp_ack?: boolean;
  alert_template_name?: string;
  alert_template_lang?: string;
  followup_template_name?: string;
  followup_template_lang?: string;
  ack_template_name?: string;
  ack_template_lang?: string;
  high_value_budget?: number;
  max_followups?: number;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  whatsapp_phone_number_id: string | null;
  facebook_page_id: string | null;
  instagram_account_id: string | null;
  website_webhook_secret: string;
  timezone: string;
  default_country_code: string;
  knowledge_base: string;
  settings: TenantSettings;
}

/** Customer-provided facts. All optional: unknown = null, never invented. */
export interface LeadFacts {
  customer_name: string | null;
  email: string | null;
  location: string | null;
  property_type: PropertyType | null;
  property_size: string | null;
  budget: number | null;
  project_type: ProjectType | null;
  property_status: PropertyStatus | null;
  timeline_text: string | null;
  expected_start_date: string | null; // YYYY-MM-DD
  requirements: string | null;
}

export interface Lead extends LeadFacts {
  lead_id: string;
  tenant_id: string;
  phone_number: string | null; // E.164; null for Instagram leads who haven't shared one
  instagram_id: string | null; // Instagram-scoped user id (IGSID)
  last_customer_channel: Channel | null;
  site_visit_requested: boolean;
  lead_source: LeadSource;
  lead_score: number | null;
  lead_temperature: Temperature;
  lead_status: LeadStatus;
  missing_information: string[];
  needs_human: boolean;
  ai_paused: boolean;
  opted_out: boolean;
  assigned_salesperson: string | null;
  assigned_at: string | null;
  contact_due_at: string | null;
  last_customer_message_at: string | null;
  last_contacted: string | null;
  next_followup: string | null;
  followup_count: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type SenderType = 'customer' | 'ai' | 'human' | 'system';
export type ProcessingStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface ConversationMessage {
  conversation_id: string;
  tenant_id: string;
  lead_id: string;
  phone_number: string | null;
  incoming_message: string | null;
  outgoing_message: string | null;
  sender_type: SenderType;
  intent: string | null;
  message_timestamp: string;
  channel: Channel;
  delivery_status: string | null;
  external_message_id: string | null;
  processing_status: ProcessingStatus;
}

export const EMPTY_FACTS: LeadFacts = {
  customer_name: null,
  email: null,
  location: null,
  property_type: null,
  property_size: null,
  budget: null,
  project_type: null,
  property_status: null,
  timeline_text: null,
  expected_start_date: null,
  requirements: null,
};
