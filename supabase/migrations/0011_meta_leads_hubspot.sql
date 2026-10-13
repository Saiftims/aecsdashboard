-- Every new Meta form fill, qualified or not, is pushed into HubSpot by the
-- Meta sync: contact (unless HubSpot's own Facebook integration got there
-- first - it matches on email) plus a deal in the "Unqualified Lead" stage
-- owned by Alex (owner-confirmed 2026-10-13). These columns record what was
-- done per submission so a run can be retried without creating duplicates.

alter table meta_leads
  add column if not exists hubspot_contact_id text,
  add column if not exists hubspot_deal_id text,
  add column if not exists hubspot_pushed_at timestamptz,
  add column if not exists hubspot_push_note text;

-- Submissions that arrived before this went live are NOT pushed: HubSpot
-- already has their contacts, and 71 of them got deals from FlyTech's bulk
-- create on 2026-10-13. Mark them handled.
update meta_leads
   set hubspot_pushed_at = now(),
       hubspot_push_note = 'pre-existing; not pushed (went live 2026-10-13)'
 where hubspot_pushed_at is null;

create index if not exists meta_leads_unpushed_idx
  on meta_leads (created_time) where hubspot_pushed_at is null;
