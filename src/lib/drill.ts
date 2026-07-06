/** Drill-down lists behind the dashboard stat tiles. Each metric returns the
 * underlying records with links to the related firm/deal. */
import { differenceInDays, subDays } from "date-fns";
import { SALES_STAGES } from "@/lib/hubspot/stages";
import {
  buildLastTouchLookup, fetchCore, isOpenSalesDeal,
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
  futureTaskDealIds: Set<string>;
  stalledDealDays: number;
  now: Date;
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
    label: "Overdue tasks",
    rows: (ctx) =>
      ctx.activities
        .filter((a) => a.kind === "task" && !a.completed && a.due_at &&
                       new Date(a.due_at) < ctx.now)
        .map((a) => ({
          title: a.subject ?? "Task",
          subtitle: `due ${differenceInDays(ctx.now, new Date(a.due_at!))}d ago`,
          companyId: a.company_hubspot_id,
          dealId: a.deal_hubspot_id,
          when: a.due_at,
        })),
  },
  deals_no_future_task: {
    label: "Open deals without a future task",
    rows: (ctx) =>
      ctx.deals
        .filter((d) => isOpenSalesDeal(d) && !ctx.futureTaskDealIds.has(d.hubspot_id))
        .map((d) => dealRow(ctx, d)),
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
  // ---- CS ----
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
  const lastTouch = buildLastTouchLookup(activities, now);
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
    futureTaskDealIds,
    stalledDealDays: settings.stalledDealDays,
    now,
  };
  return { label: def.label, rows: def.rows(ctx) };
}
