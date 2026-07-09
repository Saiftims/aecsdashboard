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
export const TEST_EMAIL_DOMAINS = ["silentwitness.ai"];
export const TEST_EMAILS = ["diegodf@gmail.com"];
export const TEST_ACCOUNT_IDS = [
  "acc_3f97023cbf544874b818a721bbab946a", // saif+7 (JJ test cases)
  "acc_288f6554fd2e4e0d850a734d25f2f799", // newton (internal)
  "acc_f5bc1fb1e0584f5f9b03435769d6c37a", // diegodf (dev)
  "acc_d9a5094383384e00a5aafb15225d5f78", // diegodf (dev)
];

export function isTestCaseActor(email: string | null, accountId: string | null): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (e) {
    if (TEST_EMAILS.includes(e)) return true;
    if (e.startsWith("saif+") || e === "saif@silentwitness.ai") return true;
    const dom = e.split("@")[1] ?? "";
    if (TEST_EMAIL_DOMAINS.includes(dom)) return true;
  }
  if (accountId && TEST_ACCOUNT_IDS.includes(accountId)) return true;
  return false;
}

export interface PostHogCase {
  caseId: string;
  accountId: string | null;
  creatorEmail: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  deliveredAt: string | null;
  analysisType: string | null;
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

  /** One row per caseId with submitted/completed/delivered timestamps. */
  async listAllCases(sinceDays = 400): Promise<PostHogCase[]> {
    const hogql = `
      select
        properties.caseId as case_id,
        max(properties.$group_0) as account_id,
        max(person.properties.email) as email,
        max(properties.analysisType) as analysis_type,
        minIf(timestamp, event = 'case_created') as submitted_at,
        minIf(timestamp, event = 'report_generation_completed') as completed_at,
        minIf(timestamp, event = 'report_downloaded') as delivered_at
      from events
      where event in ('case_created','report_generation_completed','report_downloaded')
        and timestamp > now() - interval ${sinceDays} day
        and properties.caseId is not null
      group by properties.caseId
      limit 5000`;
    const rows = await this.query(hogql);
    const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
    return rows.map((r) => ({
      caseId: String(r[0]),
      accountId: r[1] ? String(r[1]) : null,
      creatorEmail: r[2] ? String(r[2]).toLowerCase() : null,
      analysisType: r[3] ? String(r[3]) : null,
      submittedAt: iso(r[4] as string | null),
      completedAt: iso(r[5] as string | null),
      deliveredAt: iso(r[6] as string | null),
    }));
  }
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
