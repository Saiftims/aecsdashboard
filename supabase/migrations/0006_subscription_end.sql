-- Revenue retention needs to know when a subscription STOPS, not just that it
-- exists. Without an end date a cancelled plan keeps billing forever in the
-- cohort math and the subscription retention line can never fall below 100%.
-- Optional: revenueRetentionReport() reads this column defensively and treats a
-- missing/blank value as "still live".

alter table companies add column if not exists subscription_ended_at timestamptz;
