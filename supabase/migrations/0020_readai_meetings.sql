-- Read.ai meeting reports, one row per meeting session. The webhook at
-- /api/webhooks/readai stores the raw payload here first, then an LLM pulls
-- the sales facts out of the transcript (firm, contact + role, case
-- management system, MVA cases a month, plan discussed, next step) and they
-- are written to HubSpot. Keeping the raw payload means a bad extraction can
-- be re-run without asking Read.ai to push the report again.
create table if not exists readai_meetings (
  session_id          text primary key,
  request_id          text,                     -- Read.ai's per-delivery id (replay guard)
  title               text,
  started_at          timestamptz,
  ended_at            timestamptz,
  platform            text,
  owner_email         text,
  participants        jsonb not null default '[]'::jsonb,
  report_url          text,
  raw                 jsonb not null default '{}'::jsonb,
  -- received -> extracted -> synced | skipped (not a sales/CS call) | error
  status              text not null default 'received',
  attempts            integer not null default 0,
  error               text,
  extracted           jsonb,                    -- the LLM's structured answer
  hubspot_company_id  text,
  hubspot_contact_ids text[] not null default '{}',
  hubspot_deal_id     text,
  hubspot_note_id     text,
  hubspot_task_id     text,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz
);
create index if not exists readai_meetings_status_idx on readai_meetings (status, received_at);
create index if not exists readai_meetings_started_idx on readai_meetings (started_at desc);
