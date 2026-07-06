/** Case sync + rollups: pulls Silent Witness cases, computes per-firm usage,
 * health and risk flags, runs activation-lifecycle automation, and writes the
 * rollups back to HubSpot (gated by HUBSPOT_APPLY). */
import { SilentWitnessProvider, type CaseRecord } from "@/lib/cases/provider";
import { env } from "@/lib/env";
import { computeHealth, computeRiskFlags } from "@/lib/health";
import { hsCreateObject, hsUpdateProperties, ASSOC } from "@/lib/hubspot/client";
import { nextActivationStage } from "@/lib/lifecycle";
import { computeFirmUsage } from "@/lib/metrics";
import { loadSettings } from "@/lib/settings";
import { supabaseService } from "@/lib/supabase/server";
import type { ActivationStage } from "@/lib/hubspot/stages";

const DAY = 24 * 60 * 60 * 1000;

export async function syncCases() {
  const sb = supabaseService();
  const provider = new SilentWitnessProvider(env.swApiBaseUrl(), env.swApiKey());
  const cases = await provider.listAllCases();
  if (cases.length) {
    await sb.from("cases").upsert(
      cases.map((c) => ({
        sw_id: c.swId,
        sw_account_id: c.swAccountId,
        sw_organization_id: c.swOrganizationId,
        name: c.name,
        case_stage: c.caseStage,
        analysis_type: c.analysisType,
        submitted_at: c.submittedAt,
        delivered_at: c.deliveredAt,
        report_status: c.reportStatus,
        raw: c.raw,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "sw_id" },
    );
  }
  return { cases: cases.length };
}

interface CompanyRow {
  hubspot_id: string;
  name: string | null;
  properties: Record<string, string | null>;
}

/** Compute per-firm rollups + health + lifecycle and write back. */
export async function computeRollups() {
  const sb = supabaseService();
  const settings = await loadSettings();
  const now = new Date();
  const stats = { firms: 0, lifecycleMoves: 0, writebacks: 0, handoffs: 0 };

  const [{ data: mappings }, { data: allCases }, { data: companies },
         { data: deals }, { data: activities }] = await Promise.all([
    sb.from("firm_mapping").select("*"),
    sb.from("cases").select("*"),
    sb.from("companies").select("hubspot_id, name, properties"),
    sb.from("deals").select("*"),
    sb.from("activities").select("kind, company_hubspot_id, deal_hubspot_id, occurred_at, due_at, completed, outcome"),
  ]);

  const casesByKey = new Map<string, CaseRecord[]>();
  for (const c of allCases ?? []) {
    const keys = [c.sw_organization_id, c.sw_account_id].filter(Boolean) as string[];
    const rec: CaseRecord = {
      swId: c.sw_id, swAccountId: c.sw_account_id, swOrganizationId: c.sw_organization_id,
      name: c.name, caseStage: c.case_stage, analysisType: c.analysis_type,
      submittedAt: c.submitted_at, deliveredAt: c.delivered_at,
      reportStatus: c.report_status, raw: c.raw,
    };
    for (const k of keys) {
      casesByKey.set(k, [...(casesByKey.get(k) ?? []), rec]);
    }
  }

  const dealsByCompany = new Map<string, Record<string, unknown>[]>();
  for (const d of deals ?? []) {
    if (!d.company_hubspot_id) continue;
    dealsByCompany.set(d.company_hubspot_id,
      [...(dealsByCompany.get(d.company_hubspot_id) ?? []), d]);
  }

  const nowMs = now.getTime();
  const actsByCompany = new Map<string, { lastInteraction: number | null; futureTask: boolean }>();
  for (const a of activities ?? []) {
    if (!a.company_hubspot_id) continue;
    const cur = actsByCompany.get(a.company_hubspot_id) ?? { lastInteraction: null, futureTask: false };
    const t = a.occurred_at ? new Date(a.occurred_at).getTime() : null;
    if (t && t <= nowMs && (a.kind === "call" || a.kind === "meeting" || a.kind === "note")) {
      cur.lastInteraction = Math.max(cur.lastInteraction ?? 0, t);
    }
    if (a.kind === "task" && !a.completed && a.due_at && new Date(a.due_at).getTime() > nowMs) {
      cur.futureTask = true;
    }
    if (a.kind === "meeting" && t && t > nowMs) cur.futureTask = true;
    actsByCompany.set(a.company_hubspot_id, cur);
  }

  const companyById = new Map((companies ?? []).map((c: CompanyRow) => [c.hubspot_id, c]));

  for (const map of mappings ?? []) {
    const company = companyById.get(map.hubspot_company_id);
    if (!company) continue;
    stats.firms += 1;

    const firmCases =
      casesByKey.get(map.sw_organization_id ?? "") ??
      casesByKey.get(map.sw_account_id ?? "") ?? [];
    const price = Number(map.per_case_price) || settings.defaultCasePrice;
    const usage = computeFirmUsage(firmCases, { now, pricePerCase: price });

    const companyDeals = dealsByCompany.get(company.hubspot_id) ?? [];
    const activationDeal = companyDeals.find((d) => d.is_activation) ??
      companyDeals.find((d) => d.stage === "closedwon");
    const acts = actsByCompany.get(company.hubspot_id) ?? { lastInteraction: null, futureTask: false };

    const onboardingCompleted =
      company.properties?.sw_onboarding_status === "completed" ||
      (activationDeal?.properties as Record<string, string | null> | undefined)
        ?.sw_onboarding_completed === "true";
    const championIdentified = Boolean(company.properties?.sw_active_champion);
    const openIssue = (company.properties?.sw_at_risk_reason ?? "")
      .toLowerCase().includes("issue");
    const daysSinceInteraction = acts.lastInteraction
      ? Math.floor((nowMs - acts.lastInteraction) / DAY) : null;
    const closedWonAt = activationDeal?.closed_at
      ? new Date(activationDeal.closed_at as string).getTime() : null;

    const health = computeHealth({
      caseInLast30d: usage.cases30d > 0,
      twoPlusCasesInLast60d: usage.cases60d >= 2,
      onboardingCompleted,
      championIdentified,
      interactionInLast30d: daysSinceInteraction !== null && daysSinceInteraction <= 30,
      futureTaskOrMeetingExists: acts.futureTask,
      noUnresolvedCriticalIssue: !openIssue,
    });
    const riskFlags = computeRiskFlags({
      onboardingCompleted,
      daysSinceClosedWon: closedWonAt ? Math.floor((nowMs - closedWonAt) / DAY) : null,
      firstCaseAt: usage.firstCaseAt,
      secondCaseAt: usage.secondCaseAt,
      daysSinceLastCase: usage.daysSinceLastCase,
      daysSinceLastInteraction: daysSinceInteraction,
      openProductIssue: openIssue,
      negativeFeedback: false,
      paymentIssue: false,
      championIdentified,
      futureTaskExists: acts.futureTask,
      firstCaseTargetDays: settings.firstCaseTargetDays,
      secondCaseTargetDays: settings.secondCaseTargetDays,
      atRiskInactivityDays: settings.atRiskInactivityDays,
    });

    // ---- cache the rollups ----
    await sb.from("companies").update({
      sw_account_id: map.sw_account_id,
      cases_lifetime: usage.casesLifetime,
      cases_7d: usage.cases7d,
      cases_30d: usage.cases30d,
      cases_60d: usage.cases60d,
      cases_90d: usage.cases90d,
      cases_prev_30d: usage.casesPrev30d,
      first_case_at: usage.firstCaseAt,
      last_case_at: usage.lastCaseAt,
      avg_cases_per_month: usage.avgCasesPerMonth,
      est_revenue: usage.estRevenue,
      health_score: health.score,
      health_category: health.category,
      health_factors: health.factors,
      risk_flags: riskFlags,
      usage_trend: usage.usageTrend,
      updated_at: new Date().toISOString(),
    }).eq("hubspot_id", company.hubspot_id);

    // ---- write rollups back to HubSpot (source of truth for reporting) ----
    const wb = await hsUpdateProperties("companies", company.hubspot_id, {
      sw_internal_firm_id: map.sw_organization_id ?? map.sw_account_id,
      sw_total_lifetime_cases: usage.casesLifetime,
      sw_cases_last_30_days: usage.cases30d,
      sw_cases_last_60_days: usage.cases60d,
      sw_last_case_date: usage.lastCaseAt?.slice(0, 10),
      sw_first_case_date: usage.firstCaseAt?.slice(0, 10),
      sw_avg_monthly_cases: usage.avgCasesPerMonth,
      sw_estimated_case_revenue: usage.estRevenue,
      sw_health_score: health.score,
      sw_health_category: health.category,
      sw_at_risk_reason: riskFlags.length ? riskFlags.join("; ") : undefined,
    });
    if (wb.ok) stats.writebacks += 1;

    // ---- activation lifecycle automation on the activation deal ----
    if (activationDeal) {
      const cur = (activationDeal.activation_stage ?? null) as ActivationStage | null;
      const next = nextActivationStage({
        current: cur,
        casesLifetime: usage.casesLifetime,
        cases30d: usage.cases30d,
        firstCaseDelivered: firmCases.some((c) => c.deliveredAt),
        daysSinceLastCase: usage.daysSinceLastCase,
        atRiskInactivityDays: settings.atRiskInactivityDays,
        healthyCasesPer30d: settings.healthyCasesPer30d,
      });
      if (next) {
        stats.lifecycleMoves += 1;
        await hsUpdateProperties("deals", activationDeal.hubspot_id as string, {
          sw_activation_stage: next,
          sw_usage_status:
            next === "healthy_account" ? "healthy"
            : next === "repeat_user" ? "repeat"
            : next === "at_risk" ? "at_risk"
            : next === "activated" || next === "first_case_delivered" ? "activated"
            : undefined,
          sw_first_case_submitted_date:
            usage.firstCaseAt?.slice(0, 10),
          sw_second_case_date: usage.secondCaseAt?.slice(0, 10),
          sw_last_case_date: usage.lastCaseAt?.slice(0, 10),
          sw_cases_last_30_days: usage.cases30d,
          sw_cases_lifetime: usage.casesLifetime,
        });
        await sb.from("deals").update({ activation_stage: next, is_activation: true })
          .eq("hubspot_id", activationDeal.hubspot_id);
      }
    }
  }

  // ---- handoff automation: Closed Won without an activation stage ----
  const csOwnerSetting = (companies ?? []).length ? null : null; // resolved per-company below
  void csOwnerSetting;
  for (const d of deals ?? []) {
    if (d.stage !== "closedwon" || d.activation_stage) continue;
    stats.handoffs += 1;
    const res = await hsUpdateProperties("deals", d.hubspot_id, {
      sw_activation_stage: "handoff_pending",
      sw_usage_status: "pre_first_case",
    });
    if (res.ok) {
      await sb.from("deals").update({
        activation_stage: "handoff_pending", is_activation: true,
      }).eq("hubspot_id", d.hubspot_id);
      // onboarding task for the deal owner (CS accepts via dashboard)
      await hsCreateObject("tasks", {
        hs_task_subject: `Onboarding: accept handoff for ${d.name ?? "new customer"}`,
        hs_task_body: "[type:handoff] Auto-created when the deal reached Closed Won. " +
          "Accept the handoff and schedule onboarding.",
        hs_task_status: "NOT_STARTED",
        hs_timestamp: new Date(Date.now() + DAY).toISOString(),
        ...(d.owner_id ? { hubspot_owner_id: d.owner_id } : {}),
      }, [{ toId: d.hubspot_id, associationTypeId: ASSOC.taskToDeal }]);
      await notifySlack(`:handshake: New customer handoff pending: *${d.name}* - CS to accept and schedule onboarding.`);
    }
  }

  return stats;
}

async function notifySlack(text: string) {
  const url = env.slackWebhookUrl();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    // never fail a sync over a notification
  }
}
