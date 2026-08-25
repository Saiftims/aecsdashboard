/** Pull Stripe into `stripe_customers`, `stripe_payments`, `stripe_subscriptions`.
 *
 * Stripe is the billing system, so it is the only thing that knows what a firm
 * actually paid. The dashboard used to model revenue instead ($250 a case, with
 * a flat monthly amount typed onto the HubSpot company as an override) and the
 * model had drifted a third away from the money in both directions.
 *
 * Two rules do most of the work here:
 *
 * 1. CASH IS CHARGES, NOT INVOICES. This API version leaves `invoice.charge` and
 *    `charge.invoice` null even when a charge IS the payment for an invoice, so
 *    adding paid invoices to "charges with no invoice" books the same money
 *    twice - Sunset West's four $700 subscription payments appear on both sides.
 *    Invoices are read only for their line descriptions, which are the sole
 *    thing that says whether a payment was a plan or a case, and are paired to a
 *    charge on (customer, amount, day) since no id links them.
 *
 * 2. REFUNDS COME OFF. `net_cents` is amount minus refunds, because refunded
 *    money is not revenue: Mardirosian's $2,800 came back in full, so their four
 *    May cases are worth $0 rather than the $1,000 the old model gave them.
 */
import { isTestCaseActor } from "@/lib/cases/provider";
import {
  listCharges, listCustomers, listInvoices, listSubscriptions,
  StripeCharge, StripeInvoice,
} from "@/lib/stripe/client";
import { supabaseService } from "@/lib/supabase/server";

/** Consumer mail providers: a billing address here says nothing about which firm
 * is paying, so it must never be used to match one. */
const GENERIC_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com",
  "icloud.com", "me.com", "comcast.net", "sbcglobal.net", "prodigy.net",
  "live.com", "msn.com", "att.net", "verizon.net",
]);

/** Firms that pay from a personal address, so neither the domain nor the name on
 * the Stripe customer can find them. Stated by company NAME rather than HubSpot
 * id so the mapping stays readable and survives a re-import. */
const EMAIL_TO_COMPANY_NAME: Record<string, string> = {
  "jacksilvestre@yahoo.com": "Jack Silvestre",
  "freshwater@prodigy.net": "Wheatley",
};

/** Internal payers that `isTestCaseActor` does not know about, because they are
 * not case actors. Chris's own pre-hire signup is a demo, not a customer. */
const INTERNAL_EMAILS = new Set(["csanz2121@gmail.com"]);

function isInternal(email: string | null | undefined, name?: string | null): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (e && INTERNAL_EMAILS.has(e)) return true;
  if (e && isTestCaseActor(e, null)) return true;
  // A Stripe customer can exist with no email at all; fall back to the name so
  // an obvious test account is still caught.
  if (!e && /\btest\b|\bdemo\b/i.test(name ?? "")) return true;
  return false;
}

/** Strip punctuation and the words every law firm shares, so "Law Offices of
 * Allen Farshi" and "Allen Farshi" collapse to the same key. */
function normName(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(the|law|firm|group|offices?|llp|llc|pc|pa|apc|plc|inc|attorneys?|injury|legal|trial|lawyers?|and|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A subscription line reads "1 × Boutique (at $700.00 / month)"; anything else
 * on an invoice is usage - a case, a report, an add-on. */
function lineIsSubscription(desc: string | null | undefined): boolean {
  return /\(at \$[\d,.]+ \/ (month|year)\)/i.test(desc ?? "");
}

function chargeKind(
  charge: StripeCharge, invoice: StripeInvoice | undefined,
): "subscription" | "per_case" | "other" {
  const desc = charge.description ?? "";
  if (/^subscription (creation|update)/i.test(desc)) return "subscription";
  const lines = invoice?.lines?.data ?? [];
  if (lines.length) {
    return lines.some((l) => lineIsSubscription(l.description))
      ? "subscription" : "per_case";
  }
  if (/subscription/i.test(desc)) return "subscription";
  return "other";
}

function iso(sec: number | null | undefined): string | null {
  return sec ? new Date(sec * 1000).toISOString() : null;
}

function dayKey(sec: number | null | undefined): string {
  return sec ? new Date(sec * 1000).toISOString().slice(0, 10) : "";
}

export async function syncStripe() {
  const sb = supabaseService();

  const [customers, charges, invoices, subscriptions] = await Promise.all([
    listCustomers(), listCharges(), listInvoices(), listSubscriptions(),
  ]);

  // ---- company lookup ------------------------------------------------------
  const { data: companyRows } = await sb.from("companies")
    .select("hubspot_id, name, domain");
  const byDomain = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const c of companyRows ?? []) {
    const dom = (c.domain ?? "").toLowerCase().trim().replace(/^www\./, "");
    if (dom && !GENERIC_DOMAINS.has(dom) && !byDomain.has(dom)) {
      byDomain.set(dom, c.hubspot_id);
    }
    const n = normName(c.name);
    if (n && !byName.has(n)) byName.set(n, c.hubspot_id);
  }

  const match = (email: string, name: string | null | undefined) => {
    const manual = EMAIL_TO_COMPANY_NAME[email];
    if (manual) {
      const id = byName.get(normName(manual));
      if (id) return { id, method: "manual" };
    }
    const dom = email.includes("@") ? email.split("@")[1] : "";
    if (dom && !GENERIC_DOMAINS.has(dom)) {
      const id = byDomain.get(dom);
      if (id) return { id, method: "domain" };
    }
    const id = byName.get(normName(name));
    if (id) return { id, method: "name" };
    return { id: null as string | null, method: "none" };
  };

  const now = new Date().toISOString();
  const customerRows = customers.map((cu) => {
    const email = (cu.email ?? "").trim().toLowerCase();
    const internal = isInternal(email, cu.name);
    // Don't burn a company match on an internal account: it would hand a staff
    // test payer a real firm's id and leak into that firm's revenue.
    const m = internal ? { id: null, method: "none" } : match(email, cu.name);
    return {
      customer_id: cu.id,
      email: email || null,
      name: cu.name ?? null,
      company_hubspot_id: m.id,
      match_method: m.method,
      is_internal: internal,
      delinquent: cu.delinquent ?? null,
      created_at: iso(cu.created),
      synced_at: now,
    };
  });
  const byCustomer = new Map(customerRows.map((r) => [r.customer_id, r]));

  // ---- pair each charge with the invoice it settled ------------------------
  // No id links them in this API version, so match on (customer, amount, day)
  // and consume each invoice once, so two same-priced cases on one day do not
  // both claim the same invoice. Used ONLY to classify, never to total money.
  const invoiceByKey = new Map<string, StripeInvoice[]>();
  for (const inv of invoices) {
    if (inv.status !== "paid" || !inv.amount_paid) continue;
    const k = `${inv.customer}|${inv.amount_paid}|${dayKey(inv.status_transitions?.paid_at ?? inv.created)}`;
    const list = invoiceByKey.get(k) ?? [];
    list.push(inv);
    invoiceByKey.set(k, list);
  }

  const paymentRows = charges.map((ch) => {
    const cust = byCustomer.get(ch.customer ?? "");
    const key = `${ch.customer}|${ch.amount}|${dayKey(ch.created)}`;
    const invoice = invoiceByKey.get(key)?.shift();
    const amount = ch.amount ?? 0;
    const refunded = ch.amount_refunded ?? 0;
    const succeeded = ch.status === "succeeded" && ch.paid === true;
    return {
      charge_id: ch.id,
      customer_id: ch.customer ?? null,
      company_hubspot_id: cust?.company_hubspot_id ?? null,
      amount_cents: amount,
      refunded_cents: refunded,
      // A failed charge is not money: it must not net out to a positive figure.
      net_cents: succeeded ? amount - refunded : 0,
      currency: ch.currency ?? null,
      status: ch.status ?? null,
      paid: ch.paid ?? null,
      kind: chargeKind(ch, invoice),
      description: invoice?.lines?.data?.[0]?.description ?? ch.description ?? null,
      invoice_id: invoice?.id ?? ch.invoice ?? null,
      is_internal: cust?.is_internal
        ?? isInternal(ch.billing_details?.email, ch.billing_details?.name),
      created_at: iso(ch.created),
      synced_at: now,
    };
  });

  const subscriptionRows = subscriptions.map((s) => {
    const cust = byCustomer.get(s.customer ?? "");
    const items = s.items?.data ?? [];
    const amount = items.reduce((t, i) => t + (i.price?.unit_amount ?? 0), 0);
    const interval = items[0]?.price?.recurring?.interval ?? null;
    return {
      subscription_id: s.id,
      customer_id: s.customer ?? null,
      company_hubspot_id: cust?.company_hubspot_id ?? null,
      amount_cents: amount,
      // Normalised so an annual plan can be compared with a monthly one.
      monthly_cents: interval === "year" ? Math.round(amount / 12) : amount,
      interval,
      status: s.status ?? null,
      is_internal: cust?.is_internal ?? false,
      started_at: iso(s.created),
      cancelled_at: iso(s.canceled_at),
      current_period_end: iso(s.current_period_end),
      synced_at: now,
    };
  });

  const upsert = async (
    table: string, conflict: string, rows: Record<string, unknown>[],
  ) => {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from(table)
        .upsert(rows.slice(i, i + 500), { onConflict: conflict });
      if (error) throw new Error(`${table} upsert failed: ${error.message}`);
    }
    return rows.length;
  };

  await upsert("stripe_customers", "customer_id", customerRows);
  await upsert("stripe_payments", "charge_id", paymentRows);
  await upsert("stripe_subscriptions", "subscription_id", subscriptionRows);

  const real = paymentRows.filter((p) => !p.is_internal);
  const unmatchedCash = real
    .filter((p) => !p.company_hubspot_id)
    .reduce((t, p) => t + p.net_cents, 0);

  return {
    customers: customerRows.length,
    customersMatched: customerRows.filter((c) => c.company_hubspot_id).length,
    customersInternal: customerRows.filter((c) => c.is_internal).length,
    payments: paymentRows.length,
    subscriptions: subscriptionRows.length,
    netCollectedCents: real.reduce((t, p) => t + p.net_cents, 0),
    internalCents: paymentRows.filter((p) => p.is_internal)
      .reduce((t, p) => t + p.net_cents, 0),
    refundedCents: real.reduce((t, p) => t + p.refunded_cents, 0),
    unmatchedCashCents: unmatchedCash,
    activeMrrCents: subscriptionRows
      .filter((s) => s.status === "active" && !s.is_internal)
      .reduce((t, s) => t + (s.monthly_cents ?? 0), 0),
  };
}
