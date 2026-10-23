-- One row per Stripe invoice the platform raised for a CASE. The platform
-- stamps `type=case_processing`, the real case_id, the PostHog account_id,
-- the matter name, plan_type and is_overage onto every such invoice, which
-- makes Stripe the only feed that ties a staff-entered case to its firm
-- (PostHog reports the analyst's own org while impersonating). Filled by
-- the Stripe sync; the cases sync inserts any invoiced case the table does
-- not already hold (source 'stripe_invoice').
create table if not exists stripe_case_invoices (
  invoice_id         text primary key,
  customer_id        text,
  company_hubspot_id text,
  case_id            text not null,
  account_id         text,
  case_name          text,
  plan_type          text,
  is_overage         boolean,
  status             text,
  amount_paid_cents  integer,
  amount_due_cents   integer,
  is_internal        boolean not null default false,
  created_at         timestamptz,
  synced_at          timestamptz not null default now()
);
create index if not exists stripe_case_invoices_case_id on stripe_case_invoices (case_id);
create index if not exists stripe_case_invoices_company on stripe_case_invoices (company_hubspot_id);
