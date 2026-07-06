/** Server-side page data assembly. Reads only the Supabase cache (fast);
 * HubSpot remains the system of record via the sync. */
import { differenceInDays, startOfMonth, subDays } from "date-fns";
import { median } from "@/lib/metrics";
import {
  SALES_STAGES, hubspotDealUrl, type ActivationStage,
} from "@/lib/hubspot/stages";
import { loadSettings } from "@/lib/settings";
import { supabaseService } from "@/lib/supabase/server";

export interface DealRow {
  hubspot_id: string;
  name: string | null;
  pipeline: string | null;
  stage: string | null;
  stage_label: string | null;
  activation_stage: ActivationStage | null;
  is_activation: boolean;
  owner_id: string | null;
  amount: number | null;
  company_hubspot_id: string | null;
  primary_contact_id: string | null;
  properties: Record<string, string | null>;
  hs_created_at: string | null;
  closed_at: string | null;
}

export interface CompanyRow {
  hubspot_id: string;
  name: string | null;
  domain: string | null;
  properties: Record<string, string | null>;
  sw_account_id: string | null;
  cases_lifetime: number;
  cases_7d: number;
  cases_30d: number;
  cases_60d: number;
  cases_90d: number;
  cases_prev_30d: number;
  first_case_at: string | null;
  last_case_at: string | null;
  avg_cases_per_month: number | null;
  est_revenue: number;
  actual_revenue: number | null;
  health_score: number | null;
  health_category: string | null;
  health_factors: unknown;
  risk_flags: string[];
  usage_trend: string | null;
}

export interface ActivityRow {
  hubspot_id: string;
  kind: string;
  owner_id: string | null;
  subject: string | null;
  outcome: string | null;
  activity_type: string | null;
  contact_hubspot_id: string | null;
  deal_hubspot_id: string | null;
  company_hubspot_id: string | null;
  occurred_at: string | null;
  due_at: string | null;
  completed: boolean | null;
  /** For tasks: hs_lastmodifieddate, used as completion-time approximation. */
  modified_at: string | null;
}

/** Same calendar day in the dashboard timezone (default LA). */
export function sameLocalDay(a: string | Date, b: string | Date, tz: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(a)) === fmt.format(new Date(b));
}

export async function fetchCore() {
  const sb = supabaseService();
  const [settings, deals, companies, contacts, activities] = await Promise.all([
    loadSettings(),
    sb.from("deals").select("*").then((r) => (r.data ?? []) as DealRow[]),
    sb.from("companies").select("*").then((r) => (r.data ?? []) as CompanyRow[]),
    sb.from("contacts").select("hubspot_id, email, first_name, last_name, company_hubspot_id, owner_id, lifecycle_stage, properties"),
    // Note: body/properties intentionally excluded - large payloads (215+ note
    // bodies) that no dashboard aggregate needs.
    sb.from("activities").select(
      "hubspot_id, kind, owner_id, subject, outcome, activity_type, " +
      "contact_hubspot_id, deal_hubspot_id, company_hubspot_id, " +
      "occurred_at, due_at, completed, " +
      "modified_at:properties->>hs_lastmodifieddate",
    ).then((r) => (r.data ?? []) as unknown as ActivityRow[]),
  ]);
  return { settings, deals, companies, contacts: contacts.data ?? [], activities };
}

const OPEN_SALES_STAGES = new Set<string>([
  SALES_STAGES.mql, SALES_STAGES.attemptingContact, SALES_STAGES.connected,
  SALES_STAGES.qualified, SALES_STAGES.demoScheduled, SALES_STAGES.demoCompleted,
  SALES_STAGES.firstCaseIdentified, SALES_STAGES.firstCaseCommitted,
]);

export function isOpenSalesDeal(d: DealRow): boolean {
  return OPEN_SALES_STAGES.has(d.stage ?? "");
}

const STAGE_REACHED_ORDER: string[] = [
  SALES_STAGES.mql, SALES_STAGES.attemptingContact, SALES_STAGES.connected,
  SALES_STAGES.qualified, SALES_STAGES.demoScheduled, SALES_STAGES.demoCompleted,
  SALES_STAGES.firstCaseIdentified, SALES_STAGES.firstCaseCommitted,
  SALES_STAGES.closedWon,
];

/** Deals at-or-past a funnel stage (closed-won counts as passing everything). */
function reachedAtLeast(d: DealRow, stageId: string): boolean {
  if (d.stage === SALES_STAGES.closedWon) return true;
  if (d.stage === SALES_STAGES.closedLost || d.stage === SALES_STAGES.nurture) {
    return false; // terminal without full history; conservative
  }
  const cur = STAGE_REACHED_ORDER.indexOf(d.stage ?? "");
  const want = STAGE_REACHED_ORDER.indexOf(stageId);
  return cur >= 0 && want >= 0 && cur >= want;
}

/** A "meaningful touch" = real outreach: calls, meetings, emails, or notes
 * explicitly logged through the quick logger ([type:...] marker). Excludes
 * tasks and the agent's auto-generated context notes, which are not contact. */
export function isMeaningfulTouch(a: ActivityRow): boolean {
  if (a.kind === "task") return false;
  if (a.kind === "note") return Boolean(a.activity_type);
  return true; // call, meeting, email
}

/** Last meaningful-touch lookup for deals: checks activity on the deal itself
 * AND on the deal's primary contact (Gmail-logged emails often associate with
 * the contact only). Returns epoch ms or null if never touched. */
export function buildLastTouchLookup(
  activities: ActivityRow[],
  now: Date,
): (d: DealRow) => number | null {
  const byDeal = new Map<string, number>();
  const byContact = new Map<string, number>();
  const nowMs = now.getTime();
  for (const a of activities) {
    if (!isMeaningfulTouch(a) || !a.occurred_at) continue;
    const t = new Date(a.occurred_at).getTime();
    if (t > nowMs) continue;
    if (a.deal_hubspot_id) {
      byDeal.set(a.deal_hubspot_id, Math.max(byDeal.get(a.deal_hubspot_id) ?? 0, t));
    }
    if (a.contact_hubspot_id) {
      byContact.set(a.contact_hubspot_id,
        Math.max(byContact.get(a.contact_hubspot_id) ?? 0, t));
    }
  }
  return (d: DealRow) => {
    const dealT = byDeal.get(d.hubspot_id);
    const contactT = d.primary_contact_id ? byContact.get(d.primary_contact_id) : undefined;
    const best = Math.max(dealT ?? 0, contactT ?? 0);
    return best > 0 ? best : null;
  };
}

function firstResponseHours(d: DealRow, activities: ActivityRow[]): number | null {
  const explicit = d.properties?.sw_first_response_hours;
  if (explicit) return Number(explicit);
  if (!d.hs_created_at) return null;
  const created = new Date(d.hs_created_at).getTime();
  const touches = activities
    .filter((a) => a.deal_hubspot_id === d.hubspot_id && a.kind !== "task")
    .map((a) => (a.occurred_at ? new Date(a.occurred_at).getTime() : Infinity))
    .filter((t) => t >= created);
  if (!touches.length) return null;
  return (Math.min(...touches) - created) / 3600000;
}

// ---------------------------------------------------------------------------
export async function execOverview() {
  const { settings, deals, companies, activities } = await fetchCore();
  const now = new Date();
  const monthStart = startOfMonth(now);
  const sales = deals.filter((d) => !d.is_activation || isOpenSalesDeal(d));
  const last30 = subDays(now, 30);

  const newMqls30d = deals.filter(
    (d) => d.hs_created_at && new Date(d.hs_created_at) >= last30,
  ).length;

  const speedSamples = deals
    .map((d) => firstResponseHours(d, activities))
    .filter((h): h is number => h !== null && h < 24 * 14);

  const funnel = [
    { label: "MQL", count: deals.length },
    { label: "Contacted", count: deals.filter((d) => reachedAtLeast(d, SALES_STAGES.attemptingContact)).length },
    { label: "Connected", count: deals.filter((d) => reachedAtLeast(d, SALES_STAGES.connected)).length },
    { label: "Qualified", count: deals.filter((d) => reachedAtLeast(d, SALES_STAGES.qualified)).length },
    { label: "Demo", count: deals.filter((d) => reachedAtLeast(d, SALES_STAGES.demoScheduled)).length },
    { label: "First Case Committed", count: deals.filter((d) => reachedAtLeast(d, SALES_STAGES.firstCaseCommitted)).length },
    { label: "Closed Won", count: deals.filter((d) => d.stage === SALES_STAGES.closedWon).length },
  ];

  const activation = deals.filter((d) => d.activation_stage);
  const byActivation = (s: ActivationStage) => activation.filter((d) => d.activation_stage === s).length;
  const customers = companies.filter((c) => c.cases_lifetime > 0 || activation.some((d) => d.company_hubspot_id === c.hubspot_id));
  const activated = activation.filter((d) =>
    ["activated", "repeat_user", "healthy_account"].includes(d.activation_stage ?? ""),
  ).length;

  const postSaleFunnel = [
    { label: "Closed Won", count: deals.filter((d) => d.stage === SALES_STAGES.closedWon).length },
    { label: "Onboarded", count: activation.filter((d) => !["handoff_pending", "onboarding_scheduled"].includes(d.activation_stage ?? "")).length },
    { label: "First Case", count: companies.filter((c) => c.first_case_at).length },
    { label: "Activated", count: activated },
    { label: "Second Case", count: companies.filter((c) => c.cases_lifetime >= 2).length },
    { label: "Healthy", count: byActivation("healthy_account") },
  ];

  const { data: monthCases } = await supabaseService()
    .from("cases").select("sw_id, submitted_at")
    .gte("submitted_at", monthStart.toISOString());
  const casesThisMonth = monthCases?.length ?? 0;

  const pipelineValue = sales
    .filter(isOpenSalesDeal)
    .reduce((s, d) => s + (d.amount ?? (Number(d.properties?.sw_estimated_monthly_case_volume) || 0) * settings.defaultCasePrice), 0);

  const wonThisMonth = deals.filter(
    (d) => d.stage === SALES_STAGES.closedWon && d.closed_at && new Date(d.closed_at) >= monthStart,
  );

  const activeFirms = companies.filter((c) => c.cases_30d > 0);

  return {
    settings,
    kpis: {
      newMqls30d,
      medianSpeedToLeadHours: median(speedSamples),
      contactRate: pct(funnel[1].count, funnel[0].count),
      demoBookingRate: pct(funnel[4].count, funnel[0].count),
      demoCompletionRate: pct(
        deals.filter((d) => reachedAtLeast(d, SALES_STAGES.demoCompleted)).length,
        funnel[4].count,
      ),
      qualifiedOpen: deals.filter((d) => d.stage === SALES_STAGES.qualified).length,
      firstCaseCommitted: deals.filter((d) => d.stage === SALES_STAGES.firstCaseCommitted).length,
      newFirmsThisMonth: wonThisMonth.length,
      pipelineValue,
      revenueClosedThisMonth: wonThisMonth.reduce((s, d) => s + (d.amount ?? 0), 0),
      totalCustomerFirms: customers.length,
      activatedFirms: activated,
      repeatUsers: companies.filter((c) => c.cases_lifetime >= 2).length,
      healthyAccounts: byActivation("healthy_account"),
      atRiskAccounts: byActivation("at_risk"),
      casesThisMonth,
      estRevenueThisMonth: casesThisMonth * settings.defaultCasePrice,
      actualRevenueThisMonth: null as number | null, // no invoice source yet
      avgCasesPerActiveFirm: activeFirms.length
        ? Math.round((activeFirms.reduce((s, c) => s + c.cases_30d, 0) / activeFirms.length) * 10) / 10
        : 0,
    },
    funnel,
    postSaleFunnel,
  };
}

function pct(n: number, d: number): number | null {
  return d ? Math.round((n / d) * 100) : null;
}

// ---------------------------------------------------------------------------
export interface QueueItem {
  priority: number;
  bucket: string;
  dealId?: string;
  companyId?: string;
  title: string;
  detail: string;
  href: string;
}

export async function aeDashboard(ownerId?: string | null) {
  const { settings, deals, companies, activities } = await fetchCore();
  const now = new Date();
  const weekStart = subDays(now, 7);
  const mine = (x: { owner_id: string | null }) => !ownerId || x.owner_id === ownerId;

  const salesDeals = deals.filter((d) => mine(d));
  const openDeals = salesDeals.filter(isOpenSalesDeal);
  const weekActs = activities.filter(
    (a) => mine(a) && a.occurred_at && new Date(a.occurred_at) >= weekStart && a.kind !== "task",
  );
  const typeCount = (t: string) =>
    weekActs.filter((a) => (a.activity_type ?? a.kind) === t).length;

  const openTasks = activities.filter((a) => a.kind === "task" && !a.completed && mine(a));
  const overdueTasks = openTasks.filter((a) => a.due_at && new Date(a.due_at) < now);
  const futureTaskDealIds = new Set(
    openTasks.filter((a) => a.due_at && new Date(a.due_at) >= now).map((a) => a.deal_hubspot_id),
  );
  const lastTouch = buildLastTouchLookup(activities, now);
  const stalled = openDeals.filter((d) => {
    const last = lastTouch(d) ??
      (d.hs_created_at ? new Date(d.hs_created_at).getTime() : 0);
    return differenceInDays(now, new Date(last)) > settings.stalledDealDays;
  });
  const noFutureTask = openDeals.filter((d) => !futureTaskDealIds.has(d.hubspot_id));
  const speedSamples = salesDeals.map((d) => firstResponseHours(d, activities))
    .filter((h): h is number => h !== null && h < 24 * 14);

  // ---- today's activity vs daily targets ------------------------------------
  const tz = settings.dashboardTimezone;
  const isToday = (ts: string | null) => Boolean(ts && sameLocalDay(ts, now, tz));
  const todayActs = activities.filter((a) => mine(a) && isToday(a.occurred_at));
  const actType = (a: ActivityRow) => a.activity_type ?? a.kind;

  const completedTasksToday = activities.filter(
    (a) => mine(a) && a.kind === "task" && a.completed && isToday(a.modified_at),
  );
  // Follow-ups completed = completed today AND was due today or earlier
  // (cleared from the follow-up list, not a future task closed early).
  const followupsToday = completedTasksToday.filter(
    (a) => a.due_at && new Date(a.due_at).getTime() <= now.getTime(),
  );

  // New leads today + SLA: first meaningful touch within N hours of creation.
  const newLeadsToday = salesDeals.filter(
    (d) => d.hs_created_at && isToday(d.hs_created_at),
  );
  const slaMs = settings.slaFirstContactHours * 3600 * 1000;
  const contactedWithinSla = newLeadsToday.filter((d) => {
    const created = new Date(d.hs_created_at!).getTime();
    const touches = activities
      .filter((a) => isMeaningfulTouch(a) && a.occurred_at &&
        (a.deal_hubspot_id === d.hubspot_id ||
         (d.primary_contact_id && a.contact_hubspot_id === d.primary_contact_id)))
      .map((a) => new Date(a.occurred_at!).getTime())
      .filter((t) => t >= created);
    return touches.length > 0 && Math.min(...touches) - created <= slaMs;
  });

  const today = {
    calls: { value: todayActs.filter((a) => actType(a) === "call" || actType(a) === "voicemail").length, target: settings.dailyCallsTarget },
    emails: { value: todayActs.filter((a) => actType(a) === "email").length, target: settings.dailyEmailsTarget },
    followups: { value: followupsToday.length, target: settings.dailyFollowupsTarget },
    newLeadsSla: { value: contactedWithinSla.length, target: newLeadsToday.length || settings.dailyNewLeadsTarget, isSla: newLeadsToday.length > 0 },
    tasksCompleted: { value: completedTasksToday.length, target: settings.dailyTasksTarget },
  };

  // ---- prioritized daily action queue --------------------------------------
  const companyName = new Map(companies.map((c) => [c.hubspot_id, c.name ?? c.domain ?? ""]));
  const queue: QueueItem[] = [];
  const touched = (d: DealRow) => lastTouch(d) !== null;
  const push = (priority: number, bucket: string, d: DealRow, detail: string) =>
    queue.push({
      priority, bucket, dealId: d.hubspot_id,
      companyId: d.company_hubspot_id ?? undefined,
      title: d.name ?? companyName.get(d.company_hubspot_id ?? "") ?? d.hubspot_id,
      detail,
      // No associated company -> open the deal in HubSpot directly.
      href: d.company_hubspot_id
        ? `/firms/${d.company_hubspot_id}`
        : hubspotDealUrl(settings.hubspotPortalId, d.hubspot_id),
    });

  for (const d of openDeals) {
    const ageDays = d.hs_created_at ? differenceInDays(now, new Date(d.hs_created_at)) : 99;
    const uncontactedStage =
      d.stage === SALES_STAGES.mql || d.stage === SALES_STAGES.attemptingContact;
    if (d.stage === SALES_STAGES.mql && ageDays <= 2 && !touched(d)) {
      push(1, "New inbound leads", d, `MQL created ${ageDays}d ago - contact now`);
    } else if (uncontactedStage && !touched(d)) {
      push(2, "Awaiting first contact", d, `No outreach logged yet (${ageDays}d old)`);
    }
  }
  for (const t of overdueTasks) {
    queue.push({
      priority: 3, bucket: "Overdue follow-ups",
      dealId: t.deal_hubspot_id ?? undefined,
      companyId: t.company_hubspot_id ?? undefined,
      title: t.subject ?? "Task",
      detail: `Due ${t.due_at ? differenceInDays(now, new Date(t.due_at)) : "?"}d ago`,
      href: t.company_hubspot_id
        ? `/firms/${t.company_hubspot_id}`
        : t.deal_hubspot_id
          ? hubspotDealUrl(settings.hubspotPortalId, t.deal_hubspot_id)
          : "#",
    });
  }
  for (const d of openDeals) {
    if (d.stage === SALES_STAGES.demoScheduled && d.properties?.sw_demo_date === now.toISOString().slice(0, 10)) {
      push(4, "Demos today", d, "Demo scheduled today");
    }
    if (d.stage === SALES_STAGES.demoCompleted && !futureTaskDealIds.has(d.hubspot_id)) {
      push(5, "Post-demo follow-ups", d, "Demo done - send follow-up + next step");
    }
    if (d.stage === SALES_STAGES.qualified && !futureTaskDealIds.has(d.hubspot_id)) {
      push(6, "Qualified without future task", d, "Qualified deal has no future task");
    }
  }
  for (const d of stalled) {
    push(7, "Stalled opportunities", d,
      `No touch in ${settings.stalledDealDays}+ days`);
  }
  for (const a of activities) {
    if (a.kind === "task" && !a.completed && a.activity_type === "walk_in") {
      queue.push({
        priority: 8, bucket: "Walk-ins scheduled",
        title: a.subject ?? "Walk-in", detail: "Planned LA walk-in",
        companyId: a.company_hubspot_id ?? undefined,
        href: a.company_hubspot_id
          ? `/firms/${a.company_hubspot_id}`
          : a.deal_hubspot_id
            ? hubspotDealUrl(settings.hubspotPortalId, a.deal_hubspot_id)
            : "#",
      });
    }
  }
  queue.sort((a, b) => a.priority - b.priority);

  return {
    settings,
    today,
    metrics: {
      leadsAssigned: salesDeals.length,
      // Never contacted = MQL or Attempting Contact stage with no real touch
      // (stage moves alone don't count as contact).
      newAwaitingContact: openDeals.filter(
        (d) => (d.stage === SALES_STAGES.mql || d.stage === SALES_STAGES.attemptingContact) &&
               !touched(d),
      ).length,
      medianSpeedToLeadHours: median(speedSamples),
      calls: typeCount("call"), emails: typeCount("email"),
      voicemails: typeCount("voicemail"), linkedin: typeCount("linkedin"),
      inPersonVisits: typeCount("in_person_visit"),
      connected: weekActs.filter((a) => a.outcome === "connected").length,
      qualified: salesDeals.filter((d) => d.stage === SALES_STAGES.qualified).length,
      demosBooked: salesDeals.filter((d) => d.stage === SALES_STAGES.demoScheduled).length,
      demosCompleted: salesDeals.filter((d) => reachedAtLeast(d, SALES_STAGES.demoCompleted)).length,
      demoNoShows: weekActs.filter((a) => a.outcome === "no_show").length,
      firstCasesIdentified: salesDeals.filter((d) => d.stage === SALES_STAGES.firstCaseIdentified).length,
      firstCaseCommitments: salesDeals.filter((d) => d.stage === SALES_STAGES.firstCaseCommitted).length,
      newFirmsClosed: salesDeals.filter((d) => d.stage === SALES_STAGES.closedWon).length,
      revenueClosed: salesDeals
        .filter((d) => d.stage === SALES_STAGES.closedWon)
        .reduce((s, d) => s + (d.amount ?? 0), 0),
      overdueTasks: overdueTasks.length,
      dealsNoFutureTask: noFutureTask.length,
      stalledDeals: stalled.length,
    },
    stageCounts: countByStage(openDeals),
    queue,
  };
}

function countByStage(deals: DealRow[]) {
  const out: Record<string, number> = {};
  for (const d of deals) {
    const k = d.stage_label ?? d.stage ?? "?";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
export async function csDashboard() {
  const { settings, deals, companies } = await fetchCore();
  const now = new Date();
  const monthStart = startOfMonth(now);
  const activation = deals.filter((d) => d.activation_stage);
  const at = (s: ActivationStage) => activation.filter((d) => d.activation_stage === s);
  const companyById = new Map(companies.map((c) => [c.hubspot_id, c]));

  const withoutFirstCase = activation.filter((d) => {
    const c = d.company_hubspot_id ? companyById.get(d.company_hubspot_id) : null;
    return !c?.first_case_at &&
      !["handoff_pending", "churned_or_inactive"].includes(d.activation_stage ?? "");
  });

  const ttfcSamples: number[] = [];
  for (const d of activation) {
    const c = d.company_hubspot_id ? companyById.get(d.company_hubspot_id) : null;
    if (c?.first_case_at && d.closed_at) {
      ttfcSamples.push(differenceInDays(new Date(c.first_case_at), new Date(d.closed_at)));
    }
  }

  const customerCompanies = companies.filter((c) =>
    activation.some((d) => d.company_hubspot_id === c.hubspot_id) || c.cases_lifetime > 0,
  );
  const inactive30 = customerCompanies.filter(
    (c) => c.last_case_at && differenceInDays(now, new Date(c.last_case_at)) > 30,
  );
  const inactive45 = customerCompanies.filter(
    (c) => c.last_case_at && differenceInDays(now, new Date(c.last_case_at)) > 45,
  );

  const { data: monthCases } = await supabaseService()
    .from("cases").select("sw_id").gte("submitted_at", monthStart.toISOString());
  const casesThisMonth = monthCases?.length ?? 0;

  // ---- CS daily queue -------------------------------------------------------
  const queue: QueueItem[] = [];
  const pushDeal = (priority: number, bucket: string, d: DealRow, detail: string) =>
    queue.push({
      priority, bucket, dealId: d.hubspot_id,
      companyId: d.company_hubspot_id ?? undefined,
      title: d.name ?? d.hubspot_id, detail,
      href: d.company_hubspot_id
        ? `/firms/${d.company_hubspot_id}`
        : hubspotDealUrl(settings.hubspotPortalId, d.hubspot_id),
    });
  at("handoff_pending").forEach((d) =>
    pushDeal(1, "New handoffs", d, "Accept handoff + schedule onboarding"));
  at("onboarding_scheduled").forEach((d) =>
    pushDeal(2, "Awaiting onboarding", d, "Run kickoff / onboarding"));
  withoutFirstCase.forEach((d) =>
    pushDeal(3, "No first case yet", d, "Help identify + submit the first case"));
  at("first_case_submitted").forEach((d) =>
    pushDeal(4, "First cases in flight", d, "Support the first case to delivery"));
  at("first_case_delivered").forEach((d) =>
    pushDeal(5, "Results delivered - follow up", d, "Review results with the firm"));
  inactive30.forEach((c) =>
    queue.push({
      priority: 6, bucket: "Inactive 30+ days", companyId: c.hubspot_id,
      title: c.name ?? c.domain ?? c.hubspot_id,
      detail: `Last case ${c.last_case_at ? differenceInDays(now, new Date(c.last_case_at)) : "?"}d ago`,
      href: `/firms/${c.hubspot_id}`,
    }));
  at("at_risk").forEach((d) =>
    pushDeal(7, "At-risk accounts", d, "Create a recovery plan"));
  companies.filter((c) => (c.risk_flags ?? []).some((f) => f.includes("issue")))
    .forEach((c) => queue.push({
      priority: 8, bucket: "Open issues", companyId: c.hubspot_id,
      title: c.name ?? c.hubspot_id, detail: c.risk_flags.join("; "),
      href: `/firms/${c.hubspot_id}`,
    }));
  companies.filter((c) => c.properties?.sw_expansion_potential === "high")
    .forEach((c) => queue.push({
      priority: 9, bucket: "Expansion opportunities", companyId: c.hubspot_id,
      title: c.name ?? c.hubspot_id, detail: "High expansion potential",
      href: `/firms/${c.hubspot_id}`,
    }));
  queue.sort((a, b) => a.priority - b.priority);

  const activatedCount = activation.filter((d) =>
    ["activated", "repeat_user", "healthy_account"].includes(d.activation_stage ?? ""),
  ).length;

  return {
    settings,
    metrics: {
      newHandoffs: at("handoff_pending").length,
      awaitingAcceptance: activation.filter(
        (d) => d.activation_stage === "handoff_pending" &&
               d.properties?.sw_handoff_accepted_by_cs !== "true").length,
      onboardingScheduled: at("onboarding_scheduled").length,
      onboardingCompleted: at("onboarding_completed").length,
      firmsWithoutFirstCase: withoutFirstCase.length,
      medianTimeToFirstCaseDays: median(ttfcSamples),
      activatedFirms: activatedCount,
      activationRate: customerCompanies.length
        ? Math.round((activatedCount / Math.max(activation.length, 1)) * 100) : null,
      repeatUserRate: customerCompanies.length
        ? Math.round((customerCompanies.filter((c) => c.cases_lifetime >= 2).length /
            customerCompanies.length) * 100) : null,
      monthlyActiveFirms: customerCompanies.filter((c) => c.cases_30d > 0).length,
      totalCustomerFirms: customerCompanies.length,
      casesThisMonth,
      revenueThisMonth: casesThisMonth * settings.defaultCasePrice,
      inactive30: inactive30.length,
      inactive45: inactive45.length,
      atRisk: at("at_risk").length,
      reactivationInProgress: at("reactivation_in_progress").length,
      reactivated: activation.filter(
        (d) => d.properties?.sw_reactivation_status === "reactivated").length,
      openIssues: companies.filter((c) => (c.risk_flags ?? []).some((f) => f.includes("issue"))).length,
      expansionOpportunities: companies.filter(
        (c) => c.properties?.sw_expansion_potential === "high").length,
    },
    queue,
    activationBoard: groupActivation(activation),
  };
}

function groupActivation(deals: DealRow[]) {
  const out: Record<string, { id: string; name: string | null; companyId: string | null }[]> = {};
  for (const d of deals) {
    const k = d.activation_stage ?? "unknown";
    (out[k] ??= []).push({
      id: d.hubspot_id, name: d.name, companyId: d.company_hubspot_id,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
export async function dataQuality() {
  const { deals, companies, contacts, activities } = await fetchCore();
  const sb = supabaseService();
  const now = new Date();
  const openDeals = deals.filter(isOpenSalesDeal);
  const activation = deals.filter((d) => d.activation_stage);
  const { data: mappings } = await sb.from("firm_mapping").select("*");
  const { data: caseAccounts } = await sb.from("cases").select("sw_account_id, sw_organization_id");
  const { data: failedSyncs } = await sb.from("sync_runs")
    .select("*").eq("status", "error")
    .order("started_at", { ascending: false }).limit(10);

  const mappedCompanyIds = new Set((mappings ?? []).map((m) => m.hubspot_company_id));
  const mappedSwIds = new Set(
    (mappings ?? []).flatMap((m) => [m.sw_account_id, m.sw_organization_id].filter(Boolean)),
  );
  const swIdsWithCases = [...new Set(
    (caseAccounts ?? []).flatMap((c) => [c.sw_organization_id ?? c.sw_account_id]).filter(Boolean),
  )] as string[];

  const lastTouch = buildLastTouchLookup(activities, now);

  const dupEmails = findDuplicates(contacts.map((c) => c.email).filter(Boolean) as string[]);
  const dupDomains = findDuplicates(companies.map((c) => c.domain).filter(Boolean) as string[]);

  const checks = [
    check("Deals without owner", openDeals.filter((d) => !d.owner_id)),
    check("Deals without next step", openDeals.filter((d) => !d.properties?.sw_next_step)),
    check("Deals without next-step date", openDeals.filter((d) => !d.properties?.sw_next_step_date)),
    check("Deals without associated company", openDeals.filter((d) => !d.company_hubspot_id)),
    check("Deals missing lead source", openDeals.filter((d) => !d.properties?.sw_lead_source)),
    check("Closed-lost without reason", deals.filter(
      (d) => d.stage === "closedlost" && !d.properties?.sw_closed_lost_reason)),
    check("Closed-won without CS handoff", deals.filter(
      (d) => d.stage === "closedwon" && d.properties?.sw_handoff_completed !== "true")),
    check("Customers without accepted handoff", activation.filter(
      (d) => d.activation_stage !== "handoff_pending" &&
             d.properties?.sw_handoff_accepted_by_cs !== "true")),
    check("Customers without champion", companies.filter(
      (c) => mappedCompanyIds.has(c.hubspot_id) && !c.properties?.sw_active_champion)),
    check("Customers without internal firm ID", companies.filter(
      (c) => activation.some((d) => d.company_hubspot_id === c.hubspot_id) &&
             !mappedCompanyIds.has(c.hubspot_id))),
    {
      label: "App firms without HubSpot mapping",
      count: swIdsWithCases.filter((id) => !mappedSwIds.has(id)).length,
      items: swIdsWithCases.filter((id) => !mappedSwIds.has(id))
        .map((id) => ({ id, name: `SW firm ${id}` })),
    },
    check("Overdue tasks", activities.filter(
      (a) => a.kind === "task" && !a.completed && a.due_at && new Date(a.due_at) < now)
      .map((a) => ({ hubspot_id: a.hubspot_id, name: a.subject }))),
    check("Open deals with no activity 14+ days", openDeals.filter((d) => {
      const last = lastTouch(d) ??
        (d.hs_created_at ? new Date(d.hs_created_at).getTime() : 0);
      return differenceInDays(now, new Date(last)) > 14;
    })),
    {
      label: "Possible duplicate contacts (same email)",
      count: dupEmails.length,
      items: dupEmails.map((e) => ({ id: e, name: e })),
    },
    {
      label: "Possible duplicate companies (same domain)",
      count: dupDomains.length,
      items: dupDomains.map((d) => ({ id: d, name: d })),
    },
    {
      label: "Failed syncs (last 10)",
      count: failedSyncs?.length ?? 0,
      items: (failedSyncs ?? []).map((s) => ({
        id: String(s.id), name: `${s.kind}: ${s.error?.slice(0, 120)}`,
      })),
    },
  ];
  return { checks };
}

function check(
  label: string,
  rows: { hubspot_id: string; name?: string | null }[],
) {
  return {
    label,
    count: rows.length,
    items: rows.slice(0, 50).map((r) => ({ id: r.hubspot_id, name: r.name ?? r.hubspot_id })),
  };
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const v of values.map((x) => x.toLowerCase())) {
    if (seen.has(v)) dups.add(v);
    seen.add(v);
  }
  return [...dups];
}
