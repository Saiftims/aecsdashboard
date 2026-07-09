/** Case ingestion + reconciliation + CS rollups.
 *
 * Cases feed from PostHog (case_created=submitted, report_generation_completed=
 * completed, report_downloaded=delivered), reconciled with HubSpot "intake"
 * deals, plus manual rows. Test/internal accounts are excluded. Cases live in
 * Supabase (workflow source of truth); firm/account + handoff fields are
 * mirrored to HubSpot.
 */
import {
  PostHogProvider, TEST_ACCOUNT_IDS, TEST_EMAILS, isTestCaseActor,
  type PostHogCase,
} from "@/lib/cases/provider";
import { env } from "@/lib/env";
import {
  computeAccountHealth, type FirmSegment, type SegmentRule,
} from "@/lib/health";
import { hsCreateObject, hsUpdateProperties, ASSOC } from "@/lib/hubspot/client";
import { SALES_STAGES } from "@/lib/hubspot/stages";
import { computeFirmUsage } from "@/lib/metrics";
import { loadSettings } from "@/lib/settings";
import { supabaseService } from "@/lib/supabase/server";

const DAY = 24 * 60 * 60 * 1000;

const OPEN_SALES_STAGES = new Set<string>([
  SALES_STAGES.mql, SALES_STAGES.attemptingContact, SALES_STAGES.connected,
  SALES_STAGES.qualified, SALES_STAGES.demoScheduled, SALES_STAGES.demoCompleted,
  SALES_STAGES.firstCaseIdentified, SALES_STAGES.firstCaseCommitted,
]);

interface CompanyLite {
  hubspot_id: string;
  name: string | null;
  domain: string | null;
  sw_account_id: string | null;
  properties: Record<string, string | null>;
}

function emailDomain(email: string | null): string | null {
  if (!email) return null;
  const d = email.split("@")[1];
  return d ? d.toLowerCase() : null;
}

function derivedStatus(c: { submitted_date: string | null; completed_date: string | null; delivered_date: string | null }): string {
  if (c.delivered_date) return "delivered";
  if (c.completed_date) return "completed";
  return "submitted";
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------
export async function syncCases() {
  const sb = supabaseService();
  const stats = { posthog: 0, mapped: 0, unmapped: 0, intake: 0, bootstrapped: 0, purgedTest: 0 };

  // Purge any previously-ingested test/internal cases (idempotent cleanup).
  const purge = await sb.from("cases").delete({ count: "exact" })
    .or(
      `posthog_account_id.in.(${TEST_ACCOUNT_IDS.join(",")}),` +
      `creator_email.in.(${TEST_EMAILS.join(",")})`,
    );
  stats.purgedTest = purge.count ?? 0;
  // Also drop cases whose creator is an internal silentwitness.ai / saif+ user.
  await sb.from("cases").delete().like("creator_email", "%@silentwitness.ai");
  await sb.from("cases").delete().like("creator_email", "saif+%");

  const { data: companies } = await sb
    .from("companies")
    .select("hubspot_id, name, domain, sw_account_id, properties");
  const { data: mappings } = await sb.from("firm_mapping").select("*");
  const { data: deals } = await sb
    .from("deals")
    .select("hubspot_id, name, company_hubspot_id, stage, hs_created_at, properties");
  const { data: existingCases } = await sb.from("cases").select("case_id, case_status, company_hubspot_id, submitted_date");

  const byDomain = new Map<string, CompanyLite>();
  const byAccount = new Map<string, string>(); // acc -> hubspot_company_id
  for (const c of (companies ?? []) as CompanyLite[]) {
    if (c.domain) byDomain.set(c.domain.toLowerCase(), c);
    if (c.sw_account_id) byAccount.set(c.sw_account_id, c.hubspot_id);
  }
  for (const m of mappings ?? []) {
    if (m.sw_account_id && m.hubspot_company_id) byAccount.set(m.sw_account_id, m.hubspot_company_id);
  }
  const existingById = new Map((existingCases ?? []).map((c) => [c.case_id, c]));

  // ---- PostHog cases ----
  let phCases: PostHogCase[] = [];
  if (env.posthogKey() && env.posthogProjectId()) {
    try {
      const provider = new PostHogProvider(
        env.posthogKey(), env.posthogProjectId(), env.posthogHost(),
      );
      phCases = await provider.listAllCases();
    } catch (e) {
      console.error("PostHog fetch failed:", e instanceof Error ? e.message : e);
    }
  }

  const bootstrapMappings: { sw_account_id: string; hubspot_company_id: string; confirmed: boolean }[] = [];
  const inserts: Record<string, unknown>[] = [];
  const updates: { case_id: string; row: Record<string, unknown> }[] = [];

  for (const pc of phCases) {
    if (isTestCaseActor(pc.creatorEmail, pc.accountId)) continue;
    stats.posthog += 1;

    // firm match: account id -> else creator email domain (bootstrap mapping)
    let companyId: string | null =
      (pc.accountId && byAccount.get(pc.accountId)) || null;
    if (!companyId) {
      const dom = emailDomain(pc.creatorEmail);
      const co = dom ? byDomain.get(dom) : undefined;
      if (co) {
        companyId = co.hubspot_id;
        if (pc.accountId && !byAccount.has(pc.accountId)) {
          byAccount.set(pc.accountId, companyId);
          bootstrapMappings.push({
            sw_account_id: pc.accountId, hubspot_company_id: companyId, confirmed: false,
          });
          stats.bootstrapped += 1;
        }
      }
    }
    if (companyId) stats.mapped += 1; else stats.unmapped += 1;

    // Fall back to completed/delivered when there's no valid submitted date
    // (a case can appear via report events without a case_created event).
    const submittedAt = pc.submittedAt ?? pc.completedAt ?? pc.deliveredAt;
    const dates = {
      submitted_date: submittedAt,
      completed_date: pc.completedAt,
      delivered_date: pc.deliveredAt,
    };
    const existing = existingById.get(pc.caseId);
    if (!existing) {
      inserts.push({
        case_id: pc.caseId,
        sw_id: pc.caseId,
        company_hubspot_id: companyId,
        case_name: `Case ${pc.caseId.replace(/^case_/, "").slice(0, 8)}`,
        case_status: derivedStatus(dates),
        submitted_date: submittedAt,
        submitted_at: submittedAt,
        completed_date: pc.completedAt,
        delivered_date: pc.deliveredAt,
        delivered_at: pc.deliveredAt,
        analysis_type: pc.analysisType,
        source: "posthog",
        posthog_account_id: pc.accountId,
        creator_email: pc.creatorEmail,
        revenue_amount: 250,
        updated_at: new Date().toISOString(),
      });
    } else {
      // Update dates + company; advance status only if still auto (never
      // override a CS-set issue_open / cancelled).
      const row: Record<string, unknown> = {
        company_hubspot_id: companyId ?? existing.company_hubspot_id,
        completed_date: pc.completedAt,
        delivered_date: pc.deliveredAt,
        delivered_at: pc.deliveredAt,
        updated_at: new Date().toISOString(),
      };
      // Repair a previously-stored bad/epoch submitted date.
      const existingSubmitted = existing.submitted_date
        ? new Date(existing.submitted_date) : null;
      const existingBad = !existingSubmitted ||
        Number.isNaN(existingSubmitted.getTime()) ||
        existingSubmitted.getUTCFullYear() < 2015;
      if (submittedAt && existingBad) {
        row.submitted_date = submittedAt;
        row.submitted_at = submittedAt;
      }
      if (!["issue_open", "cancelled"].includes(existing.case_status ?? "")) {
        row.case_status = derivedStatus(dates);
      }
      updates.push({ case_id: pc.caseId, row });
    }
  }

  // ---- HubSpot intake reconciliation ----
  // Deals whose name flags an intake submission == a case for that firm.
  const phByCompany = new Map<string, number[]>(); // company -> submitted epochs
  for (const pc of phCases) {
    if (isTestCaseActor(pc.creatorEmail, pc.accountId) || !pc.submittedAt) continue;
    const cid = (pc.accountId && byAccount.get(pc.accountId)) || null;
    if (cid) phByCompany.set(cid, [...(phByCompany.get(cid) ?? []), new Date(pc.submittedAt).getTime()]);
  }
  for (const d of deals ?? []) {
    const name = (d.name ?? "").toLowerCase();
    if (!name.includes("intake") || !d.company_hubspot_id || !d.hs_created_at) continue;
    const created = new Date(d.hs_created_at).getTime();
    // dedupe vs a PostHog case for the same firm within 3 days
    const near = (phByCompany.get(d.company_hubspot_id) ?? [])
      .some((t) => Math.abs(t - created) <= 3 * DAY);
    const caseId = `intake_${d.hubspot_id}`;
    if (near || existingById.has(caseId)) continue;
    inserts.push({
      case_id: caseId,
      sw_id: caseId,
      company_hubspot_id: d.company_hubspot_id,
      case_name: d.name,
      case_status: "submitted",
      submitted_date: d.hs_created_at,
      submitted_at: d.hs_created_at,
      source: "hubspot_intake",
      revenue_amount: 250,
      updated_at: new Date().toISOString(),
    });
    stats.intake += 1;
  }

  if (bootstrapMappings.length) {
    await sb.from("firm_mapping").upsert(bootstrapMappings, { onConflict: "sw_account_id,sw_organization_id" }).then(
      () => undefined, () => undefined,
    );
  }
  if (inserts.length) await sb.from("cases").insert(inserts);
  for (const u of updates) await sb.from("cases").update(u.row).eq("case_id", u.case_id);

  return stats;
}

// ---------------------------------------------------------------------------
// Rollups: per-firm usage, account health, expert-review tasks, handoffs.
// ---------------------------------------------------------------------------
interface CaseRow {
  case_id: string;
  company_hubspot_id: string | null;
  case_status: string | null;
  submitted_date: string | null;
  completed_date: string | null;
  delivered_date: string | null;
  revenue_amount: number | null;
  expert_review_offered: boolean;
  expert_review_task_created: boolean;
  case_name: string | null;
  issue_flag: boolean;
}

export async function computeRollups() {
  const sb = supabaseService();
  const settings = await loadSettings();
  const now = new Date();
  const nowMs = now.getTime();
  const stats = { firms: 0, writebacks: 0, expertTasks: 0, handoffs: 0 };

  const [{ data: companies }, { data: cases }, { data: deals }, { data: handoffs }] =
    await Promise.all([
      sb.from("companies").select("hubspot_id, name, domain, properties, monthly_case_target, firm_segment, first_case_commitment_date, actual_revenue"),
      sb.from("cases").select("case_id, company_hubspot_id, case_status, submitted_date, completed_date, delivered_date, revenue_amount, expert_review_offered, expert_review_task_created, case_name, issue_flag"),
      sb.from("deals").select("hubspot_id, name, company_hubspot_id, stage, activation_stage, owner_id, closed_at, hs_created_at, properties"),
      sb.from("handoffs").select("deal_hubspot_id"),
    ]);

  const casesByCompany = new Map<string, CaseRow[]>();
  for (const c of (cases ?? []) as CaseRow[]) {
    if (!c.company_hubspot_id) continue;
    casesByCompany.set(c.company_hubspot_id, [...(casesByCompany.get(c.company_hubspot_id) ?? []), c]);
  }
  const dealsByCompany = new Map<string, Record<string, unknown>[]>();
  for (const d of deals ?? []) {
    if (!d.company_hubspot_id) continue;
    dealsByCompany.set(d.company_hubspot_id, [...(dealsByCompany.get(d.company_hubspot_id) ?? []), d]);
  }
  const existingHandoffDeals = new Set((handoffs ?? []).map((h) => h.deal_hubspot_id));

  const segRule = (segment: FirmSegment | null): SegmentRule => {
    const cfg = settings.segmentConfig[segment ?? "small"] ?? settings.segmentConfig.small;
    return {
      monthlyTarget: cfg.monthly_target,
      atRiskFloor30d: cfg.at_risk_floor_30d,
      churnDays: cfg.churn_days,
    };
  };

  for (const company of companies ?? []) {
    const firmCases = casesByCompany.get(company.hubspot_id) ?? [];
    const companyDeals = dealsByCompany.get(company.hubspot_id) ?? [];
    const isCustomer = firmCases.length > 0 ||
      companyDeals.some((d) => d.stage === "closedwon" || d.activation_stage);
    if (!isCustomer) continue;
    stats.firms += 1;

    const segment = (company.firm_segment ??
      (company.properties?.sw_firm_segment as string | null) ?? null) as FirmSegment | null;
    const rule = segRule(segment);
    const overrideTarget = company.monthly_case_target != null
      ? Number(company.monthly_case_target)
      : (company.properties?.sw_monthly_case_target != null
          ? Number(company.properties.sw_monthly_case_target) : null);
    const monthlyTarget = overrideTarget ?? rule.monthlyTarget;

    const usage = computeFirmUsage(
      firmCases.map((c) => ({
        swId: c.case_id, swAccountId: null, swOrganizationId: null,
        name: c.case_name, caseStage: null, analysisType: null,
        submittedAt: c.submitted_date ?? new Date().toISOString(),
        deliveredAt: c.delivered_date, reportStatus: null, raw: c,
      })),
      { now, pricePerCase: settings.defaultCasePrice },
    );

    const completedDates = firmCases.map((c) => c.completed_date).filter(Boolean) as string[];
    const firstCaseCompletedDate = completedDates.sort()[0] ?? null;
    const commitmentDate = company.first_case_commitment_date ??
      (company.properties?.sw_first_case_commitment_date as string | null) ?? null;
    const openIssueCount = firmCases.filter(
      (c) => c.issue_flag || c.case_status === "issue_open",
    ).length;
    const deliveredWithoutOffer = firmCases.some(
      (c) => c.case_status === "delivered" && !c.expert_review_offered,
    );
    const hasActiveOpp = companyDeals.some(
      (d) => OPEN_SALES_STAGES.has(d.stage as string) ||
             d.activation_stage === "reactivation_in_progress",
    );

    const health = computeAccountHealth({
      segment, monthlyTarget, rule,
      handoffExists: companyDeals.some((d) => d.activation_stage || d.stage === "closedwon"),
      handoffAccepted: companyDeals.some(
        (d) => (d.properties as Record<string, string | null>)?.sw_handoff_accepted_by_cs === "true"),
      firstCaseCommitmentDate: commitmentDate,
      firstCaseSubmittedDate: usage.firstCaseAt,
      firstCaseCompletedDate,
      secondCaseDate: usage.secondCaseAt,
      casesLifetime: usage.casesLifetime,
      casesThisMonth: usage.casesThisMonth,
      cases30d: usage.cases30d,
      daysSinceLastCase: usage.daysSinceLastCase,
      openIssueCount,
      hasDeliveredCaseWithoutExpertReviewOffered: deliveredWithoutOffer,
      hasActiveOpp,
      now,
    });

    const attainment = monthlyTarget && monthlyTarget > 0
      ? Math.round((usage.casesThisMonth / monthlyTarget) * 100) : null;

    // ---- cache ----
    await sb.from("companies").update({
      firm_segment: segment,
      monthly_case_target: monthlyTarget,
      account_health: health.status,
      cases_lifetime: usage.casesLifetime,
      cases_7d: usage.cases7d,
      cases_30d: usage.cases30d,
      cases_last_45d: usage.cases45d,
      cases_60d: usage.cases60d,
      cases_90d: usage.cases90d,
      cases_this_month: usage.casesThisMonth,
      cases_prev_30d: usage.casesPrev30d,
      first_case_at: usage.firstCaseAt,
      last_case_at: usage.lastCaseAt,
      first_case_completed_date: firstCaseCompletedDate,
      second_case_submitted_date: usage.secondCaseAt,
      avg_cases_per_month: usage.avgCasesPerMonth,
      est_revenue: usage.estRevenue,
      actual_revenue: firmCases.reduce((s, c) => s + (Number(c.revenue_amount) || 0), 0),
      target_attainment_percent: attainment,
      open_issue_count: openIssueCount,
      usage_trend: usage.usageTrend,
      health_category: health.category === "neutral" ? "yellow" : health.category,
      risk_flags: health.reasons,
      updated_at: new Date().toISOString(),
    }).eq("hubspot_id", company.hubspot_id);

    // ---- HubSpot write-back (firm/account source of truth) ----
    const wb = await hsUpdateProperties("companies", company.hubspot_id, {
      sw_account_health: health.status,
      sw_firm_segment: segment ?? undefined,
      sw_monthly_case_target: monthlyTarget ?? undefined,
      sw_target_attainment_percent: attainment ?? undefined,
      sw_open_issue_count: openIssueCount,
      sw_total_lifetime_cases: usage.casesLifetime,
      sw_cases_last_30_days: usage.cases30d,
      sw_cases_last_60_days: usage.cases60d,
      sw_first_case_date: usage.firstCaseAt?.slice(0, 10),
      sw_first_case_completed_date: firstCaseCompletedDate?.slice(0, 10),
      sw_second_case_date: usage.secondCaseAt?.slice(0, 10),
      sw_last_case_date: usage.lastCaseAt?.slice(0, 10),
      sw_avg_monthly_cases: usage.avgCasesPerMonth,
      sw_estimated_case_revenue: usage.estRevenue,
      sw_at_risk_reason: health.status === "at_risk" ? health.reasons.join("; ") : undefined,
    });
    if (wb.ok) stats.writebacks += 1;

    // ---- expert-review task automation (delivered w/o offer) ----
    for (const c of firmCases) {
      if (c.case_status !== "delivered" || c.expert_review_offered || c.expert_review_task_created) continue;
      const res = await hsCreateObject("tasks", {
        hs_task_subject: "Offer 15-minute expert review call",
        hs_task_body: `[type:expert_review][case:${c.case_id}] Case "${c.case_name ?? c.case_id}" ` +
          `for ${company.name ?? company.hubspot_id} was delivered. Offer a 15-minute ` +
          `expert review call. Suggested email subject: "${c.case_name ?? "Case"} Expert Witness Call".`,
        hs_task_status: "NOT_STARTED",
        hs_task_priority: "HIGH",
        hs_timestamp: now.toISOString(),
      }, [{ toId: company.hubspot_id, associationTypeId: ASSOC.taskToCompany }]);
      if (res.ok || res.skipped) {
        await sb.from("cases").update({ expert_review_task_created: true }).eq("case_id", c.case_id);
        stats.expertTasks += 1;
      }
    }
  }

  // ---- AE -> CS handoff upsert (First Case Committed or Closed Won) ----
  for (const d of deals ?? []) {
    const committed = d.stage === SALES_STAGES.firstCaseCommitted || d.stage === "closedwon";
    if (!committed || existingHandoffDeals.has(d.hubspot_id)) continue;
    const props = (d.properties ?? {}) as Record<string, string | null>;
    await sb.from("handoffs").insert({
      deal_hubspot_id: d.hubspot_id,
      company_hubspot_id: d.company_hubspot_id,
      handoff_created_date: d.closed_at ?? d.hs_created_at ?? new Date().toISOString(),
      handoff_owner: d.owner_id as string | null,
      handoff_status: props.sw_handoff_accepted_by_cs === "true" ? "accepted" : "pending",
      handoff_accepted_date: props.sw_handoff_accepted_by_cs === "true" ? new Date().toISOString() : null,
      source: props.sw_lead_source ?? null,
      pain_point: props.sw_primary_objection ?? null,
      next_step: props.sw_next_step ?? null,
    }).then(() => undefined, () => undefined);
    await hsUpdateProperties("deals", d.hubspot_id, {
      sw_handoff_status: props.sw_handoff_accepted_by_cs === "true" ? "accepted" : "pending",
      sw_handoff_created_date: (d.closed_at ?? d.hs_created_at ?? new Date().toISOString()).slice(0, 10),
    });
    stats.handoffs += 1;
  }
  void nowMs;
  return stats;
}
