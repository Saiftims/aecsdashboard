/** Case-data provider interface + the Silent Witness API implementation.
 *
 * A "case" is the unit of revenue (default $250/case, configurable).
 * `submittedAt` = SW `created_at`; `deliveredAt` = when the technical report
 * completed. PostHog is wired as a supplementary engagement signal, not the
 * case source of record.
 */

export interface CaseRecord {
  swId: string;
  swAccountId: string | null;
  swOrganizationId: string | null;
  name: string | null;
  caseStage: string | null;
  analysisType: string | null;
  submittedAt: string; // ISO
  deliveredAt: string | null;
  reportStatus: string | null;
  raw: unknown;
}

export interface CaseDataProvider {
  listAllCases(): Promise<CaseRecord[]>;
}

interface SwCase {
  id: string;
  account_id?: string | null;
  organization_id?: string | null;
  name?: string | null;
  case_stage?: string | null;
  analysis_type?: string | null;
  created_at: string;
  updated_at?: string;
  analysis_status?: {
    technical_report?: { status?: string };
  };
}

export class SilentWitnessProvider implements CaseDataProvider {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {
    if (!baseUrl || !apiKey) {
      throw new Error("SW_API_BASE_URL / SILENT_WITNESS_API_KEY not configured");
    }
  }

  private async req<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        cache: "no-store",
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`SW API ${path} -> ${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    }
    throw new Error(`SW API ${path} -> repeated 429`);
  }

  async listAllCases(): Promise<CaseRecord[]> {
    const out: CaseRecord[] = [];
    let page = 1;
    for (;;) {
      const data = await this.req<{ cases: SwCase[]; total: number }>("/cases", {
        page: String(page),
        limit: "100",
      });
      for (const c of data.cases ?? []) out.push(toCaseRecord(c));
      if (!data.cases?.length || out.length >= (data.total ?? out.length)) break;
      page += 1;
      if (page > 200) break; // hard safety cap
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// PostHog: the real case feed. `case_created` = submitted,
// `report_generation_completed` = completed, `report_downloaded` = delivered.
// Each event carries caseId, the account id ($group_0 = acc_...), and the
// creator's email. Test/internal accounts are excluded.
// ---------------------------------------------------------------------------

/** Internal/test accounts to exclude from ingestion (email or acc id). */
export const TEST_EMAIL_DOMAINS = ["silentwitness.ai", "das.es"];
export const TEST_EMAILS = [
  "diegodf@gmail.com", "saif.altimims@gmail.com", "sheikhrobertomanagement@gmail.com",
  // Silent Witness's own demo login - it signs into customer orgs, so it must
  // never be treated as the creator of a real firm's case.
  "silentwitnessdemo@gmail.com",
];
/** Individual cases the owner has confirmed were tests. Excluded by case ID, not
 * by firm or email: these firms are real prospects whose NEXT case must still
 * count, so banning the account would silently drop future revenue. */
export const EXCLUDED_CASE_IDS = [
  // Khorshidi Law kicking the tyres in May; never became a real matter.
  "case_48bcbc8b1fdc4fd5bdf0453023495d6e",
];

export const TEST_ACCOUNT_IDS = [
  "acc_3f97023cbf544874b818a721bbab946a", // saif+7 (JJ test cases)
  "acc_288f6554fd2e4e0d850a734d25f2f799", // newton (internal)
  "acc_f5bc1fb1e0584f5f9b03435769d6c37a", // diegodf (dev)
  "acc_d9a5094383384e00a5aafb15225d5f78", // diegodf (dev)
];

/** Local-part prefixes (before @) that mark internal/dev gmail accounts,
 * incl. plus-addressing like diegodf+30@, diego+asda@, saif+1@. */
const TEST_LOCAL_PREFIXES = ["saif+", "saif.", "diego+", "diegodf+", "demo", "test"];

export function isTestCaseActor(email: string | null, accountId: string | null): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (e) {
    if (TEST_EMAILS.includes(e)) return true;
    if (e === "saif@silentwitness.ai") return true;
    const [local = "", dom = ""] = e.split("@");
    if (TEST_EMAIL_DOMAINS.includes(dom)) return true;
    if (TEST_LOCAL_PREFIXES.some((p) => local.startsWith(p))) return true;
  }
  if (accountId && TEST_ACCOUNT_IDS.includes(accountId)) return true;
  return false;
}

/** Free/consumer email providers - not a firm domain, so never auto-create a
 * HubSpot company from them. */
export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
  "aol.com", "proton.me", "protonmail.com", "live.com", "msn.com", "me.com",
]);

// Events that carry a real case's caseId. Kept broad on purpose: the app emits
// a caseId across the whole case lifecycle, and many cases never fire
// case_created. Anything here proves a case exists.
export const CASE_START_EVENTS = [
  "case_created", "case_creation_opened", "file_uploaded",
  "results_calculation_started", "biomechanics_data_saved",
  "intake_submission_completed", "evidence_classification_status",
];
export const CASE_DELIVER_EVENTS = ["report_downloaded", "invoice_downloaded"];
export const CASE_EVENTS = [
  ...CASE_START_EVENTS,
  "report_generation_completed",
  ...CASE_DELIVER_EVENTS,
];

export interface PostHogCase {
  caseId: string;
  accountId: string | null;
  creatorEmail: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  deliveredAt: string | null;
  analysisType: string | null;
}

/** A completed intake-form submission (IntakeForm.tsx -> handleSubmit). These
 * events carry no caseId, so each completed submission == one case, keyed by
 * the PostHog event uuid. Firm is resolved via the account group ($group_0). */
export interface PostHogIntake {
  eventId: string;
  accountId: string | null;
  email: string | null;
  submittedAt: string | null;
  mode: string | null;
  fileCount: number | null;
  /** Subdomain of a branded intake portal, e.g. 'nordean' for
   * nordean.intake.silentwitness.ai. The only identity a public submission
   * carries: it has no account and no signed-in person. */
  portalSlug: string | null;
  /** The case this submission created. Present since 2026-07-30; before that the
   * submission and the case it produced cannot be linked. */
  caseId: string | null;
}

export interface PostHogSignup {
  accountId: string;
  email: string | null;
  signedUpAt: string | null;
  subscribedAt: string | null;
}

/** One person's footprint on one case, from one account. */
interface Sighting {
  account: string | null;
  email: string | null;
  at: string | null;
  events: number;
}

/** The account that carried the most events, for cases nobody identified. */
function dominantAccount(sightings: Sighting[]): string | null {
  const tally = new Map<string, number>();
  for (const s of sightings) {
    if (s.account) tally.set(s.account, (tally.get(s.account) ?? 0) + s.events);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Who owns a case: the FIRST person to work it, because creating a case (or
 * submitting the intake form) puts you on it before anyone else can see it.
 * Two corrections to a naive "first seen":
 *
 * 1. Viewers with a footprint below `minEvents` are ignored. On page-URL data a
 *    real owner's session produces many events, while one or two is a stray
 *    pageview or a merged PostHog identity that can beat the true owner by
 *    seconds and hand the case to an unrelated firm. Case-lifecycle events are
 *    already meaningful on their own, so that path passes minEvents = 1.
 * 2. We do NOT skip past an internal owner to a customer who viewed the case
 *    later. Silent Witness builds demo cases that customers open afterwards, and
 *    skipping would credit a real firm with a case it never submitted; such a
 *    case is dropped downstream by isTestCaseActor().
 *
 * Deliberately not "most active": Silent Witness analysts do the heavy work on a
 * customer's case after submission, so the busiest person on a real case is
 * often staff.
 */
function pickOwner(
  sightings: Sighting[],
  minEvents: number,
): { email: string; account: string | null } | null {
  const byEmail = new Map<string, {
    events: number; first: string | null; accounts: Map<string, number>;
  }>();
  for (const s of [...sightings].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))) {
    if (!s.email) continue; // anonymous: $identify hadn't resolved yet
    const rec = byEmail.get(s.email) ?? { events: 0, first: s.at, accounts: new Map() };
    rec.events += s.events;
    if (s.account) {
      rec.accounts.set(s.account, (rec.accounts.get(s.account) ?? 0) + s.events);
    }
    byEmail.set(s.email, rec);
  }
  const all = [...byEmail.entries()]
    .sort((a, b) => (a[1].first ?? "").localeCompare(b[1].first ?? ""));
  const substantial = all.filter(([, r]) => r.events >= minEvents);
  const owner = (substantial.length ? substantial : all)[0];
  if (!owner) return null;
  const [email, rec] = owner;
  return {
    email,
    account: [...rec.accounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };
}

export class PostHogProvider {
  constructor(
    private apiKey: string,
    private projectId: string,
    private host = "https://us.posthog.com",
  ) {
    if (!apiKey || !projectId) {
      throw new Error("POSTHOG_API_KEY / POSTHOG_PROJECT_ID not configured");
    }
  }

  private async query<T = (string | null)[]>(hogql: string): Promise<T[]> {
    const res = await fetch(`${this.host}/api/projects/${this.projectId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`PostHog query -> ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { results: T[] };
    return data.results ?? [];
  }

  /** One row per caseId with submitted/completed/delivered timestamps.
   *
   * A case is any caseId that appears on ANY case-bearing event - not just
   * case_created. The app frequently emits a caseId only on downstream events
   * (file_uploaded, results_calculation_started, biomechanics_data_saved,
   * invoice_downloaded, ...) without ever firing case_created, so keying on
   * case_created alone silently drops real (often already-billed) cases.
   *   submitted = first "case exists / work started" event
   *   completed = report_generation_completed
   *   delivered = report_downloaded OR invoice_downloaded (invoice == billed)
   *
   * Rows are grouped per (case, account, person), not per case. Collapsing the
   * identity with max() hands the case to whichever email happens to sort last,
   * which is routinely a Silent Witness analyst who worked the matter AFTER the
   * firm submitted it - isTestCaseActor() then discards a real billable case.
   * That silently lost Big Case Mike's first case on 2026-07-30, where the firm
   * (daniel@) fired the intake events and staff (sachi@) everything downstream.
   */
  async listAllCases(sinceDays = 400): Promise<PostHogCase[]> {
    const START = CASE_START_EVENTS.map((e) => `'${e}'`).join(",");
    const DELIVER = CASE_DELIVER_EVENTS.map((e) => `'${e}'`).join(",");
    const ALL = CASE_EVENTS.map((e) => `'${e}'`).join(",");
    const hogql = `
      select
        properties.caseId as case_id,
        properties.$group_0 as account_id,
        person.properties.email as email,
        max(properties.analysisType) as analysis_type,
        minIf(timestamp, event in (${START})) as submitted_at,
        minIf(timestamp, event = 'report_generation_completed') as completed_at,
        minIf(timestamp, event in (${DELIVER})) as delivered_at,
        min(timestamp) as first_seen,
        count() as events
      from events
      where event in (${ALL})
        and timestamp > now() - interval ${sinceDays} day
        and properties.caseId is not null
      group by case_id, account_id, email
      limit 20000`;
    const rows = await this.query(hogql);

    interface Agg {
      sightings: Sighting[];
      analysisType: string | null;
      submitted: string | null;
      completed: string | null;
      delivered: string | null;
      firstSeen: string | null;
    }
    const earliest = (a: string | null, b: string | null) =>
      !a ? b : !b ? a : (a < b ? a : b);

    const byCase = new Map<string, Agg>();
    for (const r of rows) {
      const caseId = String(r[0]);
      const agg = byCase.get(caseId) ?? {
        sightings: [], analysisType: null,
        submitted: null, completed: null, delivered: null, firstSeen: null,
      };
      agg.sightings.push({
        account: r[1] ? String(r[1]) : null,
        email: r[2] ? String(r[2]).toLowerCase() : null,
        at: safeIso(r[7] as string | null),
        events: Number(r[8] ?? 0),
      });
      agg.analysisType = agg.analysisType ?? (r[3] ? String(r[3]) : null);
      agg.submitted = earliest(agg.submitted, safeIso(r[4] as string | null));
      agg.completed = earliest(agg.completed, safeIso(r[5] as string | null));
      agg.delivered = earliest(agg.delivered, safeIso(r[6] as string | null));
      agg.firstSeen = earliest(agg.firstSeen, safeIso(r[7] as string | null));
      byCase.set(caseId, agg);
    }

    const out: PostHogCase[] = [];
    for (const [caseId, agg] of byCase) {
      // Every event here is a case-lifecycle event, so there are no stray
      // pageviews to filter out: the earliest identified actor is the creator.
      const owner = pickOwner(agg.sightings, 1);
      out.push({
        caseId,
        accountId: owner?.account ?? dominantAccount(agg.sightings),
        creatorEmail: owner?.email ?? null,
        analysisType: agg.analysisType,
        // Guarantee a submitted date: fall back to the earliest signal we saw
        // (e.g. a case known only from invoice_downloaded).
        submittedAt: agg.submitted ?? agg.completed ?? agg.delivered ?? agg.firstSeen,
        completedAt: agg.completed,
        deliveredAt: agg.delivered,
      });
    }
    return out;
  }

  /** Cases whose id only ever appears in a `/cases/<id>` URL.
   *
   * A case created through the in-app intake form emits
   * intake_submission_completed with NO caseId property, and may never emit any
   * other case-bearing event - so listAllCases() cannot see it even though the
   * case is real and billable. The id is present in the URL of every page the
   * firm opens for it, which is the only reliable recovery path.
   *
   * `submittedAt` is the first time the case URL was seen; for a case opened
   * straight after submission that is its creation time.
   */
  async listCasesFromUrls(sinceDays = 400): Promise<PostHogCase[]> {
    // Staging is excluded: dev/QA work lives on app.staging.silentwitness.ai.
    //
    // One row per (case, account, viewer) with that viewer's first sighting,
    // rather than an aggregate identity per case. Silent Witness staff open real
    // customer cases to review them, and staff can be signed into a different
    // org than the firm that owns the case, so max()/argMin() over the whole
    // case hands back the wrong identity: either a reviewer (making
    // isTestCaseActor discard a real billable case) or another firm's account
    // (attributing the case to the wrong customer). Resolving per viewer lets us
    // pick the EARLIEST non-internal one, which is the firm that created it.
    const hogql = `
      select
        extract(toString(properties.$current_url),
                'cases/(case_[0-9a-fA-F]{8,})') as case_id,
        properties.$group_0 as account_id,
        person.properties.email as email,
        min(timestamp) as first_seen,
        count() as events
      from events
      where properties.$current_url like '%/cases/case_%'
        and properties.$current_url not like '%staging%'
        and timestamp > now() - interval ${sinceDays} day
      group by case_id, account_id, email
      having case_id != ''
      limit 20000`;
    const rows = await this.query(hogql);

    const byCase = new Map<string, Sighting[]>();
    for (const r of rows) {
      const caseId = String(r[0]);
      byCase.set(caseId, [...(byCase.get(caseId) ?? []), {
        account: r[1] ? String(r[1]) : null,
        email: r[2] ? String(r[2]).toLowerCase() : null,
        at: safeIso(r[3] as string | null),
        events: Number(r[4] ?? 0),
      }]);
    }

    const out: PostHogCase[] = [];
    for (const [caseId, sightings] of byCase) {
      const ordered = [...sightings].sort(
        (a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
      // A single stray pageview is not ownership - see pickOwner().
      const owner = pickOwner(ordered, 3);
      if (!owner) continue; // never seen by an identified user
      out.push({
        caseId,
        accountId: owner.account,
        creatorEmail: owner.email,
        analysisType: null,
        // Earliest sighting of the case page across everyone.
        submittedAt: ordered[0]?.at ?? null,
        completedAt: null,
        deliveredAt: null,
      });
    }
    return out;
  }

  /** One row per completed intake submission. No caseId exists on these events,
   * so each completed submission is treated as one case, keyed by event uuid.
   *
   * NOTE `mode` is the SUBMITTER's context, not ours: 'internal' means a signed-in
   * firm user submitting at app.silentwitness.ai/intake, 'public' means someone
   * using a firm's branded intake portal (<firm>.intake.silentwitness.ai).
   * Neither means Silent Witness staff - internal actors are excluded by email
   * via isTestCaseActor(). In-app ('internal') submissions do create a real case,
   * which is picked up by listCasesFromUrls() under its true case id, so they are
   * skipped here to avoid a second phantom row for the same matter.
   *
   * A 'public' submission is anonymous - no account, no signed-in person - so the
   * host is fetched too. It is the firm's own branded portal
   * (<firm>.intake.silentwitness.ai), which is the only thing tying the
   * submission to a customer. */
  async listIntakeSubmissions(sinceDays = 400): Promise<PostHogIntake[]> {
    const hogql = `
      select uuid, properties.$group_0 as account_id,
             person.properties.email as email, timestamp,
             properties.mode as mode, properties.fileCount as file_count,
             toString(properties.$host) as host, properties.caseId as case_id
      from events
      where event = 'intake_submission_completed'
        and timestamp > now() - interval ${sinceDays} day
      order by timestamp desc
      limit 5000`;
    const rows = await this.query(hogql);
    return rows.map((r) => ({
      eventId: String(r[0]),
      accountId: r[1] ? String(r[1]) : null,
      email: r[2] ? String(r[2]).toLowerCase() : null,
      submittedAt: safeIso(r[3] as string | null),
      mode: r[4] ? String(r[4]).toLowerCase() : null,
      fileCount: r[5] != null ? Number(r[5]) : null,
      portalSlug: portalSlug(r[6] as string | null),
      caseId: r[7] ? String(r[7]) : null,
    }));
  }

  /** One row per account that completed signup, with first signup + first
   * subscription timestamps. Anonymous (no group) rows are dropped. */
  async listSignups(sinceDays = 400): Promise<PostHogSignup[]> {
    const hogql = `
      select
        properties.$group_0 as account_id,
        max(person.properties.email) as email,
        minIf(timestamp, event = 'signup_completed') as signed_up_at,
        minIf(timestamp, event = 'subscription_created') as subscribed_at
      from events
      where event in ('signup_completed','subscription_created')
        and properties.$group_0 is not null
        and timestamp > now() - interval ${sinceDays} day
      group by properties.$group_0
      limit 5000`;
    const rows = await this.query(hogql);
    return rows.map((r) => ({
      accountId: String(r[0]),
      email: r[1] ? String(r[1]).toLowerCase() : null,
      signedUpAt: safeIso(r[2] as string | null),
      subscribedAt: safeIso(r[3] as string | null),
    })).filter((s) => s.signedUpAt || s.subscribedAt);
  }
}

// HogQL minIf() returns epoch 0 (1970) when no matching event exists for the
// group (e.g. a case delivered but never case_created, or subscribed w/o a
// captured signup). Treat any pre-2015 / unparseable timestamp as missing so
// it can't corrupt health or last-activity math.
function safeIso(v: string | null): string | null {
  if (!v) return null;
  const t = new Date(v);
  if (Number.isNaN(t.getTime()) || t.getUTCFullYear() < 2015) return null;
  return t.toISOString();
}

/** Firm slug from a branded intake host, e.g. nordean.intake.silentwitness.ai ->
 * 'nordean'. Returns null for the shared app host, which identifies nobody. */
export function portalSlug(host: string | null): string | null {
  const m = /^([a-z0-9-]+)\.intake\.silentwitness\.ai$/i.exec((host ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

export function toCaseRecord(c: SwCase): CaseRecord {
  const reportStatus = c.analysis_status?.technical_report?.status ?? null;
  return {
    swId: c.id,
    swAccountId: c.account_id ?? null,
    swOrganizationId: c.organization_id ?? null,
    name: c.name ?? null,
    caseStage: c.case_stage ?? null,
    analysisType: c.analysis_type ?? null,
    submittedAt: c.created_at,
    // The SW list API doesn't expose a delivery timestamp; when the report is
    // completed we use updated_at as the best available delivery time.
    deliveredAt: reportStatus === "completed" ? (c.updated_at ?? c.created_at) : null,
    reportStatus,
    raw: c,
  };
}
