-- Subscription billing: a few firms pay a flat monthly fee (MRR) instead of the
-- transactional $250/case. Revenue math uses the monthly amount for these firms
-- and ignores their per-case revenue so nothing is double-counted.

alter table companies add column if not exists billing_type text not null default 'transactional';
  -- transactional | subscription
alter table companies add column if not exists subscription_monthly_amount numeric;
