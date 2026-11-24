# Client Handover — AI Lead Receptionist

For the **business owner and sales team**. No technical knowledge needed, except in the
"Changing settings" section, which your developer or Lusa support will usually handle.

---

## 1. What the system does for you

1. **Answers every enquiry instantly, 24×7**: WhatsApp messages, Instagram DMs, your website form and Facebook lead ads.
2. **Collects the details** your team needs: name, location, property type and size, project, readiness, start date, budget and requirements. It asks one friendly question at a time, in the customer's language.
3. **Scores every lead** (0–100) and labels it **Hot / Warm / Cold**. A lead stays *Provisional* until there's enough information to judge it fairly.
4. **Assigns the lead to a salesperson** when it needs attention, sharing leads evenly.
5. **Alerts your team on WhatsApp and/or email** when:
   - a hot lead comes in
   - a customer asks for a site visit
   - a customer asks for a person
   - a high-value enquiry arrives
   - a customer is ready to proceed
   - a lead hasn't been contacted in time, or a follow-up date has passed
6. **Follows up politely** with customers who stop replying, up to 3 times, and stops as soon as your team takes over.

What it will **never** do: quote prices you haven't approved, promise dates, offer discounts, or
claim a site visit is booked. Anything it can't answer goes to your team.

---

## 2. Your daily workflow

### When an alert arrives
```
NEW HOT LEAD – INTERIOR ENQUIRY
Customer Name: Rahul Kumar
Phone: +91 9876543210
Location: Kondapur, Hyderabad
Property: 3BHK Apartment
Project: Full Home Interiors
Budget: ₹8,00,000
Timeline: Next Month
Lead Source: Instagram
Lead Score: 85/100 (Hot)
Assigned To: Priya
Recommended Action: Contact customer and arrange a site visit.
```
1. The **assigned salesperson** calls the customer, ideally within **4 hours**. After that, a
   "FOLLOW-UP OVERDUE" reminder is sent.
2. After calling, **update the lead in the Google Sheet** (next section). This is what stops reminders and AI follow-ups.

### The Google Sheet ("Leads" tab)
Every lead appears here within about 2 minutes, newest first. **Only the columns marked ✎ can be edited.**
Everything else is refreshed by the system, so changes there are overwritten.

| Column ✎ | What to put | Effect |
|---|---|---|
| **Status ✎** | Pick from the dropdown (see below) | Moving a lead to `contacted` or later stops AI follow-ups and the contact reminder |
| **Assigned To ✎** | A salesperson's name | Reassigns the lead; alerts go to that person |
| **Next Follow-up ✎** | `2026-11-25 16:00` or `2026-11-25` (10am) | You get a reminder alert if it passes and the lead is still active |
| **AI Paused ✎** | `TRUE` / `FALSE` | `TRUE` = the AI stays silent with this customer; `FALSE` = the AI resumes |
| **Notes ✎** | Anything | Saved on the lead |

Tips:
- Don't sort the sheet itself, because it's rewritten every 2 minutes. Use **Data → Create a filter view** instead; filter views are personal and are kept.
- If you type an invalid value (e.g. a status that isn't in the list), it's ignored and changed back at the next sync.

### Lead statuses
| Status | Meaning | Who sets it |
|---|---|---|
| `new` | Just arrived, few details | System |
| `information_pending` | AI is still collecting details | System |
| `qualified` | All key details collected | System |
| `contacted` | Your team has spoken to the customer | **You** |
| `site_visit_scheduled` | Visit fixed | **You** |
| `quotation_sent` | Quote shared | **You** |
| `negotiation` | Discussing the quote | **You** |
| `converted` | Won 🎉 | **You** |
| `lost` | Not going ahead | **You** |

The system never changes a status your team has set.

### Hot / Warm / Cold (lead temperature)
Points: budget given +20, property ready +20, starting within 30 days +25, site visit requested +20,
full-home project +15. **70+ Hot**, **40–69 Warm**, **below 40 Cold**. *Provisional* means
"not enough information yet".

---

## 3. Common situations

| Situation | What happens / what to do |
|---|---|
| Customer asks for a real person | AI says a team member will reach out, **pauses itself**, and alerts you. Reply to the customer yourself. When done, set **AI Paused = FALSE** if you want the AI to continue. |
| You want to chat with a customer yourself | Set **AI Paused = TRUE** first so the AI doesn't reply at the same time. |
| Customer says "STOP" | They get a confirmation and no more automated messages. If they message again later, the AI answers them normally. |
| Customer sends a photo / voice note | The AI can't see or hear media yet: it's saved as "[Customer sent an image]" etc. and the AI replies to the conversation text. Check the photo in WhatsApp / Instagram yourself. |
| Instagram customer | The AI asks for a phone number once. Until they share it, the Phone column shows nothing and the lead is identified by Instagram. |
| Same customer on WhatsApp and the website | Matched by phone number: it stays **one** lead. |
| No alert received | Check that your number is in the alert list, and that your phone has messaged the business WhatsApp number in the last 24h (only needed if alert templates aren't set up). Email alerts are the backup. |

---

## 4. Changing settings

These are stored in the database (Supabase → Table editor → `tenants` → your row → `settings` /
`knowledge_base`). Ask Lusa support if you're not comfortable editing them.

| You want to… | Change |
|---|---|
| Update what the AI may say about your company (services, areas, process, pricing policy, hours) | `knowledge_base` text |
| Add / remove salespeople | `settings.salespeople` (`{"name": "...", "whatsapp": "+91...", "email": "..."}`; set `"active": false` for someone on leave) |
| Change who gets every alert | `settings.sales_whatsapp_numbers`, `settings.sales_emails` |
| Change the contact time limit | `settings.contact_sla_hours` (default 4) |
| Change what counts as high-value | `settings.high_value_budget` in rupees (default 15,00,000) |
| Change the number of AI follow-ups | `settings.max_followups` (default 3) |

Changes take effect immediately, with no restart needed.

---

## 5. Accounts, credentials and ownership

| Item | Owner | Notes |
|---|---|---|
| Meta Business, WhatsApp number, Facebook Page, Instagram | **You** | Keep admin access with the business owner |
| WhatsApp message templates | You (managed in WhatsApp Manager) | `alert`, `follow-up`, `acknowledgement` |
| Google Sheet | **You** | Shared with the system's service account; don't remove that share |
| Supabase project (database) | As agreed with Lusa | Contains all customer data |
| OpenAI account | As agreed with Lusa | Usage is billed per conversation |
| Server (VPS) | As agreed with Lusa | |

Customer data is personal data under India's DPDP Act. Give Sheet and database access only to
staff who need it. To delete a customer's data on request, remove their row in Supabase `leads`. Their messages
and alerts are deleted with it. Also delete the `audit_log` rows whose `entity_id` is that lead id, because these can contain
details the customer gave. The Sheet row disappears at the next sync.

---

## 6. Support and troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| AI not replying on WhatsApp | Server down, Meta token expired, or WhatsApp number unlinked | Check `https://<domain>/health`; check `error_log` in Supabase; renew the token |
| Customers get "Our team will get back to you shortly" | AI service error | Reply manually; Lusa checks the OpenAI key/billing (you'll also get an "AI COULD NOT RESPOND" alert) |
| Sheet not updating | Sheet unshared from the service account, or sheet ID wrong | Re-share the sheet with the service account email (Editor) |
| Instagram replies not sent | Page token expired / permissions | Lusa regenerates the Page token |
| Lead ads not arriving | App not subscribed to the Page, or token expired | Lusa re-subscribes the Page and renews the token |

Every failure is recorded in the `error_log` table with the time and reason, and every important change
(assignments, sheet edits, opt-outs) is in `audit_log`.

**Lusa support:** _[add contact name, phone, email, support hours]_
