-- Handoffs are account-based and triggered by a REAL activation signal: the
-- firm's first actual case, or an app signup. (Previously keyed by deal and
-- fired on the 'First Case Committed' sales stage, which is only a promise.)
-- The prior table held only noise, so we recreate it.

drop table if exists handoffs cascade;

create table handoffs (
  company_hubspot_id text primary key references companies (hubspot_id) on delete cascade,
  trigger_type text not null,                       -- 'first_case' | 'signup'
  deal_hubspot_id text,                             -- optional originating deal
  handoff_created_date timestamptz not null default now(),
  handoff_accepted_date timestamptz,
  handoff_owner text,                               -- CS owner (HubSpot id)
  handoff_status text not null default 'pending',   -- pending | accepted
  handoff_notes text,
  source text,
  next_step text,
  updated_at timestamptz not null default now()
);

alter table handoffs enable row level security;
create policy read_all_handoffs on handoffs for select to authenticated using (true);
