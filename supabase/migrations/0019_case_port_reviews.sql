-- Manual review of each case ported to the new UI (bulk move of 2026-10-18).
-- One row per case, from PostHog's `ui_port_reviewed` event (the "Mark
-- reviewed" button on the port-review modal); the latest review wins. The
-- CS rep works this list: a reviewed case is ready to be sent to the firm.
create table if not exists case_port_reviews (
  case_id text primary key,
  reviewed_at timestamptz not null,
  reviewed_by text,
  port_status text,
  days_since_port integer,
  overall_before integer,
  overall_after integer,
  overall_delta integer,
  liability_delta integer,
  crash_severity_delta integer,
  injury_causation_delta integer,
  evidence_integrity_delta integer,
  injury_synopses integer,
  reconstruction_texts boolean,
  assessment_refreshed boolean,
  warnings integer,
  backfilled boolean not null default false,
  reviews integer not null default 1,
  synced_at timestamptz not null default now()
);
create index if not exists case_port_reviews_reviewed_at_idx on case_port_reviews (reviewed_at);
