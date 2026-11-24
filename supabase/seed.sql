-- Example tenant. Run AFTER both migrations. Replace every REPLACE_* value first.
-- Remove the ids / settings you don't use (e.g. no Instagram -> leave instagram_account_id null).
insert into tenants (slug, name, whatsapp_phone_number_id, facebook_page_id, instagram_account_id, knowledge_base, settings)
values (
  'demo-interiors',
  'Demo Interiors',
  'REPLACE_WITH_META_PHONE_NUMBER_ID',
  null,   -- 'REPLACE_WITH_FACEBOOK_PAGE_ID'        (Lead Ads)
  null,   -- 'REPLACE_WITH_INSTAGRAM_ACCOUNT_ID'    (Instagram DMs)
  $kb$
Company: Demo Interiors, Hyderabad.
Services: full home interiors, modular kitchens, wardrobes, living room and bedroom interiors, renovation.
Areas served: Hyderabad and Secunderabad (Kondapur, Gachibowli, Madhapur, Kukatpally, Miyapur and nearby).
Process: free consultation -> site visit and measurement -> 3D design -> quotation -> execution (typically 45-60 days for a 3BHK).
Pricing policy: do NOT quote prices. Say our designer will share a detailed quotation after the site visit.
Working hours: Mon-Sat, 10am-7pm IST.
$kb$,
  '{
    "sales_whatsapp_numbers": ["+919000000000"],
    "sales_emails": ["sales@example.com"],
    "salespeople": [
      {"name": "Salesperson One", "whatsapp": "+919000000001", "email": "one@example.com"},
      {"name": "Salesperson Two", "whatsapp": "+919000000002"}
    ],
    "contact_sla_hours": 4,
    "high_value_budget": 1500000,
    "max_followups": 3
  }'::jsonb
);

-- Facebook Page access token for Instagram DMs + Lead Ads (service-role-only table):
-- insert into tenant_secrets (tenant_id, page_access_token)
-- select id, 'REPLACE_WITH_PAGE_ACCESS_TOKEN' from tenants where slug = 'demo-interiors';
