# Deployment Guide — Interior AI Lead Management

Audience: the developer or ops person setting up a production instance.
Time needed: about half a day of hands-on work. Meta business verification and app review
can add **1–3 weeks** of waiting, so start step 3 first.

---

## 1. What you are deploying

| Component | Where it runs | Notes |
|---|---|---|
| Backend (`backend/`) | A VPS (Docker) | Node 22, one container. 1 vCPU / 1 GB RAM is enough for a few businesses. |
| HTTPS proxy | Same VPS (Caddy) | Free automatic TLS certificates; Meta requires HTTPS webhooks. |
| Database | Supabase (managed Postgres) | Source of truth for leads, conversations, logs. |
| AI | OpenAI (any OpenAI-compatible API works) | Production: your OpenAI account (see §5a). |
| Messaging | Meta: WhatsApp Cloud API, Instagram Messaging, Facebook Lead Ads | One Meta app; one webhook URL. |
| Owner CRM view | Google Sheets (optional) | Two-way sync every 2 minutes. |
| Alert email | Any SMTP provider (optional, recommended) | Backup channel for sales alerts. |

The service runs as **one instance**. Don't scale it to several replicas without replacing the
in-process debouncer (see README → Operating notes).

---

## 2. Supabase

1. Create a project (choose the Mumbai region for Indian customers).
2. **SQL editor** → run, in order:
   1. `supabase/migrations/0001_init.sql`
   2. `supabase/migrations/0002_spec_completion.sql`
   3. `supabase/seed.sql`, after editing it for the first business (see §5).
3. **Settings → API**: copy the project URL and the `service_role` key. The service-role key
   bypasses row-level security, so keep it **only** in the server's `.env`.
4. Backups: the free plan has no point-in-time recovery. For production, use a paid plan or
   schedule `pg_dump` from the VPS.

---

## 3. Meta (WhatsApp, Instagram, Lead Ads)

### 3.1 Business and app
1. Complete **Meta Business verification** for the business (or for Lusa, if Lusa owns the app).
2. Create a Meta app of type **Business**, then add the products: **WhatsApp**, **Instagram** (messaging) and **Webhooks**.
3. Request these permissions in App Review. Meta changes these lists from time to time, so confirm them in the App Dashboard:
   - WhatsApp: `whatsapp_business_messaging`, `whatsapp_business_management`
   - Instagram DMs: `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_show_list`
   - Lead Ads: `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`
4. Create a **System User** in Business Settings, assign it the app, the WhatsApp account and the Page,
   and generate:
   - a **permanent token** with the WhatsApp permissions → `WHATSAPP_ACCESS_TOKEN` in `.env`
   - a **Page access token** for the business's Facebook Page (linked to its Instagram professional
     account) → store per business in `tenant_secrets` (§5)

### 3.2 IDs you need per business
| Value | Where to find it | Stored in |
|---|---|---|
| WhatsApp *Phone number ID* | WhatsApp → API Setup | `tenants.whatsapp_phone_number_id` |
| Facebook *Page ID* | Page → About / Business Settings | `tenants.facebook_page_id` |
| Instagram *professional account ID* | Graph API: `GET /{page-id}?fields=instagram_business_account` | `tenants.instagram_account_id` |

### 3.3 Webhooks (one URL for everything)
- Callback URL: `https://<your-domain>/webhooks/meta`
- Verify token: the value of `META_VERIFY_TOKEN`
- Subscribe to these fields:
  - **WhatsApp Business Account** → `messages`
  - **Instagram** → `messages`
  - **Page** → `leadgen`
- Subscribe the app to the Page (needed for Lead Ads and Instagram events):
  `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen,messages` with the Page token.
- Test Lead Ads with Meta's **Lead Ads Testing Tool** once deployed.

### 3.4 WhatsApp message templates
Submit these in WhatsApp Manager. Approval usually takes minutes to a day. Then add their names to the business's settings (§5).

| Setting | Category | Example body | Params |
|---|---|---|---|
| `alert_template_name` | Utility | `{{1}}: {{2}} ({{3}}) – {{4}}` | title, name, phone, summary |
| `followup_template_name` | Marketing | `Hi {{1}}, just checking in about your interior enquiry. Would you like our designer to call you?` | name |
| `ack_template_name` | Utility | `Hi {{1}}, thanks for your interior enquiry! Our design team will contact you shortly.` | name |

Without `alert_template_name`, alerts go to staff phones as plain text, and WhatsApp only
delivers those if the staff member messaged the business number in the last 24 hours. Configure
**SMTP email** as a backup either way.

---

## 4. Google Sheets CRM (optional, recommended)

1. Google Cloud Console → create a project → enable the **Google Sheets API**.
2. Create a **service account** → Keys → *Add key (JSON)*. Keep the file secret.
3. For each business: create a Google Sheet, **Share** it with the service account's
   `client_email` as **Editor**, and put the sheet ID (the long id in its URL) in that business's `settings.google_sheet_id`.
4. On the server, either paste the JSON into `GOOGLE_SERVICE_ACCOUNT_JSON` or mount the file and set
   `GOOGLE_SERVICE_ACCOUNT_FILE` (see the commented volume in `deploy/docker-compose.yml`).

The service creates a **Leads** tab, freezes the header and adds dropdowns. Columns marked ✎ can be
edited by people; everything else is overwritten on every sync.

---

## 5. Configure a business (tenant)

Edit and run in the Supabase SQL editor:

```sql
-- 1. Business details (or edit supabase/seed.sql before running it)
update tenants set
  whatsapp_phone_number_id = '123456789012345',
  facebook_page_id         = '111111111111111',
  instagram_account_id     = '17841400000000000',
  knowledge_base = $kb$ ...services, areas, process, pricing policy, hours... $kb$,
  settings = '{
    "sales_whatsapp_numbers": ["+919000000000"],
    "sales_emails": ["sales@business.com"],
    "salespeople": [
      {"name": "Priya", "whatsapp": "+919111111111", "email": "priya@business.com"},
      {"name": "Arjun", "whatsapp": "+919222222222"}
    ],
    "contact_sla_hours": 4,
    "high_value_budget": 1500000,
    "max_followups": 3,
    "alert_template_name": "new_lead_alert",
    "followup_template_name": "lead_followup",
    "ack_template_name": "enquiry_received",
    "google_sheet_id": "1AbC...",
    "lead_ads_whatsapp_ack": true,
    "lead_ads_field_map": {
      "what_type_of_property?": "property_type",
      "your_budget": "budget",
      "when_do_you_want_to_start?": "timeline_text"
    }
  }'::jsonb
where slug = 'demo-interiors';

-- 2. Page token (service-role only table)
insert into tenant_secrets (tenant_id, page_access_token)
select id, 'EAAG...' from tenants where slug = 'demo-interiors'
on conflict (tenant_id) do update set page_access_token = excluded.page_access_token, updated_at = now();

-- 3. Website form secret to give the web developer
select website_webhook_secret from tenants where slug = 'demo-interiors';
```

`lead_ads_field_map` keys are the question keys of the Lead Ads form; look at one test lead's
`field_data` to see them. The targets you can map to are `location`, `property_type`, `property_size`, `project_type`, `budget`,
`property_status`, `timeline_text` and `requirements`. Any question you don't map is saved in the lead's notes.

---

## 5a. AI model settings

**Production uses OpenAI.** In `backend/.env`:
```
OPENAI_BASE_URL=
OPENAI_API_KEY=<your OpenAI API key>
OPENAI_MODEL=<a current OpenAI model with Structured Outputs>
LLM_JSON_MODE=json_schema
LLM_FACT_GROUNDING=false
LLM_TIMEOUT_MS=60000
```
Before going live, run the AI test plan with this key: `cd backend && npm run test:live`.
If any required check fails, set `LLM_FACT_GROUNDING=true` (the configuration that passed 84/84 in
development) and run it again. The price/booking/human/STOP safety checks are on in both modes.

**Development testing** used a separate private test server (`mistral:7b` on Ollama), which is not part of the
production setup. Results there (23–24 Nov 2026):

| Model | Mode | Result |
|---|---|---|
| `mistral:7b` | `json_schema` + grounding | ✅ Live test plan 84/84, median about 5 s per reply |
| `qwen3:32b` | `json_schema` / `json_object` | ❌ Requests hang until timeout (thinking model + format constraint) |
| `qwen3:32b` | `prompt` | ❌ Over 2 minutes per reply: too slow for chat |

---

## 6. Server

On a fresh Ubuntu VPS with a DNS `A` record pointing your domain at it:

```bash
# Docker
curl -fsSL https://get.docker.com | sh

# Code
git clone <your-repo> lead-ai && cd lead-ai
cp backend/.env.example backend/.env   # fill in every value
echo "DOMAIN=leads.example.com" > deploy/.env

# Run
cd deploy
docker compose up -d --build
docker compose logs -f app
```

Without Docker: `cd backend && npm ci && npm run build && node dist/index.js`, run under a process manager such as
systemd or PM2, behind any HTTPS reverse proxy.

> Note: the Dockerfile and compose file were written but **not built** in the development environment
> (Docker wasn't available there). Run the first build on the server and check the logs.

---

## 7. Go-live checklist

| # | Check | How |
|---|---|---|
| 1 | Health | `curl https://<domain>/health` returns `{"ok":true}` |
| 2 | Webhook verification | "Verify and save" succeeds in the Meta dashboard |
| 3 | Startup log | `Google Sheets sync enabled` (if configured), no config errors |
| 4 | WhatsApp round trip | Message the business number, get an AI reply within ~10s |
| 5 | Burst handling | Send 3 quick messages, get **one** reply |
| 6 | Instagram round trip | DM the Instagram account, get a reply in the DM |
| 7 | Lead Ads | Lead Ads Testing Tool → lead appears in Supabase and the Sheet; sales alert received |
| 8 | Website form | `curl` the form endpoint (README) → `201` |
| 9 | Hot lead | Give full details with a near start date → hot alert to managers + assigned salesperson |
| 10 | Human request | "I want to talk to a person" → alert, AI goes silent for that lead |
| 11 | Opt-out | Send "STOP" → confirmation, no further automated messages |
| 12 | Sheet edit | Change a lead's status in the Sheet → reflected in Supabase within 2 minutes |
| 13 | Errors | `select * from error_log order by id desc limit 20;` shows nothing unexpected |

---

## 8. Operations

- **Logs**: `docker compose logs -f app` (JSON). Business-level failures also go to the `error_log` table.
- **Update**: `git pull && docker compose up -d --build`. Shutdown is graceful: the app finishes in-flight replies first.
- **Rollback**: `git checkout <previous-tag> && docker compose up -d --build`. Database migrations only add things, so older code still runs against the newer schema.
- **Rotate secrets**: update `backend/.env` or `tenant_secrets`, then `docker compose restart app`. Rotate the
  Meta app secret / verify token in the Meta dashboard at the same time.
- **Monitoring**: point an uptime checker (e.g. UptimeRobot) at `/health`, and check `error_log` daily for the first weeks.

## 9. Security checklist
- [ ] `.env` is readable only by the deploy user; it is never committed.
- [ ] Webhooks are rejected without a valid Meta signature (built in).
- [ ] The website form posts from the **website's server**, never from browser JavaScript (the secret must stay private).
- [ ] The Supabase service-role key is used only on the server.
- [ ] Google Sheets are shared only with the service account and the business's own staff.
- [ ] Customer consent: the website form sends `whatsapp_consent`, and Lead Ads forms include consent text before `lead_ads_whatsapp_ack` is turned on.
