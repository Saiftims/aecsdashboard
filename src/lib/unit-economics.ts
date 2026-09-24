import { loadSettings } from "@/lib/settings";
import { selectAll, supabaseService } from "@/lib/supabase/server";

/** Subscription plans replaced per-case pricing in August 2026. Leads from
 * before this were bought by the transactional business, so they are left out
 * of every cohort even when they later subscribe (Traut, Portland). */
export const SUBSCRIPTION_ERA_START = "2026-08-01";

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
  /** Lead predates the subscription era; shown but never in a cohort. */
  preSwitch: boolean;
}

export interface CohortMonth {
  month: string;
  label: string;
  spend: number;
  spendFromLedger: boolean;
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
  const [deals, { data: subs }, contacts, companies] = await Promise.all([
    selectAll<DealRow>("deals", "name, is_activation, hs_created_at, company_hubspot_id, properties"),
    sb.from("stripe_subscriptions")
      .select("company_hubspot_id, billed_cents, monthly_cents, status, is_internal, started_at"),
    selectAll<ContactRow>("contacts", "company_hubspot_id, properties"),
    selectAll<{ hubspot_id: string; name: string }>("companies", "hubspot_id, name"),
  ]);
  const name = new Map(companies.map((c) => [c.hubspot_id, c.name]));

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
      preSwitch: lead < SUBSCRIPTION_ERA_START,
    });
  }
  subscribers.sort((a, b) => a.leadAt.localeCompare(b.leadAt));

  const mqlsByMonth = new Map<string, number>();
  for (const d of sales) mqlsByMonth.set(monthKey(d.hs_created_at), (mqlsByMonth.get(monthKey(d.hs_created_at)) ?? 0) + 1);

  const months: CohortMonth[] = [];
  for (let m = new Date(SUBSCRIPTION_ERA_START + "T00:00:00Z"); m <= now; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const key = m.toISOString().slice(0, 7);
    const end = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    const daysIn = (end.getTime() - m.getTime()) / DAY;
    const elapsed = Math.min(daysIn, Math.max(1, Math.ceil((now.getTime() - m.getTime()) / DAY)));
    const fraction = elapsed / daysIn;
    const ledger = settings.adSpendByMonth[key];
    months.push({
      month: key,
      label: m.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
        + (elapsed < daysIn ? ` (1–${now.getUTCDate()})` : ""),
      spend: Number.isFinite(Number(ledger)) ? Number(ledger) : settings.monthlyAdSpend * fraction,
      spendFromLedger: ledger !== undefined,
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
