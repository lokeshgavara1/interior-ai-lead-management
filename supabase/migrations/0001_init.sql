-- Lusa Interior AI Lead Management — initial schema
-- Multi-tenant from day one: every row carries tenant_id.
-- The backend uses the service-role key (bypasses RLS). RLS policies below
-- are for the future dashboard (Supabase Auth users scoped to their tenant).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tenants (one per interior business)
-- ---------------------------------------------------------------------------
create table tenants (
  id                        uuid primary key default gen_random_uuid(),
  slug                      text not null unique,
  name                      text not null,
  whatsapp_phone_number_id  text unique,             -- Meta phone_number_id for this business
  website_webhook_secret    text not null default encode(gen_random_bytes(24), 'hex'),
  timezone                  text not null default 'Asia/Kolkata',
  default_country_code      text not null default '91',
  -- Approved company information the AI may use (services, areas served,
  -- process, approved price ranges). The AI must not go beyond this.
  knowledge_base            text not null default '',
  -- {
  --   "sales_whatsapp_numbers": ["+91..."], "sales_emails": ["..."],
  --   "alert_template_name": "new_lead_alert", "alert_template_lang": "en",
  --   "followup_template_name": "lead_followup", "followup_template_lang": "en",
  --   "ack_template_name": "enquiry_received",
  --   "high_value_budget": 1500000, "max_followups": 3
  -- }
  settings                  jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now()
);

-- Dashboard users ↔ tenants (Supabase Auth)
create table tenant_members (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'sales' check (role in ('owner', 'admin', 'sales')),
  display_name text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Leads (spec §5.1)
-- ---------------------------------------------------------------------------
create table leads (
  lead_id               uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  customer_name         text,
  phone_number          text not null,               -- E.164, e.g. +919876543210
  email                 text,
  location              text,
  property_type         text check (property_type in ('apartment','villa','independent_house','commercial','other')),
  property_size         text,
  budget                numeric check (budget is null or budget >= 0),
  project_type          text check (project_type in ('full_home','kitchen','wardrobe','living_room','bedroom','renovation','other')),
  property_status       text check (property_status in ('ready','under_construction')),
  timeline_text         text,                        -- what the customer said ("next month")
  expected_start_date   date,                        -- resolved absolute date
  requirements          text,
  site_visit_requested  boolean not null default false,
  lead_source           text not null check (lead_source in ('whatsapp','instagram','facebook','website','google_business','referral','manual')),
  lead_score            integer check (lead_score between 0 and 100),
  lead_temperature      text not null default 'provisional'
                          check (lead_temperature in ('hot','warm','cold','provisional')),
  lead_status           text not null default 'new'
                          check (lead_status in ('new','information_pending','qualified','contacted',
                                                 'site_visit_scheduled','quotation_sent','negotiation',
                                                 'converted','lost')),
  missing_information   text[] not null default '{}',
  needs_human           boolean not null default false,
  ai_paused             boolean not null default false,  -- human takeover: AI stays silent
  opted_out             boolean not null default false,
  assigned_salesperson  text,
  last_customer_message_at timestamptz,              -- drives WhatsApp 24h window
  last_contacted        timestamptz,
  next_followup         timestamptz,
  followup_count        integer not null default 0,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, phone_number)                   -- prevents duplicate leads
);

create index leads_tenant_status_idx on leads (tenant_id, lead_status);
create index leads_followup_idx on leads (next_followup) where next_followup is not null and opted_out = false;

-- ---------------------------------------------------------------------------
-- Conversation history (spec §5.2) — one row per message
-- ---------------------------------------------------------------------------
create table interior_conversations (
  conversation_id     uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  lead_id             uuid not null references leads(lead_id) on delete cascade,
  phone_number        text not null,
  incoming_message    text,                          -- set for customer messages
  outgoing_message    text,                          -- set for ai/human/system messages
  sender_type         text not null check (sender_type in ('customer','ai','human','system')),
  intent              text,
  message_timestamp   timestamptz not null default now(),
  channel             text not null check (channel in ('whatsapp','instagram','facebook','website')),
  delivery_status     text,                          -- sent / delivered / read / failed
  external_message_id text,                          -- WhatsApp wamid etc.
  processing_status   text not null default 'done'
                        check (processing_status in ('pending','processing','done','failed')),
  claimed_at          timestamptz,
  created_at          timestamptz not null default now(),
  unique (tenant_id, channel, external_message_id)   -- idempotency for webhook retries
);

create index conv_lead_time_idx on interior_conversations (lead_id, message_timestamp desc);
create index conv_pending_idx on interior_conversations (lead_id) where processing_status in ('pending','processing');

-- ---------------------------------------------------------------------------
-- Notifications (deduplicated) and logs
-- ---------------------------------------------------------------------------
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  lead_id     uuid references leads(lead_id) on delete cascade,
  kind        text not null,                         -- hot_lead / site_visit / human_needed / high_value / ai_failure
  dedupe_key  text not null unique,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending' check (status in ('pending','sent','failed')),
  error       text,
  created_at  timestamptz not null default now()
);

create table error_log (
  id          bigserial primary key,
  tenant_id   uuid references tenants(id) on delete set null,
  lead_id     uuid references leads(lead_id) on delete set null,
  operation   text not null,
  message     text not null,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table audit_log (
  id          bigserial primary key,
  tenant_id   uuid references tenants(id) on delete set null,
  actor       text not null,                         -- 'system', 'ai', or a user id
  action      text not null,
  entity      text not null,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger leads_updated_at before update on leads
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Atomically claim a lead's pending inbound messages (burst merging).
-- Two workers can never claim the same message.
-- ---------------------------------------------------------------------------
create or replace function claim_pending_messages(p_lead_id uuid)
returns setof interior_conversations
language sql as $$
  update interior_conversations
     set processing_status = 'processing', claimed_at = now()
   where lead_id = p_lead_id
     and processing_status = 'pending'
  returning *;
$$;

-- Reset messages stuck in 'processing' (worker crashed) back to 'pending'.
create or replace function reset_stale_processing(p_older_than interval)
returns setof uuid
language sql as $$
  update interior_conversations
     set processing_status = 'pending', claimed_at = null
   where processing_status = 'processing'
     and claimed_at < now() - p_older_than
  returning lead_id;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security (for dashboard users; service role bypasses)
-- ---------------------------------------------------------------------------
alter table tenants                enable row level security;
alter table tenant_members         enable row level security;
alter table leads                  enable row level security;
alter table interior_conversations enable row level security;
alter table notifications          enable row level security;
alter table error_log              enable row level security;
alter table audit_log              enable row level security;

create or replace function is_tenant_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tenant_members where tenant_id = p_tenant and user_id = auth.uid());
$$;

create policy tenants_read on tenants for select using (is_tenant_member(id));
create policy members_read on tenant_members for select using (is_tenant_member(tenant_id));
create policy leads_rw on leads for all using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
create policy conv_rw on interior_conversations for all using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
create policy notif_read on notifications for select using (is_tenant_member(tenant_id));
create policy audit_read on audit_log for select using (is_tenant_member(tenant_id));
