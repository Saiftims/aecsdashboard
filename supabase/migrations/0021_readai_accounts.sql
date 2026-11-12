-- Read.ai accounts connected through OAuth (Integrations are per user: the
-- webhook only pushes meetings recorded from now on, so importing the
-- history needs each rep to authorise the dashboard once at
-- /api/readai/connect). Refresh tokens rotate on every use and live ~6
-- months; the newest one is always kept here.
create table if not exists readai_accounts (
  email              text primary key,
  name               text,
  refresh_token      text not null,
  access_token       text,
  access_expires_at  timestamptz,
  connected_at       timestamptz not null default now(),
  backfill_cursor    text,                      -- id of the last meeting listed (Read.ai pages by id)
  backfill_done      boolean not null default false,
  backfill_seen      integer not null default 0, -- meetings listed so far
  last_backfill_at   timestamptz,
  error              text
);

alter table readai_meetings add column if not exists source text not null default 'webhook';  -- webhook | backfill
alter table readai_meetings add column if not exists hubspot_writes jsonb;                    -- which properties were set / newly filled
