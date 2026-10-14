-- Actual Meta Ads spend, one row per day, read from the Insights API at
-- account level (owner, 2026-10-14: "actual CAC figures for meta spend from
-- meta"). Replaces the hand-typed ad_spend_by_month ledger in settings, which
-- had drifted (Sep 2026 ledger $4,810 against $7,225 spent). The ledger stays
-- as a fallback for months Meta has no row for.
--
-- `leads` is Meta's `onsite_conversion.lead_grouped` - one per submission.
-- The `lead` action double counts (it adds the pixel's MQL/SQL events), so it
-- is not stored.

create table if not exists meta_ad_spend_daily (
  day          date primary key,
  spend_cents  integer not null default 0,
  impressions  integer not null default 0,
  clicks       integer not null default 0,
  leads        integer not null default 0,
  synced_at    timestamptz not null default now()
);
