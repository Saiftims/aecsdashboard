/** Subscribers page: one row per firm on a plan, with the plan, the current
 * billing period and how many of its included cases it has used. Built so a
 * CSM can call the accounts with unused cases before they renew, without
 * logging into each firm's account. */
import { firmMrr } from "@/lib/queries";
import { selectAll, supabaseService } from "@/lib/supabase/server";

/** Cases included per month by plan family, from silentwitness.ai/pricing
 * (2026-10-14): Solo 2 ($175 extra), Boutique 5 ($125), Growth 10 ($100). The
 * older solo/solo_v2/boutique_v2 price points carry the same allowance; Stripe
 * holds no allowance field, so this is the one place the number lives. Plans
 * not listed (Custom Pricing, Powerhouse, Enterprise) show no allowance. */
export function includedCases(planName: string | null | undefined): number | null {
  const n = (planName ?? "").toLowerCase();
  if (n.startsWith("solo")) return 2;
  if (n.startsWith("boutique")) return 5;
  if (n.startsWith("growth")) return 10;
  return null;
}

/** Stripe customers the sync flags internal (staff email on the account) that
 * the owner says are real paying firms. CF Injury bills from
 * diego+10@silentwitness.ai (owner, 2026-10-14). Listed by Stripe customer id
 * so the page shows them while the revenue code keeps its own view. */
const REAL_DESPITE_STAFF_EMAIL = new Set(["cus_USJrd91b84An63"]);

/** Billing arrangements Stripe's subscription object cannot express, shown
 * under the plan so the CSM is not misled by the list price. */
const PLAN_NOTES: Record<string, { monthly: number; note: string }> = {
  // Powerhouse $24,000/yr carries a 100% Stripe discount (invoice of 4 May 2026
  // paid $0); the firm is billed per case at $83.33 instead. Owner states a
  // $500/mo arrangement (2026-10-14) that Stripe does not show.
  cus_USJrd91b84An63: { monthly: 0, note: "Plan 100% discounted in Stripe; billed $83.33 per case" },
};

export interface SubscriberRow {
  companyId: string | null;
  firm: string;
  plan: string;
  /** What the plan bills per month (annual plans normalised). */
  monthly: number;
  interval: string | null;
  status: string;
  /** "stripe" or "hubspot" (flat fee invoiced outside Stripe). */
  source: "stripe" | "hubspot";
  periodStart: string | null;
  periodEnd: string | null;
  daysToRenewal: number | null;
  casesThisPeriod: number;
  included: number | null;
  left: number | null;
  casesLast30: number;
  lastCase: string | null;
  cancelAtPeriodEnd: boolean;
  startedAt: string | null;
  note: string | null;
}

export async function subscribersReport(now = new Date()): Promise<{ rows: SubscriberRow[]; syncedAt: string | null }> {
  type SubRow = {
    subscription_id: string; customer_id: string | null; company_hubspot_id: string | null; customer_name: string | null;
    plan_name: string | null; plan_type: string | null; amount_cents: number | null; billed_cents: number | null;
    interval: string | null; status: string | null; is_internal: boolean; started_at: string | null;
    current_period_start: string | null; current_period_end: string | null; cancel_at_period_end: boolean | null; synced_at: string | null;
  };
  type CoRow = {
    hubspot_id: string; name: string | null; billing_type: string | null; subscription_monthly_amount: number | null;
    properties: Record<string, unknown> | null;
  };
  type CaseRow = { company_hubspot_id: string | null; submitted_date: string | null };
  const sb = supabaseService();
  const [subs, companies, cases] = await Promise.all([
    selectAll<SubRow>("stripe_subscriptions", "*", "subscription_id"),
    selectAll<CoRow>("companies", "hubspot_id, name, billing_type, subscription_monthly_amount, properties", "hubspot_id"),
    (async () => {
      const { data, error } = await sb.from("cases").select("company_hubspot_id, submitted_date").not("company_hubspot_id", "is", null);
      if (error) throw error;
      return (data ?? []) as CaseRow[];
    })(),
  ]);
  const coById = new Map(companies.map((c) => [c.hubspot_id, c]));
  const casesByCo = new Map<string, string[]>();
  for (const c of cases) {
    if (!c.company_hubspot_id || !c.submitted_date) continue;
    casesByCo.set(c.company_hubspot_id, [...(casesByCo.get(c.company_hubspot_id) ?? []), c.submitted_date]);
  }
  const nowMs = now.getTime();
  // By calendar day, not timestamp: firms routinely subscribe and submit their
  // first case the same day, and the case is often dated earlier in that day
  // than the subscription. A case on the renewal day belongs to the new period.
  const countBetween = (cid: string | null, from: string | null, to: string | null) => {
    if (!cid || !from) return 0;
    const f = from.slice(0, 10);
    const t = to ? to.slice(0, 10) : "9999";
    return (casesByCo.get(cid) ?? []).filter((d) => { const x = d.slice(0, 10); return x >= f && x < t; }).length;
  };
  // What the plan costs per month. Normally the last subscription charge (it
  // carries the firm's discount: Peerali pays $500 on a $700 Boutique), but a
  // charge far below list is a proration from a mid-cycle change, not a price.
  const monthlyPrice = (s: { amount_cents: number | null; billed_cents: number | null; interval: string | null }) => {
    const list = s.amount_cents ?? 0;
    const billed = s.billed_cents ?? list;
    const cents = billed >= list * 0.5 ? billed : list;
    return (s.interval === "year" ? Math.round(cents / 12) : cents) / 100;
  };
  const last30 = (cid: string | null) => cid
    ? (casesByCo.get(cid) ?? []).filter((d) => nowMs - new Date(d).getTime() <= 30 * 86400000).length : 0;
  const lastCase = (cid: string | null) => cid ? ((casesByCo.get(cid) ?? []).sort().at(-1) ?? null) : null;

  // Live Stripe plans. One row per firm: if a firm has several live
  // subscriptions (a re-subscribe left the old one trialing, say) keep the one
  // renewing soonest.
  const LIVE = new Set(["active", "trialing", "past_due"]);
  const rows: SubscriberRow[] = [];
  const seen = new Set<string>();
  for (const s of subs
    .filter((s) => (!s.is_internal || REAL_DESPITE_STAFF_EMAIL.has(s.customer_id ?? "")) && LIVE.has(s.status ?? ""))
    .sort((a, b) => (a.current_period_end ?? "").localeCompare(b.current_period_end ?? ""))) {
    const key = s.company_hubspot_id ?? `stripe:${s.customer_id}`;
    if (seen.has(key)) continue;
    // A $0 plan on a customer no HubSpot firm owns is a test account.
    if (!s.company_hubspot_id && !(s.amount_cents ?? 0)) continue;
    seen.add(key);
    const co = s.company_hubspot_id ? coById.get(s.company_hubspot_id) : undefined;
    const included = includedCases(s.plan_name);
    const used = countBetween(s.company_hubspot_id, s.current_period_start, s.current_period_end);
    const end = s.current_period_end ? new Date(s.current_period_end).getTime() : null;
    const special = PLAN_NOTES[s.customer_id ?? ""];
    rows.push({
      companyId: s.company_hubspot_id,
      firm: co?.name ?? s.customer_name ?? s.customer_id ?? s.subscription_id,
      plan: s.plan_name ?? "Plan",
      monthly: special?.monthly ?? monthlyPrice(s),
      note: special?.note ?? null,
      interval: s.interval,
      status: s.status ?? "",
      source: "stripe",
      periodStart: s.current_period_start,
      periodEnd: s.current_period_end,
      daysToRenewal: end === null ? null : Math.ceil((end - nowMs) / 86400000),
      casesThisPeriod: used,
      included,
      left: included === null ? null : Math.max(0, included - used),
      casesLast30: last30(s.company_hubspot_id),
      lastCase: lastCase(s.company_hubspot_id),
      cancelAtPeriodEnd: !!s.cancel_at_period_end,
      startedAt: s.started_at,
    });
  }

  // Flat fees invoiced outside Stripe (Chudacoff is the standing example):
  // HubSpot's sw_subscription_monthly_amount with no end date. Their period is
  // the calendar month, since nothing records a renewal date.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  for (const co of companies) {
    if (seen.has(co.hubspot_id)) continue;
    const mrr = firmMrr(co);
    if (!mrr) continue;
    seen.add(co.hubspot_id);
    rows.push({
      companyId: co.hubspot_id,
      firm: co.name ?? co.hubspot_id,
      plan: "Flat fee (invoiced outside Stripe)",
      monthly: mrr, interval: "month", status: "active", source: "hubspot",
      periodStart: monthStart, periodEnd: monthEnd,
      daysToRenewal: Math.ceil((new Date(monthEnd).getTime() - nowMs) / 86400000),
      casesThisPeriod: countBetween(co.hubspot_id, monthStart, monthEnd),
      included: null, left: null,
      casesLast30: last30(co.hubspot_id), lastCase: lastCase(co.hubspot_id),
      cancelAtPeriodEnd: false, startedAt: null, note: null,
    });
  }

  rows.sort((a, b) => (a.daysToRenewal ?? 9e9) - (b.daysToRenewal ?? 9e9));
  const syncedAt = subs.map((s) => s.synced_at).filter((x): x is string => !!x).sort().at(-1) ?? null;
  return { rows, syncedAt };
}
