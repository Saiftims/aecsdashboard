-- Quo (OpenPhone) calls: the source of truth for dial activity.
--
-- HubSpot's Quo integration only logs a call when the dialled number already
-- exists as a contact, so it silently undercounts a rep working new numbers
-- (Chris: 24 dials in Quo on 2026-07-31 vs 18 in HubSpot). Activity-vs-target
-- reporting reads this table for any rep we can map to a Quo seat and falls
-- back to HubSpot call engagements for everyone else.

create table if not exists quo_calls (
  call_id text primary key,
  quo_user_id text,
  user_email text,                 -- Quo seat email, used to resolve the owner
  hubspot_owner_id text,           -- resolved at sync time by matching email
  direction text,                  -- outgoing | incoming
  status text,
  duration_sec int,
  participant text,                -- the other party, E.164
  quo_number text,                 -- the line it was placed on
  phone_number_id text,
  created_at timestamptz,          -- when the call started
  answered_at timestamptz,
  completed_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists quo_calls_created_idx on quo_calls (created_at desc);
create index if not exists quo_calls_owner_created_idx
  on quo_calls (hubspot_owner_id, created_at desc);

-- The HubSpot owner roster, so per-rep reporting can name people instead of
-- printing owner ids, and so a new hire shows up the moment they get a seat.
create table if not exists crm_owners (
  owner_id text primary key,
  email text,
  first_name text,
  last_name text,
  archived boolean not null default false,
  updated_at timestamptz not null default now()
);
