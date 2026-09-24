import { loadSettings } from "@/lib/settings";
import { selectAll, supabaseService } from "@/lib/supabase/server";

/** Subscription plans replaced per-case pricing in August 2026. Leads from
 * before this were bought by the transactional business, so they are left out
 * of every cohort even when they later subscribe (Traut, Portland). */
export const SUBSCRIPTION_ERA_START = "2026-08-01";

/** A lead month is read as settled once this many days have passed since it
 * ended; before that its later conversions have not happened yet. */
const MATURE_AFTER_DAYS = 21;

export interface LeadCohort {
  month: string;
  label: string;
  spend: number;
  spendFromLedger: boolean;
  mqls: number;
  subscribers: number;
  adSubscribers: number;
  adCac: number;
  teamPerSubscriber: number;
  fullCac: number;
  mature: boolean;
  firms: string[];
}

/** Inputs for the paid-acquisition payback model on the Activity page.
 *
 * CAC is measured by LEAD cohort: each subscription is dated back to the lead
 * that converted (the latest sales deal created before it started, else the
 * firm's first contact, else the subscription itself) and charged to that
 * month's ad spend. Dividing a month's spend by that month's sign-ups instead
 * credits the ads with conference, outbound and pre-switch firms and reads
 * CAC far too low. */
export interface UnitEconomicsSnapshot {
  monthLabel: string;
  adLeadShare: number;
  teamCost: number;
  grossMargin: number;
  cohorts: LeadCohort[];
  /** Pooled over mature cohorts, or over all of them while none is mature. */
  headline: { adCac: number; teamPerSubscriber: number; fullCac: number; basis: string; costPerMql: number; mqlToSub: number };
  newSubscriberMrr: number;
  newSubscribers: number;
  activeSubscribers: number;
  liveMrr: number;
}

const INTERNAL_DEAL = /silent\s?witness/i;
const monthKey = (iso: string) => iso.slice(0, 7);
const DAY = 86400000;

export async function unitEconomicsSnapshot(): Promise<UnitEconomicsSnapshot> {
  const sb = supabaseService();
  const settings = await loadSettings();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  type DealRow = { name: string | null; is_activation: boolean | null; hs_created_at: string; company_hubspot_id: string | null };
  type ContactRow = { company_hubspot_id: string | null; properties: Record<string, string> | null };
  const [deals, { data: subs }, contacts, companies] = await Promise.all([
    selectAll<DealRow>("deals", "name, is_activation, hs_created_at, company_hubspot_id"),
    sb.from("stripe_subscriptions")
      .select("company_hubspot_id, billed_cents, monthly_cents, status, is_internal, started_at"),
    selectAll<ContactRow>("contacts", "company_hubspot_id, properties"),
    selectAll<{ hubspot_id: string; name: string }>("companies", "hubspot_id, name"),
  ]);
  const name = new Map(companies.map((c) => [c.hubspot_id, c.name]));

  const sales = deals.filter((d) =>
    d.hs_created_at && !d.is_activation
    && !/intake/i.test(d.name ?? "") && !INTERNAL_DEAL.test(d.name ?? ""));
  const dealsByCompany = new Map<string, string[]>();
  for (const d of sales) {
    if (!d.company_hubspot_id) continue;
    const list = dealsByCompany.get(d.company_hubspot_id) ?? [];
    list.push(d.hs_created_at);
    dealsByCompany.set(d.company_hubspot_id, list);
  }
  const firstContact = new Map<string, string>();
  for (const c of contacts) {
    const created = c.properties?.createdate;
    if (!created || !c.company_hubspot_id) continue;
    const prev = firstContact.get(c.company_hubspot_id);
    if (!prev || created < prev) firstContact.set(c.company_hubspot_id, created);
  }

  let activeSubscribers = 0;
  let liveMrr = 0;
  let newSubscribers = 0;
  let newSubscriberMrr = 0;
  // Every subscription ever acquired counts toward CAC, cancelled or not; one
  // per firm, dated by its first subscription.
  const acquired = new Map<string, string>();
  for (const s of subs ?? []) {
    if (s.is_internal) continue;
    const billed = (s.billed_cents ?? s.monthly_cents ?? 0) / 100;
    if (billed <= 0 || !s.started_at) continue;
    if (s.status === "active") {
      activeSubscribers += 1;
      liveMrr += billed;
      if (new Date(s.started_at) >= monthStart) {
        newSubscribers += 1;
        newSubscriberMrr += billed;
      }
    }
    const key = s.company_hubspot_id ?? `sub:${s.started_at}`;
    const prev = acquired.get(key);
    if (!prev || s.started_at < prev) acquired.set(key, s.started_at);
  }

  const leadMonthFirms = new Map<string, string[]>();
  for (const [company, started] of acquired) {
    if (started < SUBSCRIPTION_ERA_START) continue;
    const cutoff = new Date(Date.parse(started) + DAY).toISOString();
    const priorDeals = (dealsByCompany.get(company) ?? []).filter((d) => d <= cutoff).sort();
    const contact = firstContact.get(company);
    const lead = priorDeals.at(-1) ?? (contact && contact <= cutoff ? contact : started);
    if (lead < SUBSCRIPTION_ERA_START) continue;
    const list = leadMonthFirms.get(monthKey(lead)) ?? [];
    list.push(name.get(company) ?? "Unmatched Stripe customer");
    leadMonthFirms.set(monthKey(lead), list);
  }

  const mqlsByMonth = new Map<string, number>();
  for (const d of sales) mqlsByMonth.set(monthKey(d.hs_created_at), (mqlsByMonth.get(monthKey(d.hs_created_at)) ?? 0) + 1);

  const share = settings.adLeadSharePct / 100;
  const cohorts: LeadCohort[] = [];
  for (let m = new Date(SUBSCRIPTION_ERA_START + "T00:00:00Z"); m <= now; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const key = m.toISOString().slice(0, 7);
    const end = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    const daysIn = (end.getTime() - m.getTime()) / DAY;
    const elapsed = Math.min(daysIn, Math.max(1, Math.ceil((now.getTime() - m.getTime()) / DAY)));
    const ledger = settings.adSpendByMonth[key];
    const spend = Number.isFinite(Number(ledger)) ? Number(ledger) : settings.monthlyAdSpend * (elapsed / daysIn);
    const firms = leadMonthFirms.get(key) ?? [];
    const adSubscribers = firms.length * share;
    const teamCost = settings.monthlyTeamCost * (elapsed / daysIn);
    const adCac = adSubscribers > 0 ? spend / adSubscribers : Infinity;
    const teamPerSubscriber = firms.length > 0 ? teamCost / firms.length : Infinity;
    cohorts.push({
      month: key,
      label: m.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
        + (elapsed < daysIn ? ` (1–${now.getUTCDate()})` : ""),
      spend,
      spendFromLedger: ledger !== undefined,
      mqls: mqlsByMonth.get(key) ?? 0,
      subscribers: firms.length,
      adSubscribers,
      adCac,
      teamPerSubscriber,
      fullCac: adCac + teamPerSubscriber,
      mature: now.getTime() - end.getTime() >= MATURE_AFTER_DAYS * DAY,
      firms: firms.sort(),
    });
  }

  const pool = cohorts.some((c) => c.mature) ? cohorts.filter((c) => c.mature) : cohorts;
  const sum = (f: (c: LeadCohort) => number) => pool.reduce((a, c) => a + f(c), 0);
  const poolSubs = sum((c) => c.subscribers);
  const poolAdCac = poolSubs > 0 ? sum((c) => c.spend) / (poolSubs * share) : Infinity;
  const poolTeam = poolSubs > 0
    ? pool.reduce((a, c) => a + (Number.isFinite(c.teamPerSubscriber) ? c.teamPerSubscriber * c.subscribers : 0), 0) / poolSubs
    : Infinity;
  const poolMqls = sum((c) => c.mqls);

  return {
    monthLabel: now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    adLeadShare: share,
    teamCost: settings.monthlyTeamCost,
    grossMargin: settings.grossMarginPct / 100,
    cohorts,
    headline: {
      adCac: poolAdCac,
      teamPerSubscriber: poolTeam,
      fullCac: poolAdCac + poolTeam,
      basis: pool.map((c) => c.label).join(" + ") + (pool === cohorts && !cohorts.some((c) => c.mature) ? " (not yet settled)" : ""),
      costPerMql: poolMqls > 0 ? sum((c) => c.spend) / (poolMqls * share) : Infinity,
      mqlToSub: poolMqls > 0 ? poolSubs / poolMqls : 0,
    },
    newSubscriberMrr,
    newSubscribers,
    activeSubscribers,
    liveMrr,
  };
}
