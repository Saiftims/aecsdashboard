/** Case ingestion + reconciliation + CS rollups.
 *
 * Cases feed from PostHog (case_created=submitted, report_generation_completed=
 * completed, report_downloaded=delivered), reconciled with HubSpot "intake"
 * deals, plus manual rows. Test/internal accounts are excluded. Cases live in
 * Supabase (workflow source of truth); firm/account + handoff fields are
 * mirrored to HubSpot.
 */
import {
  PostHogProvider, EXCLUDED_CASE_IDS, TEST_ACCOUNT_IDS, TEST_EMAILS, isTestCaseActor,
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
import { must, selectAll, supabaseService } from "@/lib/supabase/server";

const DAY = 24 * 60 * 60 * 1000;

/** A case id minted by the platform, as opposed to a synthetic key we invent for
 * a hand-entered row (intake_..., manual_...). */
const REAL_CASE_ID = /^case_[0-9a-fA-F]{8,}$/;

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
/** One `case_ui_usage` row per case, customer and staff activity apart.
 * Returns the number of cases written. */
async function syncCaseUiUsage(provider: PostHogProvider): Promise<number> {
  const rows = await provider.listCaseUiUsage();
  type Agg = {
    v1: number; v2: number; v1First: string | null; v1Last: string | null; v2First: string | null; v2Last: string | null;
    custEvents: number; custFirst: string | null; custLast: string | null;
    staffV1: number; staffV2: number; staffLastUi: string | null; staffLastAt: string | null;
    accounts: Set<string>; emails: Set<string>;
  };
  const byCase = new Map<string, Agg>();
  const minIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
  const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
  for (const r of rows) {
    const a = byCase.get(r.caseId) ?? {
      v1: 0, v2: 0, v1First: null, v1Last: null, v2First: null, v2Last: null,
      custEvents: 0, custFirst: null, custLast: null,
      staffV1: 0, staffV2: 0, staffLastUi: null, staffLastAt: null, accounts: new Set(), emails: new Set(),
    };
    if (r.account) a.accounts.add(r.account);
    const staff = isTestCaseActor(r.email, r.account);
    // ui === "" is activity from before the case_ui flag existed (or an event
    // without it): it dates the case but says nothing about which UI.
    if (staff) {
      a.staffLastAt = maxIso(a.staffLastAt, r.last);
      if (r.ui === "v1") a.staffV1 += r.events; else if (r.ui === "v2") a.staffV2 += r.events;
      if (r.ui && (!a.staffLastUi || (r.last ?? "") >= (a.staffLastAt ?? ""))) a.staffLastUi = r.ui;
    } else {
      if (r.email) a.emails.add(r.email);
      a.custEvents += r.events; a.custFirst = minIso(a.custFirst, r.first); a.custLast = maxIso(a.custLast, r.last);
      if (r.ui === "v1") { a.v1 += r.events; a.v1First = minIso(a.v1First, r.first); a.v1Last = maxIso(a.v1Last, r.last); }
      else if (r.ui === "v2") { a.v2 += r.events; a.v2First = minIso(a.v2First, r.first); a.v2Last = maxIso(a.v2Last, r.last); }
    }
    byCase.set(r.caseId, a);
  }
  const now = new Date().toISOString();
  const out = [...byCase.entries()].map(([case_id, a]) => ({
    case_id, v1_events: a.v1, v2_events: a.v2, v1_first: a.v1First, v1_last: a.v1Last, v2_first: a.v2First, v2_last: a.v2Last,
    customer_events: a.custEvents, customer_first: a.custFirst, customer_last: a.custLast,
    staff_v1_events: a.staffV1, staff_v2_events: a.staffV2, staff_last_ui: a.staffLastUi, staff_last: a.staffLastAt,
    accounts: [...a.accounts], customer_emails: [...a.emails], synced_at: now,
  }));
  const sb = supabaseService();
  for (let i = 0; i < out.length; i += 500) {
    await must(
      `case_ui_usage upsert batch ${i / 500 + 1}`,
      sb.from("case_ui_usage").upsert(out.slice(i, i + 500), { onConflict: "case_id" }),
    );
  }
  return out.length;
}

// ---------------------------------------------------------------------------
export async function syncCases() {
  const sb = supabaseService();
  const stats = {
    posthog: 0, fromUrls: 0, mapped: 0, unmapped: 0, intake: 0, intakeEvents: 0, stripeInvoiced: 0, dedupedStandIn: 0,
    bootstrapped: 0, purgedTest: 0, signups: 0, signupsMapped: 0, signupsCreated: 0, uiCases: 0,
  };

  // Purge any previously-ingested test/internal cases (idempotent cleanup).
  const purgeOr = [
    `posthog_account_id.in.(${TEST_ACCOUNT_IDS.join(",")})`,
    `creator_email.in.(${TEST_EMAILS.join(",")})`,
  ];
  if (EXCLUDED_CASE_IDS.length) {
    purgeOr.push(`case_id.in.(${EXCLUDED_CASE_IDS.join(",")})`);
  }
  const purge = await must(
    "cases purge (test actors)",
    sb.from("cases").delete({ count: "exact" }).or(purgeOr.join(",")),
  );
  stats.purgedTest = purge.count ?? 0;
  // Also drop cases whose creator is an internal silentwitness.ai / saif+ user.
  await must("cases purge (silentwitness.ai)", sb.from("cases").delete().like("creator_email", "%@silentwitness.ai"));
  await must("cases purge (saif+)", sb.from("cases").delete().like("creator_email", "saif+%"));

  // Paginated reads (`selectAll`): PostgREST caps a plain select at 1000 rows
  // and returns the first page WITHOUT an error, so once companies passed
  // 1000 (983 on 2026-10-21) the sync would silently have run against a
  // slice and filed the missing firms' cases as unmapped. A failed read
  // throws rather than coming back `null`, for the same reason.
  const companies = await selectAll<CompanyLite & { sw_account_id: string | null; properties: Record<string, unknown> | null }>(
    "companies", "hubspot_id, name, domain, sw_account_id, properties");
  const { data: mappings } = await must("firm_mapping read", sb.from("firm_mapping").select("*"));
  const deals = await selectAll<{ hubspot_id: string; name: string | null; company_hubspot_id: string | null; stage: string | null; hs_created_at: string | null; properties: Record<string, unknown> | null }>(
    "deals", "hubspot_id, name, company_hubspot_id, stage, hs_created_at, properties");
  const existingCases = await selectAll<{ case_id: string; sw_id: string | null; case_status: string | null; company_hubspot_id: string | null; submitted_date: string | null; source: string | null; case_name: string | null }>(
    "cases", "case_id, sw_id, case_status, company_hubspot_id, submitted_date, source, case_name", "case_id");

  const byDomain = new Map<string, CompanyLite>();
  const byAccount = new Map<string, string>(); // acc -> hubspot_company_id
  // Branded intake portal slug -> firm. A public submission carries no account
  // and no person, so its portal host is the only thing identifying the firm.
  // Indexed on both the domain stem and the squashed company name, because the
  // slug is chosen by hand and matches one or the other ('nordean' sits under
  // nordeanlaw.com; 'stittvu' under Stitt Vu Trial Lawyers).
  const bySlug = new Map<string, string>();
  const addSlug = (key: string | null | undefined, id: string) => {
    const k = (key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    // Ambiguity must not silently pick a winner and bill the wrong firm.
    if (!k) return;
    bySlug.set(k, bySlug.has(k) && bySlug.get(k) !== id ? "" : id);
  };
  for (const c of (companies ?? []) as CompanyLite[]) {
    if (c.domain) byDomain.set(c.domain.toLowerCase(), c);
    if (c.sw_account_id) byAccount.set(c.sw_account_id, c.hubspot_id);
    addSlug(c.domain?.split(".")[0], c.hubspot_id);
    addSlug(c.name, c.hubspot_id);
  }
  /** Longest company whose squashed name/domain starts with the slug, so
   * 'nordean' still finds 'nordeanlaw.com' / 'Nordean Law'. Exact wins first. */
  const companyForSlug = (slug: string | null): string | null => {
    if (!slug) return null;
    const exact = bySlug.get(slug);
    if (exact) return exact;
    const hits = [...bySlug.entries()]
      .filter(([k, v]) => v && k.startsWith(slug))
      .map(([, v]) => v);
    return new Set(hits).size === 1 ? hits[0] : null;
  };
  for (const m of mappings ?? []) {
    if (m.sw_account_id && m.hubspot_company_id) byAccount.set(m.sw_account_id, m.hubspot_company_id);
  }
  const existingById = new Map((existingCases ?? []).map((c) => [c.case_id, c]));
  // `sw_id` is the table's PRIMARY KEY and is where a hand-entered row records
  // the platform id of the matter it stands for (Morrin's "Cordova v. Stacy":
  // case_id intake_6a29..., sw_id case_932665...). A discovered case whose id
  // sits in that column is that row, not a new case - inserting it fails on
  // the key, and would double the matter if it did not.
  const existingBySwId = new Map((existingCases ?? []).flatMap((c) => (c.sw_id && c.sw_id !== c.case_id ? [[c.sw_id, c] as const] : [])));

  // Stand-in dedupe: the same physical matter can already be in the table as a
  // hand-entered row - an intake-form submission that was also re-created in-app,
  // or a row a human added precisely BECAUSE tracking missed the real case. Case
  // events carry no matter name, so we match 1:1 by firm + date proximity: each
  // stand-in "absorbs" at most one discovered case, which is then skipped.
  //
  // The window depends on how trustworthy the stand-in's date is, and is
  // asymmetric for hand-entered rows. Intake submissions carry a real submission
  // timestamp, so a tight window either side is right. A manually added row
  // carries whatever date the person entering it estimated, which can be weeks
  // late (Sunset West's placeholder was 20 days after the real case) - but it
  // cannot stand in for a case that had not happened yet when it was typed, so
  // it must not reach far forward and swallow a genuinely new case.
  const STAND_IN_WINDOW: Record<string, { before: number; after: number }> = {
    intake_form: { before: 4 * DAY, after: 4 * DAY },
    hubspot_intake: { before: 4 * DAY, after: 4 * DAY },
    manual: { before: 30 * DAY, after: 4 * DAY },
    app: { before: 30 * DAY, after: 4 * DAY },
  };
  interface StandIn { t: number; used: boolean; before: number; after: number }
  const standInByCompany = new Map<string, StandIn[]>();
  for (const c of existingCases ?? []) {
    const window = STAND_IN_WINDOW[c.source ?? ""];
    if (!window || !c.company_hubspot_id || !c.submitted_date) continue;
    // A row typed in WITH the platform's real case id is not a placeholder for
    // anything: the discovered case matches it by id, so handing it a stand-in
    // slot only lets it swallow a DIFFERENT, genuinely new case for the same
    // firm. That hid Stitt Vu's third July case behind "Amador v. Reinoso".
    if (REAL_CASE_ID.test(c.case_id)) continue;
    const t = new Date(c.submitted_date).getTime();
    if (Number.isNaN(t)) continue;
    standInByCompany.set(c.company_hubspot_id,
      [...(standInByCompany.get(c.company_hubspot_id) ?? []), { t, used: false, ...window }]);
  }
  const absorbedByStandIn = (companyId: string | null, submittedAt: string | null): boolean => {
    if (!companyId || !submittedAt) return false;
    const t = new Date(submittedAt).getTime();
    if (Number.isNaN(t)) return false;
    const slots = standInByCompany.get(companyId);
    if (!slots) return false;
    let best: StandIn | null = null, bestDiff = Infinity;
    for (const s of slots) {
      if (s.used) continue;
      // s.t is the stand-in's date, t the real case's: reach back s.before and
      // forward s.after from the stand-in.
      const limit = t <= s.t ? s.before : s.after;
      const diff = Math.abs(s.t - t);
      if (diff <= limit && diff < bestDiff) { best = s; bestDiff = diff; }
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
      // Recover cases that emit no caseId-bearing event (in-app intake
      // submissions), whose id is only visible in the /cases/<id> URL. Event
      // data wins where both exist - it carries completed/delivered timestamps.
      const seen = new Set(phCases.map((c) => c.caseId));
      for (const uc of await provider.listCasesFromUrls()) {
        if (!seen.has(uc.caseId)) {
          phCases.push(uc);
          stats.fromUrls += 1;
        }
      }
      // Old UI vs new UI per case (case_ui property, since 2026-10-13). Its
      // own try: a failure here must not cost the case ingest below.
      try {
        stats.uiCases = await syncCaseUiUsage(provider);
      } catch (e) {
        console.error("case_ui sync failed:", e instanceof Error ? e.message : e);
      }
    } catch (e) {
      console.error("PostHog fetch failed:", e instanceof Error ? e.message : e);
    }
  }

  const bootstrapMappings: { sw_account_id: string; hubspot_company_id: string; confirmed: boolean }[] = [];
  const inserts: Record<string, unknown>[] = [];
  const updates: { case_id: string; row: Record<string, unknown> }[] = [];
  // caseId -> firm, as actually resolved below. The later dedupe passes need the
  // same answer; re-deriving it from the account id alone would miss cases
  // attributed by email domain or by branded portal, and duplicate them.
  const resolvedCompany = new Map<string, string>();

  // Cases created by a submission on a firm's own branded intake portal.
  //
  // Nobody is signed in on a public portal, so the case carries no account and no
  // email, and the only people who ever touch it afterwards are the Silent
  // Witness analysts who work it up - which made isTestCaseActor() discard it as
  // internal. That is the documented failure mode of attributing a case to its
  // busiest actor rather than its submitter, and it lost Nordean both August
  // cases. The submission event names the firm in its host and (since 2026-07-30)
  // carries the case id, so the two can be tied together exactly.
  const portalCase = new Map<string, { companyId: string; submittedAt: string | null }>();
  for (const it of phIntakes) {
    if ((it.mode ?? "") !== "public" || !it.caseId) continue;
    const companyId = companyForSlug(it.portalSlug);
    if (companyId) portalCase.set(it.caseId, { companyId, submittedAt: it.submittedAt });
  }
  // Cases staff file INTO a customer's account while impersonating it. Same
  // failure as the portal: every actor is staff, so the case read as internal
  // and was dropped (Megeredchian's two on 2026-10-01). The submission event
  // names the target account and its firm, so it is attributed the same way
  // and stored with no creator/account for the same reason. Only an exact firm
  // match counts - an impersonated demo org ("Doe & Partners LLP") matches no
  // company and stays out - and only with evidence attached: a zero-file
  // submission is staff setting an account up (Adam M. Thompson, 2026-08-26).
  for (const it of phIntakes) {
    const target = it.targetAccountId;
    if (!it.caseId || !target || target === it.accountId || portalCase.has(it.caseId)) continue;
    if (!isTestCaseActor(it.email, it.accountId) || TEST_ACCOUNT_IDS.includes(target)) continue;
    if (!(it.fileCount && it.fileCount > 0)) continue;
    const byName = bySlug.get((it.firmName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")) || null;
    const companyId = byAccount.get(target) ?? byName;
    if (!companyId) continue;
    if (!byAccount.has(target)) {
      byAccount.set(target, companyId);
      bootstrapMappings.push({ sw_account_id: target, hubspot_company_id: companyId, confirmed: false });
      stats.bootstrapped += 1;
    }
    portalCase.set(it.caseId, { companyId, submittedAt: it.submittedAt });
  }
  const phCaseIds = new Set(phCases.map((c) => c.caseId));

  // Oldest first: stand-in slots are single-use, so the pairing (and therefore
  // which cases get skipped) must not depend on PostHog's row order.
  phCases.sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));

  for (const pc of phCases) {
    // A portal case has a known customer behind it, so the analysts working it
    // must not read as "this is an internal case".
    const portal = portalCase.get(pc.caseId);
    if (!portal && isTestCaseActor(pc.creatorEmail, pc.accountId)) continue;
    if (EXCLUDED_CASE_IDS.includes(pc.caseId)) continue;
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
    if (portal) companyId = portal.companyId;
    if (companyId) {
      stats.mapped += 1;
      resolvedCompany.set(pc.caseId, companyId);
    } else stats.unmapped += 1;

    // Fall back to completed/delivered when there's no valid submitted date
    // (a case can appear via report events without a case_created event).
    // A portal case is dated by its submission: its other events belong to the
    // analyst picking it up, which can be days later.
    const submittedAt = portal?.submittedAt ?? pc.submittedAt ?? pc.completedAt ?? pc.deliveredAt;

    // Skip discovered cases that a hand-entered row already stands in for. Only
    // skip NEW ones; never delete a case a human/CS already curated.
    if (!existingById.has(pc.caseId) && absorbedByStandIn(companyId, submittedAt)) {
      stats.dedupedStandIn += 1;
      continue;
    }
    // A hand-entered row already carries this platform id as its sw_id (the
    // matter was billed under another id first) - that row is the case.
    if (!existingById.has(pc.caseId) && existingBySwId.has(pc.caseId)) {
      stats.dedupedStandIn += 1;
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
        // A portal case has no submitter identity, and its only actors are the
        // analysts. Storing one of those here would be wrong on the face of it
        // AND fatal: the purge at the top of this sync deletes any case whose
        // creator is a silentwitness.ai address or whose account is the internal
        // one, so the row would be dropped again on every run.
        posthog_account_id: portal ? null : pc.accountId,
        creator_email: portal ? null : pc.creatorEmail,
        revenue_amount: 250,
        updated_at: new Date().toISOString(),
      });
    } else {
      // Update dates + company; advance status only if still auto (never
      // override a CS-set issue_open / cancelled).
      const row: Record<string, unknown> = {
        company_hubspot_id: companyId ?? existing.company_hubspot_id,
        ...(portal ? { posthog_account_id: null, creator_email: null } : {}),
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
      if (submittedAt && (existingBad || portal)) {
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
    // Same portal exemption as the ingestion loop: judging a portal case by its
    // actors calls it internal and leaves it out of this index, which is how a
    // hand-entered stand-in for it gets recreated as a duplicate every run.
    const portal = portalCase.get(pc.caseId);
    const submittedAt = portal?.submittedAt ?? pc.submittedAt;
    if (!portal && isTestCaseActor(pc.creatorEmail, pc.accountId)) continue;
    if (!submittedAt || EXCLUDED_CASE_IDS.includes(pc.caseId)) continue;
    const cid = resolvedCompany.get(pc.caseId) ??
      ((pc.accountId && byAccount.get(pc.accountId)) || null);
    if (cid) phByCompany.set(cid, [...(phByCompany.get(cid) ?? []), new Date(submittedAt).getTime()]);
  }
  // ---- PostHog intake-form submissions (no caseId on these events) ----
  // Each completed submission == one case, keyed by the event uuid. Firm is
  // resolved via account group, then email domain (bootstrapping the mapping).
  // Excludes test actors, and de-dupes against a caseId-based PostHog case for
  // the same firm within 2d.
  // mode='internal' means a signed-in firm user submitting in-app (NOT Silent
  // Witness staff - see listIntakeSubmissions). Those create a real case that
  // listCasesFromUrls() ingests under its true id, so they are skipped here
  // rather than duplicated as an intake_evt_ row.
  for (const it of phIntakes) {
    if (isTestCaseActor(it.email, it.accountId)) continue;
    if ((it.mode ?? "") === "internal") continue;
    // The submission names the case it created and that case is being ingested
    // under its real id, so a synthetic intake_evt_ row would be the same matter
    // a second time.
    if (it.caseId && phCaseIds.has(it.caseId)) continue;
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
    // A public-portal submission is anonymous - no account, no signed-in person -
    // so account and domain both fail and it used to be dropped outright. But it
    // was made on the firm's OWN branded portal, so the host names the customer:
    // Nordean's 13 Aug case was lost this way, and its 3 Aug one only survived
    // because somebody happened to open the case page afterwards.
    if (!companyId) companyId = companyForSlug(it.portalSlug);
    // Still nothing: an intake we cannot tie to a customer would inflate
    // revenue and volume as a phantom row.
    if (!companyId) continue;
    // dedupe: skip if a caseId-based PostHog case already exists for this firm
    // within 2 days (same physical case captured via both paths).
    const ts = it.submittedAt ? new Date(it.submittedAt).getTime() : null;
    const near = ts !== null &&
      (phByCompany.get(companyId) ?? []).some((t) => Math.abs(t - ts) <= 2 * DAY);
    if (near) continue;
    // Or a hand-entered row someone added precisely because this submission was
    // never tracked - same rule the discovered-case path uses.
    if (absorbedByStandIn(companyId, it.submittedAt)) {
      stats.dedupedStandIn += 1;
      continue;
    }
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

  // Every row already in the table, by firm, so an intake deal is also deduped
  // against the hand-entered / intake-form row for the same matter. The intake
  // form's HubSpot app creates the deal the minute a case is submitted, so the
  // same case usually exists as an `intake_<submission>` or manual row dated
  // the same day; without this, associating such a deal to its firm (which the
  // health page asks for) created a second case (Nazarian 14 Jul, Cavin Le
  // 21 Jul, Bermudez 16 Sep, Catalan 6 Oct would all have doubled on
  // 2026-10-21).
  const rowsByCompany = new Map<string, number[]>();
  for (const c of existingCases ?? []) {
    if (!c.company_hubspot_id || !c.submitted_date) continue;
    const t = new Date(c.submitted_date).getTime();
    if (!Number.isNaN(t)) rowsByCompany.set(c.company_hubspot_id, [...(rowsByCompany.get(c.company_hubspot_id) ?? []), t]);
  }
  for (const d of deals ?? []) {
    const name = (d.name ?? "").toLowerCase();
    if (!name.includes("intake") || !d.company_hubspot_id || !d.hs_created_at) continue;
    const created = new Date(d.hs_created_at).getTime();
    const caseId = `intake_${d.hubspot_id}`;
    if (existingById.has(caseId)) continue;
    // dedupe vs a PostHog case, or any existing row, for the same firm within 3 days
    const near = [...(phByCompany.get(d.company_hubspot_id) ?? []), ...(rowsByCompany.get(d.company_hubspot_id) ?? [])]
      .some((t) => Math.abs(t - created) <= 3 * DAY);
    if (near) continue;
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

  // ---- Stripe-invoiced cases ----
  // The platform raises an invoice for every case it processes and stamps the
  // real case id, the PostHog account and the matter name on it
  // (`stripe_case_invoices`, filled by the Stripe sync). That is the ONE feed
  // that names the firm behind a case staff entered on a customer's behalf:
  // every actor on such a case is an analyst, PostHog reports the analyst's
  // own org even while impersonating, so the ingestion loop above has to drop
  // it. On 2026-10-23 that was four October cases - three for The Injury Firm
  // and one for Kass & Moses, every one with a paid invoice - which is why the
  // team counted more cases than the dashboard. A row is inserted only when no
  // row holds the id, no stand-in absorbs it and nothing else sits on the same
  // firm within 2 days; creator/account stay NULL (a staff email here would be
  // purged next run) and the Stripe cash prices it, as for any Stripe firm.
  const stripeCaseRows = await selectAll<{
    invoice_id: string; case_id: string; company_hubspot_id: string | null; case_name: string | null;
    status: string | null; is_internal: boolean; created_at: string | null;
  }>("stripe_case_invoices", "invoice_id, case_id, company_hubspot_id, case_name, status, is_internal, created_at", "invoice_id");
  const phById = new Map(phCases.map((c) => [c.caseId, c]));
  const insertedIds = new Set(inserts.map((r) => String(r.case_id)));
  const seenStripeCase = new Set<string>();
  for (const inv of [...stripeCaseRows].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))) {
    if (inv.is_internal || !inv.company_hubspot_id || !inv.created_at) continue;
    if (inv.status === "void" || inv.status === "draft") continue;
    if (EXCLUDED_CASE_IDS.includes(inv.case_id) || seenStripeCase.has(inv.case_id)) continue;
    seenStripeCase.add(inv.case_id);
    const existing = existingById.get(inv.case_id) ?? existingBySwId.get(inv.case_id);
    if (existing) {
      // Already counted; just give it its real name if it only has a stub.
      const stub = !existing.case_name || /^Case [0-9a-f]{8}$/i.test(existing.case_name) || existing.case_name === "Intake submission";
      if (stub && inv.case_name) {
        const u = updates.find((x) => x.case_id === existing.case_id);
        if (u) u.row.case_name = inv.case_name;
        else updates.push({ case_id: existing.case_id, row: { case_name: inv.case_name, updated_at: new Date().toISOString() } });
      }
      continue;
    }
    if (insertedIds.has(inv.case_id)) {
      const r = inserts.find((x) => x.case_id === inv.case_id);
      if (r && inv.case_name) r.case_name = inv.case_name;
      continue;
    }
    // Dated by the EARLIER of PostHog's first sight of the case and the
    // invoice: a case cannot be invoiced before it exists, and PostHog's date
    // on a staff-only case can be an analyst reopening it weeks later (Breyon
    // Maasch: invoiced 22 Jul, PostHog 4 Sep).
    const phAt = phById.get(inv.case_id)?.submittedAt;
    const submittedAt = phAt && Date.parse(phAt) < Date.parse(inv.created_at) ? phAt : inv.created_at;
    const t = new Date(submittedAt).getTime();
    // The id IS the identity, so the only duplicate possible is a hand-entered
    // stand-in for this same matter. No "same firm within N days" test here:
    // The Injury Firm had two distinct invoiced cases 31 minutes apart on
    // 19 Oct, and a date test would have swallowed the second.
    if (absorbedByStandIn(inv.company_hubspot_id, submittedAt)) { stats.dedupedStandIn += 1; continue; }
    inserts.push({
      case_id: inv.case_id,
      sw_id: inv.case_id,
      company_hubspot_id: inv.company_hubspot_id,
      case_name: inv.case_name ?? `Case ${inv.case_id.replace(/^case_/, "").slice(0, 8)}`,
      case_status: "submitted",
      submitted_date: submittedAt,
      submitted_at: submittedAt,
      source: "stripe_invoice",
      revenue_amount: 250,
      updated_at: new Date().toISOString(),
    });
    rowsByCompany.set(inv.company_hubspot_id, [...(rowsByCompany.get(inv.company_hubspot_id) ?? []), t]);
    stats.stripeInvoiced += 1;
  }

  if (bootstrapMappings.length) {
    // Best-effort by design: firm_mapping is also unique on hubspot_company_id,
    // so a firm already mapped under another account id rejects the row. Logged,
    // never fatal.
    await must(
      "firm_mapping bootstrap upsert",
      sb.from("firm_mapping").upsert(bootstrapMappings, { onConflict: "sw_account_id,sw_organization_id" }),
    ).catch((e) => console.error(e instanceof Error ? e.message : e));
  }
  const INSERT_BATCH = 500;
  for (let i = 0; i < inserts.length; i += INSERT_BATCH) {
    await must(
      `cases insert batch ${i / INSERT_BATCH + 1}/${Math.ceil(inserts.length / INSERT_BATCH)}`,
      sb.from("cases").insert(inserts.slice(i, i + INSERT_BATCH)),
    );
  }
  for (const u of updates) {
    await must(`cases update ${u.case_id}`, sb.from("cases").update(u.row).eq("case_id", u.case_id));
  }

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
          // Seed the Supabase cache row so it shows before the next HubSpot
          // sync. Best-effort: the next HubSpot sync writes the real row.
          await must(`companies seed ${companyId}`, sb.from("companies").upsert(
            { hubspot_id: companyId, name, domain: dom, properties: {} },
            { onConflict: "hubspot_id" },
          )).catch((e) => console.error(e instanceof Error ? e.message : e));
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
      signup_account_id: s.accountId,
      updated_at: new Date().toISOString(),
    };
    // Omit rather than null: a null would erase a signup date we already hold,
    // the same way a failed association must never write null over a live link.
    if (s.signedUpAt) row.signed_up_at = s.signedUpAt;
    if (s.subscribedAt) row.subscribed_at = s.subscribedAt;
    // Fatal: a dropped signup date silently removes the firm from "new firms".
    await must(`companies signup update ${companyId}`, sb.from("companies").update(row).eq("hubspot_id", companyId));
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

  // Paginated + checked reads: a plain select caps at 1000 rows without an
  // error, and a failed read coming back null would roll every firm up to zero.
  type RollupCompany = {
    hubspot_id: string; name: string | null; domain: string | null;
    properties: Record<string, string | null> | null;
    monthly_case_target: number | null; firm_segment: string | null;
    first_case_commitment_date: string | null; actual_revenue: number | null;
  };
  type RollupDeal = {
    hubspot_id: string; name: string | null; company_hubspot_id: string | null;
    stage: string | null; activation_stage: string | null; owner_id: string | null;
    closed_at: string | null; hs_created_at: string | null; properties: Record<string, string | null> | null;
  };
  const [companies, cases, deals, { data: handoffs }] =
    await Promise.all([
      selectAll<RollupCompany>("companies", "hubspot_id, name, domain, properties, monthly_case_target, firm_segment, first_case_commitment_date, actual_revenue"),
      selectAll<CaseRow>("cases", "case_id, company_hubspot_id, case_status, submitted_date, completed_date, delivered_date, revenue_amount, expert_review_offered, expert_review_task_created, case_name, issue_flag", "case_id"),
      selectAll<RollupDeal>("deals", "hubspot_id, name, company_hubspot_id, stage, activation_stage, owner_id, closed_at, hs_created_at, properties"),
      must("rollup handoffs read", sb.from("handoffs").select("company_hubspot_id")),
    ]);

  const casesByCompany = new Map<string, CaseRow[]>();
  for (const c of (cases ?? []) as CaseRow[]) {
    if (!c.company_hubspot_id) continue;
    casesByCompany.set(c.company_hubspot_id, [...(casesByCompany.get(c.company_hubspot_id) ?? []), c]);
  }
  const dealsByCompany = new Map<string, RollupDeal[]>();
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
    // The override is read ONLY from HubSpot, where a human sets it (the
    // firm-page "target" input writes both places). The Supabase column is a
    // cache of the EFFECTIVE target for display, and this rollup writes it - so
    // reading the override from there made every derived value sticky: a firm
    // segmented up to mid_size/large kept the small default it was first
    // stamped with, and the segment could never take effect.
    const overrideTarget = company.properties?.sw_monthly_case_target != null
      && company.properties.sw_monthly_case_target !== ""
      ? Number(company.properties.sw_monthly_case_target) : null;
    const monthlyTarget = Number.isFinite(overrideTarget as number)
      ? (overrideTarget as number) : rule.monthlyTarget;

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
    await must(`rollup companies update ${company.hubspot_id}`, sb.from("companies").update({
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
    }).eq("hubspot_id", company.hubspot_id));

    // ---- HubSpot write-back (firm/account source of truth) ----
    const wb = await hsUpdateProperties("companies", company.hubspot_id, {
      sw_account_health: health.status,
      sw_firm_segment: segment ?? undefined,
      // sw_monthly_case_target is deliberately NOT written here: it holds the
      // human's override and this rollup would otherwise overwrite it with the
      // value it just derived, making the segment default permanent.
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
        // Fatal: if this flag is lost the same task is created again next run.
        await must(
          `cases expert_review_task_created ${c.case_id}`,
          sb.from("cases").update({ expert_review_task_created: true }).eq("case_id", c.case_id),
        );
        stats.expertTasks += 1;
      }
    }

    // ---- auto-advance sales deal to Closed Won on first real case ----
    // A firm that has submitted a case is a won customer; its sales deal must
    // not sit in an open stage. Close date = first case date. Supabase is updated
    // too so the dashboard reflects it without waiting for HubSpot's list-API to
    // re-index.
    // At most ONE deal per firm is ever auto-closed, and only a deal that already
    // existed when the case landed. A deal opened after that is a re-engagement or
    // duplicate: back-dating it to an old first case would double-count the win and
    // silently bury a live demo.
    if (usage.firstCaseAt) {
      const alreadyWon = companyDeals.some((d) => d.stage === SALES_STAGES.closedWon);
      const firstCaseMs = new Date(usage.firstCaseAt).getTime();
      const eligible = alreadyWon ? [] : companyDeals
        .filter((d) => OPEN_SALES_STAGES.has(d.stage as string))
        .filter((d) => !d.hs_created_at ||
                       new Date(d.hs_created_at as string).getTime() <= firstCaseMs + DAY)
        .sort((a, b) => String(a.hs_created_at ?? "").localeCompare(String(b.hs_created_at ?? "")));
      const d = eligible[0];
      if (d) {
        const dealId = d.hubspot_id as string;
        const closeIso = usage.firstCaseAt;
        const wb = await hsUpdateProperties("deals", dealId, {
          dealstage: SALES_STAGES.closedWon,
          closedate: closeIso,
        });
        if (wb.ok || wb.skipped) {
          await must(`deals closed-won update ${dealId}`, sb.from("deals").update({
            stage: SALES_STAGES.closedWon, stage_label: "Closed Won", closed_at: closeIso,
          }).eq("hubspot_id", dealId));
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
        await must(`handoffs insert ${company.hubspot_id}`, sb.from("handoffs").insert({
          company_hubspot_id: company.hubspot_id,
          trigger_type: triggerType,
          deal_hubspot_id: (deal?.hubspot_id as string | undefined) ?? null,
          handoff_created_date: triggerDate,
          handoff_owner: (deal?.owner_id as string | null) ?? null,
          handoff_status: isNew ? "pending" : "accepted",
          handoff_accepted_date: isNew ? null : new Date().toISOString(),
          source: props.sw_lead_source ?? (triggerType === "signup" ? "app_signup" : null),
          next_step: props.sw_next_step ?? null,
        }));
        existingHandoffCompanies.add(company.hubspot_id);
        stats.handoffs += 1;
      }
    }
  }

  void nowMs;
  return stats;
}
