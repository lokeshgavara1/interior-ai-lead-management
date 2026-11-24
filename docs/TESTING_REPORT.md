# Testing Report — Interior AI Lead Management

| | |
|---|---|
| Date | 24 Nov 2026 |
| Build | backend 0.1.0 |
| Environment | Windows 10, Node 24.12, TypeScript 7.0.2, Vitest 5.1.1 |
| Commands | `npm run typecheck`, `npm test`, `npm run test:live` (in `backend/`) |
| Result | **163 / 163 automated tests passed**, type-check clean. **Live AI test plan: 68 / 68 checks passed** on `mistral:7b` (§2a). Database migrations: 8 / 8 checks passed on Postgres (§2b). |

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
| Customer skips a question | Continue naturally | small-model › a refusal is never asked again; live §2a L4 | ✅ Pass (automated + live) |
| Customer asks about price | Use approved pricing or escalate | small-model › reply guard (invented prices removed, quotation line on price questions); live §2a | ✅ Pass (automated + live) |
| Customer requests site visit | Notify sales team | engine › customer requests site visit — sales team notified once | ✅ Pass |
| Customer asks for human | Escalate conversation | engine › escalated and AI paused; small-model › escalates even when the model misses it; live §2a | ✅ Pass |
| Customer sends multiple messages | Avoid duplicate lead creation | engine › one lead, one AI call, one reply; duplicate webhook delivery is ignored | ✅ Pass |
| AI generates invalid data | Reject or retry safely | unit › AI output validation (4 tests); engine › fallback reply, error logged, team alerted | ✅ Pass |
| WhatsApp API fails | Log error and retry safely | engine › error logged and message marked failed (retries on 429/5xx are in the sender) | ✅ Pass |
| Customer opts out | Stop automated messages | engine › confirmed, no AI call, follow-ups stopped; unit › isOptOut (9 tests) | ✅ Pass |
| Customer converts | Stop lead follow-ups | engine › customer converts — follow-ups stop; unit › decideFollowup | ✅ Pass |

**All 12 spec §12 cases pass automatically; the AI-behaviour cases are also confirmed live in §2a.**

## 2a. Live AI test plan — `mistral:7b` on the private gateway (24 Nov 2026)

Command: `cd backend && npm run test:live`. It runs the real prompt, engine, scoring, assignment and alerts against
the real model, with an in-memory database and a fake WhatsApp. Each scenario prints its transcript and
checks the outcome automatically. Settings: `LLM_JSON_MODE=json_schema`, `LLM_FACT_GROUNDING=true`.

Every scenario also checks:
- no invented prices
- no booking claims
- at most one question per reply
- no AI failures
- average reply time

| Scenario | Checks | Result |
|---|---|---|
| L1–L3 Full qualification (spec §4.3 conversation, 7 turns) | 18 | ✅ Kondapur, ready, start 2026-12-01, ₹8,00,000, full home, Rahul, site visit → **100 / Hot / qualified**, assigned; hot-lead and site-visit alerts exactly once |
| L4 Customer skips a question ("Not sure about the budget yet") | 8 | ✅ Budget stays empty, not asked again, conversation continues |
| L5 Price question | 6 | ✅ Approved quotation line, no amount |
| L6 Hinglish ("…2BHK flat… Gachibowli mein") | 7 | ✅ Location and property captured; reply is in English |
| L7 "I want to talk to a real person, not a bot" | 8 | ✅ Handoff reply, AI paused, team alerted |
| L7b Customer writes again after handoff | 6 | ✅ AI stays silent |
| L8 "STOP" | 8 | ✅ Confirmed, opted out, no follow-up |
| X1 "Can your designer come tomorrow at 5pm?" | 7 | ✅ Visit recorded and alerted, no booking claim; all 6 facts read from one message |
| **Total** | **68** | **68 / 68 passed** |

**How we got here.** The first run of this plan passed 63/67. Its four failures were real defects, each now fixed and covered by a unit test:
1. A reply over 1,000 characters (a cost-breakdown essay after the budget) failed the whole turn. It is now shortened at a sentence boundary.
2. "Not sure about the budget yet" was followed by the budget question again. Refusals are now tracked by topic.
3. "Can your designer come tomorrow?" wasn't recognised as a site-visit request.
4. A reply was broken at "e.g." by the sentence splitter.

The rerun also added area recognition from the business's "Areas served" list (fixes Hinglish and "3BHK in Kondapur") and readiness detection from multi-fact messages.

## 2b. Database migrations (24 Nov 2026)

Both migrations and the seed run cleanly on Postgres (PGlite, with a stub of Supabase's `auth` schema). Checks:
- duplicate phone and duplicate Instagram id are ignored
- a lead with no contact details is rejected
- a webhook message is stored once and claimed atomically (2 claimed, then 0)
- messages stuck in "processing" are reset for retry
- an invalid status is rejected
- a duplicate alert is ignored
- the `updated_at` trigger works

**8 / 8 passed.**

### Earlier live findings (23 Nov)

What the safeguards caught **in live runs** (before they existed, these reached the "customer"):
- an invented price list ("Kitchen: INR 1.5 lakhs … Total: INR 7 lakhs")
- a booking claim ("our designer will visit your site on Saturday")
- invented facts ("property ready", "renovation") that inflated the score
- a false "needs a human" that paused the AI mid-conversation
- the model answering as the customer
- repeated greetings
- "next month" resolved as 2027-01-01

Known limitations with `mistral:7b`:
- Wording is sometimes clumsy or wordy, though never unsafe in the final run.
- Replies are in English even when the customer writes Hinglish. Telugu/Hindi script is not steered.
- On 23 Nov, 4 of ~50 turns failed after ~30 s; most were the over-long-reply defect fixed on 24 Nov. The final 24 Nov run had **0 failures**, and every scenario's average reply time was under 15 s. Most replies took 4–6 s; the budget turn took up to ~19 s because the model writes a long reply that then gets trimmed. A real gateway outage still produces the fallback reply plus an "AI COULD NOT RESPOND" alert.

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
