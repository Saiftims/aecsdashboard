-- Plan identity and billing period on each Stripe subscription, so the
-- Subscribers page can show what a firm is on and when it renews without
-- asking Stripe. Filled by /api/cron/stripe.
alter table stripe_subscriptions add column if not exists plan_name text;            -- Solo | Boutique | Growth | Custom Pricing | ...
alter table stripe_subscriptions add column if not exists plan_type text;            -- Stripe product metadata plan_type, e.g. solo_v3
alter table stripe_subscriptions add column if not exists customer_name text;        -- name on the Stripe customer
alter table stripe_subscriptions add column if not exists current_period_start timestamptz;
alter table stripe_subscriptions add column if not exists cancel_at_period_end boolean not null default false;
