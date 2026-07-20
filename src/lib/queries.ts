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
  // CS model (0002)
  firm_segment: string | null;
  monthly_case_target: number | null;
  account_health: string | null;
  first_case_commitment_date: string | null;
  first_case_completed_date: string | null;
  second_case_submitted_date: string | null;
  cases_this_month: number;
  cases_last_45d: number;
  target_attainment_percent: number | null;
  open_issue_count: number;
  next_cs_action: string | null;
  next_cs_action_due_date: string | null;
  signed_up_at: string | null;
  subscribed_at: string | null;
  signup_account_id: string | null;
  // Subscription billing (0005)
  billing_type: string | null;              // transactional | subscription
  subscription_monthly_amount: number | null;
}

/** A firm's active monthly recurring revenue, or 0 if transactional. */
export function firmMrr(c: { billing_type?: string | null; subscription_monthly_amount?: number | null }): number {
  return c.billing_type === "subscription" ? Number(c.subscription_monthly_amount) || 0 : 0;
}

/** Monthly revenue split: subscription firms bill their flat MRR (their per-case
 * cases are ignored); everyone else bills per case. `monthCases` must carry
 * company_hubspot_id + revenue_amount for cases submitted this month. */
export function monthlyRevenue(
  companies: { hubspot_id: string; billing_type?: string | null; subscription_monthly_amount?: number | null }[],
  monthCases: { company_hubspot_id: string | null; revenue_amount: number | null }[],
  price: number,
): { mrr: number; transactional: number; total: number; subscriptionFirms: number } {
  const subIds = new Set<string>();
  let mrr = 0;
  for (const c of companies) {
    const amt = firmMrr(c);
    if (amt > 0) { subIds.add(c.hubspot_id); mrr += amt; }
  }
  let transactional = 0;
  for (const mc of monthCases) {
    if (mc.company_hubspot_id && subIds.has(mc.company_hubspot_id)) continue;
    transactional += Number(mc.revenue_amount) || price;
  }
  return { mrr, transactional, total: mrr + transactional, subscriptionFirms: subIds.size };
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
  /** For tasks: real completion timestamp when HubSpot provides it. */
  completed_at: string | null;
  /** For tasks: hs_lastmodifieddate, completion-time fallback. */
  modified_at: string | null;
}

/** Best available completion time for a completed task. */
export function taskCompletedAt(a: ActivityRow): string | null {
  if (!a.completed) return null;
  return a.completed_at ?? a.modified_at;
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
      "completed_at:properties->>hs_task_completion_date, " +
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

export interface TouchMaps {
  byDeal: Map<string, number>;
  byContact: Map<string, number>;
  byCompany: Map<string, number>;
}

/** Last meaningful-touch time per deal/contact/company (epoch ms). */
export function buildTouchMaps(activities: ActivityRow[], now: Date): TouchMaps {
  const byDeal = new Map<string, number>();
  const byContact = new Map<string, number>();
  const byCompany = new Map<string, number>();
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
    if (a.company_hubspot_id) {
      byCompany.set(a.company_hubspot_id,
        Math.max(byCompany.get(a.company_hubspot_id) ?? 0, t));
    }
  }
  return { byDeal, byContact, byCompany };
}

/** Last meaningful-touch lookup for deals: checks activity on the deal itself
 * AND on the deal's primary contact (Gmail-logged emails often associate with
 * the contact only). Returns epoch ms or null if never touched. */
export function buildLastTouchLookup(
  activities: ActivityRow[],
  now: Date,
  maps?: TouchMaps,
): (d: DealRow) => number | null {
  const { byDeal, byContact } = maps ?? buildTouchMaps(activities, now);
  return (d: DealRow) => {
    const dealT = byDeal.get(d.hubspot_id);
    const contactT = d.primary_contact_id ? byContact.get(d.primary_contact_id) : undefined;
    const best = Math.max(dealT ?? 0, contactT ?? 0);
    return best > 0 ? best : null;
  };
}

/** A task is "superseded" when its lead received a real touch (call/email/
 * meeting/logged activity) AFTER the task came due - the follow-up happened,
 * it just wasn't checked off. Superseded tasks are not flagged as overdue. */
export function isTaskSuperseded(a: ActivityRow, maps: TouchMaps): boolean {
  if (!a.due_at) return false;
  const due = new Date(a.due_at).getTime();
  const touched = Math.max(
    a.deal_hubspot_id ? (maps.byDeal.get(a.deal_hubspot_id) ?? 0) : 0,
    a.contact_hubspot_id ? (maps.byContact.get(a.contact_hubspot_id) ?? 0) : 0,
    a.company_hubspot_id ? (maps.byCompany.get(a.company_hubspot_id) ?? 0) : 0,
  );
  return touched > due;
}

/** Grace window: a deal touched within the last N days is being worked and is
 * not flagged as "no future task" even if none is scheduled yet. */
export const FOLLOWUP_GRACE_DAYS = 3;

/** A deal with a demo booked today or later is fully covered - the demo IS the
 * follow-up plan, no interim touch or task needed. */
export function hasFutureDemo(d: DealRow, now: Date): boolean {
  const demo = d.properties?.sw_demo_date;
  if (!demo) return false;
  return demo.slice(0, 10) >= now.toISOString().slice(0, 10);
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
    .from("cases").select("sw_id, submitted_at, company_hubspot_id, revenue_amount")
    .gte("submitted_at", monthStart.toISOString());
  const casesThisMonth = monthCases?.length ?? 0;
  const monthRevenue = monthlyRevenue(
    companies,
    (monthCases ?? []) as { company_hubspot_id: string | null; revenue_amount: number | null }[],
    settings.defaultCasePrice,
  );

  const pipelineValue = sales
    .filter(isOpenSalesDeal)
    .reduce((s, d) => s + (d.amount ?? (Number(d.properties?.sw_estimated_monthly_case_volume) || 0) * settings.defaultCasePrice), 0);

  const wonThisMonth = deals.filter(
    (d) => d.stage === SALES_STAGES.closedWon && d.closed_at && new Date(d.closed_at) >= monthStart,
  );

  const activeFirms = companies.filter((c) => c.cases_30d > 0);
  const newCustomersThisMonth = companies.filter(
    (c) => c.first_case_at && new Date(c.first_case_at) >= monthStart,
  ).length;

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
      newCustomersThisMonth,
      pipelineValue,
      revenueClosedThisMonth: wonThisMonth.reduce((s, d) => s + (d.amount ?? 0), 0),
      totalCustomerFirms: customers.length,
      activatedFirms: activated,
      repeatUsers: companies.filter((c) => c.cases_lifetime >= 2).length,
      healthyAccounts: byActivation("healthy_account"),
      atRiskAccounts: byActivation("at_risk"),
      casesThisMonth,
      estRevenueThisMonth: monthRevenue.total,
      mrr: monthRevenue.mrr,
      transactionalRevenueThisMonth: monthRevenue.transactional,
      subscriptionFirms: monthRevenue.subscriptionFirms,
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
  const touchMaps = buildTouchMaps(activities, now);
  const lastTouch = buildLastTouchLookup(activities, now, touchMaps);
  // Deals (and their companies) with a demo booked today or later.
  const futureDemoDealIds = new Set(
    deals.filter((d) => hasFutureDemo(d, now)).map((d) => d.hubspot_id),
  );
  const futureDemoCompanyIds = new Set(
    deals.filter((d) => hasFutureDemo(d, now) && d.company_hubspot_id)
      .map((d) => d.company_hubspot_id as string),
  );
  // Overdue = past due AND the lead was NOT touched after the due date
  // (a later call/email supersedes the un-checked task) AND there's no
  // upcoming demo (a booked demo makes interim follow-up unnecessary).
  const overdueTasks = openTasks.filter(
    (a) => a.due_at && new Date(a.due_at) < now &&
           !isTaskSuperseded(a, touchMaps) &&
           !(a.deal_hubspot_id && futureDemoDealIds.has(a.deal_hubspot_id)) &&
           !(a.company_hubspot_id && futureDemoCompanyIds.has(a.company_hubspot_id)),
  );
  const futureTaskDealIds = new Set(
    openTasks.filter((a) => a.due_at && new Date(a.due_at) >= now).map((a) => a.deal_hubspot_id),
  );
  // "Covered" = scheduled future task OR touched within the grace window OR a
  // demo booked today/later (the demo IS the plan).
  const recentlyTouched = (d: DealRow) => {
    const t = lastTouch(d);
    return t !== null && differenceInDays(now, new Date(t)) <= FOLLOWUP_GRACE_DAYS;
  };
  const covered = (d: DealRow) =>
    futureTaskDealIds.has(d.hubspot_id) || recentlyTouched(d) || hasFutureDemo(d, now);
  const stalled = openDeals.filter((d) => {
    const last = lastTouch(d) ??
      (d.hs_created_at ? new Date(d.hs_created_at).getTime() : 0);
    return differenceInDays(now, new Date(last)) > settings.stalledDealDays;
  });
  const noFutureTask = openDeals.filter((d) => !covered(d));
  const speedSamples = salesDeals.map((d) => firstResponseHours(d, activities))
    .filter((h): h is number => h !== null && h < 24 * 14);

  // ---- today's activity vs daily targets ------------------------------------
  const tz = settings.dashboardTimezone;
  const isToday = (ts: string | null) => Boolean(ts && sameLocalDay(ts, now, tz));
  const todayActs = activities.filter((a) => mine(a) && isToday(a.occurred_at));
  const actType = (a: ActivityRow) => a.activity_type ?? a.kind;

  const completedTasksToday = activities.filter(
    (a) => mine(a) && a.kind === "task" && a.completed && isToday(taskCompletedAt(a)),
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
    if (d.stage === SALES_STAGES.demoCompleted && !covered(d)) {
      push(5, "Post-demo follow-ups", d, "Demo done - send follow-up + next step");
    }
    if (d.stage === SALES_STAGES.qualified && !covered(d)) {
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

// ---------------------------------------------------------------------------
// 7-day activity + funnel report (drill target from the Today cards).
// ---------------------------------------------------------------------------
const STAGE_RANK: Record<string, number> = {
  [SALES_STAGES.mql]: 1,
  [SALES_STAGES.attemptingContact]: 2,
  [SALES_STAGES.connected]: 3,
  [SALES_STAGES.qualified]: 4,
  [SALES_STAGES.demoScheduled]: 5,
  [SALES_STAGES.demoCompleted]: 6,
  [SALES_STAGES.firstCaseIdentified]: 7,
  [SALES_STAGES.firstCaseCommitted]: 8,
  [SALES_STAGES.closedWon]: 9,
  [SALES_STAGES.closedLost]: 1, // was a lead; no reliable progress history
  [SALES_STAGES.nurture]: 1,
};

export interface FunnelStep {
  label: string;
  count: number;
  convFromPrev: number | null; // % of previous step
  convFromTop: number | null; // % of leads
}

export async function activityReport(ownerId?: string | null) {
  const { settings, deals, companies, activities } = await fetchCore();
  const now = new Date();
  const tz = settings.dashboardTimezone;
  const weekAgo = subDays(now, 7);
  const weekAgoMs = weekAgo.getTime();
  const nowMs = now.getTime();
  const mine = <T extends { owner_id: string | null }>(x: T) =>
    !ownerId || x.owner_id === ownerId;

  const acts7 = activities.filter(
    (a) => mine(a) && a.kind !== "task" && a.occurred_at &&
           new Date(a.occurred_at) >= weekAgo && new Date(a.occurred_at).getTime() <= nowMs,
  );
  const t = (a: ActivityRow) => a.activity_type ?? a.kind;

  const activityTotals = {
    touches: acts7.length,
    calls: acts7.filter((a) => t(a) === "call").length,
    emails: acts7.filter((a) => t(a) === "email").length,
    voicemails: acts7.filter((a) => t(a) === "voicemail").length,
    linkedin: acts7.filter((a) => t(a) === "linkedin").length,
    meetings: acts7.filter((a) => a.kind === "meeting").length,
    inPersonVisits: acts7.filter((a) => t(a) === "in_person_visit").length,
    connected: acts7.filter((a) => a.outcome === "connected").length,
  };

  // Daily breakdown (last 7 LA days).
  const daily: { day: string; calls: number; emails: number; other: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowMs - i * 86400000);
    const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
    const md = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric", day: "numeric" }).format(d);
    daily.push({ day: `${label} ${md}`, calls: 0, emails: 0, other: 0 });
  }
  const dayIndex = new Map(daily.map((b, i) => [b.day, i]));
  for (const a of acts7) {
    const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(a.occurred_at!));
    const md = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric", day: "numeric" }).format(new Date(a.occurred_at!));
    const idx = dayIndex.get(`${label} ${md}`);
    if (idx === undefined) continue;
    if (t(a) === "call" || t(a) === "voicemail") daily[idx].calls += 1;
    else if (t(a) === "email") daily[idx].emails += 1;
    else daily[idx].other += 1;
  }

  // Funnel cohort = deals created in the last 7 days (this week's new business).
  const cohort = deals.filter(
    (d) => mine(d) && d.hs_created_at && new Date(d.hs_created_at) >= weekAgo,
  );
  const rank = (d: DealRow) => STAGE_RANK[d.stage ?? ""] ?? 0;
  const reached = (r: number) => cohort.filter((d) => rank(d) >= r).length;

  // Funnel is stage-progression based end-to-end (each step = deals that
  // REACHED at least that stage), so it is monotonically non-increasing.
  // Mixing a touch-based "Contacted" with stage-based steps previously made the
  // funnel non-monotonic (e.g. Contacted < Connected -> >100% conversion).
  const steps: { label: string; count: number }[] = [
    { label: "Leads", count: cohort.length },
    { label: "Contacted", count: reached(2) },
    { label: "Connected", count: reached(3) },
    { label: "Qualified", count: reached(4) },
    { label: "Demo Scheduled", count: reached(5) },
    { label: "Demo Completed", count: reached(6) },
    { label: "First Case Identified", count: reached(7) },
    { label: "First Case Committed", count: reached(8) },
    { label: "Closed Won", count: cohort.filter((d) => d.stage === SALES_STAGES.closedWon).length },
  ];
  const top = steps[0].count || 1;
  const funnel: FunnelStep[] = steps.map((s, i) => ({
    label: s.label,
    count: s.count,
    convFromPrev: i === 0 ? null
      : steps[i - 1].count ? Math.round((s.count / steps[i - 1].count) * 100) : null,
    convFromTop: i === 0 ? null : Math.round((s.count / top) * 100),
  }));

  // ---- real results this week (firm/case-level, team-wide) ------------------
  // Revenue = cases submitted in the window x their price ($250/case) - NOT deal
  // "amount" (rarely set). New customers = firms whose FIRST case landed this
  // week (they started generating revenue). These are firm-level, so they are
  // team-wide regardless of the AE activity scope above.
  const inWeek = (iso: string | null) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= weekAgoMs && t <= nowMs;
  };
  const { data: caseRows } = await supabaseService()
    .from("cases").select("company_hubspot_id, submitted_date, revenue_amount");
  const casesThisWeek = (caseRows ?? []).filter((c) => inWeek(c.submitted_date));
  const revenue = casesThisWeek.reduce(
    (s, c) => s + (Number(c.revenue_amount) || settings.defaultCasePrice), 0);
  const newCustomers = companies.filter((c) => inWeek(c.first_case_at)).length;
  // Deals actually signed (closed-won) this week, by close date.
  const dealsWon = deals.filter(
    (d) => d.stage === SALES_STAGES.closedWon && inWeek(d.closed_at)).length;

  return {
    settings, activityTotals, daily, funnel, cohortSize: cohort.length,
    revenue, casesThisWeek: casesThisWeek.length, newCustomers, dealsWon,
  };
}

// ---------------------------------------------------------------------------
// Retention: activation->2nd->3rd->30/60/90-day funnel, first-case cohorts,
// and usage-frequency metrics. All firm/case-level and team-wide.
// ---------------------------------------------------------------------------
export interface CohortRow {
  key: string;            // "2026-04"
  label: string;          // "April 2026"
  firms: number;
  retention: (number | null)[]; // Month 0..N (% retained), null if not elapsed
}

export interface RetentionReport {
  funnel: FunnelStep[];
  cohorts: CohortRow[];
  monthCols: number;
  monthlyCases: { month: string; count: number }[];
  frequency: {
    activatedFirms: number;
    totalCases: number;
    casesPerActivatedFirm: number;
    activeFirms30d: number;
    casesPerActiveFirm: number;
    medianCasesPerActiveFirm: number;
    top3ConcentrationPct: number | null;
    zeroCasesThisMonth: number;
    oneCaseOnly: number;
    twoPlusCases: number;
    threePlusCases: number;
    activeTwoPlusConsecutiveMonths: number;
  };
}

const DAY_MS = 86400000;

export async function retentionReport(): Promise<RetentionReport> {
  const sb = supabaseService();
  const now = new Date();
  const nowMs = now.getTime();
  const monthIdx = (t: number) => {
    const d = new Date(t);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();

  const { data: caseRows } = await sb.from("cases")
    .select("company_hubspot_id, submitted_date")
    .not("company_hubspot_id", "is", null);

  // firm -> ascending submitted timestamps
  const byFirm = new Map<string, number[]>();
  for (const c of caseRows ?? []) {
    if (!c.submitted_date) continue;
    const t = new Date(c.submitted_date).getTime();
    if (Number.isNaN(t)) continue;
    byFirm.set(c.company_hubspot_id!, [...(byFirm.get(c.company_hubspot_id!) ?? []), t]);
  }
  const firms = [...byFirm.values()].map((a) => a.sort((x, y) => x - y));
  const activated = firms.length;

  // monthly case volume (all cases with a date), ascending
  const monthCount = new Map<string, number>();
  for (const c of caseRows ?? []) {
    if (!c.submitted_date) continue;
    const d = new Date(c.submitted_date);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    monthCount.set(key, (monthCount.get(key) ?? 0) + 1);
  }
  const monthlyCases = [...monthCount.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, count]) => ({
      month: new Date(`${k}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
      count,
    }));

  const has2 = firms.filter((f) => f.length >= 2).length;
  const has3 = firms.filter((f) => f.length >= 3).length;
  // windowed retention: an ADDITIONAL case in days [lo,hi) after the first case
  const win = (lo: number, hi: number) =>
    firms.filter((f) => f.some((t, i) => i > 0 && t - f[0] >= lo * DAY_MS && t - f[0] < hi * DAY_MS)).length;
  const ret30 = win(0, 30), ret60 = win(30, 60), ret90 = win(60, 90);

  const step = (label: string, count: number, prev: number | null): FunnelStep => ({
    label, count,
    convFromPrev: prev === null ? null : prev ? Math.round((count / prev) * 100) : null,
    convFromTop: activated ? Math.round((count / activated) * 100) : null,
  });
  const funnel: FunnelStep[] = [
    step("Submitted 1st case", activated, null),
    step("Submitted 2nd case", has2, activated),
    step("Submitted 3rd case", has3, has2),
    step("Active in 30-day window", ret30, activated),
    step("Active in 60-day window", ret60, ret30),
    step("Active in 90-day window", ret90, ret60),
  ];

  // ---- first-case cohorts (calendar month) ----
  const cohortMap = new Map<string, { first: number; active: Set<number> }[]>();
  for (const f of firms) {
    const d = new Date(f[0]);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const entry = { first: monthIdx(f[0]), active: new Set(f.map(monthIdx)) };
    cohortMap.set(key, [...(cohortMap.get(key) ?? []), entry]);
  }
  const monthCols = 4; // Month 0..3
  const cohorts: CohortRow[] = [...cohortMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => {
    const retention: (number | null)[] = [];
    for (let m = 0; m < monthCols; m++) {
      const target = list[0].first + m;
      if (target > nowIdx) { retention.push(null); continue; } // month not reached yet
      const cnt = list.filter((x) => x.active.has(x.first + m)).length;
      retention.push(Math.round((cnt / list.length) * 100));
    }
    const label = new Date(`${key}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    return { key, label, firms: list.length, retention };
  });

  // ---- usage-frequency metrics ----
  const totalCases = firms.reduce((s, f) => s + f.length, 0);
  const active30 = firms.filter((f) => f.some((t) => nowMs - t <= 30 * DAY_MS));
  const perActive = active30.map((f) => f.filter((t) => nowMs - t <= 30 * DAY_MS).length);
  const casesLast30 = perActive.reduce((s, n) => s + n, 0);
  const lifetimeDesc = firms.map((f) => f.length).sort((a, b) => b - a);
  const top3 = lifetimeDesc.slice(0, 3).reduce((a, b) => a + b, 0);
  const consecutive = firms.filter((f) => {
    const idxs = [...new Set(f.map(monthIdx))].sort((a, b) => a - b);
    return idxs.some((v, i) => i > 0 && v - idxs[i - 1] === 1);
  }).length;
  const round1 = (n: number) => Math.round(n * 10) / 10;

  return {
    funnel, cohorts, monthCols, monthlyCases,
    frequency: {
      activatedFirms: activated,
      totalCases,
      casesPerActivatedFirm: activated ? round1(totalCases / activated) : 0,
      activeFirms30d: active30.length,
      casesPerActiveFirm: active30.length ? round1(casesLast30 / active30.length) : 0,
      medianCasesPerActiveFirm: median(perActive) ?? 0,
      top3ConcentrationPct: totalCases ? Math.round((top3 / totalCases) * 100) : null,
      zeroCasesThisMonth: firms.filter((f) => !f.some((t) => monthIdx(t) === nowIdx)).length,
      oneCaseOnly: firms.filter((f) => f.length === 1).length,
      twoPlusCases: has2,
      threePlusCases: has3,
      activeTwoPlusConsecutiveMonths: consecutive,
    },
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
export interface CsCaseRow {
  case_id: string;
  company_hubspot_id: string | null;
  case_status: string | null;
  submitted_date: string | null;
  delivered_date: string | null;
  revenue_amount: number | null;
  expert_review_offered: boolean;
  expert_review_booked: boolean;
  expert_review_completed: boolean;
  case_name: string | null;
  issue_flag: boolean;
}

export interface CsBoardRow {
  companyId: string;
  firm: string;
  segment: string | null;
  monthlyTarget: number | null;
  casesThisMonth: number;
  cases30d: number;
  attainment: number | null;
  lastCaseDate: string | null;
  daysSinceLastCase: number | null;
  health: string | null;
  openIssues: number;
  expertReviewMissing: boolean;
  nextAction: string | null;
  nextActionDue: string | null;
}

export type CsSegment = "all" | "small" | "mid_size" | "large" | "strategic";

export async function csDashboard(segment: CsSegment = "all") {
  const { settings, deals, companies } = await fetchCore();
  const sb = supabaseService();
  const now = new Date();
  const monthStart = startOfMonth(now);

  const [{ data: cases }, { data: handoffs }] = await Promise.all([
    sb.from("cases").select(
      "case_id, company_hubspot_id, case_status, submitted_date, delivered_date, " +
      "revenue_amount, expert_review_offered, expert_review_booked, " +
      "expert_review_completed, case_name, issue_flag",
    ).then((r) => ({ data: (r.data ?? []) as unknown as CsCaseRow[] })),
    sb.from("handoffs").select("*"),
  ]);

  // customer universe = firms with cases OR a signup OR a closed-won/activation deal
  const customerIds = new Set<string>();
  for (const c of cases ?? []) if (c.company_hubspot_id) customerIds.add(c.company_hubspot_id);
  for (const c of companies) if (c.signed_up_at) customerIds.add(c.hubspot_id);
  for (const d of deals) {
    if ((d.stage === SALES_STAGES.closedWon || d.activation_stage) && d.company_hubspot_id) {
      customerIds.add(d.company_hubspot_id);
    }
  }
  let customers = companies.filter((c) => customerIds.has(c.hubspot_id));
  // Firms without an explicit segment default to "small" (their effective rule
  // set), so a "Small" filter must include them - otherwise unsegmented firms
  // vanish under every segment tab.
  if (segment !== "all") customers = customers.filter((c) => (c.firm_segment ?? "small") === segment);
  const custIds = new Set(customers.map((c) => c.hubspot_id));

  const casesForCust = (cases ?? []).filter((c) => c.company_hubspot_id && custIds.has(c.company_hubspot_id));
  const casesByCompany = new Map<string, CsCaseRow[]>();
  for (const c of casesForCust) {
    casesByCompany.set(c.company_hubspot_id!, [...(casesByCompany.get(c.company_hubspot_id!) ?? []), c]);
  }
  const expertMissingByCompany = new Map<string, boolean>();
  for (const [cid, list] of casesByCompany) {
    expertMissingByCompany.set(cid, list.some((c) => c.case_status === "delivered" && !c.expert_review_offered));
  }

  const daysSince = (iso: string | null) => iso ? differenceInDays(now, new Date(iso)) : null;
  const health = (h: string) => customers.filter((c) => c.account_health === h);

  // ---- KPI metrics ----
  const monthCases = casesForCust.filter((c) => c.submitted_date && new Date(c.submitted_date) >= monthStart);
  const activatedFirms = customers.filter((c) => c.first_case_completed_date);
  const secondCaseConv = activatedFirms.length
    ? Math.round((activatedFirms.filter((c) => c.second_case_submitted_date).length / activatedFirms.length) * 100)
    : null;
  const ttfc: number[] = [];
  for (const c of customers) {
    if (c.first_case_at && c.first_case_commitment_date) {
      ttfc.push(differenceInDays(new Date(c.first_case_at), new Date(c.first_case_commitment_date)));
    }
  }
  const attainmentVals = customers.map((c) => c.target_attainment_percent).filter((v): v is number => v != null);

  // Signed up (app account) but no case submitted yet - activation cohort.
  const signedUpNoCase = customers.filter(
    (c) => c.signed_up_at && !c.first_case_at,
  );
  // Submitted a case (via intake/manual) but never signed up in-app - the
  // mirror cohort; nudge them to create an account.
  const caseNoSignup = customers.filter(
    (c) => c.first_case_at && !c.signed_up_at,
  );

  const metrics = {
    activatedFirms: activatedFirms.length,
    signedUpNoCase: signedUpNoCase.length,
    caseNoSignup: caseNoSignup.length,
    subscribedFirms: customers.filter((c) => c.subscribed_at).length,
    healthyFirms: health("healthy").length,
    activeBelowTarget: health("active_below_target").length,
    atRiskFirms: health("at_risk").length,
    churnedFirms: health("churned").length,
    reactivationInProgress: deals.filter((d) => d.activation_stage === "reactivation_in_progress").length,
    casesThisMonth: monthCases.length,
    revenueThisMonth: monthlyRevenue(customers, monthCases, settings.defaultCasePrice).total,
    mrr: monthlyRevenue(customers, monthCases, settings.defaultCasePrice).mrr,
    expertReviewsOffered: casesForCust.filter((c) => c.expert_review_offered).length,
    expertReviewsBooked: casesForCust.filter((c) => c.expert_review_booked).length,
    expertReviewsCompleted: casesForCust.filter((c) => c.expert_review_completed).length,
    secondCaseConversionRate: secondCaseConv,
    avgDaysToFirstCase: ttfc.length ? Math.round(ttfc.reduce((a, b) => a + b, 0) / ttfc.length) : null,
    targetAttainmentAvg: attainmentVals.length
      ? Math.round(attainmentVals.reduce((a, b) => a + b, 0) / attainmentVals.length) : null,
    totalCustomers: customers.length,
    monthlyActiveFirms: customers.filter((c) => c.cases_30d > 0).length,
  };

  // ---- Account Health Board ----
  const board: CsBoardRow[] = customers.map((c) => ({
    companyId: c.hubspot_id,
    firm: c.name ?? c.domain ?? c.hubspot_id,
    segment: c.firm_segment ?? null,
    monthlyTarget: c.monthly_case_target ?? null,
    casesThisMonth: c.cases_this_month ?? 0,
    cases30d: c.cases_30d ?? 0,
    attainment: c.target_attainment_percent ?? null,
    lastCaseDate: c.last_case_at ?? null,
    daysSinceLastCase: daysSince(c.last_case_at ?? null),
    health: c.account_health ?? null,
    openIssues: c.open_issue_count ?? 0,
    expertReviewMissing: expertMissingByCompany.get(c.hubspot_id) ?? false,
    nextAction: c.next_cs_action,
    nextActionDue: c.next_cs_action_due_date,
  })).sort((a, b) => healthRank(a.health) - healthRank(b.health));

  // ---- Today's CS Priorities (10-step) ----
  const queue: QueueItem[] = [];
  const pushCo = (priority: number, bucket: string, c: { hubspot_id: string; name: string | null; domain: string | null }, detail: string) =>
    queue.push({
      priority, bucket, companyId: c.hubspot_id,
      title: c.name ?? c.domain ?? c.hubspot_id, detail,
      href: `/firms/${c.hubspot_id}`,
    });
  const byId = new Map(customers.map((c) => [c.hubspot_id, c]));
  // Name resolution across ALL firms + deals (handoffs may reference a firm
  // outside the current customer/segment set - never show a raw HubSpot id).
  const firmNameById = new Map(companies.map((c) => [c.hubspot_id, c.name ?? c.domain ?? null]));
  const dealNameById = new Map(deals.map((d) => [d.hubspot_id, d.name ?? null]));
  const handoffTitle = (h: { company_hubspot_id: string | null; deal_hubspot_id: string | null }) =>
    (h.company_hubspot_id && firmNameById.get(h.company_hubspot_id)) ||
    (h.deal_hubspot_id && dealNameById.get(h.deal_hubspot_id)) ||
    h.company_hubspot_id || h.deal_hubspot_id || "Unknown firm";

  // 1. open customer issues
  for (const c of customers) if ((c.open_issue_count ?? 0) > 0) pushCo(1, "Open customer issues", c, `${c.open_issue_count} open issue(s)`);
  // 2. new handoffs not accepted (+SLA overdue)
  for (const h of handoffs ?? []) {
    if (h.handoff_status !== "pending") continue;
    const co = h.company_hubspot_id ? byId.get(h.company_hubspot_id) : null;
    if (segment !== "all" && !co) continue;
    const hrs = h.handoff_created_date ? Math.round((now.getTime() - new Date(h.handoff_created_date).getTime()) / 3600000) : 0;
    queue.push({
      priority: 2, bucket: "New handoffs to accept", companyId: h.company_hubspot_id ?? undefined,
      title: handoffTitle(h),
      detail: hrs > 24 ? `SLA overdue (${hrs}h, target 24h)` : `Pending ${hrs}h`,
      href: h.company_hubspot_id ? `/firms/${h.company_hubspot_id}` : "#",
    });
  }
  // 3/4. commitment with no submitted case after 7/14 days
  for (const c of customers) {
    const cd = daysSince(c.first_case_commitment_date);
    if (c.first_case_commitment_date && !c.first_case_at && cd !== null) {
      if (cd > 14) pushCo(4, "No first case after 14 days", c, `Committed ${cd}d ago, no case`);
      else if (cd > 7) pushCo(3, "No first case after 7 days", c, `Committed ${cd}d ago, no case`);
    }
  }
  // 3. signed up (app account) but no case + no sales commitment - activate them
  for (const c of customers) {
    if (!c.signed_up_at || c.first_case_at || c.first_case_commitment_date) continue;
    const sd = daysSince(c.signed_up_at);
    pushCo(3, "Signed up, no case yet",
      c, `Signed up ${sd ?? "?"}d ago${c.subscribed_at ? " · subscribed" : ""} - drive first case`);
  }
  // 3. submitted a case via intake but never signed up - invite to the app
  for (const c of customers) {
    if (!c.first_case_at || c.signed_up_at) continue;
    pushCo(3, "Case submitted, no signup",
      c, `${c.cases_lifetime} case(s) via intake, no app account - invite to sign up`);
  }
  // 5. delivered cases with expert review not offered
  for (const c of casesForCust) {
    if (c.case_status === "delivered" && !c.expert_review_offered) {
      const co = c.company_hubspot_id ? byId.get(c.company_hubspot_id) : null;
      queue.push({
        priority: 5, bucket: "Offer expert review", companyId: c.company_hubspot_id ?? undefined,
        title: co?.name ?? c.case_name ?? c.case_id, detail: `Delivered case "${c.case_name ?? c.case_id}" - offer 15-min review`,
        href: c.company_hubspot_id ? `/firms/${c.company_hubspot_id}` : "#",
      });
    }
  }
  // 6. expert review offered but not booked
  for (const c of casesForCust) {
    if (c.expert_review_offered && !c.expert_review_booked) {
      const co = c.company_hubspot_id ? byId.get(c.company_hubspot_id) : null;
      queue.push({
        priority: 6, bucket: "Expert review offered, not booked", companyId: c.company_hubspot_id ?? undefined,
        title: co?.name ?? c.case_name ?? c.case_id, detail: "Follow up to book the review",
        href: c.company_hubspot_id ? `/firms/${c.company_hubspot_id}` : "#",
      });
    }
  }
  // 7. first case completed but no second case after 30 days
  for (const c of customers) {
    const fc = daysSince(c.first_case_completed_date);
    if (c.first_case_completed_date && !c.second_case_submitted_date && fc !== null && fc > 30) {
      pushCo(7, "No second case (30d+)", c, `First case completed ${fc}d ago`);
    }
  }
  // 8. at-risk
  for (const c of health("at_risk")) pushCo(8, "At-risk accounts", c, (c.risk_flags ?? []).join("; ") || "At risk");
  // 9. inactive 30+ days
  for (const c of customers) {
    const d = daysSince(c.last_case_at);
    if (d !== null && d > 30 && c.account_health !== "churned") pushCo(9, "Inactive 30+ days", c, `Last case ${d}d ago`);
  }
  // 10. churned for reactivation
  for (const c of health("churned")) pushCo(10, "Churned - reactivate", c, `Last case ${daysSince(c.last_case_at) ?? "?"}d ago`);
  queue.sort((a, b) => a.priority - b.priority);

  return { settings, segment, metrics, board, queue };
}

function healthRank(h: string | null): number {
  const order = ["at_risk", "churned", "active_below_target", "awaiting_first_case",
                 "new_handoff", "activated", "healthy"];
  const i = order.indexOf(h ?? "");
  return i === -1 ? 99 : i;
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

  const dqTouchMaps = buildTouchMaps(activities, now);
  const lastTouch = buildLastTouchLookup(activities, now, dqTouchMaps);

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
    check("Overdue tasks (no touch since due, no upcoming demo)", activities.filter(
      (a) => {
        if (a.kind !== "task" || a.completed || !a.due_at) return false;
        if (new Date(a.due_at) >= now || isTaskSuperseded(a, dqTouchMaps)) return false;
        const demoDeal = deals.find((d) => d.hubspot_id === a.deal_hubspot_id);
        return !(demoDeal && hasFutureDemo(demoDeal, now));
      })
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
