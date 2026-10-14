-- Last/first customer and staff activity on each case regardless of which UI
-- (or none, before the case_ui flag existed on 2026-10-13), so the UI
-- migration view can list every case ever worked and filter by recency.
alter table case_ui_usage add column if not exists customer_first timestamptz;
alter table case_ui_usage add column if not exists customer_last timestamptz;
alter table case_ui_usage add column if not exists customer_events integer not null default 0;
alter table case_ui_usage add column if not exists staff_last timestamptz;
create index if not exists case_ui_usage_customer_last_idx on case_ui_usage (customer_last);
