import { loadSettings } from "@/lib/settings";
import { selectAll, supabaseService } from "@/lib/supabase/server";

/** Subscription plans replaced per-case pricing in August 2026; only
 * subscriptions started since then are counted. */
export const SUBSCRIPTION_ERA_START = "2026-08-01";

/** First lead month reported. July leads were bought by July's ad spend and
 * many subscribed once plans launched, so July is a cohort; leads from before
 * it are listed but belong to no cohort. */
export const FIRST_COHORT = "2026-07-01";

/** A lead month is read as settled once this many days have passed since it
 * ended; before that its later conversions have not happened yet. */
const MATURE_AFTER_DAYS = 21;

/** Where a subscribed firm came from, read from `sw_lead_source` on its
 * converting deal and its contacts in HubSpot. */
export type LeadSource =
  | "meta" | "website" | "outbound" | "conference" | "referral" | "selfserve" | "other" | "unknown";

const SOURCE_OF: Record<string, LeadSource> = {
  meta_ads: "meta",
  calendly: "website",
  organic_form: "website",
  cold_email: "outbound",
  walk_in: "conference",
  referral: "referral",
  app_signup: "selfserve",
  other: "other",
};

export interface Subscriber {
  company: string;
  firm: string;
  leadAt: string;
  subscribedAt: string;
  source: LeadSource;
  sourceDetail: string | null;
  plan: number;
  /** Lead predates the first cohort; shown but never in a cohort. */
  preSwitch: boolean;
}

export interface CohortMonth {
  month: string;
  label: string;
  spend: number;
  /** `meta`: summed from `meta_ad_spend_daily` (Insights API, actual);
   * `ledger`: the hand-typed month in Settings; `planned`: the monthly budget
   * prorated. */
  spendSource: "meta" | "ledger" | "planned";
  /** True unless the figure is a prorated plan. */
  spendFromLedger: boolean;
  /** Form submissions Meta reports for the month (null when no Meta row). */
  adLeads: number | null;
  mqls: number;
  /** Share of the month elapsed, for prorating monthly costs. */
  fraction: number;
  teamCost: number;
  mature: boolean;
}

/** Inputs for the paid-acquisition payback model on the Activity page.
 *
 * CAC is measured by LEAD cohort: each subscription is dated back to the lead
 * that converted (the latest sales deal created before it started, else the
 * firm's first contact, else the subscription itself) and charged to that
 * month's ad spend, counting only the firms whose source was paid. Dividing a
 * month's spend by that month's sign-ups instead credits the ads with
 * conference, outbound and pre-switch firms and reads CAC far too low. */
export interface UnitEconomicsSnapshot {
  monthLabel: string;
  teamCost: number;
  grossMargin: number;
  months: CohortMonth[];
  subscribers: Subscriber[];
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

  type DealRow = {
    name: string | null; is_activation: boolean | null; hs_created_at: string;
    company_hubspot_id: string | null; properties: Record<string, string> | null;
  };
  type ContactRow = { company_hubspot_id: string | null; properties: Record<string, string> | null };
  type SpendRow = { day: string; spend_cents: number; leads: number };
  const [deals, { data: subs }, contacts, companies, { data: spendDays }] = await Promise.all([
    selectAll<DealRow>("deals", "name, is_activation, hs_created_at, company_hubspot_id, properties"),
    sb.from("stripe_subscriptions")
      .select("company_hubspot_id, billed_cents, monthly_cents, status, is_internal, started_at"),
    selectAll<ContactRow>("contacts", "company_hubspot_id, properties"),
    selectAll<{ hubspot_id: string; name: string }>("companies", "hubspot_id, name"),
    sb.from("meta_ad_spend_daily").select("day, spend_cents, leads"),
  ]);
  const name = new Map(companies.map((c) => [c.hubspot_id, c.name]));
  // Actual Meta spend by month. A month is only "known" once a day of it has
  // synced; zero-spend days still come back as rows, so a paused month reads
  // $0 rather than falling through to the plan.
  const metaByMonth = new Map<string, { spend: number; leads: number }>();
  for (const r of (spendDays ?? []) as SpendRow[]) {
    const k = monthKey(r.day);
    const cur = metaByMonth.get(k) ?? { spend: 0, leads: 0 };
    cur.spend += r.spend_cents / 100;
    cur.leads += r.leads;
    metaByMonth.set(k, cur);
  }

  const sales = deals.filter((d) =>
    d.hs_created_at && !d.is_activation
    && !/intake/i.test(d.name ?? "") && !INTERNAL_DEAL.test(d.name ?? ""));
  const dealsByCompany = new Map<string, DealRow[]>();
  for (const d of sales) {
    if (!d.company_hubspot_id) continue;
    const list = dealsByCompany.get(d.company_hubspot_id) ?? [];
    list.push(d);
    dealsByCompany.set(d.company_hubspot_id, list);
  }
  const contactsByCompany = new Map<string, ContactRow[]>();
  for (const c of contacts) {
    if (!c.company_hubspot_id || !c.properties?.createdate) continue;
    const list = contactsByCompany.get(c.company_hubspot_id) ?? [];
    list.push(c);
    contactsByCompany.set(c.company_hubspot_id, list);
  }

  let activeSubscribers = 0;
  let liveMrr = 0;
  let newSubscribers = 0;
  let newSubscriberMrr = 0;
  // Every subscription ever acquired counts toward CAC, cancelled or not; one
  // per firm, dated by its first subscription.
  const acquired = new Map<string, { started: string; plan: number }>();
  for (const s of subs ?? []) {
    if (s.is_internal) continue;
    const billed = (s.billed_cents ?? s.monthly_cents ?? 0) / 100;
    if (billed <= 0 || !s.started_at) continue;
    // Stripe opens a subscription before its first payment clears; a failed
    // card leaves it incomplete, and that firm was never acquired.
    if (s.status === "incomplete" || s.status === "incomplete_expired") continue;
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
    if (!prev || s.started_at < prev.started) acquired.set(key, { started: s.started_at, plan: billed });
  }

  const subscribers: Subscriber[] = [];
  for (const [company, { started, plan }] of acquired) {
    if (started < SUBSCRIPTION_ERA_START) continue;
    const cutoff = new Date(Date.parse(started) + DAY).toISOString();
    const priorDeals = (dealsByCompany.get(company) ?? [])
      .filter((d) => d.hs_created_at <= cutoff)
      .sort((a, b) => a.hs_created_at.localeCompare(b.hs_created_at));
    const firmContacts = (contactsByCompany.get(company) ?? [])
      .sort((a, b) => a.properties!.createdate.localeCompare(b.properties!.createdate));
    const contact = firmContacts[0]?.properties?.createdate;
    const converting = priorDeals.at(-1);
    const lead = converting?.hs_created_at ?? (contact && contact <= cutoff ? contact : started);

    // A specific source beats "other" (the CAALA import stamps every contact
    // "other", including firms that actually came in through an ad).
    const candidates = [
      { src: converting?.properties?.sw_lead_source, detail: null as string | null },
      ...firmContacts.map((c) => ({ src: c.properties?.sw_lead_source, detail: c.properties?.sw_lead_source_detail ?? null })),
    ].filter((c) => c.src);
    const pick = candidates.find((c) => SOURCE_OF[c.src!] && SOURCE_OF[c.src!] !== "other") ?? candidates[0];
    subscribers.push({
      company,
      firm: name.get(company) ?? "Unmatched Stripe customer",
      leadAt: lead,
      subscribedAt: started,
      source: pick ? SOURCE_OF[pick.src!] ?? "other" : "unknown",
      sourceDetail: pick?.detail ?? null,
      plan,
      preSwitch: lead < FIRST_COHORT,
    });
  }
  subscribers.sort((a, b) => a.leadAt.localeCompare(b.leadAt));

  const mqlsByMonth = new Map<string, number>();
  for (const d of sales) mqlsByMonth.set(monthKey(d.hs_created_at), (mqlsByMonth.get(monthKey(d.hs_created_at)) ?? 0) + 1);

  const months: CohortMonth[] = [];
  for (let m = new Date(FIRST_COHORT + "T00:00:00Z"); m <= now; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const key = m.toISOString().slice(0, 7);
    const end = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    const daysIn = (end.getTime() - m.getTime()) / DAY;
    const elapsed = Math.min(daysIn, Math.max(1, Math.ceil((now.getTime() - m.getTime()) / DAY)));
    const fraction = elapsed / daysIn;
    const ledger = settings.adSpendByMonth[key];
    const meta = metaByMonth.get(key);
    const spendSource = meta ? "meta" : Number.isFinite(Number(ledger)) ? "ledger" : "planned";
    months.push({
      month: key,
      label: m.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
        + (elapsed < daysIn ? ` (1–${now.getUTCDate()})` : ""),
      spend: meta ? meta.spend : spendSource === "ledger" ? Number(ledger) : settings.monthlyAdSpend * fraction,
      spendSource,
      spendFromLedger: spendSource !== "planned",
      adLeads: meta ? meta.leads : null,
      mqls: mqlsByMonth.get(key) ?? 0,
      fraction,
      teamCost: settings.monthlyTeamCost * fraction,
      mature: now.getTime() - end.getTime() >= MATURE_AFTER_DAYS * DAY,
    });
  }

  return {
    monthLabel: now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    teamCost: settings.monthlyTeamCost,
    grossMargin: settings.grossMarginPct / 100,
    months,
    subscribers,
    newSubscriberMrr,
    newSubscribers,
    activeSubscribers,
    liveMrr,
  };
}
