-- Quo (OpenPhone) SMS/MMS: the source of truth for texting activity, for the
-- same reason quo_calls is for dials - HubSpot only ever sees a message it can
-- attach to an existing contact, so it undercounts texts to new prospects.
--
-- Populated by the same line x participant walk as quo_calls (the walk is the
-- expensive part, so one pass fills both tables).

create table if not exists quo_messages (
  message_id text primary key,
  quo_user_id text,
  user_email text,                 -- Quo seat email, used to resolve the owner
  hubspot_owner_id text,           -- resolved at sync time by matching email
  direction text,                  -- outgoing | incoming
  status text,
  body text,                       -- message text, for reading a thread back
  participant text,                -- the other party, E.164
  quo_number text,                 -- the line it was sent from
  phone_number_id text,
  conversation_id text,
  created_at timestamptz,          -- when the message was sent/received
  synced_at timestamptz not null default now()
);

create index if not exists quo_messages_created_idx
  on quo_messages (created_at desc);
create index if not exists quo_messages_owner_created_idx
  on quo_messages (hubspot_owner_id, created_at desc);
