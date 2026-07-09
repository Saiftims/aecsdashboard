-- Signups: firms that created an app account (PostHog signup_completed) and,
-- optionally, subscribed (subscription_created) - tracked so CS can chase the
-- "signed up but no case yet" cohort. Stored on the company (account-level).

alter table companies add column if not exists signed_up_at timestamptz;
alter table companies add column if not exists signup_account_id text;
alter table companies add column if not exists subscribed_at timestamptz;

create index if not exists companies_signed_up_idx on companies (signed_up_at);
