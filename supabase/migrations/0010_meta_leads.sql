-- Meta Lead Ads submissions, read straight from the Graph API rather than via
-- the FlyTech sheet (owner, 2026-10-13: "we want it directly from source,
-- qualified and unqualified"). FlyTech screens the raw submissions and copies
-- the ones it qualifies onto the sheet; the rest were only ever visible as
-- bare HubSpot contacts, with no record of the form answers or the ad.
--
-- Persisted because Meta deletes lead records about 90 days after
-- submission - the May and June forms already return nothing - so the API
-- can only ever show the recent tail. Each row is one submission (Meta's
-- leadgen id); the same person submitting twice is two rows.

create table if not exists meta_leads (
  leadgen_id text primary key,
  created_time timestamptz not null,
  form_id text not null,
  form_name text,
  page_id text,
  ad_id text,
  ad_name text,
  adset_name text,
  campaign_id text,
  campaign_name text,
  platform text,
  is_organic boolean not null default false,
  full_name text,
  email text,
  phone text,
  company text,
  -- every question/answer pair as submitted, keyed by Meta's field name
  answers jsonb not null default '{}'::jsonb,
  -- Meta's own test submissions ("<test lead: dummy data for ...>")
  is_test boolean not null default false,
  synced_at timestamptz not null default now()
);

create index if not exists meta_leads_created_idx on meta_leads (created_time desc);
create index if not exists meta_leads_email_idx on meta_leads (lower(email));

comment on table meta_leads is
  'Meta Lead Ads submissions from the Graph API (page 852956741232072). '
  'Archive: Meta purges leads after ~90 days.';
