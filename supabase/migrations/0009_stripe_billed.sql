-- A subscription's list price is not always what it bills. Peerali's plan line
-- reads "1 x Boutique (at $700.00 / month)" but the charge is $500, and Stitt Vu
-- bills $300 against a $350 line - both carry a Stripe discount, which the list
-- API returns only as an opaque id (`di_...`) with no amount attached.
--
-- So the amount that actually recurs is taken from the most recent successful
-- subscription charge, and kept separately from the list price: `amount_cents`
-- stays what the plan says, `billed_cents` is what the customer is charged.
-- Pricing MRR off the list price overstated it by $549 a month.

alter table stripe_subscriptions
  add column if not exists billed_cents bigint;

comment on column stripe_subscriptions.amount_cents is
  'List price from the Stripe price object, before any discount.';
comment on column stripe_subscriptions.billed_cents is
  'What the customer is actually charged per period, taken from their most '
  'recent successful subscription charge. Falls back to amount_cents when the '
  'plan has never billed.';
comment on column stripe_subscriptions.monthly_cents is
  'billed_cents normalised to a month, so annual plans compare with monthly.';
