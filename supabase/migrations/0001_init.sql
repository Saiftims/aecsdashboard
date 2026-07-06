-- GTM Operating System - initial schema.
-- Supabase Postgres. HubSpot stays the source of truth: these tables are a
-- read cache + app-owned settings/audit tables.

-- ---------- app users & roles ------------------------------------------------
create type app_role as enum ('executive', 'ae', 'cs');

create table app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text,
  role app_role not null default 'ae',
  hubspot_owner_id text,          -- maps app user -> HubSpot owner
  created_at timestamptz not null default now()
);

-- ---------- HubSpot caches (idempotent upserts keyed by hubspot id) ----------
create table companies (
  hubspot_id text primary key,
  name text,
  domain text,
  properties jsonb not null default '{}'::jsonb,
  -- computed usage metrics (also written back to HubSpot sw_* props)
  sw_account_id text,             -- Silent Witness account/org id (firm mapping)
  cases_lifetime int not null default 0,
  cases_7d int not null default 0,
  cases_30d int not null default 0,
  cases_60d int not null default 0,
  cases_90d int not null default 0,
  cases_prev_30d int not null default 0,   -- days 31-60, for trend comparison
  first_case_at timestamptz,
  last_case_at timestamptz,
  avg_cases_per_month numeric,
  est_revenue numeric not null default 0,
  actual_revenue numeric,          -- null unless invoice data exists
  health_score int,
  health_category text,            -- green | yellow | red
  health_factors jsonb,            -- per-factor breakdown (transparent rubric)
  risk_flags text[] not null default '{}',
  usage_trend text,                -- up | flat | down
  updated_at timestamptz not null default now()
);

create table contacts (
  hubspot_id text primary key,
  email text,
  first_name text,
  last_name text,
  company_hubspot_id text references companies (hubspot_id),
  owner_id text,
  lifecycle_stage text,
  properties jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table deals (
  hubspot_id text primary key,
  name text,
  pipeline text,
  stage text,                      -- HubSpot dealstage id
  stage_label text,
  activation_stage text,           -- sw_activation_stage (virtual CS pipeline)
  is_activation boolean not null default false,
  owner_id text,
  amount numeric,
  company_hubspot_id text references companies (hubspot_id),
  primary_contact_id text,
  properties jsonb not null default '{}'::jsonb,
  hs_created_at timestamptz,
  hs_updated_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table activities (
  hubspot_id text primary key,
  kind text not null,              -- call | meeting | note | task
  owner_id text,
  subject text,
  body text,
  outcome text,
  activity_type text,              -- structured: call/email/voicemail/linkedin/demo/in_person_visit/...
  contact_hubspot_id text,
  deal_hubspot_id text,
  company_hubspot_id text,
  occurred_at timestamptz,
  due_at timestamptz,              -- tasks
  completed boolean,
  properties jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- Silent Witness cases ---------------------------------------------
create table cases (
  sw_id text primary key,
  sw_account_id text,
  sw_organization_id text,
  name text,
  case_stage text,
  analysis_type text,
  submitted_at timestamptz,        -- created_at from SW API
  delivered_at timestamptz,        -- when technical_report completed
  report_status text,
  billable boolean not null default true,
  price_override numeric,          -- per-case price override (else firm/default)
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- firm mapping (human-confirmed once) -------------------------------
create table firm_mapping (
  id bigint generated always as identity primary key,
  sw_account_id text not null,
  sw_organization_id text,
  hubspot_company_id text not null references companies (hubspot_id),
  confirmed boolean not null default false,   -- human-confirmed in Admin
  per_case_price numeric,                      -- firm-specific price override
  created_at timestamptz not null default now(),
  unique (sw_account_id, sw_organization_id),
  unique (hubspot_company_id)
);

-- ---------- settings & targets --------------------------------------------------
create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_users (id)
);

-- Defaults (also seeded by the app on first boot):
insert into settings (key, value) values
  ('default_case_price', '250'),
  ('at_risk_inactivity_days', '30'),
  ('first_case_target_days', '14'),
  ('second_case_target_days', '45'),
  ('healthy_cases_per_30d', '2'),
  ('stalled_deal_days', '14'),
  ('hubspot_portal_id', '"148349267"'),
  ('hubspot_sales_pipeline_id', '"default"'),
  ('ae_weekly_targets', '{
    "new_leads_contacted_pct": 100, "contacted_within_2h_pct": 90,
    "outbound_touches": [100, 150], "live_conversations": [15, 25],
    "qualified_opportunities": [5, 8], "demos_booked": [4, 6],
    "demos_completed": [3, 5], "first_case_commitments": [2, 3],
    "new_firms": [1, 2], "open_deals_without_future_task": 0,
    "conversations_logged_pct": 100
  }'),
  ('cs_targets', '{
    "contact_within_days": 1, "kickoff_within_days": 3,
    "first_case_within_days": [7, 14], "activation_rate_pct": 80,
    "first_delivery_followup_pct": 100, "second_case_within_45d_pct": 60,
    "monthly_active_firms_pct": 70, "documented_next_step_pct": 100,
    "at_risk_with_recovery_plan_pct": 100
  }'),
  ('ae_scorecard_weights', '{
    "new_firms_and_commitments": 35, "qualified_pipeline": 20,
    "demos_completed": 15, "speed_to_lead": 10, "crm_discipline": 10,
    "field_activity": 10
  }'),
  ('cs_scorecard_weights', '{
    "activated_customers": 30, "repeat_usage": 25, "monthly_active_firms": 15,
    "time_to_first_value": 10, "at_risk_recovery": 10, "crm_discipline": 10
  }');

-- ---------- sync bookkeeping ----------------------------------------------------
create table sync_runs (
  id bigint generated always as identity primary key,
  kind text not null,              -- hubspot_incremental | hubspot_full | cases | rollup
  status text not null default 'running',  -- running | ok | error
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb,
  error text
);

-- ---------- audit trail for dashboard-originated writes ---------------------------
create table audit_log (
  id bigint generated always as identity primary key,
  actor uuid references app_users (id),
  actor_email text,
  action text not null,            -- e.g. deal.stage_update, activity.log, handoff.submit
  object_type text not null,       -- deal | contact | company | task | note
  object_id text not null,         -- HubSpot id
  payload jsonb not null default '{}'::jsonb,
  hubspot_result text,             -- ok | error message
  created_at timestamptz not null default now()
);

-- ---------- indexes -----------------------------------------------------------------
create index deals_stage_idx on deals (stage);
create index deals_activation_idx on deals (activation_stage) where is_activation;
create index deals_owner_idx on deals (owner_id);
create index contacts_company_idx on contacts (company_hubspot_id);
create index activities_deal_idx on activities (deal_hubspot_id);
create index activities_company_idx on activities (company_hubspot_id);
create index activities_kind_time_idx on activities (kind, occurred_at);
create index cases_account_idx on cases (sw_account_id, submitted_at);

-- ---------- RLS ------------------------------------------------------------------
alter table app_users enable row level security;
alter table companies enable row level security;
alter table contacts enable row level security;
alter table deals enable row level security;
alter table activities enable row level security;
alter table cases enable row level security;
alter table firm_mapping enable row level security;
alter table settings enable row level security;
alter table sync_runs enable row level security;
alter table audit_log enable row level security;

-- All authenticated app users can read everything (4-person startup; page-level
-- role guards control editing). Writes go through the service-role key only.
create policy read_all_app_users on app_users for select to authenticated using (true);
create policy read_all_companies on companies for select to authenticated using (true);
create policy read_all_contacts on contacts for select to authenticated using (true);
create policy read_all_deals on deals for select to authenticated using (true);
create policy read_all_activities on activities for select to authenticated using (true);
create policy read_all_cases on cases for select to authenticated using (true);
create policy read_all_mapping on firm_mapping for select to authenticated using (true);
create policy read_all_settings on settings for select to authenticated using (true);
create policy read_all_syncs on sync_runs for select to authenticated using (true);
create policy read_all_audit on audit_log for select to authenticated using (true);
