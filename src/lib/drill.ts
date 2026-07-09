/** Drill-down lists behind the dashboard stat tiles. Each metric returns the
 * underlying records with links to the related firm/deal. */
import { differenceInDays, subDays } from "date-fns";
import { SALES_STAGES } from "@/lib/hubspot/stages";
import {
  FOLLOWUP_GRACE_DAYS, buildLastTouchLookup, buildTouchMaps, fetchCore,
  hasFutureDemo, isOpenSalesDeal, isTaskSuperseded,
  type ActivityRow, type CompanyRow, type DealRow,
} from "@/lib/queries";

export interface DrillRow {
  title: string;
  subtitle?: string;
  companyId?: string | null;
  dealId?: string | null;
  when?: string | null;
  nextStep?: string | null;
  nextStepDate?: string | null;
}

export interface DrillResult {
  label: string;
  rows: DrillRow[];
}

interface Ctx {
  deals: DealRow[];
  companies: CompanyRow[];
  activities: ActivityRow[];
  companyName: Map<string, string>;
  dealCompany: Map<string, string>;    // deal id -> company id
  contactCompany: Map<string, string>; // contact id -> company id
  lastTouch: (d: DealRow) => number | null;
  isSuperseded: (a: ActivityRow) => boolean;
  futureTaskDealIds: Set<string>;
  stalledDealDays: number;
  now: Date;
}

/** Covered = future task scheduled OR touched within the grace window OR a
 * demo booked today/later (the demo IS the plan). */
function isCovered(ctx: Ctx, d: DealRow): boolean {
  if (ctx.futureTaskDealIds.has(d.hubspot_id)) return true;
  if (hasFutureDemo(d, ctx.now)) return true;
  const t = ctx.lastTouch(d);
  return t !== null && differenceInDays(ctx.now, new Date(t)) <= FOLLOWUP_GRACE_DAYS;
}

/** Best-effort firm resolution for an activity: direct company association,
 * else via its deal, else via its contact. */
function activityCompanyId(ctx: Ctx, a: ActivityRow): string | null {
  return (
    a.company_hubspot_id ??
    (a.deal_hubspot_id ? ctx.dealCompany.get(a.deal_hubspot_id) : null) ??
    (a.contact_hubspot_id ? ctx.contactCompany.get(a.contact_hubspot_id) : null) ??
    null
  );
}

const EMAIL_DIRECTIONS: Record<string, string> = {
  EMAIL: "sent",
  INCOMING_EMAIL: "received",
  FORWARDED_EMAIL: "forwarded",
};

function dealRow(ctx: Ctx, d: DealRow, subtitle?: string): DrillRow {
  // Demos: prefer the Calendly-synced demo date over deal creation date.
  const when = (d.stage === SALES_STAGES.demoScheduled || d.stage === SALES_STAGES.demoCompleted)
    ? (d.properties?.sw_demo_date ?? d.hs_created_at)
    : d.hs_created_at;
  return {
    title: d.name ?? d.hubspot_id,
    subtitle: subtitle ?? d.stage_label ?? undefined,
    companyId: d.company_hubspot_id,
    dealId: d.hubspot_id,
    when,
    nextStep: d.properties?.sw_next_step ?? null,
    nextStepDate: d.properties?.sw_next_step_date ?? null,
  };
}

function activityRows(ctx: Ctx, filter: (a: ActivityRow) => boolean): DrillRow[] {
  const weekStart = subDays(ctx.now, 7);
  return ctx.activities
    .filter((a) => a.occurred_at && new Date(a.occurred_at) >= weekStart && filter(a))
    .sort((a, b) => (b.occurred_at ?? "").localeCompare(a.occurred_at ?? ""))
    .map((a) => {
      const companyId = activityCompanyId(ctx, a);
      const firm = companyId ? ctx.companyName.get(companyId) : null;
      const outcome = a.outcome ? (EMAIL_DIRECTIONS[a.outcome] ?? a.outcome) : null;
      return {
        // Firm first - that's what you scan the list by.
        title: firm || a.subject || a.outcome || a.kind,
        subtitle: [a.subject, outcome].filter(Boolean).join(" - ") || undefined,
        companyId,
        dealId: a.deal_hubspot_id,
        when: a.occurred_at,
      };
    });
}

const stageMetric = (stageId: string) => (ctx: Ctx) =>
  ctx.deals.filter((d) => d.stage === stageId).map((d) => dealRow(ctx, d));

// ---- 7-day funnel cohort drill-downs --------------------------------------
const FUNNEL_RANK: Record<string, number> = {
  [SALES_STAGES.mql]: 1,
  [SALES_STAGES.attemptingContact]: 2,
  [SALES_STAGES.connected]: 3,
  [SALES_STAGES.qualified]: 4,
  [SALES_STAGES.demoScheduled]: 5,
  [SALES_STAGES.demoCompleted]: 6,
  [SALES_STAGES.firstCaseIdentified]: 7,
  [SALES_STAGES.firstCaseCommitted]: 8,
  [SALES_STAGES.closedWon]: 9,
  [SALES_STAGES.closedLost]: 1,
  [SALES_STAGES.nurture]: 1,
};

function cohort(ctx: Ctx): DealRow[] {
  const weekAgo = subDays(ctx.now, 7);
  return ctx.deals.filter(
    (d) => d.hs_created_at && new Date(d.hs_created_at) >= weekAgo,
  );
}

const funnelReached = (rank: number, label: string) => (ctx: Ctx) =>
  cohort(ctx)
    .filter((d) => (FUNNEL_RANK[d.stage ?? ""] ?? 0) >= rank)
    .map((d) => dealRow(ctx, d, `${d.stage_label} · reached ${label}`));

const METRICS: Record<string, { label: string; rows: (ctx: Ctx) => DrillRow[] }> = {
  leads_assigned: {
    label: "Leads assigned",
    rows: (ctx) => ctx.deals.map((d) => dealRow(ctx, d)),
  },
  awaiting_first_contact: {
    label: "Awaiting first contact",
    rows: (ctx) =>
      ctx.deals
        .filter((d) =>
          (d.stage === SALES_STAGES.mql || d.stage === SALES_STAGES.attemptingContact) &&
          ctx.lastTouch(d) === null)
        .map((d) => dealRow(ctx, d, `No outreach logged (${d.stage_label})`)),
  },
  calls_7d: { label: "Calls (7d)", rows: (ctx) => activityRows(ctx, (a) => (a.activity_type ?? a.kind) === "call") },
  emails_7d: { label: "Emails (7d)", rows: (ctx) => activityRows(ctx, (a) => (a.activity_type ?? a.kind) === "email") },
  voicemails_7d: { label: "Voicemails (7d)", rows: (ctx) => activityRows(ctx, (a) => a.activity_type === "voicemail") },
  linkedin_7d: { label: "LinkedIn (7d)", rows: (ctx) => activityRows(ctx, (a) => a.activity_type === "linkedin") },
  visits_7d: { label: "In-person visits (7d)", rows: (ctx) => activityRows(ctx, (a) => a.activity_type === "in_person_visit") },
  connected_7d: { label: "Connected conversations (7d)", rows: (ctx) => activityRows(ctx, (a) => a.outcome === "connected") },
  demo_noshows_7d: { label: "Demo no-shows (7d)", rows: (ctx) => activityRows(ctx, (a) => a.outcome === "no_show") },
  qualified: { label: "Qualified (open)", rows: stageMetric(SALES_STAGES.qualified) },
  demos_booked: { label: "Demos booked", rows: stageMetric(SALES_STAGES.demoScheduled) },
  demos_completed: {
    label: "Demos completed",
    rows: (ctx) => {
      const order: string[] = [
        SALES_STAGES.demoCompleted, SALES_STAGES.firstCaseIdentified,
        SALES_STAGES.firstCaseCommitted, SALES_STAGES.closedWon,
      ];
      return ctx.deals
        .filter((d) => order.includes(d.stage ?? ""))
        .map((d) => dealRow(ctx, d));
    },
  },
  first_cases_identified: { label: "First cases identified", rows: stageMetric(SALES_STAGES.firstCaseIdentified) },
  first_case_commitments: { label: "First-case commitments", rows: stageMetric(SALES_STAGES.firstCaseCommitted) },
  firms_closed: { label: "Firms closed", rows: stageMetric(SALES_STAGES.closedWon) },
  overdue_tasks: {
    label: "Overdue tasks (no touch since due, no upcoming demo)",
    rows: (ctx) =>
      ctx.activities
        .filter((a) => {
          if (a.kind !== "task" || a.completed || !a.due_at) return false;
          if (new Date(a.due_at) >= ctx.now || ctx.isSuperseded(a)) return false;
          const deal = a.deal_hubspot_id
            ? ctx.deals.find((d) => d.hubspot_id === a.deal_hubspot_id) : undefined;
          return !(deal && hasFutureDemo(deal, ctx.now));
        })
        .map((a) => ({
          title: a.subject ?? "Task",
          subtitle: `due ${differenceInDays(ctx.now, new Date(a.due_at!))}d ago`,
          companyId: a.company_hubspot_id,
          dealId: a.deal_hubspot_id,
          when: a.due_at,
        })),
  },
  deals_no_future_task: {
    label: "Open deals without follow-up coverage",
    rows: (ctx) =>
      ctx.deals
        .filter((d) => isOpenSalesDeal(d) && !isCovered(ctx, d))
        .map((d) => dealRow(ctx, d, "No future task + no recent touch")),
  },
  stalled: {
    label: "Stalled deals",
    rows: (ctx) =>
      ctx.deals
        .filter((d) => {
          if (!isOpenSalesDeal(d)) return false;
          const last = ctx.lastTouch(d) ??
            (d.hs_created_at ? new Date(d.hs_created_at).getTime() : 0);
          return differenceInDays(ctx.now, new Date(last)) > ctx.stalledDealDays;
        })
        .map((d) => dealRow(ctx, d, "No recent touch")),
  },
  // ---- 7-day funnel cohort (this week's new leads) ----
  funnel_leads: {
    label: "Leads created this week",
    rows: (ctx) => cohort(ctx).map((d) => dealRow(ctx, d)),
  },
  funnel_contacted: {
    label: "Contacted (this week's leads)",
    rows: (ctx) => cohort(ctx).filter((d) => ctx.lastTouch(d) !== null)
      .map((d) => dealRow(ctx, d, "touched")),
  },
  funnel_connected: { label: "Connected (this week's leads)", rows: funnelReached(3, "Connected") },
  funnel_demo_scheduled: { label: "Demo Scheduled (this week's leads)", rows: funnelReached(5, "Demo Scheduled") },
  funnel_demo_completed: { label: "Demo Completed (this week's leads)", rows: funnelReached(6, "Demo Completed") },
  funnel_first_case_identified: { label: "First Case Identified (this week's leads)", rows: funnelReached(7, "First Case Identified") },
  funnel_first_case_committed: { label: "First Case Committed (this week's leads)", rows: funnelReached(8, "First Case Committed") },
  funnel_closed_won: {
    label: "Closed Won (this week's leads)",
    rows: (ctx) => cohort(ctx).filter((d) => d.stage === SALES_STAGES.closedWon)
      .map((d) => dealRow(ctx, d, "Closed Won")),
  },
  funnel_revenue: {
    label: "Revenue won this week",
    rows: (ctx) => cohort(ctx).filter((d) => d.stage === SALES_STAGES.closedWon)
      .map((d) => dealRow(ctx, d, `$${Math.round(Number(d.amount ?? 0)).toLocaleString()}`)),
  },

  // ---- CS account-health cohorts ----
  cs_activated: {
    label: "Activated firms",
    rows: (ctx) => ctx.companies.filter((c) => c.first_case_completed_date)
      .map((c) => companyRow(c)),
  },
  cs_healthy: {
    label: "Healthy firms",
    rows: (ctx) => ctx.companies.filter((c) => c.account_health === "healthy").map((c) => companyRow(c)),
  },
  cs_below_target: {
    label: "Active below target",
    rows: (ctx) => ctx.companies.filter((c) => c.account_health === "active_below_target")
      .map((c) => companyRow(c, `${c.cases_this_month}/${c.monthly_case_target ?? "?"} this month`)),
  },
  cs_at_risk: {
    label: "At-risk firms",
    rows: (ctx) => ctx.companies.filter((c) => c.account_health === "at_risk")
      .map((c) => companyRow(c, (c.risk_flags ?? []).join("; "))),
  },
  cs_churned: {
    label: "Churned firms",
    rows: (ctx) => ctx.companies.filter((c) => c.account_health === "churned").map((c) => companyRow(c)),
  },
  cs_signed_up_no_case: {
    label: "Signed up, no case yet",
    rows: (ctx) => ctx.companies
      .filter((c) => c.signed_up_at && !c.first_case_at)
      .map((c) => companyRow(c, c.subscribed_at ? "Subscribed" : "Signed up")),
  },
  cs_case_no_signup: {
    label: "Case submitted (intake), no signup",
    rows: (ctx) => ctx.companies
      .filter((c) => c.first_case_at && !c.signed_up_at)
      .map((c) => companyRow(c, `${c.cases_lifetime} case(s), no app account`)),
  },
  cs_expert_missing: {
    label: "Delivered cases missing expert review",
    rows: (ctx) => ctx.companies
      .filter((c) => (c.risk_flags ?? []).some((f) => f.toLowerCase().includes("expert review")))
      .map((c) => companyRow(c, "Delivered case without expert review offered")),
  },

  // ---- CS activation-stage ----
  activation: {
    label: "Activation accounts",
    rows: (ctx) =>
      ctx.deals.filter((d) => d.activation_stage)
        .map((d) => dealRow(ctx, d, d.activation_stage ?? undefined)),
  },
  inactive_30: {
    label: "Firms inactive 30+ days",
    rows: (ctx) => inactiveFirms(ctx, 30),
  },
  inactive_45: {
    label: "Firms inactive 45+ days",
    rows: (ctx) => inactiveFirms(ctx, 45),
  },
};

function companyRow(c: CompanyRow, subtitle?: string): DrillRow {
  return {
    title: c.name ?? c.domain ?? c.hubspot_id,
    subtitle: subtitle ?? (c.account_health ?? undefined),
    companyId: c.hubspot_id,
    when: c.last_case_at,
  };
}

function inactiveFirms(ctx: Ctx, days: number): DrillRow[] {
  return ctx.companies
    .filter((c) => c.last_case_at &&
      differenceInDays(ctx.now, new Date(c.last_case_at)) > days)
    .map((c) => ({
      title: c.name ?? c.domain ?? c.hubspot_id,
      subtitle: `last case ${differenceInDays(ctx.now, new Date(c.last_case_at!))}d ago`,
      companyId: c.hubspot_id,
    }));
}

/** Activation-stage drills, e.g. metric=activation_at_risk. */
function activationMetric(stage: string) {
  return {
    label: `Activation: ${stage.replaceAll("_", " ")}`,
    rows: (ctx: Ctx) =>
      ctx.deals.filter((d) => d.activation_stage === stage)
        .map((d) => dealRow(ctx, d, stage.replaceAll("_", " "))),
  };
}

export async function drill(metric: string, ownerId?: string | null): Promise<DrillResult | null> {
  const def = metric.startsWith("activation_")
    ? activationMetric(metric.slice("activation_".length))
    : METRICS[metric];
  if (!def) return null;

  const { settings, deals, companies, contacts, activities } = await fetchCore();
  const now = new Date();
  const mine = <T extends { owner_id: string | null }>(xs: T[]) =>
    ownerId ? xs.filter((x) => x.owner_id === ownerId) : xs;

  const scopedDeals = mine(deals);
  const scopedActivities = mine(activities);
  const touchMaps = buildTouchMaps(activities, now);
  const lastTouch = buildLastTouchLookup(activities, now, touchMaps);
  const futureTaskDealIds = new Set(
    activities
      .filter((a) => a.kind === "task" && !a.completed && a.due_at &&
                     new Date(a.due_at) >= now)
      .map((a) => a.deal_hubspot_id)
      .filter(Boolean) as string[],
  );

  const ctx: Ctx = {
    deals: scopedDeals,
    companies,
    activities: scopedActivities,
    companyName: new Map(companies.map((c) => [c.hubspot_id, c.name ?? c.domain ?? ""])),
    dealCompany: new Map(
      deals.filter((d) => d.company_hubspot_id)
        .map((d) => [d.hubspot_id, d.company_hubspot_id as string]),
    ),
    contactCompany: new Map(
      (contacts as { hubspot_id: string; company_hubspot_id: string | null }[])
        .filter((c) => c.company_hubspot_id)
        .map((c) => [c.hubspot_id, c.company_hubspot_id as string]),
    ),
    lastTouch,
    isSuperseded: (a: ActivityRow) => isTaskSuperseded(a, touchMaps),
    futureTaskDealIds,
    stalledDealDays: settings.stalledDealDays,
    now,
  };
  return { label: def.label, rows: def.rows(ctx) };
}
