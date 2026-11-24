# Lusa Interior AI — Lead Receptionist & Lead Management

A code-based implementation of the *Lusa Technologies Interior AI Lead Management* spec v1.0
(replacing the n8n workflows with a tested TypeScript service). Multi-tenant from day one,
so one deployment can serve many interior businesses.

| Document | For |
|---|---|
| [docs/Client_Setup_and_Deployment_Guide.docx](docs/Client_Setup_and_Deployment_Guide.docx) | Client-facing: credentials checklist, step-by-step deployment, go-live checks |
| [docs/Test_Results_Report.docx](docs/Test_Results_Report.docx) | Client-facing: test results, live conversation showcase, quality improvements |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Setting up Supabase, Meta, Google Sheets, the server; go-live checklist |
| [docs/TESTING_REPORT.md](docs/TESTING_REPORT.md) | Automated results, spec §12 mapping, live test plan |
| [docs/HANDOVER.md](docs/HANDOVER.md) | Business owner and sales team: daily use, Sheet, settings, troubleshooting |

## Spec coverage

| Spec | Status | Where |
|---|---|---|
| §3.1 WhatsApp | ✅ | `channels/whatsapp.ts`, `engine/ingest.ts` |
| §3.2 Website form | ✅ | `POST /webhooks/website/:slug` |
| §3.3 Instagram DMs | ✅ | `channels/meta.ts`, `engine/ingest.ts` |
| §3.4 Facebook Lead Ads | ✅ | `channels/meta.ts`, `engine/ingest.ts` (field mapping per business) |
| §3.5 Google Business / referrals | ✅ via website form or manual entry (as the spec says for v1) | |
| §4 / §9 AI receptionist + structured output | ✅ | `ai/` |
| §5 CRM schema + rules | ✅ | `supabase/migrations/` |
| §6 Scoring + classification | ✅ | `engine/scoring.ts` |
| §7 WF01 receptionist | ✅ | `engine/conversation.ts`, `engine/inbox.ts` |
| §7 WF02 qualification, notification, **salesperson assignment** | ✅ | `engine/sales.ts` |
| §7 WF03 automated follow-ups | ✅ | `jobs/followups.ts` |
| §8 Notifications incl. **ready to proceed** and **overdue follow-up** | ✅ | `notify/notifier.ts`, `jobs/overdue.ts` |
| §10 Error handling + security | ✅ | throughout; `error_log`, `audit_log` |
| §15 Owner can access CRM | ✅ Google Sheet with two-way sync | `jobs/sheetSync.ts` |
| §11 Phase 11 Dashboard | ⏭ Future (per spec) | |
| §14 Future enhancements | ⏭ Future (per spec) | |

## Layout

```
Chatbot/
├── backend/
│   ├── src/
│   │   ├── index.ts          Entry: wires everything, starts server + background jobs
│   │   ├── server.ts         Routes: /webhooks/meta (WhatsApp, Instagram, Lead Ads), /webhooks/website/:slug, /health
│   │   ├── config.ts         Env validation
│   │   ├── domain/types.ts   Lead / tenant / message types and enums
│   │   ├── db/               Repo interface + Supabase implementation
│   │   ├── channels/         WhatsApp, Meta Graph (Instagram + Lead Ads), Google Sheets
│   │   ├── ai/               Prompt, schema, OpenAI-compatible client, repair, grounding, reply guard, checklist steering
│   │   ├── cli/              Local chat (npm run chat) and live AI test plan (npm run test:live)
│   │   ├── engine/           Conversation, scoring, merge, opt-out, debouncing inbox, ingest, sales workflow
│   │   ├── notify/           Sales alerts (WhatsApp template/text + email)
│   │   ├── jobs/             Follow-ups, overdue alerts, Google Sheets sync
│   │   └── lib/              Phone, signatures, budget parsing, time zones
│   ├── test/                 168 tests (in-memory fakes for every external service)
│   └── Dockerfile
├── supabase/
│   ├── migrations/0001_init.sql            Core schema, constraints, RLS, claim functions
│   ├── migrations/0002_spec_completion.sql Instagram, assignment, deadlines, secrets, sheet sync
│   └── seed.sql                            Example business
├── deploy/                   docker-compose + Caddy (HTTPS)
└── docs/                     Deployment, testing report, handover
```

## How a message flows

1. **Webhook** `POST /webhooks/meta` (WhatsApp / Instagram) checks the Meta signature, then stores the message as `pending`
   *before* acknowledging Meta. Duplicate deliveries are dropped by a unique message id.
2. **Debounce**: the system waits 4 seconds after the customer's last message, so a burst becomes **one** AI turn and **one** reply.
   One lead is never processed twice at the same time.
3. **Opt-out check** (rule-based, before the AI), then the **human takeover check** (`ai_paused`).
4. **AI turn**: the reply and extracted fields come back as JSON, which is repaired and then strictly validated. If the output is invalid it retries once,
   then sends a fallback reply and alerts the team. Next come grounding (small-model mode), the price/booking guard and reply steering.
5. **Merge** (new facts never erase known ones), then **score** (deterministic, §6), then **status** (automation only moves leads
   new → information_pending → qualified).
6. **Reply** on the same channel.
7. **Sales workflow**: if the lead needs attention (hot, qualified, site visit, needs a human, high value, ready to
   proceed, or a new form lead), it's assigned to the least-loaded salesperson and given a contact deadline
   (4 hours by default), and the alerts go out, each sent once.
8. **Background jobs**:
   - AI follow-ups every 15 min (max 3, respecting the 24h window)
   - overdue checks every 10 min
   - Google Sheet sync every 2 min

Form leads (website, Lead Ads) skip the AI conversation and go straight from merge to the sales workflow, with
an optional consented WhatsApp acknowledgement template.

## Quick start (local)

```powershell
cd backend
copy .env.example .env   # then fill it in
npm install
npm run typecheck
npm test
npm run dev
```

### Talk to the AI receptionist without WhatsApp
`npm run chat` runs the real prompt, engine, scoring, assignment and alerts against an
in-memory database. Only the AI settings in `.env` are needed.
```powershell
npm run chat
```
```powershell
npm run chat -- "Hi, 3BHK in Kondapur" "It is ready" "Around 8 lakhs"
```
Interactive commands: `/lead` (show the lead record), `/history`, `/reset`, `/quit`.

### Live AI test plan
`npm run test:live` plays the test-plan scenarios against the real model and checks each outcome
(data, alerts, no prices, no booking claims, one question per reply). Run one scenario with
`npm run test:live -- L4`. Development result: 84/84 on the `mistral:7b` test server. Run it again with the production OpenAI key.

## AI model

Any **OpenAI-compatible** chat API works (OpenAI, Ollama, vLLM, private gateways):

| Setting | Meaning |
|---|---|
| `OPENAI_BASE_URL` | Empty for api.openai.com, or e.g. `https://<gateway>/v1` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Credentials and model id |
| `LLM_JSON_MODE` | `json_schema` (server enforces the schema; best), `json_object`, or `prompt` (schema described in the prompt) |
| `LLM_FACT_GROUNDING` | `true` turns on **small-model mode** (below). Use it for 7B-class models. |

**Production uses OpenAI** (`OPENAI_BASE_URL` empty, `LLM_FACT_GROUNDING=false`; verify with `npm run test:live`).
Development testing used a private test server running `mistral:7b` (Ollama) with grounding on.

**Safety guards for all models** (`ai/replyGuard.ts`, `engine/optout.ts`):
- invented prices and discounts are removed
- booking claims ("your visit is booked") are replaced
- STOP and "talk to a person" are detected in code

Every rewrite is recorded in `audit_log` (`reply_guard_*`) with the original text.

**Small-model mode** (`ai/grounding.ts`, `ai/checklist.ts`): small models fill in guesses, re-ask questions, repeat
themselves and drift. With grounding on:
- facts are kept only when the customer's own words support them
- start dates are resolved in code
- the answer to the last question is slot-filled when the model misses it
- the reply is steered to ask the next missing detail in spec order
- repeated greetings and parroting are removed
- the closing message is written in code once everything is collected
To test webhooks locally, expose port 3000 with a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`).
Full setup: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Website form
`POST /webhooks/website/<tenant-slug>` with header `x-webhook-secret: <tenants.website_webhook_secret>`:
```json
{
  "customer_name": "Rahul Kumar", "phone_number": "9876543210", "email": "",
  "property_type": "apartment", "property_location": "Kondapur", "property_size": "3BHK",
  "project_type": "full_home", "property_status": "ready", "project_requirements": "Kitchen, wardrobes",
  "approximate_budget": 800000, "expected_start_date": "2026-12-01", "whatsapp_consent": true
}
```
Call it from the website's **server**, not browser JavaScript, so the secret stays private.

## Deliberate differences from the spec
- **Supabase is the source of truth; Google Sheets is the team's view and editor.** Unique constraints in the database are what actually
  prevent duplicate leads, while the Sheet keeps the "Google Sheets initially" experience for the business.
- **`lead_status` is computed in code, not by the AI.** Sales stages set by people are never overwritten.
- **`provisional` temperature**, as §6.2 requires ("don't mark incorrectly cold").
- **`timeline_text` + `expected_start_date`** keep the customer's words *and* a resolved date for scoring.
- **Human takeover** (`ai_paused`): an escalated lead's AI stays silent until someone sets AI Paused = FALSE.
- **Instagram leads may have no phone.** The AI asks for one; a number already used by another lead is flagged in
  notes rather than auto-merged.
- **`contact_due_at`** (sales contact deadline) is a separate field from `next_followup`, so AI follow-ups and salesperson reminders never collide.

## Operating notes
- Runs as a **single instance**. To scale horizontally, replace `engine/inbox.ts` with a queue that supports per-lead
  concurrency (e.g. BullMQ groups). The database claim function already prevents double-processing.
- The WhatsApp token is a single env var. Page tokens are stored per business in `tenant_secrets`; consider Supabase Vault for both.
- Failures go to `error_log`, important actions to `audit_log`, and alerts to `notifications`.

## Roadmap (spec §11 Phase 11 and §14, all marked Future in the spec)
Dashboard and reporting, AI appointment booking, quotation generation, project status assistant, voice
receptionist, portfolio recommendations, image enquiry handling, project-management integration.
