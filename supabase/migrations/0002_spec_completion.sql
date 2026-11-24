-- Spec completion: salesperson assignment (§7 WF02), overdue follow-up alerts (§8.1),
-- Instagram DMs (§3.3), Facebook Lead Ads (§3.4), Google Sheets CRM sync (§2.2, §15).

-- ---------------------------------------------------------------------------
-- Tenants: Meta page / Instagram account mapping
-- ---------------------------------------------------------------------------
alter table tenants
  add column facebook_page_id     text unique,
  add column instagram_account_id text unique;

-- Per-tenant secrets. RLS on with NO policies => only the service role can read.
create table tenant_secrets (
  tenant_id          uuid primary key references tenants(id) on delete cascade,
  page_access_token  text,          -- Facebook Page token (Instagram DMs + Lead Ads)
  updated_at         timestamptz not null default now()
);
alter table tenant_secrets enable row level security;

-- ---------------------------------------------------------------------------
-- Leads: Instagram identity, assignment, contact deadline, last channel
-- ---------------------------------------------------------------------------
alter table leads alter column phone_number drop not null;   -- Instagram leads may not share a phone yet
alter table leads
  add column instagram_id          text,
  add column last_customer_channel text check (last_customer_channel in ('whatsapp','instagram','facebook','website')),
  add column assigned_at           timestamptz,
  add column contact_due_at        timestamptz,   -- SLA: salesperson should contact the lead by this time
  add constraint leads_has_contact check (phone_number is not null or instagram_id is not null),
  add constraint leads_tenant_instagram_key unique (tenant_id, instagram_id);

create index leads_contact_due_idx on leads (contact_due_at) where contact_due_at is not null;

alter table interior_conversations alter column phone_number drop not null;

-- ---------------------------------------------------------------------------
-- Idempotency for webhook events that are not messages (e.g. Lead Ads leadgen ids)
-- ---------------------------------------------------------------------------
create table processed_events (
  event_key   text primary key,
  tenant_id   uuid references tenants(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table processed_events enable row level security;

-- ---------------------------------------------------------------------------
-- Google Sheets sync state: last values pushed to the sheet, per tenant.
-- Used to detect which cells a person edited since the last sync.
-- ---------------------------------------------------------------------------
create table sheet_sync_state (
  tenant_id   uuid primary key references tenants(id) on delete cascade,
  snapshot    jsonb not null default '{}'::jsonb,
  synced_at   timestamptz
);
alter table sheet_sync_state enable row level security;
