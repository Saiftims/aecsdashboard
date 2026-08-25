/** Revenue facts drawn from Stripe, the billing system.
 *
 * The dashboard used to MODEL revenue: $250 a case, overridden by a flat monthly
 * amount typed onto the HubSpot company. That model had drifted a third away
 * from the money and was wrong in both directions - Chudacoff was credited
 * $2,000 having paid nothing through Stripe, while Morrin showed $250 having
 * paid $1,900 for reports the model had no concept of.
 *
 * The rule now: A FIRM THAT EXISTS IN STRIPE IS DESCRIBED BY STRIPE. Its revenue
 * is the cash Stripe collected, net of refunds, in the month it was collected.
 * A firm with NO Stripe customer keeps the old modelled pricing, because
 * something has to price its cases - but those firms are listed by
 * `unbilledFirms` so they can be reconciled rather than quietly guessed at.
 *
 * Cash, not billings: an unpaid invoice is not revenue, and a refunded charge is
 * not revenue either. Both matter here - Mardirosian's $2,800 was refunded in
 * full, so their four cases are worth nothing.
 *
 * Amounts are converted to DOLLARS at this boundary; Stripe's cents never escape
 * this module, because every caller and every existing revenue figure is dollars.
 */
import { supabaseService } from "@/lib/supabase/server";

/** Calendar month as year*12 + monthIndex, matching billingRetentionReport. */
export function monthIndexOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getUTCFullYear() * 12 + d.getUTCMonth();
}

export interface StripePayment {
  companyId: string | null;
  customerId: string | null;
  /** Dollars, net of refunds. Zero for a failed charge. */
  net: number;
  refunded: number;
  kind: string | null;
  description: string | null;
  at: string | null;
}

export interface RevenueFacts {
  /** False when Stripe has never synced. Callers fall back to the old model
   * wholesale rather than reporting every firm as $0. */
  ready: boolean;
  /** Firms Stripe knows about. Their revenue is Stripe's to state, INCLUDING
   * when the answer is zero - a firm that was billed and refunded earned us
   * nothing, and modelling $250 a case over the top would invent it back. */
  inStripe: Set<string>;
  /** company id -> month index -> dollars collected. */
  byCompanyMonth: Map<string, Map<number, number>>;
  /** Live subscription value per firm, in dollars a month. */
  mrrByCompany: Map<string, number>;
  payments: StripePayment[];
  /** Cash from a payer no HubSpot company could be matched to. */
  unmatched: number;
  totalCollected: number;
}

const EMPTY: RevenueFacts = {
  ready: false,
  inStripe: new Set(),
  byCompanyMonth: new Map(),
  mrrByCompany: new Map(),
  payments: [],
  unmatched: 0,
  totalCollected: 0,
};

export async function loadRevenueFacts(): Promise<RevenueFacts> {
  const sb = supabaseService();
  const [paymentsRes, customersRes, subsRes] = await Promise.all([
    sb.from("stripe_payments")
      .select("company_hubspot_id, customer_id, net_cents, refunded_cents, kind, description, created_at, is_internal"),
    sb.from("stripe_customers").select("company_hubspot_id, is_internal"),
    sb.from("stripe_subscriptions")
      .select("company_hubspot_id, monthly_cents, status, is_internal"),
  ]);
  // Table missing (migration not applied) or nothing synced yet: say so rather
  // than reporting a zeroed-out month as fact.
  if (paymentsRes.error || !paymentsRes.data?.length) return EMPTY;

  const inStripe = new Set<string>();
  for (const c of customersRes.data ?? []) {
    if (!c.is_internal && c.company_hubspot_id) inStripe.add(c.company_hubspot_id);
  }

  const byCompanyMonth = new Map<string, Map<number, number>>();
  const payments: StripePayment[] = [];
  let unmatched = 0;
  let totalCollected = 0;
  for (const p of paymentsRes.data) {
    if (p.is_internal) continue;
    const net = (p.net_cents ?? 0) / 100;
    payments.push({
      companyId: p.company_hubspot_id ?? null,
      customerId: p.customer_id ?? null,
      net,
      refunded: (p.refunded_cents ?? 0) / 100,
      kind: p.kind ?? null,
      description: p.description ?? null,
      at: p.created_at ?? null,
    });
    if (!net) continue;
    totalCollected += net;
    if (!p.company_hubspot_id) { unmatched += net; continue; }
    const m = monthIndexOf(p.created_at);
    if (m === null) continue;
    const firm = byCompanyMonth.get(p.company_hubspot_id) ?? new Map<number, number>();
    firm.set(m, (firm.get(m) ?? 0) + net);
    byCompanyMonth.set(p.company_hubspot_id, firm);
  }

  const mrrByCompany = new Map<string, number>();
  for (const s of subsRes.data ?? []) {
    if (s.is_internal || s.status !== "active" || !s.company_hubspot_id) continue;
    const amount = (s.monthly_cents ?? 0) / 100;
    mrrByCompany.set(s.company_hubspot_id,
      (mrrByCompany.get(s.company_hubspot_id) ?? 0) + amount);
  }

  return { ready: true, inStripe, byCompanyMonth, mrrByCompany, payments,
    unmatched, totalCollected };
}

/** Cash collected from a firm in one calendar month, or null when Stripe cannot
 * speak for that firm and the caller should fall back to modelled pricing. */
export function stripeRevenueFor(
  facts: RevenueFacts, companyId: string | null | undefined, month: number,
): number | null {
  if (!facts.ready || !companyId || !facts.inStripe.has(companyId)) return null;
  return facts.byCompanyMonth.get(companyId)?.get(month) ?? 0;
}

/** Cash collected across an arbitrary window (used for "revenue won this week").
 * Only counts firms Stripe can speak for; the caller prices the rest. */
export function stripeRevenueBetween(
  facts: RevenueFacts, fromMs: number, toMs: number,
): number {
  if (!facts.ready) return 0;
  let total = 0;
  for (const p of facts.payments) {
    if (!p.net || !p.at) continue;
    const t = new Date(p.at).getTime();
    if (Number.isNaN(t) || t < fromMs || t > toMs) continue;
    total += p.net;
  }
  return total;
}
