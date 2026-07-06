import { supabaseService } from "@/lib/supabase/server";

export interface GtmSettings {
  defaultCasePrice: number;
  atRiskInactivityDays: number;
  firstCaseTargetDays: number;
  secondCaseTargetDays: number;
  healthyCasesPer30d: number;
  stalledDealDays: number;
  hubspotPortalId: string;
  hubspotSalesPipelineId: string;
  aeWeeklyTargets: Record<string, unknown>;
  csTargets: Record<string, unknown>;
  aeScorecardWeights: Record<string, number>;
  csScorecardWeights: Record<string, number>;
}

const DEFAULTS: GtmSettings = {
  defaultCasePrice: 250,
  atRiskInactivityDays: 30,
  firstCaseTargetDays: 14,
  secondCaseTargetDays: 45,
  healthyCasesPer30d: 2,
  stalledDealDays: 14,
  hubspotPortalId: "148349267",
  hubspotSalesPipelineId: "default",
  aeWeeklyTargets: {},
  csTargets: {},
  aeScorecardWeights: {},
  csScorecardWeights: {},
};

const KEY_MAP: Record<string, keyof GtmSettings> = {
  default_case_price: "defaultCasePrice",
  at_risk_inactivity_days: "atRiskInactivityDays",
  first_case_target_days: "firstCaseTargetDays",
  second_case_target_days: "secondCaseTargetDays",
  healthy_cases_per_30d: "healthyCasesPer30d",
  stalled_deal_days: "stalledDealDays",
  hubspot_portal_id: "hubspotPortalId",
  hubspot_sales_pipeline_id: "hubspotSalesPipelineId",
  ae_weekly_targets: "aeWeeklyTargets",
  cs_targets: "csTargets",
  ae_scorecard_weights: "aeScorecardWeights",
  cs_scorecard_weights: "csScorecardWeights",
};

export async function loadSettings(): Promise<GtmSettings> {
  const sb = supabaseService();
  const { data } = await sb.from("settings").select("key, value");
  const out = { ...DEFAULTS };
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
