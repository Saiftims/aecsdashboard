/** Old UI (v1) vs new UI (v2) adoption, per case and per firm. Lists EVERY
 * firm that has used the product (a case, or an app signup) and every case it
 * has ever had, each dated by its last customer activity so the view can be
 * filtered to recent ones. The UI verdict comes from the `case_ui_usage` cache
 * the cases sync fills from PostHog: `case_ui` is an event property stamped
 * since 2026-10-13, so a case nobody from the firm has opened since then is
 * "unseen" - unknown, not new. Customer activity decides the verdict; staff
 * activity is shown only as context. */
import { selectAll, supabaseService } from "@/lib/supabase/server";

export type UiVerdict = "new" | "old" | "both" | "unseen";
export type Ui = "v1" | "v2";

export interface UiCase {
  caseId: string;
  name: string | null;
  submitted: string | null;
  verdict: UiVerdict;
  /** UI of the most recent customer event; null when unseen. */
  lastUi: Ui | null;
  /** Most recent flagged customer event (decides the verdict). */
  lastAt: string | null;
  /** Most recent customer activity of any kind, else the submission date. */
  lastActivity: string | null;
  v1: number;
  v2: number;
  staffLastUi: string | null;
}

export interface UiFirm {
  companyId: string | null;
  name: string;
  verdict: UiVerdict;
  lastUi: Ui | null;
  lastAt: string | null;
  /** Most recent customer activity across the firm's cases, signup or case submission. */
  lastActivity: string | null;
  signedUpAt: string | null;
  cases: UiCase[];
  counts: { new: number; old: number; both: number; unseen: number };
}

export interface CaseUiReport {
  since: string;
  syncedAt: string | null;
  firms: UiFirm[];
  /** Cases only staff have touched (demo builds, analyst work), by verdict. */
  staffOnly: { cases: number; v1: number; v2: number };
  totals: {
    firms: number; firmsOnNew: number; firmsOnOld: number; firmsUnseen: number;
    cases: number; new: number; old: number; both: number; unseen: number;
  };
}

export type UiSort = "recent" | "status";
export type UiWindow = "7d" | "30d" | "90d" | "all";
export const UI_WINDOWS: { id: UiWindow; label: string; days: number | null }[] = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "all", label: "All time", days: null },
];

const rankStatus = (f: UiFirm) => (f.lastUi === "v1" ? 0 : f.counts.old || f.counts.both ? 1 : f.lastUi === "v2" ? 2 : 3);
const byRecency = (a: { lastActivity: string | null }, b: { lastActivity: string | null }) =>
  (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");

/** Firms active in the window (by any customer activity), sorted. Cases inside
 * each firm are always newest-activity first; the window does not drop a
 * firm's older cases, only firms with nothing recent. */
export function viewFirms(report: CaseUiReport, window: UiWindow, sort: UiSort, now = new Date()): UiFirm[] {
  const days = UI_WINDOWS.find((w) => w.id === window)?.days ?? null;
  const cutoff = days === null ? null : new Date(now.getTime() - days * 86_400_000).toISOString();
  const firms = cutoff ? report.firms.filter((f) => (f.lastActivity ?? "") >= cutoff) : report.firms;
  return [...firms].sort((a, b) =>
    sort === "status"
      ? rankStatus(a) - rankStatus(b) || byRecency(a, b) || a.name.localeCompare(b.name)
      : byRecency(a, b) || rankStatus(a) - rankStatus(b) || a.name.localeCompare(b.name));
}

export async function caseUiReport(): Promise<CaseUiReport> {
  type UsageRow = {
    case_id: string; v1_events: number; v2_events: number; v1_last: string | null; v2_last: string | null;
    customer_events: number | null; customer_last: string | null;
    staff_v1_events: number; staff_v2_events: number; staff_last_ui: string | null;
    accounts: string[] | null; customer_emails: string[] | null; synced_at: string | null;
  };
  type CaseRow = { case_id: string; company_hubspot_id: string | null; case_name: string | null; submitted_date: string | null };
  type CoRow = { hubspot_id: string; name: string | null; domain: string | null; sw_account_id: string | null; signed_up_at: string | null; last_case_at: string | null };
  type MapRow = { sw_account_id: string | null; hubspot_company_id: string | null };
  const sb = supabaseService();
  const [usage, companies, mappings, { data: caseData, error }] = await Promise.all([
    selectAll<UsageRow>("case_ui_usage", "*", "case_id"),
    selectAll<CoRow>("companies", "hubspot_id, name, domain, sw_account_id, signed_up_at, last_case_at", "hubspot_id"),
    selectAll<MapRow>("firm_mapping", "sw_account_id, hubspot_company_id", "sw_account_id"),
    sb.from("cases").select("case_id, company_hubspot_id, case_name, submitted_date").order("submitted_date", { ascending: false }),
  ]);
  if (error) throw error;
  const cases = (caseData ?? []) as CaseRow[];
  const usageById = new Map(usage.map((u) => [u.case_id, u]));
  const caseById = new Map(cases.map((c) => [c.case_id, c]));
  const coById = new Map(companies.map((c) => [c.hubspot_id, c]));
  const coByAccount = new Map<string, string>();
  for (const c of companies) if (c.sw_account_id) coByAccount.set(c.sw_account_id, c.hubspot_id);
  for (const m of mappings) if (m.sw_account_id && m.hubspot_company_id) coByAccount.set(m.sw_account_id, m.hubspot_company_id);
  const coByDomain = new Map<string, string>();
  for (const c of companies) if (c.domain) coByDomain.set(c.domain.toLowerCase().replace(/^www\./, ""), c.hubspot_id);
  const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

  const firmFor = (caseId: string, u: UsageRow | undefined): string | null => {
    const c = caseById.get(caseId);
    if (c?.company_hubspot_id) return c.company_hubspot_id;
    for (const a of u?.accounts ?? []) { const id = coByAccount.get(a); if (id) return id; }
    for (const e of u?.customer_emails ?? []) { const id = coByDomain.get(e.split("@")[1] ?? ""); if (id) return id; }
    return null;
  };

  const firms = new Map<string | null, UiFirm>();
  const firmOf = (cid: string | null) => {
    const co = cid ? coById.get(cid) : undefined;
    const f = firms.get(cid) ?? {
      companyId: cid, name: cid ? co?.name ?? cid : "Unmatched (no firm found)",
      verdict: "unseen" as UiVerdict, lastUi: null, lastAt: null,
      lastActivity: maxIso(co?.signed_up_at ?? null, co?.last_case_at ?? null), signedUpAt: co?.signed_up_at ?? null,
      cases: [], counts: { new: 0, old: 0, both: 0, unseen: 0 },
    };
    firms.set(cid, f);
    return f;
  };
  const staffOnly = { cases: 0, v1: 0, v2: 0 };
  const placed = new Set<string>();

  const addCase = (caseId: string, u: UsageRow | undefined) => {
    if (placed.has(caseId)) return;
    placed.add(caseId);
    const c = caseById.get(caseId);
    const flagged = !!u && u.v1_events + u.v2_events > 0;
    const base = {
      caseId, name: c?.case_name ?? null, submitted: c?.submitted_date ?? null,
      lastActivity: maxIso(u?.customer_last ?? null, c?.submitted_date ?? null),
      staffLastUi: u?.staff_last_ui ?? null,
    };
    let row: UiCase;
    if (flagged) {
      const verdict: UiVerdict = u.v1_events && u.v2_events ? "both" : u.v1_events ? "old" : "new";
      const lastUi: Ui = (u.v1_last ?? "") > (u.v2_last ?? "") ? "v1" : "v2";
      row = { ...base, verdict, lastUi, lastAt: lastUi === "v1" ? u.v1_last : u.v2_last, v1: u.v1_events, v2: u.v2_events };
    } else {
      row = { ...base, verdict: "unseen", lastUi: null, lastAt: null, v1: 0, v2: 0 };
    }
    const f = firmOf(firmFor(caseId, u));
    f.cases.push(row);
    f.counts[row.verdict] += 1;
    if (row.lastAt && row.lastAt > (f.lastAt ?? "")) { f.lastAt = row.lastAt; f.lastUi = row.lastUi; }
    f.lastActivity = maxIso(f.lastActivity, row.lastActivity);
  };

  // Every case the firm has ever submitted, newest first.
  for (const c of cases) if (c.company_hubspot_id) addCase(c.case_id, usageById.get(c.case_id));
  // Cases PostHog saw a customer open that the cases table has not attributed
  // (or does not hold) - still placed by account / email domain where possible.
  for (const u of usage) {
    if (placed.has(u.case_id)) continue;
    if ((u.customer_events ?? 0) > 0) { addCase(u.case_id, u); continue; }
    staffOnly.cases += 1;
    if (u.staff_last_ui === "v1") staffOnly.v1 += 1; else if (u.staff_last_ui === "v2") staffOnly.v2 += 1;
  }
  // Firms that signed up for the app but have no case yet - they use the
  // product too, and will show which UI they land in once they open a case.
  for (const co of companies) if (co.signed_up_at && !firms.has(co.hubspot_id)) firmOf(co.hubspot_id);

  for (const f of firms.values()) {
    const seen = f.counts.new + f.counts.old + f.counts.both;
    f.verdict = !seen ? "unseen"
      : f.counts.old && (f.counts.new || f.counts.both) ? "both"
      : f.counts.old ? "old" : f.counts.both ? "both" : "new";
    f.cases.sort((a, b) => byRecency(a, b) || (b.submitted ?? "").localeCompare(a.submitted ?? ""));
  }
  const list = [...firms.values()].sort((a, b) => byRecency(a, b) || a.name.localeCompare(b.name));
  const allCases = list.flatMap((f) => f.cases);
  const real = list.filter((f) => f.companyId);
  return {
    since: "2026-10-13",
    syncedAt: usage.map((u) => u.synced_at).filter((x): x is string => !!x).sort().at(-1) ?? null,
    firms: list,
    staffOnly,
    totals: {
      firms: real.length,
      firmsOnNew: real.filter((f) => f.lastUi === "v2").length,
      firmsOnOld: real.filter((f) => f.lastUi === "v1").length,
      firmsUnseen: real.filter((f) => f.verdict === "unseen").length,
      cases: allCases.length,
      new: allCases.filter((c) => c.verdict === "new").length,
      old: allCases.filter((c) => c.verdict === "old").length,
      both: allCases.filter((c) => c.verdict === "both").length,
      unseen: allCases.filter((c) => c.verdict === "unseen").length,
    },
  };
}
