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
  FREE_EMAIL_DOMAINS, type PostHogCase, type PostHogIntake, type PostHogSignup,
} from "@/lib/cases/provider";
import { env } from "@/lib/env";
import {
  computeAccountHealth, type AccountHealthStatus, type FirmSegment, type SegmentRule,
} from "@/lib/health";
import { hsCreateObject, hsUpdateProperties, ASSOC } from "@/lib/hubspot/client";
import { SALES_PIPELINE_ID, SALES_STAGES } from "@/lib/hubspot/stages";
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

const HEALTH_STATUSES = new Set([
  "churned", "at_risk", "healthy", "active_below_target",
  "activated", "awaiting_first_case", "new_handoff",
]);
function normalizeHealthOverride(v: string | null): AccountHealthStatus | null {
  const s = (v ?? "").trim().toLowerCase();
  return HEALTH_STATUSES.has(s) ? (s as AccountHealthStatus) : null;
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
  const stats = {
    posthog: 0, mapped: 0, unmapped: 0, intake: 0, intakeEvents: 0, dedupedIntake: 0,
    bootstrapped: 0, purgedTest: 0, signups: 0, signupsMapped: 0, signupsCreated: 0,
  };

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
  const { data: existingCases } = await sb.from("cases").select("case_id, case_status, company_hubspot_id, submitted_date, source");

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

  // Intake-vs-in-app dedupe: a case submitted via the intake form is often ALSO
  // re-created in-app on the firm's production account, producing a PostHog case
  // for the same physical matter. PostHog case events carry no name, so we match
  // 1:1 by firm + date proximity: each intake submission "absorbs" at most one
  // in-app case within +/-4 days, and that in-app duplicate is skipped.
  const intakeByCompany = new Map<string, { t: number; used: boolean }[]>();
  for (const c of existingCases ?? []) {
    if (c.source !== "intake_form" || !c.company_hubspot_id || !c.submitted_date) continue;
    const t = new Date(c.submitted_date).getTime();
    if (Number.isNaN(t)) continue;
    intakeByCompany.set(c.company_hubspot_id,
      [...(intakeByCompany.get(c.company_hubspot_id) ?? []), { t, used: false }]);
  }
  const intakeDuplicate = (companyId: string | null, submittedAt: string | null): boolean => {
    if (!companyId || !submittedAt) return false;
    const t = new Date(submittedAt).getTime();
    if (Number.isNaN(t)) return false;
    const slots = intakeByCompany.get(companyId);
    if (!slots) return false;
    let best: { t: number; used: boolean } | null = null, bestDiff = Infinity;
    for (const s of slots) {
      if (s.used) continue;
      const diff = Math.abs(s.t - t);
      if (diff <= 4 * DAY && diff < bestDiff) { best = s; bestDiff = diff; }
    }
    if (best) { best.used = true; return true; }
    return false;
  };

  // ---- PostHog cases + intake submissions + signups ----
  let phCases: PostHogCase[] = [];
  let phIntakes: PostHogIntake[] = [];
  let phSignups: PostHogSignup[] = [];
  if (env.posthogKey() && env.posthogProjectId()) {
    try {
      const provider = new PostHogProvider(
        env.posthogKey(), env.posthogProjectId(), env.posthogHost(),
      );
      phCases = await provider.listAllCases();
      phIntakes = await provider.listIntakeSubmissions();
      phSignups = await provider.listSignups();
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

    // Skip in-app cases that duplicate an intake submission for the same firm
    // (same physical matter entered via intake AND re-created in-app). Only
    // skip NEW ones; never delete a case a human/CS already curated.
    if (!existingById.has(pc.caseId) && intakeDuplicate(companyId, submittedAt)) {
      stats.dedupedIntake += 1;
      continue;
    }

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
  // ---- PostHog intake-form submissions (no caseId on these events) ----
  // Each completed submission == one case, keyed by the event uuid. Firm is
  // resolved via account group, then email domain (bootstrapping the mapping).
  // Excludes test actors and SW-internal (mode='internal') submissions, and
  // de-dupes against a caseId-based PostHog case for the same firm within 2d.
  for (const it of phIntakes) {
    if (isTestCaseActor(it.email, it.accountId)) continue;
    if ((it.mode ?? "") === "internal") continue;
    const caseId = `intake_evt_${it.eventId}`;
    if (existingById.has(caseId)) continue;
    let companyId: string | null = (it.accountId && byAccount.get(it.accountId)) || null;
    if (!companyId) {
      const dom = emailDomain(it.email);
      const co = dom ? byDomain.get(dom) : undefined;
      if (co) {
        companyId = co.hubspot_id;
        if (it.accountId && !byAccount.has(it.accountId)) {
          byAccount.set(it.accountId, companyId);
          bootstrapMappings.push({ sw_account_id: it.accountId, hubspot_company_id: companyId, confirmed: false });
        }
      }
    }
    // Skip submissions we can't attribute to a firm (anonymous public-portal
    // intakes carry no account/email). An unmapped intake can't be tied to a
    // customer and would inflate revenue/volume as a phantom row - and it's
    // almost always the same case the firm also has in-app.
    if (!companyId) continue;
    // dedupe: skip if a caseId-based PostHog case already exists for this firm
    // within 2 days (same physical case captured via both paths).
    const ts = it.submittedAt ? new Date(it.submittedAt).getTime() : null;
    const near = ts !== null &&
      (phByCompany.get(companyId) ?? []).some((t) => Math.abs(t - ts) <= 2 * DAY);
    if (near) continue;
    inserts.push({
      case_id: caseId,
      sw_id: caseId,
      company_hubspot_id: companyId,
      case_name: "Intake submission",
      case_status: "submitted",
      submitted_date: it.submittedAt,
      submitted_at: it.submittedAt,
      source: "posthog_intake",
      posthog_account_id: it.accountId,
      creator_email: it.email,
      revenue_amount: 250,
      updated_at: new Date().toISOString(),
    });
    stats.intakeEvents += 1;
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
    // A closed-won intake deal is a finished, invoiced case -> mark completed so
    // the firm counts as an activated customer (not stuck pre-first-case).
    const done = d.stage === SALES_STAGES.closedWon;
    inserts.push({
      case_id: caseId,
      sw_id: caseId,
      company_hubspot_id: d.company_hubspot_id,
      case_name: d.name,
      case_status: done ? "completed" : "submitted",
      submitted_date: d.hs_created_at,
      submitted_at: d.hs_created_at,
      ...(done ? { completed_date: d.hs_created_at } : {}),
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

  // ---- Signups: firms that created an app account -------------------------
  // Map each signed-up account to a firm (account id -> email domain). Unmapped
  // signups on a real (non-free) domain get a lightweight HubSpot company + MQL
  // deal so CS can work them. Earliest signup/subscription per firm wins.
  const companyName = new Map<string, string | null>(
    (companies ?? []).map((c) => [c.hubspot_id, c.name]),
  );
  const signupByCompany = new Map<string, { signedUpAt: string | null; subscribedAt: string | null; accountId: string }>();
  const recordSignup = (companyId: string, s: PostHogSignup) => {
    const prev = signupByCompany.get(companyId);
    const min = (a: string | null, b: string | null) =>
      !a ? b : !b ? a : (a < b ? a : b);
    signupByCompany.set(companyId, {
      accountId: prev?.accountId ?? s.accountId,
      signedUpAt: min(prev?.signedUpAt ?? null, s.signedUpAt),
      subscribedAt: min(prev?.subscribedAt ?? null, s.subscribedAt),
    });
  };

  for (const s of phSignups) {
    if (isTestCaseActor(s.email, s.accountId)) continue;
    stats.signups += 1;
    let companyId: string | null = byAccount.get(s.accountId) ?? null;
    if (!companyId) {
      const dom = emailDomain(s.email);
      const co = dom ? byDomain.get(dom) : undefined;
      if (co) companyId = co.hubspot_id;
      // Unmapped + real firm domain -> create a lightweight company + MQL deal.
      if (!companyId && dom && !FREE_EMAIL_DOMAINS.has(dom)) {
        const name = companyNameFromDomain(dom);
        const created = await hsCreateObject("companies", {
          name, domain: dom, sw_lead_source: "app_signup",
        });
        if (created.ok && created.id) {
          companyId = created.id;
          const lite: CompanyLite = {
            hubspot_id: companyId, name, domain: dom, sw_account_id: null, properties: {},
          };
          byDomain.set(dom, lite);
          companyName.set(companyId, name);
          // Seed the Supabase cache row so it shows before the next HubSpot sync.
          await sb.from("companies").upsert(
            { hubspot_id: companyId, name, domain: dom, properties: {} },
            { onConflict: "hubspot_id" },
          ).then(() => undefined, () => undefined);
          // MQL-style deal so it also appears in the sales funnel.
          await hsCreateObject("deals", {
            dealname: name,
            pipeline: SALES_PIPELINE_ID,
            dealstage: SALES_STAGES.mql,
            sw_lead_source: "app_signup",
          }, [{ toId: companyId, associationTypeId: ASSOC.dealToCompany }]);
          stats.signupsCreated += 1;
        }
      }
    }
    if (!companyId) { stats.unmapped += 1; continue; }
    if (s.accountId && !byAccount.has(s.accountId)) byAccount.set(s.accountId, companyId);
    stats.signupsMapped += 1;
    recordSignup(companyId, s);
  }

  for (const [companyId, s] of signupByCompany) {
    // Never overwrite a known subscription date with null: a firm can be marked
    // a subscriber manually (billing_type/subscription) without PostHog ever
    // emitting subscription_created.
    const row: Record<string, unknown> = {
      signed_up_at: s.signedUpAt,
      signup_account_id: s.accountId,
      updated_at: new Date().toISOString(),
    };
    if (s.subscribedAt) row.subscribed_at = s.subscribedAt;
    await sb.from("companies").update(row).eq("hubspot_id", companyId)
      .then(() => undefined, () => undefined);
  }
  void companyName;

  return stats;
}

/** Human-ish company name from an email domain, e.g. pcilc.la -> "Pcilc". */
function companyNameFromDomain(domain: string): string {
  const base = domain.split(".")[0] ?? domain;
  return base.charAt(0).toUpperCase() + base.slice(1);
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
  const stats = { firms: 0, writebacks: 0, expertTasks: 0, handoffs: 0, dealsClosed: 0 };

  const [{ data: companies }, { data: cases }, { data: deals }, { data: handoffs }] =
    await Promise.all([
      sb.from("companies").select("hubspot_id, name, domain, properties, monthly_case_target, firm_segment, first_case_commitment_date, actual_revenue"),
      sb.from("cases").select("case_id, company_hubspot_id, case_status, submitted_date, completed_date, delivered_date, revenue_amount, expert_review_offered, expert_review_task_created, case_name, issue_flag"),
      sb.from("deals").select("hubspot_id, name, company_hubspot_id, stage, activation_stage, owner_id, closed_at, hs_created_at, properties"),
      sb.from("handoffs").select("company_hubspot_id"),
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
  const existingHandoffCompanies = new Set((handoffs ?? []).map((h) => h.company_hubspot_id));

  // Signup dates (0003). Fetched separately + tolerantly so a not-yet-applied
  // migration can't break the rollup.
  const signedUpByCompany = new Map<string, string>();
  {
    const { data: su } = await sb.from("companies")
      .select("hubspot_id, signed_up_at")
      .not("signed_up_at", "is", null);
    for (const r of su ?? []) {
      if (r.signed_up_at) signedUpByCompany.set(r.hubspot_id, r.signed_up_at);
    }
  }

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
    const signedUp = signedUpByCompany.has(company.hubspot_id);
    const isCustomer = firmCases.length > 0 || signedUp ||
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

    // A delivered case is by definition completed; fall back to delivered_date
    // (and the submit date for rows flagged completed/delivered) so a firm with
    // delivered-but-not-explicitly-"completed" cases still counts as activated.
    const completedDates = firmCases
      .map((c) => c.completed_date ?? c.delivered_date
        ?? (["completed", "delivered"].includes(c.case_status ?? "") ? c.submitted_date : null))
      .filter(Boolean)
      .sort() as string[];
    const firstCaseCompletedDate = completedDates[0] ?? null;
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
      signedUp,
      healthOverride: normalizeHealthOverride(
        company.properties?.sw_health_override as string | null),
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

    // ---- auto-advance sales deal to Closed Won on first real case ----
    // A firm that has submitted a case is a won customer; its sales deal must
    // not sit in an open stage. Close date = first case date. Idempotent (only
    // touches OPEN-stage deals). Supabase is updated too so the dashboard
    // reflects it without waiting for HubSpot's list-API to re-index.
    if (usage.firstCaseAt) {
      for (const d of companyDeals) {
        if (!OPEN_SALES_STAGES.has(d.stage as string)) continue;
        const dealId = d.hubspot_id as string;
        const closeIso = usage.firstCaseAt;
        const wb = await hsUpdateProperties("deals", dealId, {
          dealstage: SALES_STAGES.closedWon,
          closedate: closeIso,
        });
        if (wb.ok || wb.skipped) {
          await sb.from("deals").update({
            stage: SALES_STAGES.closedWon, stage_label: "Closed Won", closed_at: closeIso,
          }).eq("hubspot_id", dealId).then(() => undefined, () => undefined);
          stats.dealsClosed += 1;
        }
      }
    }

    // ---- AE/product -> CS handoff (account-based) ----
    // Fires on a REAL activation signal: first actual case, or app signup.
    // NOT on the "First Case Committed" sales stage (that's only a promise).
    if (!existingHandoffCompanies.has(company.hubspot_id)) {
      const signupAt = signedUpByCompany.get(company.hubspot_id) ?? null;
      const triggerType = usage.firstCaseAt ? "first_case" : signupAt ? "signup" : null;
      const triggerDate = usage.firstCaseAt ?? signupAt;
      if (triggerType && triggerDate) {
        // Baseline pre-existing accounts as already accepted; only firms that
        // became real in the last 3 days surface as a new handoff to accept.
        const isNew = nowMs - new Date(triggerDate).getTime() < 3 * DAY;
        const deal = companyDeals.find((d) => d.stage === "closedwon") ?? companyDeals[0];
        const props = (deal?.properties ?? {}) as Record<string, string | null>;
        await sb.from("handoffs").insert({
          company_hubspot_id: company.hubspot_id,
          trigger_type: triggerType,
          deal_hubspot_id: (deal?.hubspot_id as string | undefined) ?? null,
          handoff_created_date: triggerDate,
          handoff_owner: (deal?.owner_id as string | null) ?? null,
          handoff_status: isNew ? "pending" : "accepted",
          handoff_accepted_date: isNew ? null : new Date().toISOString(),
          source: props.sw_lead_source ?? (triggerType === "signup" ? "app_signup" : null),
          next_step: props.sw_next_step ?? null,
        }).then(() => undefined, () => undefined);
        existingHandoffCompanies.add(company.hubspot_id);
        stats.handoffs += 1;
      }
    }
  }

  void nowMs;
  return stats;
}
