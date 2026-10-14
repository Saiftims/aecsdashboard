-- Which case UI (v1 = old, v2 = new) each case is being worked in, from the
-- PostHog `case_ui` event property stamped on every app event since
-- 2026-10-13. One row per case; customer and staff activity kept apart so the
-- question "which CUSTOMERS are still on the old UI" is answerable.
-- Filled by the cases sync.
create table if not exists case_ui_usage (
  case_id text primary key,
  -- customer (non-internal) activity
  v1_events integer not null default 0,
  v2_events integer not null default 0,
  v1_first timestamptz,
  v1_last timestamptz,
  v2_first timestamptz,
  v2_last timestamptz,
  -- Silent Witness staff activity, for context only
  staff_v1_events integer not null default 0,
  staff_v2_events integer not null default 0,
  staff_last_ui text,
  -- every PostHog account ($group_0) seen on the case, for firm attribution
  -- when the case is not in the cases table
  accounts text[] not null default '{}',
  customer_emails text[] not null default '{}',
  synced_at timestamptz not null default now()
);
