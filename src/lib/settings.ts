import { must, supabaseService } from "@/lib/supabase/server";

export interface MonthlyTargets {
  mqls: number;
  demos: number;
  newFirms: number;
  cases: number;
  revenue: number;
}

export type MonthlyTargetEntry = Partial<MonthlyTargets> & { stretch?: Partial<MonthlyTargets> };

export interface GtmSettings {
  defaultCasePrice: number;
  atRiskInactivityDays: number;
  firstCaseTargetDays: number;
  secondCaseTargetDays: number;
  healthyCasesPer30d: number;
  stalledDealDays: number;
  dashboardTimezone: string;
  slaFirstContactHours: number;
  /** Total logged touches a role is expected to make per day, across every
   * channel. This is what the daily charts are measured against: a rep who hits
   * the number by texting instead of dialling has still done the day's work. */
  aeDailyActivityTarget: number;
  csDailyActivityTarget: number;
  /** Company-wide monthly goals, drawn as a dotted line on the Activity page's
   * monthly charts. Revenue is in dollars. */
  monthlyMqlsTarget: number;
  monthlyDemosTarget: number;
  monthlyNewFirmsTarget: number;
  monthlyCasesTarget: number;
  monthlyRevenueTarget: number;
  /** Per-month overrides of the five targets above, keyed "YYYY-MM" (owner,
   * 2026-11-02: the $500k-ARR-by-January plan sets different numbers for Nov,
   * Dec and Jan). A month with no entry falls back to the flat targets; a
   * partial entry overrides only the fields it names. An entry may also carry
   * `stretch`, a second set of numbers drawn as a stretch line - no fallback,
   * a month without one has no stretch. */
  monthlyTargetsByMonth: Record<string, MonthlyTargetEntry>;
  /** Paid-ads spend for the current month and the share of MQLs (and so of new
   * subscribers) those ads get credit for. Drives CAC in the unit economics. */
  monthlyAdSpend: number;
  /** Actual paid-ads spend by month ("YYYY-MM" -> dollars) from the Meta Ads
   * account. A month missing here falls back to monthlyAdSpend, prorated. */
  adSpendByMonth: Record<string, number>;
  adLeadSharePct: number;
  /** Fallback monthly people cost for a month before the ledger below starts.
   * Executive-only: never render it to a rep. */
  monthlyTeamCost: number;
  /** ANNUAL salary bill of the people counted in CAC (AE + CS - the CSM runs
   * the demos and owns the book), keyed by the first month each figure
   * applies and carried forward until the next entry. Owner, 2026-10-21:
   * "in july it was only 60k/year, in aug until today it was 85k/year". */
  peopleCostByMonth: Record<string, number>;
  /** Marketing agency retainer (FlyTech runs the Meta ads and screens the
   * leads) as MONTHLY dollars keyed by the first month each figure applies,
   * carried forward. Counted in CAC on top of Meta's own spend. Owner,
   * 2026-10-28: "flytech we pay $3k/month total fixed every month". */
  agencyCostByMonth: Record<string, number>;
  grossMarginPct: number;
  /** Per-channel daily targets. Reference only since the activity target above
   * replaced them - nothing is measured against these. */
  dailyCallsTarget: number;
  dailyEmailsTarget: number;
  aeDailyCallsTarget: number;
  aeDailyEmailsTarget: number;
  dailyFollowupsTarget: number;
  dailyNewLeadsTarget: number;
  dailyTasksTarget: number;
  /** HubSpot owner id -> role. Anyone not listed is treated as an AE, so a new
   * rep counts against AE targets the moment they get a HubSpot seat. */
  repRoles: Record<string, "ae" | "cs" | "exec">;
  hubspotPortalId: string;
  hubspotSalesPipelineId: string;
  aeWeeklyTargets: Record<string, unknown>;
  csTargets: Record<string, unknown>;
  aeScorecardWeights: Record<string, number>;
  csScorecardWeights: Record<string, number>;
  segmentConfig: Record<string, { monthly_target: number | null; at_risk_floor_30d: number; churn_days: number }>;
}

export const DEFAULT_SETTINGS: GtmSettings = {
  defaultCasePrice: 250,
  atRiskInactivityDays: 30,
  firstCaseTargetDays: 14,
  secondCaseTargetDays: 45,
  healthyCasesPer30d: 2,
  stalledDealDays: 14,
  dashboardTimezone: "America/Los_Angeles",
  slaFirstContactHours: 2,
  aeDailyActivityTarget: 100,
  csDailyActivityTarget: 40,
  // Flat fallbacks = the plan's January run-rate, so a month after the ledger
  // ends holds the end state rather than dropping back to the pre-plan
  // 120 / 60 / 30 / 80 / $18,000 that stood through October 2026.
  monthlyMqlsTarget: 250,
  monthlyDemosTarget: 80,
  monthlyNewFirmsTarget: 26,
  monthlyCasesTarget: 165,
  monthlyRevenueTarget: 44500,
  // Option B of the $500k-ARR plan (owner, 2026-11-02): hold October's pace -
  // 32% MQL->demo, 30% demo->plan at ~$385/mo, 3% monthly churn cushion -
  // and the $41.7k MRR line is crossed on 31 January 2027. Stretch = Option A,
  // the same line by 31 December (1.5x October on every input), so it only
  // exists for November and December.
  monthlyTargetsByMonth: {
    "2026-11": {
      mqls: 240, demos: 75, newFirms: 24, cases: 110, revenue: 27500,
      stretch: { mqls: 350, demos: 110, newFirms: 35, cases: 120, revenue: 29000 },
    },
    "2026-12": {
      mqls: 240, demos: 77, newFirms: 25, cases: 140, revenue: 36000,
      stretch: { mqls: 350, demos: 115, newFirms: 36, cases: 160, revenue: 42000 },
    },
    "2027-01": { mqls: 250, demos: 80, newFirms: 26, cases: 165, revenue: 44500 },
  },
  monthlyAdSpend: 7500,
  adSpendByMonth: { "2026-07": 5856, "2026-08": 7718, "2026-09": 4810 },
  adLeadSharePct: 95,
  monthlyTeamCost: 5000,
  peopleCostByMonth: { "2026-07": 60000, "2026-08": 85000 },
  // Keyed from the first month Meta spend ran (May 2026); cohorts start July.
  agencyCostByMonth: { "2026-05": 3000 },
  grossMarginPct: 93,
  dailyCallsTarget: 25,
  dailyEmailsTarget: 20,
  aeDailyCallsTarget: 50,
  aeDailyEmailsTarget: 50,
  dailyFollowupsTarget: 25,
  dailyNewLeadsTarget: 5,
  dailyTasksTarget: 30,
  repRoles: {
    "36148171": "cs",    // Chris Sanz
    "91425496": "exec",  // Saif Altimimi
    "62117007": "exec",  // Andrew Epps (FlyTech)
    "35454790": "ae",    // Victoria (departed; kept so her history reads right)
  },
  hubspotPortalId: "148349267",
  hubspotSalesPipelineId: "default",
  aeWeeklyTargets: {},
  csTargets: {},
  aeScorecardWeights: {},
  csScorecardWeights: {},
  segmentConfig: {
    small: { monthly_target: 2, at_risk_floor_30d: 1, churn_days: 90 },
    mid_size: { monthly_target: 5, at_risk_floor_30d: 2, churn_days: 75 },
    large: { monthly_target: 10, at_risk_floor_30d: 4, churn_days: 60 },
    strategic: { monthly_target: null, at_risk_floor_30d: 4, churn_days: 45 },
  },
};

const KEY_MAP: Record<string, keyof GtmSettings> = {
  default_case_price: "defaultCasePrice",
  at_risk_inactivity_days: "atRiskInactivityDays",
  first_case_target_days: "firstCaseTargetDays",
  second_case_target_days: "secondCaseTargetDays",
  healthy_cases_per_30d: "healthyCasesPer30d",
  stalled_deal_days: "stalledDealDays",
  dashboard_timezone: "dashboardTimezone",
  sla_first_contact_hours: "slaFirstContactHours",
  ae_daily_activity_target: "aeDailyActivityTarget",
  cs_daily_activity_target: "csDailyActivityTarget",
  monthly_mqls_target: "monthlyMqlsTarget",
  monthly_demos_target: "monthlyDemosTarget",
  monthly_new_firms_target: "monthlyNewFirmsTarget",
  monthly_cases_target: "monthlyCasesTarget",
  monthly_revenue_target: "monthlyRevenueTarget",
  monthly_targets_by_month: "monthlyTargetsByMonth",
  monthly_ad_spend: "monthlyAdSpend",
  ad_spend_by_month: "adSpendByMonth",
  ad_lead_share_pct: "adLeadSharePct",
  monthly_team_cost: "monthlyTeamCost",
  people_cost_by_month: "peopleCostByMonth",
  agency_cost_by_month: "agencyCostByMonth",
  gross_margin_pct: "grossMarginPct",
  daily_calls_target: "dailyCallsTarget",
  daily_emails_target: "dailyEmailsTarget",
  ae_daily_calls_target: "aeDailyCallsTarget",
  ae_daily_emails_target: "aeDailyEmailsTarget",
  rep_roles: "repRoles",
  daily_followups_target: "dailyFollowupsTarget",
  daily_new_leads_target: "dailyNewLeadsTarget",
  daily_tasks_target: "dailyTasksTarget",
  hubspot_portal_id: "hubspotPortalId",
  hubspot_sales_pipeline_id: "hubspotSalesPipelineId",
  ae_weekly_targets: "aeWeeklyTargets",
  cs_targets: "csTargets",
  ae_scorecard_weights: "aeScorecardWeights",
  cs_scorecard_weights: "csScorecardWeights",
  segment_config: "segmentConfig",
};

export async function loadSettings(): Promise<GtmSettings> {
  const sb = supabaseService();
  const { data } = await sb.from("settings").select("key, value");
  const out = { ...DEFAULT_SETTINGS };
  for (const row of data ?? []) {
    const key = KEY_MAP[row.key as string];
    if (key) (out as Record<string, unknown>)[key] = row.value;
  }
  // JSON scalars arrive as numbers/strings already; coerce numerics defensively
  out.defaultCasePrice = Number(out.defaultCasePrice) || 250;
  out.atRiskInactivityDays = Number(out.atRiskInactivityDays) || 30;
  out.firstCaseTargetDays = Number(out.firstCaseTargetDays) || 14;
  out.secondCaseTargetDays = Number(out.secondCaseTargetDays) || 45;
  out.healthyCasesPer30d = Number(out.healthyCasesPer30d) || 2;
  out.stalledDealDays = Number(out.stalledDealDays) || 14;
  out.slaFirstContactHours = Number(out.slaFirstContactHours) || 2;
  out.aeDailyActivityTarget = Number(out.aeDailyActivityTarget) || 100;
  out.csDailyActivityTarget = Number(out.csDailyActivityTarget) || 40;
  out.monthlyMqlsTarget = Number(out.monthlyMqlsTarget) || 120;
  out.monthlyDemosTarget = Number(out.monthlyDemosTarget) || 60;
  out.monthlyNewFirmsTarget = Number(out.monthlyNewFirmsTarget) || 30;
  out.monthlyCasesTarget = Number(out.monthlyCasesTarget) || 80;
  out.monthlyRevenueTarget = Number(out.monthlyRevenueTarget) || 18000;
  out.monthlyAdSpend = Number.isFinite(Number(out.monthlyAdSpend)) ? Number(out.monthlyAdSpend) : 7500;
  out.adLeadSharePct = Number.isFinite(Number(out.adLeadSharePct)) ? Number(out.adLeadSharePct) : 95;
  out.monthlyTeamCost = Number.isFinite(Number(out.monthlyTeamCost)) ? Number(out.monthlyTeamCost) : 5000;
  out.grossMarginPct = Number(out.grossMarginPct) > 0 ? Number(out.grossMarginPct) : 93;
  if (typeof out.monthlyTargetsByMonth === "string") {
    try { out.monthlyTargetsByMonth = JSON.parse(out.monthlyTargetsByMonth); } catch { out.monthlyTargetsByMonth = DEFAULT_SETTINGS.monthlyTargetsByMonth; }
  }
  if (!out.monthlyTargetsByMonth || typeof out.monthlyTargetsByMonth !== "object") out.monthlyTargetsByMonth = DEFAULT_SETTINGS.monthlyTargetsByMonth;
  if (typeof out.monthlyTargetsByMonth === "string") {
    try { out.monthlyTargetsByMonth = JSON.parse(out.monthlyTargetsByMonth); } catch { out.monthlyTargetsByMonth = DEFAULT_SETTINGS.monthlyTargetsByMonth; }
  }
  if (!out.monthlyTargetsByMonth || typeof out.monthlyTargetsByMonth !== "object") out.monthlyTargetsByMonth = DEFAULT_SETTINGS.monthlyTargetsByMonth;
  if (typeof out.adSpendByMonth === "string") {
    try { out.adSpendByMonth = JSON.parse(out.adSpendByMonth); } catch { out.adSpendByMonth = DEFAULT_SETTINGS.adSpendByMonth; }
  }
  if (!out.adSpendByMonth || typeof out.adSpendByMonth !== "object") out.adSpendByMonth = DEFAULT_SETTINGS.adSpendByMonth;
  if (typeof out.peopleCostByMonth === "string") {
    try { out.peopleCostByMonth = JSON.parse(out.peopleCostByMonth); } catch { out.peopleCostByMonth = DEFAULT_SETTINGS.peopleCostByMonth; }
  }
  if (!out.peopleCostByMonth || typeof out.peopleCostByMonth !== "object") out.peopleCostByMonth = DEFAULT_SETTINGS.peopleCostByMonth;
  if (typeof out.agencyCostByMonth === "string") {
    try { out.agencyCostByMonth = JSON.parse(out.agencyCostByMonth); } catch { out.agencyCostByMonth = DEFAULT_SETTINGS.agencyCostByMonth; }
  }
  if (!out.agencyCostByMonth || typeof out.agencyCostByMonth !== "object") out.agencyCostByMonth = DEFAULT_SETTINGS.agencyCostByMonth;

  out.dailyCallsTarget = Number(out.dailyCallsTarget) || 25;
  out.dailyEmailsTarget = Number(out.dailyEmailsTarget) || 20;
  out.aeDailyCallsTarget = Number(out.aeDailyCallsTarget) || 50;
  out.aeDailyEmailsTarget = Number(out.aeDailyEmailsTarget) || 50;
  if (!out.repRoles || typeof out.repRoles !== "object") out.repRoles = DEFAULT_SETTINGS.repRoles;
  out.dailyFollowupsTarget = Number(out.dailyFollowupsTarget) || 25;
  out.dailyNewLeadsTarget = Number(out.dailyNewLeadsTarget) || 5;
  out.dailyTasksTarget = Number(out.dailyTasksTarget) || 30;
  out.dashboardTimezone = String(out.dashboardTimezone || "America/Los_Angeles");
  return out;
}

/** The five monthly targets in force for a YYYY-MM month: the ledger entry
 * for that exact month (only the fields it names) over the flat settings.
 * `stretch` holds only the stretch figures the entry names - a field that is
 * missing or not above the committed target is left undefined, so the chart
 * draws no line for it. */
export function monthlyTargetsFor(
  settings: GtmSettings, month: string,
): MonthlyTargets & { stretch: Partial<MonthlyTargets> } {
  const o = settings.monthlyTargetsByMonth[month] ?? {};
  const n = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  const t: MonthlyTargets = {
    mqls: n(o.mqls, settings.monthlyMqlsTarget),
    demos: n(o.demos, settings.monthlyDemosTarget),
    newFirms: n(o.newFirms, settings.monthlyNewFirmsTarget),
    cases: n(o.cases, settings.monthlyCasesTarget),
    revenue: n(o.revenue, settings.monthlyRevenueTarget),
  };
  const s = o.stretch ?? {};
  const up = (v: unknown, committed: number) => (Number(v) > committed ? Number(v) : undefined);
  const stretch: Partial<MonthlyTargets> = {};
  for (const k of ["mqls", "demos", "newFirms", "cases", "revenue"] as const) {
    const v = up(s[k], t[k]);
    if (v !== undefined) stretch[k] = v;
  }
  return { ...t, stretch };
}

/** Monthly people cost for a YYYY-MM month: the ledger entry in force (latest
 * key at or before the month) divided by 12, else the flat fallback. */
export function peopleCostForMonth(settings: GtmSettings, month: string): number {
  const keys = Object.keys(settings.peopleCostByMonth).filter((k) => k <= month).sort();
  const key = keys.at(-1);
  if (!key) return settings.monthlyTeamCost;
  const annual = Number(settings.peopleCostByMonth[key]);
  return Number.isFinite(annual) ? annual / 12 : settings.monthlyTeamCost;
}

/** Agency retainer for a YYYY-MM month: the ledger entry in force (latest key
 * at or before the month), already monthly; 0 before the ledger starts. */
export function agencyCostForMonth(settings: GtmSettings, month: string): number {
  const keys = Object.keys(settings.agencyCostByMonth).filter((k) => k <= month).sort();
  const key = keys.at(-1);
  if (!key) return 0;
  const monthly = Number(settings.agencyCostByMonth[key]);
  return Number.isFinite(monthly) ? monthly : 0;
}

export async function saveSetting(key: string, value: unknown, updatedBy?: string) {
  const sb = supabaseService();
  // Checked, not fire-and-forget: an unchecked upsert here swallowed a failed
  // write on 2026-11-02 (a non-uuid `updated_by`) and the setting silently
  // kept its old value while the caller reported success.
  await must(`settings.upsert(${key})`, sb.from("settings").upsert({
    key,
    value,
    updated_at: new Date().toISOString(),
    ...(updatedBy ? { updated_by: updatedBy } : {}),
  }, { onConflict: "key" }));
}
