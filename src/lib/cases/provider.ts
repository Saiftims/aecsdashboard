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
