# Testing Report — Interior AI Lead Management

| | |
|---|---|
| Date | 23 Nov 2026 |
| Build | backend 0.1.0 |
| Environment | Windows 10, Node 24.12, TypeScript 7.0.2, Vitest 5.1.1 |
| Command | `cd backend && npm run typecheck && npm test` |
| Result | **156 / 156 automated tests passed**; type-check clean (source + tests). Live AI tests on `mistral:7b`: see §2a |

## 1. Scope and method

The automated tests run the real application code against **in-memory fakes** of Supabase,
WhatsApp, Meta Graph (Instagram / Lead Ads), Google Sheets and OpenAI
(`backend/test/support/fakes.ts`). The in-memory database enforces the same uniqueness and claiming
rules as the Postgres schema.

So the tests check our **logic**: what we store, score, send, skip and alert. They do **not** check
live third-party behaviour or the quality of the AI's wording. Those are covered by the live test plan in §4.

## 2. Spec §12 test cases

| Spec test case | Expected result (spec) | Automated test | Status |
|---|---|---|---|
| New customer enquiry | Create a new CRM record | engine › new customer enquiry creates a new CRM record and replies | ✅ Pass |
| Returning customer | Update existing lead | engine › returning customer updates the existing lead and keeps earlier facts | ✅ Pass |
| Customer provides budget | Save budget correctly | engine › customer provides budget — saved correctly as a number | ✅ Pass |
| Customer skips a question | Continue naturally | — (conversation behaviour of the AI) | ⏳ Live test L4 |
| Customer asks about price | Use approved pricing or escalate | small-model › reply guard (invented prices removed, quotation line on price questions); live §2a | ✅ Pass (automated + live) |
| Customer requests site visit | Notify sales team | engine › customer requests site visit — sales team notified once | ✅ Pass |
| Customer asks for human | Escalate conversation | engine › escalated and AI paused; small-model › escalates even when the model misses it; live §2a | ✅ Pass |
| Customer sends multiple messages | Avoid duplicate lead creation | engine › one lead, one AI call, one reply; duplicate webhook delivery is ignored | ✅ Pass |
| AI generates invalid data | Reject or retry safely | unit › AI output validation (4 tests); engine › fallback reply, error logged, team alerted | ✅ Pass |
| WhatsApp API fails | Log error and retry safely | engine › error logged and message marked failed (retries on 429/5xx are in the sender) | ✅ Pass |
| Customer opts out | Stop automated messages | engine › confirmed, no AI call, follow-ups stopped; unit › isOptOut (9 tests) | ✅ Pass |
| Customer converts | Stop lead follow-ups | engine › customer converts — follow-ups stop; unit › decideFollowup | ✅ Pass |

**11 of 12 pass automatically. "Customer skips a question" depends on the live model: see §2a and live test L4.**

## 2a. Live AI results — `mistral:7b` on the private gateway (23 Nov 2026)

Run with `npm run chat` (real prompt, engine, scoring and alerts; in-memory database; no WhatsApp).
Settings: `LLM_JSON_MODE=json_schema`, `LLM_FACT_GROUNDING=true`.

| Scenario | Result |
|---|---|
| Spec §4.3 sample conversation (7 turns) | ✅ One question per turn in spec order. Final lead: Kondapur, ready, start 2026-12-01, ₹8,00,000, full home, Rahul, site visit → **100 / Hot / qualified**, assigned. Hot-lead and site-visit alerts sent once each. ~4–8 s per reply. |
| Price question ("how much for a 2BHK?") | ✅ Approved quotation line, no amount, then the next question |
| "I want to talk to a real person, not a bot" | ✅ Handoff reply, AI paused, team alerted |
| "STOP" | ✅ Confirmation, opted out, no AI call |
| Hinglish ("…2BHK flat… Gachibowli mein") | ⚠️ Replies in English and missed "Gachibowli" on the first message (7B limitation) |

What the safeguards caught **in live runs** (before they existed, these reached the "customer"):
- an invented price list ("Kitchen: INR 1.5 lakhs … Total: INR 7 lakhs")
- a booking claim ("our designer will visit your site on Saturday")
- invented facts ("property ready", "renovation") that inflated the score
- a false "needs a human" that paused the AI mid-conversation
- the model answering as the customer
- repeated greetings
- "next month" resolved as 2027-01-01

Known limitations with `mistral:7b`:
- Wording is sometimes clumsy (e.g. "Here's a suggested design concept…" with no concept attached).
- Hindi/Telugu conversations are weak.
- 4 of roughly 50 live turns (about 1 in 12) took ~30 s and failed during testing. The customer then gets the fallback reply and the team an "AI COULD NOT RESPOND" alert.

`qwen3:32b` on the same gateway was not usable: it hangs with JSON formats and is too slow (over 2 minutes per reply) without them.

## 3. Coverage by spec section

| Spec section | What is verified | Test groups |
|---|---|---|
| §3.1 WhatsApp | Webhook parsing (text + media placeholders + statuses), signature check, verification handshake, idempotent ingest, burst debouncing, one-at-a-time processing per lead | unit › parseWhatsAppWebhook, verifyMetaSignature; server › HTTP routes; engine › duplicate delivery, Inbox debouncing |
| §3.2 Website form | Validation, secret check, dedupe with an existing WhatsApp lead, invalid phone rejected | engine › website form; server › website form |
| §3.3 Instagram | Parsing (echoes / read receipts skipped), lead without phone, reply via Instagram, phone captured from chat, duplicate phone flagged and not merged, missing token logged | spec-completion › Instagram DMs |
| §3.4 Facebook Lead Ads | Parsing, field mapping (standard + custom + notes), budget text parsing, consented ack template, idempotency, unknown page ignored, end-to-end through `/webhooks/meta` | spec-completion › Facebook Lead Ads, parsing helpers |
| §4 AI receptionist | Prompt receives channel instructions; history merged into turns; invalid output rejected | unit › AI output validation, toChatMessages; spec-completion › Instagram prompt |
| §5 CRM rules | Phone normalisation (12 cases), never-erase merge, corrections accepted | unit › normalizePhone, mergeFacts; engine › returning customer |
| §6 Scoring / classification | Spec example = 100 / hot; provisional vs cold; 30-day rule; status derivation; sales statuses never overwritten | unit › scoreLead, deriveStatus / missingFacts |
| §7 WF02 assignment | Least-loaded selection, load balancing, contact deadline, assigned person alerted, no assignment when not needed | spec-completion › salesperson assignment |
| §7 WF03 follow-ups | 24h window, templates, Instagram window, stop conditions, scheduling, salesperson dates preserved | unit › decideFollowup; engine › follow-ups; spec-completion › salesperson follow-up date preserved |
| §8 Notifications | §8.2 format, dedup (once per event), ready-to-proceed, overdue contact + overdue salesperson follow-up | unit › formatAlert; engine › site visit / hot lead; spec-completion › overdue follow-up alerts, ready to proceed |
| §10 Security | HMAC signature accept/reject/tamper, website secret | unit › verifyMetaSignature; server › HTTP routes |
| §15 Owner CRM (Sheets) | Push + dropdowns, human edits applied + audited, un-pause AI, invalid edit rejected and reverted, stale cells don't overwrite system changes, time-zone round trip | spec-completion › Google Sheets CRM, local time round-trip |

## 4. Live test plan (run after deployment, before handover)

Use real accounts and a test phone. Record pass/fail and the date for each.

| # | Scenario | Steps | Expected |
|---|---|---|---|
| L1 | WhatsApp round trip | Send "Hi, I need interiors for my 3BHK" | Friendly reply within ~10s asking one question; lead in Supabase + Sheet |
| L2 | Burst | Send 3 messages within 2 seconds | One reply covering all three |
| L3 | Full qualification | Answer location, readiness, start next month, budget 8L, full home | Lead `qualified`, `hot`, assigned; alert in the §8.2 format to managers + assignee |
| L4 | Skipped question | When asked for the budget, reply "not sure yet" | AI moves on naturally, budget stays empty, no repeated nagging |
| L5 | Price question | Ask "how much for a 3BHK?" | No invented price; says a designer will quote after the site visit (or escalates) |
| L6 | Multilingual | Write in Telugu / Hindi / Hinglish | Reply in the same language and script |
| L7 | Human request | "I want to talk to a person" | Handoff message, alert, AI silent afterwards; set AI Paused = FALSE in the Sheet → AI resumes |
| L8 | Opt-out | "STOP" | Confirmation; no follow-ups afterwards |
| L9 | Instagram DM | DM the business account | Reply in the DM; after the requirement, asks for a phone number once |
| L10 | Lead Ads | Submit via the Lead Ads Testing Tool | Lead with mapped fields, alert, ack template (if enabled) |
| L11 | Website form | POST a sample form | `201`, lead + alert |
| L12 | Follow-up | Leave a lead in `information_pending`; set its `next_followup` to the past | Follow-up message within 15 min |
| L13 | Overdue alert | Hot lead, don't change its status for 4h (or set `contact_due_at` to the past) | "FOLLOW-UP OVERDUE" alert once |
| L14 | Sheet editing | Change Status to `contacted`, add a note | Reflected in Supabase within 2 min; audit_log entry |
| L15 | Failure path | Temporarily set a wrong `OPENAI_API_KEY` | Customer gets the fallback reply; team gets an "AI COULD NOT RESPOND" alert; `error_log` entry |

## 5. Not covered / known limitations

- **Live AI calls** have been made (§2a). **No live calls** to WhatsApp, Meta, Google or Supabase yet (no credentials in the dev environment). The live test plan above covers this.
- **AI conversation quality** (tone, one question at a time, language matching) depends on the model and prompt. Check it in L1–L9 and adjust the prompt (`backend/src/ai/prompt.ts`) or the business's knowledge base.
- **Docker image** was written but not built locally.
- **Load**: not load-tested. The design targets a single instance serving a few businesses (hundreds of conversations a day).
- **Sheet sync race**: an edit made in the ~1 second between the sync reading and rewriting the sheet can be lost. Sorting the sheet is reset every sync, so staff should use *filter views*.
