import { supabaseService } from "@/lib/supabase/server";

export interface GtmSettings {
  defaultCasePrice: number;
  atRiskInactivityDays: number;
  firstCaseTargetDays: number;
  secondCaseTargetDays: number;
  healthyCasesPer30d: number;
  stalledDealDays: number;
  dashboardTimezone: string;
  slaFirstContactHours: number;
  /** CSM daily targets. AEs carry their own, higher, prospecting numbers. */
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

export async function saveSetting(key: string, value: unknown, updatedBy?: string) {
  const sb = supabaseService();
  await sb.from("settings").upsert({
    key,
    value,
    updated_at: new Date().toISOString(),
    ...(updatedBy ? { updated_by: updatedBy } : {}),
  });
}
