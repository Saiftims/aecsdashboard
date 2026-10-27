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
 * 2. REFUNDS ARE RECORDED, NOT DEDUCTED. `net_cents` is amount minus refunds and
 *    `refunded_cents` the refund, but the dashboard REPORTS GROSS (owner,
 *    2026-10-27): the free first month is a full charge immediately refunded,
 *    so netting it read every new subscriber's first month as $0. See
 *    `loadRevenueFacts` in lib/revenue.ts, the one place the figure is built.
 */
import { isTestCaseActor } from "@/lib/cases/provider";
import {
  listCharges, listCustomers, listInvoices, listPrices, listSubscriptions,
  StripeCharge, StripeInvoice,
} from "@/lib/stripe/client";
import { selectAll, supabaseService } from "@/lib/supabase/server";

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
  // Solo plan 2026-10-22; company 456229656799 created by hand 2026-10-23,
  // app signup is on the same gmail (firm_mapping carries the PostHog account).
  "ellielev5@gmail.com": "Law Office of Ellen Levin",
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

/** A subscription line reads "1 × Boutique (at $700.00 / month)", or is just
 * the plan's name (Ghozland's first Solo payment on 2026-09-08 was invoiced
 * as "Solo" and read as a $300 case until 2026-10-22), or is a proration
 * ("Unused time on Solo after ..."); anything else on an invoice is usage -
 * a case, a report, an add-on. */
function lineIsSubscription(desc: string | null | undefined): boolean {
  const d = (desc ?? "").trim();
  return /\(at \$[\d,.]+ \/ (month|year)\)/i.test(d)
    || /^(solo|boutique|growth|powerhouse)( plan)?$/i.test(d)
    || /^(unused time|remaining time) on (solo|boutique|growth|powerhouse)/i.test(d);
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

  const [customers, charges, invoices, subscriptions, prices] = await Promise.all([
    listCustomers(), listCharges(), listInvoices(), listSubscriptions(), listPrices(),
  ]);
  const priceById = new Map(prices.map((p) => [p.id, p]));

  // ---- company lookup ------------------------------------------------------
  // selectAll, not a plain select: `companies` passed 1,000 rows on
  // 2026-10-22 and the unpaged read dropped the newest firms, so NSJ Law
  // Group's Solo plan matched no company despite a cached nsjlawgroup.com.
  const companyRows = await selectAll<{ hubspot_id: string; name: string | null; domain: string | null }>(
    "companies", "hubspot_id, name, domain");
  const byDomain = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const c of companyRows) {
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

  // What a subscription ACTUALLY bills, which is not always its list price:
  // Peerali's line reads "1 x Boutique (at $700.00 / month)" but the charge is
  // $500, and Stitt Vu bills $300 against a $350 line. Both carry a Stripe
  // discount that the list API returns only as an opaque id with no amount, so
  // the real figure has to come from the most recent successful subscription
  // charge. Gross, not net: a refund is a one-off event, not a lower price.
  // Read off the already-classified payments rather than the raw charges: most
  // subscription charges are described only as "Payment for Invoice", and it is
  // the invoice line paired above that reveals them as a plan.
  const lastSubCharge = new Map<string, number>();
  for (const p of [...paymentRows].sort(
    (a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))) {
    if (p.status !== "succeeded" || !p.customer_id || p.kind !== "subscription") continue;
    lastSubCharge.set(p.customer_id, p.amount_cents);
  }

  const subscriptionRows = subscriptions.map((s) => {
    const cust = byCustomer.get(s.customer ?? "");
    const items = s.items?.data ?? [];
    const amount = items.reduce((t, i) => t + (i.price?.unit_amount ?? 0), 0);
    const interval = items[0]?.price?.recurring?.interval ?? null;
    const billed = lastSubCharge.get(s.customer ?? "") ?? amount;
    // The plan name lives on the product behind the item's price. Newer API
    // versions also move the billing period from the subscription to its items.
    const price = priceById.get(items[0]?.price?.id ?? "");
    const product = price && typeof price.product === "object" ? price.product : null;
    return {
      subscription_id: s.id,
      customer_id: s.customer ?? null,
      company_hubspot_id: cust?.company_hubspot_id ?? null,
      customer_name: cust?.name ?? null,
      plan_name: product?.name ?? null,
      plan_type: product?.metadata?.plan_type ?? null,
      current_period_start: iso(s.current_period_start ?? items[0]?.current_period_start),
      cancel_at_period_end: s.cancel_at_period_end ?? false,
      amount_cents: amount,
      billed_cents: billed,
      // Normalised so an annual plan can be compared with a monthly one.
      monthly_cents: interval === "year" ? Math.round(billed / 12) : billed,
      interval,
      status: s.status ?? null,
      is_internal: cust?.is_internal ?? false,
      started_at: iso(s.created),
      cancelled_at: iso(s.canceled_at),
      current_period_end: iso(s.current_period_end ?? items[0]?.current_period_end),
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

  // ---- the case ledger -------------------------------------------------------
  // The platform raises one invoice per case it processes - billed or not
  // (allowance cases are $0 / allocation lines) - and stamps the real case id,
  // the PostHog account and the matter name on it. That names the firm behind
  // every analyst-entered case, which PostHog cannot (it reports the staff
  // member's own org while impersonating). Found 2026-10-23 when the team
  // counted more October cases than the dashboard: four of them were staff
  // work for The Injury Firm and Kass & Moses, each with a paid invoice.
  const caseInvoiceRows = invoices.flatMap((inv) => {
    const meta = inv.metadata?.case_id ? inv.metadata : inv.lines?.data?.find((l) => l.metadata?.case_id)?.metadata;
    const caseId = (meta?.case_id ?? "").trim();
    if (!/^case_[0-9a-fA-F]{8,}$/.test(caseId)) return [];
    const cust = byCustomer.get(inv.customer ?? "");
    return [{
      invoice_id: inv.id,
      customer_id: inv.customer ?? null,
      company_hubspot_id: cust?.company_hubspot_id ?? null,
      case_id: caseId,
      account_id: meta?.account_id ?? null,
      case_name: meta?.case_name ?? null,
      plan_type: meta?.plan_type ?? null,
      is_overage: meta?.is_overage == null ? null : String(meta.is_overage) === "true",
      status: inv.status ?? null,
      amount_paid_cents: inv.amount_paid ?? 0,
      amount_due_cents: inv.amount_due ?? 0,
      is_internal: cust?.is_internal ?? true,
      created_at: iso(inv.created),
      synced_at: now,
    }];
  });

  await upsert("stripe_customers", "customer_id", customerRows);
  await upsert("stripe_payments", "charge_id", paymentRows);
  await upsert("stripe_subscriptions", "subscription_id", subscriptionRows);
  await upsert("stripe_case_invoices", "invoice_id", caseInvoiceRows);

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
    caseInvoices: caseInvoiceRows.length,
    netCollectedCents: real.reduce((t, p) => t + p.net_cents, 0),
    internalCents: paymentRows.filter((p) => p.is_internal)
      .reduce((t, p) => t + p.net_cents, 0),
    refundedCents: real.reduce((t, p) => t + p.refunded_cents, 0),
    unmatchedCashCents: unmatchedCash,
    // Discount-aware: what the active plans actually bill, not their list price.
    activeMrrCents: subscriptionRows
      .filter((s) => s.status === "active" && !s.is_internal)
      .reduce((t, s) => t + (s.monthly_cents ?? 0), 0),
    activeMrrListCents: subscriptionRows
      .filter((s) => s.status === "active" && !s.is_internal)
      .reduce((t, s) => t + (s.interval === "year"
        ? Math.round((s.amount_cents ?? 0) / 12) : s.amount_cents ?? 0), 0),
  };
}
