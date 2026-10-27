/** The investor data room's Pipeline page reads ONE JSON from here, so every
 * number investors see is the same number the GTM dashboard shows - same
 * series, same owner-confirmed definitions, no second derivation. Served by
 * `GET /api/investor` behind INVESTOR_FEED_TOKEN. Nothing here is computed
 * fresh: it is the master's existing reports reshaped. */
import { fetchCore, retentionReport } from "@/lib/queries";
import { unitEconomicsSnapshot } from "@/lib/unit-economics";
import { subscribersReport } from "@/lib/subscribers";
import { loadRevenueFacts } from "@/lib/revenue";
import { SALES_PIPELINE_ID, SALES_STAGE_LABELS, SALES_STAGE_ORDER, SALES_STAGES } from "@/lib/hubspot/stages";
import { supabaseService } from "@/lib/supabase/server";

export interface InvestorMonth {
  key: string;          // "2026-07"
  label: string;        // "Jul 26"
  mqls: number;
  /** Sales deals created this month that moved past MQL. */
  contacted: number;
  demosBooked: number;
  demosCompleted: number;
  noShow: number;
  newFirms: number;
  cases: number;
  /** Cash collected (Stripe) + modelled for firms Stripe never billed. */
  revenue: number;
  collected: number;
  /** The same `revenue` cut by billing model: plan payments + flat fees vs
   * per-case charges (same split as the GTM dashboard's revenue chart). */
  subscription: number;
  transactional: number;
  adSpend: number;
  adLeads: number;
  impressions: number;
  clicks: number;
}

export interface InvestorCustomer {
  firm: string;
  source: string;
  /** "Jul 26" - month the firm started (first signup, case or plan). */
  monthStarted: string;
  type: "Subscription" | "Transactional";
  plan: string | null;
  mrr: number;          // 0 for transactional
  grossRevenue: number; // cash to date (Stripe where known)
  cases: number;
}

export interface InvestorFeed {
  generatedAt: string;
  period: { from: string; to: string; label: string };
  months: InvestorMonth[];
  funnel: {
    mqls: number; contacted: number; demosBooked: number; demosCompleted: number; signedUp: number; paid: number;
    /** Paying firms whose lead source is Meta ads (incl. the meta_leads archive match). */
    paidFromMeta: number;
  };
  stages: { stage: string; deals: number }[];
  meta: { spend: number; leads: number; impressions: number; clicks: number; lastMonth: { label: string; spend: number; impressions: number } };
  revenue: {
    payingCustomers: number;
    subscribers: number;
    mrr: number;
    /** Average per-case (non-plan) cash per month over the last 3 full months. */
    transactionalMonthly: number;
    /** mrr + transactionalMonthly. */
    monthlyRunRate: number;
    annualised: number;
    collectedInPeriod: number;
    collectedLastMonth: number;
  };
  usage: { activatedFirms: number; totalCases: number; casesPerActivatedFirm: number };
  customers: InvestorCustomer[];
  freeTier: { firm: string; signedUp: string }[];
  definitions: Record<string, string>;
}

const SOURCE_LABEL: Record<string, string> = {
  meta: "Meta Ads", referral: "Referral", website: "Website", selfserve: "Self-serve",
  conference: "Conference", outbound: "Outbound", unknown: "Direct / unrecorded", other: "Other",
};
const shortLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${String(y).slice(2)}`;
};
const longLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
};

export async function investorFeed(): Promise<InvestorFeed> {
  const sb = supabaseService();
  const [report, ue, subs, facts, core, { data: spendRows }] = await Promise.all([
    retentionReport(),
    unitEconomicsSnapshot(),
    subscribersReport(),
    loadRevenueFacts(),
    fetchCore(),
    sb.from("meta_ad_spend_daily").select("day, spend_cents, impressions, clicks, leads"),
  ]);
  const now = new Date();

  // Month axis: the master's own series (first case month onward).
  const keys = report.monthlyCases.map((m) => m.key);
  const by = <T extends { key: string }>(rows: T[]) => new Map(rows.map((r) => [r.key, r]));
  const mqls = by(report.monthlyMqls), demos = by(report.monthlyDemos), firms = by(report.monthlyNewFirms),
    cases = by(report.monthlyCases), rev = by(report.monthlyRevenue);

  // Demos booked = FIRST entry into Demo Scheduled (`sw_demo_booked_at`, stamped
  // from DEMO_CREDIT_START = Aug 2026). Earlier months have no stamp, so the
  // demos that RAN stand in - no-show then reads 0 rather than inventing one.
  const booked = new Map<string, number>();
  const salesDeals = core.deals.filter((d) => (d.pipeline ?? SALES_PIPELINE_ID) === SALES_PIPELINE_ID && !d.is_activation);
  for (const d of salesDeals) {
    const at = d.properties?.sw_demo_booked_at;
    if (at) booked.set(at.slice(0, 7), (booked.get(at.slice(0, 7)) ?? 0) + 1);
  }

  const spend = new Map<string, { spend: number; leads: number; impressions: number; clicks: number }>();
  for (const r of (spendRows ?? []) as { day: string; spend_cents: number; impressions: number | null; clicks: number | null; leads: number | null }[]) {
    const k = r.day.slice(0, 7);
    const cur = spend.get(k) ?? { spend: 0, leads: 0, impressions: 0, clicks: 0 };
    cur.spend += r.spend_cents / 100; cur.leads += r.leads ?? 0; cur.impressions += r.impressions ?? 0; cur.clicks += r.clicks ?? 0;
    spend.set(k, cur);
  }

  // "Initial contact": a sales deal created in the month that got past MQL.
  const notContacted = new Set<string>([SALES_STAGES.unqualified, SALES_STAGES.mql, SALES_STAGES.nurture, SALES_STAGES.closedLost]);
  const passedMql = new Set<string>(SALES_STAGE_ORDER.filter((s) => !notContacted.has(s)));
  const contactedBy = new Map<string, number>();
  for (const d of salesDeals) {
    if (!d.hs_created_at || !passedMql.has(d.stage ?? "")) continue;
    const k = d.hs_created_at.slice(0, 7);
    contactedBy.set(k, (contactedBy.get(k) ?? 0) + 1);
  }

  const months: InvestorMonth[] = keys.map((k) => {
    const completed = demos.get(k)?.count ?? 0;
    const b = booked.has(k) ? Math.max(booked.get(k)!, completed) : completed;
    const s = spend.get(k);
    return {
      key: k, label: shortLabel(k),
      mqls: mqls.get(k)?.count ?? 0,
      contacted: contactedBy.get(k) ?? 0,
      demosBooked: b, demosCompleted: completed, noShow: Math.max(0, b - completed),
      newFirms: firms.get(k)?.count ?? 0,
      cases: cases.get(k)?.count ?? 0,
      revenue: Math.round(rev.get(k)?.total ?? 0),
      collected: Math.round(rev.get(k)?.collected ?? 0),
      subscription: Math.round(rev.get(k)?.subscription ?? 0),
      transactional: Math.round(rev.get(k)?.transactional ?? 0),
      adSpend: Math.round(s?.spend ?? 0), adLeads: s?.leads ?? 0, impressions: s?.impressions ?? 0, clicks: s?.clicks ?? 0,
    };
  });
  const sum = (f: (m: InvestorMonth) => number) => months.reduce((a, m) => a + f(m), 0);

  const contacted = sum((m) => m.contacted);

  // Open pipeline snapshot by stage, in pipeline order.
  const stageCount = new Map<string, number>();
  for (const d of salesDeals) stageCount.set(d.stage ?? "", (stageCount.get(d.stage ?? "") ?? 0) + 1);
  const stages = SALES_STAGE_ORDER.map((s) => ({ stage: SALES_STAGE_LABELS[s] ?? s, deals: stageCount.get(s) ?? 0 }));

  // Customers = every firm that used the product (unit-economics list), with
  // the plan name from the live subscriber list where there is one.
  const planByCompany = new Map(subs.rows.filter((r) => r.companyId).map((r) => [r.companyId!, r]));
  const paying = ue.customers.filter((c) => c.kind !== "signup");
  const customers: InvestorCustomer[] = paying
    .map((c) => ({
      firm: c.firm,
      source: SOURCE_LABEL[c.source] ?? c.source,
      monthStarted: shortLabel(c.arrivedAt.slice(0, 7)),
      type: (c.kind === "subscription" ? "Subscription" : "Transactional") as InvestorCustomer["type"],
      plan: planByCompany.get(c.company)?.plan ?? null,
      mrr: c.kind === "subscription" ? Math.round(c.monthly) : 0,
      grossRevenue: Math.round(c.revenueToDate),
      cases: c.cases,
    }))
    .sort((a, b) => (b.mrr - a.mrr) || (b.grossRevenue - a.grossRevenue));
  const freeTier = ue.customers.filter((c) => c.kind === "signup")
    .map((c) => ({ firm: c.firm, signedUp: shortLabel(c.arrivedAt.slice(0, 7)) }));

  // Transactional run-rate: per-case cash over the last 3 FULL months.
  const monthIdx = (iso: string) => { const d = new Date(iso); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const cur = monthIdx(now.toISOString());
  const perCase = facts.payments.filter((p) => p.at && p.kind !== "subscription" && monthIdx(p.at) >= cur - 3 && monthIdx(p.at) < cur);
  const transactionalMonthly = Math.round(perCase.reduce((a, p) => a + p.net, 0) / 3);
  const mrr = Math.round(ue.liveMrr);
  const lastKey = keys[keys.length - 2] ?? keys[keys.length - 1];
  const lastMeta = months.find((m) => m.key === lastKey);

  return {
    generatedAt: now.toISOString(),
    period: { from: keys[0], to: keys[keys.length - 1], label: `${longLabel(keys[0]).split(" ")[0]} – ${longLabel(keys[keys.length - 1])}` },
    months,
    funnel: {
      mqls: sum((m) => m.mqls), contacted,
      demosBooked: sum((m) => m.demosBooked), demosCompleted: sum((m) => m.demosCompleted),
      signedUp: ue.customers.length, paid: paying.length,
      paidFromMeta: paying.filter((c) => c.source === "meta").length,
    },
    stages,
    meta: {
      spend: sum((m) => m.adSpend), leads: sum((m) => m.adLeads), impressions: sum((m) => m.impressions), clicks: sum((m) => m.clicks),
      lastMonth: { label: lastMeta?.label ?? "", spend: lastMeta?.adSpend ?? 0, impressions: lastMeta?.impressions ?? 0 },
    },
    revenue: {
      payingCustomers: paying.length,
      subscribers: paying.filter((c) => c.kind === "subscription").length,
      mrr, transactionalMonthly,
      monthlyRunRate: mrr + transactionalMonthly,
      annualised: (mrr + transactionalMonthly) * 12,
      collectedInPeriod: sum((m) => m.collected),
      collectedLastMonth: months.find((m) => m.key === lastKey)?.collected ?? 0,
    },
    usage: {
      activatedFirms: report.frequency.activatedFirms,
      totalCases: report.frequency.totalCases,
      casesPerActivatedFirm: report.frequency.casesPerActivatedFirm,
    },
    customers, freeTier,
    definitions: {
      mqls: "Every new lead once, in the month the person arrived (Meta form fills qualified or not, website bookings, rep-added), same as the GTM dashboard's MQL chart.",
      contacted: "Sales deals created in the period that moved past MQL (excluding Nurture and Closed Lost).",
      demosBooked: "First entry into Demo Scheduled; before Aug 2026 the demos that ran stand in, so no-shows read 0 there.",
      demosCompleted: "Attended Calendly demos plus demos the CSM marked completed in HubSpot; no-shows never count.",
      newFirms: "A firm counts once, in the month it first signed up for the app or submitted its first case.",
      revenue: "Stripe cash net of refunds in the month collected; firms Stripe has never billed are modelled at $250 a case or their flat fee.",
      mrr: "Live Stripe plans at what they actually bill (discounts applied), plus flat-fee firms invoiced outside Stripe.",
      transactionalMonthly: "Per-case Stripe cash over the last three full months, divided by three.",
      customers: "Every firm that has paid or submitted a case; 'Free tier' is firms that signed up for the app and have not sent a case yet.",
    },
  };
}
