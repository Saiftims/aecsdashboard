import { caseRevenue } from "@/lib/queries";
import { loadRevenueFacts } from "@/lib/revenue";
import { loadSettings } from "@/lib/settings";
import { subscribersReport, type SubscriberRow } from "@/lib/subscribers";
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
  /** Lead predates the first cohort, or the plan predates the subscription
   * era; shown but never in a cohort. */
  preSwitch: boolean;
  /** Plan started before plans launched in August 2026. */
  preEra: boolean;
  live: boolean;
  /** Current-period usage, for the CS view; null when no live plan. */
  planName: string | null;
  periodEnd: string | null;
  daysToRenewal: number | null;
  casesThisPeriod: number | null;
  included: number | null;
  left: number | null;
  note: string | null;
}

/** Every firm that has used the product, whatever it pays (owner, 2026-10-20:
 * "we want to reflect all signups as well not just subs ... and the
 * transactional cohort, so we see the full picture"). Dated by when the firm
 * ARRIVED - first app signup, first case or first subscription, whichever is
 * earliest - and charged to the lead month that produced it, like a
 * subscriber. */
export type CustomerKind = "subscription" | "transactional" | "signup";

export interface Customer {
  company: string;
  firm: string;
  kind: CustomerKind;
  leadAt: string;
  arrivedAt: string;
  source: LeadSource;
  /** What the firm is worth per month: the billed plan for a subscriber; for a
   * transactional firm its cash to date (Stripe, else modelled per case)
   * spread over the months since its first case; 0 for a signup. */
  monthly: number;
  revenueToDate: number;
  cases: number;
  /** Lead predates the first cohort (or a pre-era plan): listed, no cohort. */
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
  /** AE + CS cost for the month, prorated; the two parts for display. */
  teamCost: number;
  aeCost: number;
  csCost: number;
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
  /** Monthly people cost counted in CAC: AE + CS. */
  teamCost: number;
  aeCost: number;
  csCost: number;
  grossMargin: number;
  months: CohortMonth[];
  subscribers: Subscriber[];
  /** Every firm that used the product - the cohort table runs on this. */
  customers: Customer[];
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
  type CompanyRow = { hubspot_id: string; name: string; domain: string | null; signed_up_at: string | null };
  type CaseRow = { company_hubspot_id: string | null; submitted_date: string | null; revenue_amount: number | null };
  const [deals, { data: subs }, contacts, companies, { data: spendDays }, current, { data: caseRows }, facts, { data: metaRows }] = await Promise.all([
    selectAll<DealRow>("deals", "name, is_activation, hs_created_at, company_hubspot_id, properties"),
    sb.from("stripe_subscriptions")
      .select("company_hubspot_id, billed_cents, monthly_cents, status, is_internal, started_at"),
    selectAll<ContactRow>("contacts", "company_hubspot_id, properties"),
    selectAll<CompanyRow>("companies", "hubspot_id, name, domain, signed_up_at"),
    sb.from("meta_ad_spend_daily").select("day, spend_cents, leads"),
    subscribersReport(now),
    sb.from("cases").select("company_hubspot_id, submitted_date, revenue_amount"),
    loadRevenueFacts(),
    sb.from("meta_leads").select("email, is_test"),
  ]);
  // The Meta lead archive names people HubSpot never stamped a source on:
  // on 2026-10-21 six of the 23 "source not recorded" customers (Griffin,
  // Cook Barkett, Katsarov, Olsen, Roxell Richards, Mary Ewing) were Meta
  // form fills by email, and October read zero paid-sourced wins.
  const metaEmails = new Set<string>();
  for (const r of (metaRows ?? []) as { email: string | null; is_test: boolean | null }[]) {
    if (r.email && !r.is_test) metaEmails.add(r.email.toLowerCase());
  }
  // Live plans with their billing period and case usage, by firm. This is the
  // COMPLETE subscriber list (it includes pre-era plans and the firms billed
  // outside Stripe); the Stripe rows below only add cancelled plans for CAC.
  const liveByCompany = new Map<string, SubscriberRow>();
  for (const r of current.rows) liveByCompany.set(r.companyId ?? `name:${r.firm}`, r);
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

  // Every firm with a live plan, plus any plan acquired since August that has
  // since been cancelled (it still cost acquisition spend).
  for (const [key, r] of liveByCompany) {
    if (!acquired.has(key)) acquired.set(key, { started: r.startedAt ?? r.periodStart ?? now.toISOString(), plan: r.monthly });
  }

  /** The lead that produced a firm's conversion at `at`: the latest sales deal
   * created before it, else the firm's first contact, else the event itself;
   * and the firm's source, where a specific source beats "other" (the CAALA
   * import stamps every contact "other", including firms that came in
   * through an ad). */
  const attribute = (company: string, at: string) => {
    const cutoff = new Date(Date.parse(at) + DAY).toISOString();
    const priorDeals = (dealsByCompany.get(company) ?? [])
      .filter((d) => d.hs_created_at <= cutoff)
      .sort((a, b) => a.hs_created_at.localeCompare(b.hs_created_at));
    const firmContacts = (contactsByCompany.get(company) ?? [])
      .sort((a, b) => a.properties!.createdate.localeCompare(b.properties!.createdate));
    const contact = firmContacts[0]?.properties?.createdate;
    const converting = priorDeals.at(-1);
    const lead = converting?.hs_created_at ?? (contact && contact <= cutoff ? contact : at);
    const candidates = [
      { src: converting?.properties?.sw_lead_source, detail: null as string | null },
      ...firmContacts.map((c) => ({ src: c.properties?.sw_lead_source, detail: c.properties?.sw_lead_source_detail ?? null })),
    ].filter((c) => c.src);
    const pick = candidates.find((c) => SOURCE_OF[c.src!] && SOURCE_OF[c.src!] !== "other") ?? candidates[0];
    const source = (pick ? SOURCE_OF[pick.src!] ?? "other" : "unknown") as LeadSource;
    if ((source === "unknown" || source === "other")
      && firmContacts.some((c) => metaEmails.has((c.properties?.email ?? "").toLowerCase()))) {
      return { lead, source: "meta" as LeadSource, sourceDetail: "Meta form fill (lead archive)" };
    }
    return { lead, source, sourceDetail: pick?.detail ?? null };
  };

  const subscribers: Subscriber[] = [];
  for (const [company, { started, plan }] of acquired) {
    const live = liveByCompany.get(company);
    const preEra = started < SUBSCRIPTION_ERA_START;
    if (preEra && !live) continue;
    const { lead, source, sourceDetail } = attribute(company, started);
    subscribers.push({
      company,
      firm: name.get(company) ?? live?.firm ?? "Unmatched Stripe customer",
      leadAt: lead,
      subscribedAt: started,
      source,
      sourceDetail,
      plan: live?.monthly ?? plan,
      // Pre-era plans are listed but stay out of every cohort, as before.
      preSwitch: lead < FIRST_COHORT || preEra,
      preEra,
      live: !!live,
      planName: live?.plan ?? null,
      periodEnd: live?.periodEnd ?? null,
      daysToRenewal: live?.daysToRenewal ?? null,
      casesThisPeriod: live ? live.casesThisPeriod : null,
      included: live?.included ?? null,
      left: live?.left ?? null,
      note: live?.note ?? null,
    });
  }
  subscribers.sort((a, b) => a.leadAt.localeCompare(b.leadAt));

  // ---- every firm that used the product ----
  // First case, case count and modelled case revenue per firm. The cases table
  // is already purged of internal/test actors.
  const firstCase = new Map<string, string>();
  const caseCount = new Map<string, number>();
  const modelled = new Map<string, number>();
  for (const c of (caseRows ?? []) as CaseRow[]) {
    if (!c.company_hubspot_id || !c.submitted_date) continue;
    const id = c.company_hubspot_id;
    if (!firstCase.has(id) || c.submitted_date < firstCase.get(id)!) firstCase.set(id, c.submitted_date);
    caseCount.set(id, (caseCount.get(id) ?? 0) + 1);
    modelled.set(id, (modelled.get(id) ?? 0) + caseRevenue(c, settings.defaultCasePrice));
  }
  const subByCompany = new Map(subscribers.map((s) => [s.company, s]));
  const customers: Customer[] = [];
  for (const co of companies) {
    const id = co.hubspot_id;
    const sub = subByCompany.get(id);
    const first = firstCase.get(id) ?? null;
    const arrivedAt = [co.signed_up_at, first, sub?.subscribedAt].filter((x): x is string => !!x).sort()[0];
    if (!arrivedAt) continue;
    const kind: CustomerKind = sub ? "subscription" : first ? "transactional" : "signup";
    // Stripe states a transactional firm's cash, including $0 for a refunded
    // one; only a firm Stripe has never billed is priced per case.
    const cash = facts.ready && facts.inStripe.has(id)
      ? [...(facts.byCompanyMonth.get(id)?.values() ?? [])].reduce((a, b) => a + b, 0)
      : modelled.get(id) ?? 0;
    const monthsActive = Math.max(1, (now.getTime() - Date.parse(first ?? arrivedAt)) / (30 * DAY));
    const { lead, source } = sub ? { lead: sub.leadAt, source: sub.source } : attribute(id, arrivedAt);
    customers.push({
      company: id, firm: co.name ?? sub?.firm ?? id, kind, leadAt: lead, arrivedAt, source,
      monthly: kind === "subscription" ? sub!.plan : kind === "transactional" ? cash / monthsActive : 0,
      revenueToDate: kind === "subscription" ? cash : kind === "transactional" ? cash : 0,
      cases: caseCount.get(id) ?? 0,
      preSwitch: sub ? sub.preSwitch : lead < FIRST_COHORT,
    });
  }
  // Subscribers Stripe knows but HubSpot does not (no company row).
  for (const s of subscribers) {
    if (customers.some((c) => c.company === s.company)) continue;
    customers.push({
      company: s.company, firm: s.firm, kind: "subscription", leadAt: s.leadAt, arrivedAt: s.subscribedAt, source: s.source,
      monthly: s.plan, revenueToDate: 0, cases: 0, preSwitch: s.preSwitch,
    });
  }
  // One firm, one row. HubSpot sometimes holds two company records for the
  // same domain (RAM Law on 2026-10-20: the app signup and case on one, the
  // Stripe plan on another created the same day) - fold them into the earlier
  // arrival, keeping the plan.
  const domainOf = new Map(companies.map((c) => [c.hubspot_id, (c.domain ?? "").toLowerCase().replace(/^www\./, "")]));
  const byDomain = new Map<string, Customer>();
  const deduped: Customer[] = [];
  for (const c of customers.sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt))) {
    const dom = domainOf.get(c.company) || null;
    const prior = dom ? byDomain.get(dom) : undefined;
    if (!prior) { if (dom) byDomain.set(dom, c); deduped.push(c); continue; }
    if (c.kind === "subscription" && prior.kind !== "subscription") {
      Object.assign(prior, { kind: c.kind, monthly: c.monthly, leadAt: c.leadAt, source: c.source, preSwitch: c.preSwitch });
    }
    prior.cases += c.cases;
    prior.revenueToDate += c.revenueToDate;
  }
  customers.length = 0;
  customers.push(...deduped.sort((a, b) => a.leadAt.localeCompare(b.leadAt)));

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
      teamCost: (settings.monthlyTeamCost + settings.monthlyCsCost) * fraction,
      aeCost: settings.monthlyTeamCost * fraction,
      csCost: settings.monthlyCsCost * fraction,
      mature: now.getTime() - end.getTime() >= MATURE_AFTER_DAYS * DAY,
    });
  }

  return {
    monthLabel: now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    teamCost: settings.monthlyTeamCost + settings.monthlyCsCost,
    aeCost: settings.monthlyTeamCost,
    csCost: settings.monthlyCsCost,
    grossMargin: settings.grossMarginPct / 100,
    months,
    subscribers,
    customers,
    newSubscriberMrr,
    newSubscribers,
    activeSubscribers,
    liveMrr,
  };
}
