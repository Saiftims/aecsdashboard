-- Stripe is the billing system, so it is the only place that knows what a firm
-- ACTUALLY paid. Until now the dashboard modelled revenue instead - $250 a case,
-- overridden by a flat monthly amount typed onto the HubSpot company - and the
-- model had drifted 33% away from the money: $20,850 modelled against $15,648
-- collected, wrong in BOTH directions (Chudacoff modelled $2,000 having paid
-- nothing; Morrin modelled $250 having paid $1,900).
--
-- Cash, not billings. `net_cents` is a succeeded charge minus its refunds,
-- because a refunded charge is not revenue: Mardirosian's $2,800 came back in
-- full and their four May cases are worth $0, not the $1,000 the model gave them.
--
-- Charges are the cash, NOT invoices. This Stripe API version leaves
-- invoice.charge and charge.invoice null even when a charge IS an invoice's
-- payment, so counting paid invoices alongside "charges with no invoice" books
-- the same money twice (Sunset West's four $700 subscription payments appear on
-- both sides). Invoices are still read for the line descriptions, which are the
-- only thing that says whether a payment was a subscription or a case.

create table if not exists stripe_customers (
  customer_id text primary key,
  email text,
  name text,
  -- Resolved at sync time: billing-email domain, then normalised company name,
  -- then a hand-stated exception. Null means nobody in HubSpot owns this payer.
  company_hubspot_id text,
  match_method text,               -- domain | name | manual | none
  -- Staff and test payers. Excluded from every revenue figure but KEPT as rows,
  -- so an internal account that starts being treated as a customer is visible
  -- rather than silently missing (CF Injury carries a $24,000/year subscription).
  is_internal boolean not null default false,
  delinquent boolean,
  created_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists stripe_customers_company_idx
  on stripe_customers (company_hubspot_id);

create table if not exists stripe_payments (
  charge_id text primary key,
  customer_id text,
  -- Denormalised from stripe_customers so revenue queries never need the join.
  company_hubspot_id text,
  amount_cents bigint not null default 0,
  refunded_cents bigint not null default 0,
  net_cents bigint not null default 0,     -- amount - refunded; the real revenue
  currency text,
  status text,                             -- succeeded | failed | pending
  paid boolean,
  -- subscription | per_case | other, read from the charge description and the
  -- invoice line behind it. Lets MRR be separated from usage without guessing
  -- from the amount.
  kind text,
  description text,
  invoice_id text,
  is_internal boolean not null default false,
  created_at timestamptz,                  -- when the money moved
  synced_at timestamptz not null default now()
);

create index if not exists stripe_payments_company_created_idx
  on stripe_payments (company_hubspot_id, created_at desc);
create index if not exists stripe_payments_created_idx
  on stripe_payments (created_at desc);

create table if not exists stripe_subscriptions (
  subscription_id text primary key,
  customer_id text,
  company_hubspot_id text,
  amount_cents bigint,             -- as billed, per `interval`
  monthly_cents bigint,            -- normalised to a month, so annual plans compare
  interval text,                   -- month | year
  status text,                     -- active | canceled | past_due | ...
  is_internal boolean not null default false,
  started_at timestamptz,
  cancelled_at timestamptz,
  current_period_end timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists stripe_subscriptions_company_idx
  on stripe_subscriptions (company_hubspot_id);
