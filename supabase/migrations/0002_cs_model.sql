-- CS dashboard + case model: firm segmentation, usage targets, account health,
-- expert-review workflow, retention. Case workflow lives here (Supabase);
-- HubSpot stays source of truth for firm/account + handoff.

-- ---------- cases: workflow fields -------------------------------------------
-- Existing table is keyed by sw_id; add a stable case_id + workflow columns.
alter table cases add column if not exists case_id text;
update cases set case_id = sw_id where case_id is null;
alter table cases alter column case_id set not null;
create unique index if not exists cases_case_id_key on cases (case_id);

alter table cases add column if not exists case_name text;
alter table cases add column if not exists company_hubspot_id text references companies (hubspot_id);
alter table cases add column if not exists case_status text default 'submitted';
  -- submitted | in_review | completed | delivered | issue_open | cancelled
alter table cases add column if not exists submitted_date timestamptz;
alter table cases add column if not exists completed_date timestamptz;
alter table cases add column if not exists delivered_date timestamptz;
alter table cases add column if not exists revenue_amount numeric not null default 250;
alter table cases add column if not exists expert_review_offered boolean not null default false;
alter table cases add column if not exists expert_review_offered_date timestamptz;
alter table cases add column if not exists expert_review_booked boolean not null default false;
alter table cases add column if not exists expert_review_completed boolean not null default false;
alter table cases add column if not exists expert_review_completed_date timestamptz;
alter table cases add column if not exists additional_docs_requested boolean not null default false;
alter table cases add column if not exists issue_flag boolean not null default false;
alter table cases add column if not exists issue_notes text;
alter table cases add column if not exists source text default 'posthog';  -- posthog | hubspot_intake | manual
alter table cases add column if not exists posthog_account_id text;
alter table cases add column if not exists creator_email text;
alter table cases add column if not exists expert_review_task_created boolean not null default false;

-- backfill submitted_date from the legacy submitted_at where present
update cases set submitted_date = submitted_at where submitted_date is null and submitted_at is not null;

create index if not exists cases_company_idx on cases (company_hubspot_id, submitted_date);
create index if not exists cases_status_idx on cases (case_status);

-- ---------- companies: account-level CS fields -------------------------------
alter table companies add column if not exists firm_segment text;  -- small | mid_size | large | strategic
alter table companies add column if not exists monthly_case_target numeric;
alter table companies add column if not exists account_health text;
alter table companies add column if not exists first_case_commitment_date timestamptz;
alter table companies add column if not exists first_case_completed_date timestamptz;
alter table companies add column if not exists second_case_submitted_date timestamptz;
alter table companies add column if not exists cases_this_month int not null default 0;
alter table companies add column if not exists cases_last_45d int not null default 0;
alter table companies add column if not exists target_attainment_percent numeric;
alter table companies add column if not exists open_issue_count int not null default 0;
alter table companies add column if not exists next_cs_action text;
alter table companies add column if not exists next_cs_action_due_date timestamptz;
-- days_since_last_case is derived from last_case_at at read time (not stored).

-- ---------- handoffs (sales -> CS), keyed by deal ----------------------------
create table if not exists handoffs (
  deal_hubspot_id text primary key references deals (hubspot_id) on delete cascade,
  company_hubspot_id text references companies (hubspot_id),
  handoff_created_date timestamptz not null default now(),
  handoff_accepted_date timestamptz,
  handoff_owner text,                          -- HubSpot owner id (CS)
  handoff_status text not null default 'pending',  -- pending | accepted | blocked
  handoff_notes text,
  expected_first_case_date timestamptz,
  pain_point text,
  source text,
  next_step text,
  updated_at timestamptz not null default now()
);
alter table handoffs enable row level security;
create policy read_all_handoffs on handoffs for select to authenticated using (true);

-- ---------- settings: segment config -----------------------------------------
insert into settings (key, value) values
  ('segment_config', '{
    "small":      {"monthly_target": 2,  "at_risk_floor_30d": 1, "churn_days": 90},
    "mid_size":   {"monthly_target": 5,  "at_risk_floor_30d": 2, "churn_days": 75},
    "large":      {"monthly_target": 10, "at_risk_floor_30d": 4, "churn_days": 60},
    "strategic":  {"monthly_target": null, "at_risk_floor_30d": 4, "churn_days": 45}
  }')
on conflict (key) do nothing;
