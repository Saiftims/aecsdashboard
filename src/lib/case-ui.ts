/** Old UI (v1) vs new UI (v2) adoption, per case and per firm. Reads the
 * `case_ui_usage` cache the cases sync fills from PostHog's `case_ui` event
 * property (stamped since 2026-10-13). Customer activity decides a case's
 * verdict; staff activity is shown only as context. */
import { selectAll, supabaseService } from "@/lib/supabase/server";

export type UiVerdict = "new" | "old" | "both";

export interface UiCase {
  caseId: string;
  name: string | null;
  submitted: string | null;
  verdict: UiVerdict;
  /** UI of the most recent customer event. */
  lastUi: "v1" | "v2";
  lastAt: string | null;
  v1: number;
  v2: number;
  staffOnly: boolean;
  staffLastUi: string | null;
}

export interface UiFirm {
  companyId: string | null;
  name: string;
  verdict: UiVerdict;
  lastUi: "v1" | "v2";
  lastAt: string | null;
  cases: UiCase[];
  counts: { new: number; old: number; both: number };
}

export interface CaseUiReport {
  since: string;
  syncedAt: string | null;
  firms: UiFirm[];
  /** Cases only staff have touched (demo builds, analyst work), by verdict. */
  staffOnly: { cases: number; v1: number; v2: number };
  totals: { firms: number; firmsOnOld: number; cases: number; new: number; old: number; both: number };
}

export async function caseUiReport(): Promise<CaseUiReport> {
  type UsageRow = {
    case_id: string; v1_events: number; v2_events: number; v1_last: string | null; v2_last: string | null;
    staff_v1_events: number; staff_v2_events: number; staff_last_ui: string | null;
    accounts: string[] | null; customer_emails: string[] | null; synced_at: string | null;
  };
  type CaseRow = { case_id: string; company_hubspot_id: string | null; case_name: string | null; submitted_date: string | null; sw_account_id: string | null };
  type CoRow = { hubspot_id: string; name: string | null; domain: string | null; sw_account_id: string | null };
  type MapRow = { sw_account_id: string | null; hubspot_company_id: string | null };
  const sb = supabaseService();
  const [usage, companies, mappings] = await Promise.all([
    selectAll<UsageRow>("case_ui_usage", "*", "case_id"),
    selectAll<CoRow>("companies", "hubspot_id, name, domain, sw_account_id", "hubspot_id"),
    selectAll<MapRow>("firm_mapping", "sw_account_id, hubspot_company_id", "sw_account_id"),
  ]);
  const ids = usage.map((u) => u.case_id);
  const cases: CaseRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("cases").select("case_id, company_hubspot_id, case_name, submitted_date, sw_account_id").in("case_id", ids.slice(i, i + 200));
    if (error) throw error;
    cases.push(...((data ?? []) as CaseRow[]));
  }
  const caseById = new Map(cases.map((c) => [c.case_id, c]));
  const coById = new Map(companies.map((c) => [c.hubspot_id, c]));
  const coByAccount = new Map<string, string>();
  for (const c of companies) if (c.sw_account_id) coByAccount.set(c.sw_account_id, c.hubspot_id);
  for (const m of mappings) if (m.sw_account_id && m.hubspot_company_id) coByAccount.set(m.sw_account_id, m.hubspot_company_id);
  const coByDomain = new Map<string, string>();
  for (const c of companies) if (c.domain) coByDomain.set(c.domain.toLowerCase().replace(/^www\./, ""), c.hubspot_id);

  const firmFor = (u: UsageRow): string | null => {
    const c = caseById.get(u.case_id);
    if (c?.company_hubspot_id) return c.company_hubspot_id;
    for (const a of u.accounts ?? []) { const id = coByAccount.get(a); if (id) return id; }
    for (const e of u.customer_emails ?? []) { const id = coByDomain.get(e.split("@")[1] ?? ""); if (id) return id; }
    return null;
  };

  const firms = new Map<string | null, UiFirm>();
  const staffOnly = { cases: 0, v1: 0, v2: 0 };
  for (const u of usage) {
    const customer = u.v1_events + u.v2_events > 0;
    if (!customer) {
      staffOnly.cases += 1;
      if (u.staff_last_ui === "v1") staffOnly.v1 += 1; else staffOnly.v2 += 1;
      continue;
    }
    const verdict: UiVerdict = u.v1_events && u.v2_events ? "both" : u.v1_events ? "old" : "new";
    const lastUi: "v1" | "v2" = (u.v1_last ?? "") > (u.v2_last ?? "") ? "v1" : "v2";
    const c = caseById.get(u.case_id);
    const row: UiCase = {
      caseId: u.case_id, name: c?.case_name ?? null, submitted: c?.submitted_date ?? null,
      verdict, lastUi, lastAt: lastUi === "v1" ? u.v1_last : u.v2_last, v1: u.v1_events, v2: u.v2_events,
      staffOnly: false, staffLastUi: u.staff_last_ui,
    };
    const cid = firmFor(u);
    const f = firms.get(cid) ?? {
      companyId: cid, name: cid ? coById.get(cid)?.name ?? cid : "Unmatched (no firm found)",
      verdict: "new", lastUi: "v2", lastAt: null, cases: [], counts: { new: 0, old: 0, both: 0 },
    };
    f.cases.push(row);
    f.counts[verdict] += 1;
    if ((row.lastAt ?? "") > (f.lastAt ?? "")) { f.lastAt = row.lastAt; f.lastUi = row.lastUi; }
    firms.set(cid, f);
  }
  for (const f of firms.values()) {
    f.verdict = f.counts.old && (f.counts.new || f.counts.both) ? "both" : f.counts.old ? "old" : f.counts.both ? "both" : "new";
    f.cases.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
  }
  const list = [...firms.values()].sort((a, b) => {
    // Firms still touching the old UI first, then by recency.
    const rank = (f: UiFirm) => (f.lastUi === "v1" ? 0 : f.counts.old || f.counts.both ? 1 : 2);
    return rank(a) - rank(b) || (b.lastAt ?? "").localeCompare(a.lastAt ?? "");
  });
  const allCases = list.flatMap((f) => f.cases);
  return {
    since: "2026-10-13",
    syncedAt: usage.map((u) => u.synced_at).filter((x): x is string => !!x).sort().at(-1) ?? null,
    firms: list,
    staffOnly,
    totals: {
      firms: list.filter((f) => f.companyId).length,
      firmsOnOld: list.filter((f) => f.companyId && f.lastUi === "v1").length,
      cases: allCases.length,
      new: allCases.filter((c) => c.verdict === "new").length,
      old: allCases.filter((c) => c.verdict === "old").length,
      both: allCases.filter((c) => c.verdict === "both").length,
    },
  };
}
