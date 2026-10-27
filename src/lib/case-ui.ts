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

/** Every case that existed on this day was moved to the new UI in bulk and
 * is being reviewed by hand, one by one (`ui_port_reviewed`). A case
 * submitted on or after it was born in the new UI and needs no review. */
export const PORT_DATE = "2026-10-18T00:00:00Z";

/** The manual port review of a case, from `case_port_reviews`. */
export interface PortReviewInfo {
  at: string;
  by: string | null;
  overallBefore: number | null;
  overallAfter: number | null;
  overallDelta: number | null;
  liabilityDelta: number | null;
  crashSeverityDelta: number | null;
  injuryCausationDelta: number | null;
  evidenceIntegrityDelta: number | null;
  injurySynopses: number | null;
  reconstructionTexts: boolean | null;
  warnings: number | null;
  reviews: number;
}
export type ReviewState = "reviewed" | "awaiting" | "native";

export interface UiCase {
  caseId: string;
  name: string | null;
  submitted: string | null;
  /** reviewed = marked reviewed after the port (send it to the firm);
   * awaiting = ported, not yet reviewed; native = created after the port. */
  reviewState: ReviewState;
  review: PortReviewInfo | null;
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
  /** Most recent port review across the firm's cases. */
  lastReviewAt: string | null;
  cases: UiCase[];
  counts: { new: number; old: number; both: number; unseen: number; reviewed: number; awaiting: number; native: number };
}

export interface CaseUiReport {
  since: string;
  syncedAt: string | null;
  reviewsSyncedAt: string | null;
  firms: UiFirm[];
  /** Cases only staff have touched (demo builds, analyst work), by verdict. */
  staffOnly: { cases: number; v1: number; v2: number; reviewed: number };
  totals: {
    firms: number; firmsOnNew: number; firmsOnOld: number; firmsUnseen: number;
    cases: number; new: number; old: number; both: number; unseen: number;
    reviewed: number; awaiting: number; firmsToCall: number;
  };
}

export type UiSort = "reviewed" | "recent" | "status";
export type UiWindow = "7d" | "30d" | "90d" | "all";
export const UI_WINDOWS: { id: UiWindow; label: string; days: number | null }[] = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "all", label: "All time", days: null },
];
/** Which firms to list: the call list (a reviewed case to send), firms with
 * ported cases still awaiting review, or everyone. */
export type UiShow = "reviewed" | "awaiting" | "all";
export const UI_SHOWS: { id: UiShow; label: string }[] = [
  { id: "reviewed", label: "Call list · reviewed" },
  { id: "awaiting", label: "Awaiting review" },
  { id: "all", label: "Everyone" },
];

const rankStatus = (f: UiFirm) => (f.lastUi === "v1" ? 0 : f.counts.old || f.counts.both ? 1 : f.lastUi === "v2" ? 2 : 3);
const byRecency = (a: { lastActivity: string | null }, b: { lastActivity: string | null }) =>
  (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
const byReview = (a: UiFirm, b: UiFirm) => (b.lastReviewAt ?? "").localeCompare(a.lastReviewAt ?? "");

/** Firms active in the window (by any customer activity), filtered by review
 * state and sorted. Cases inside each firm are reviewed-first, newest review
 * first, then newest activity; the window does not drop a firm's older
 * cases, only firms with nothing recent. */
export function viewFirms(report: CaseUiReport, window: UiWindow, sort: UiSort, show: UiShow = "all", now = new Date()): UiFirm[] {
  const days = UI_WINDOWS.find((w) => w.id === window)?.days ?? null;
  const cutoff = days === null ? null : new Date(now.getTime() - days * 86_400_000).toISOString();
  let firms = cutoff ? report.firms.filter((f) => (f.lastActivity ?? "") >= cutoff) : report.firms;
  if (show === "reviewed") firms = firms.filter((f) => f.counts.reviewed > 0);
  else if (show === "awaiting") firms = firms.filter((f) => f.counts.awaiting > 0);
  return [...firms].sort((a, b) =>
    sort === "reviewed" ? byReview(a, b) || byRecency(a, b) || a.name.localeCompare(b.name)
      : sort === "status" ? rankStatus(a) - rankStatus(b) || byRecency(a, b) || a.name.localeCompare(b.name)
      : byRecency(a, b) || rankStatus(a) - rankStatus(b) || a.name.localeCompare(b.name));
}

export async function caseUiReport(): Promise<CaseUiReport> {
  type UsageRow = {
    case_id: string; v1_events: number; v2_events: number; v1_last: string | null; v2_last: string | null;
    customer_events: number | null; customer_first: string | null; customer_last: string | null;
    staff_v1_events: number; staff_v2_events: number; staff_last_ui: string | null;
    accounts: string[] | null; customer_emails: string[] | null; synced_at: string | null;
  };
  type CaseRow = { case_id: string; sw_id: string | null; company_hubspot_id: string | null; case_name: string | null; submitted_date: string | null };
  type CoRow = { hubspot_id: string; name: string | null; domain: string | null; sw_account_id: string | null; signed_up_at: string | null; last_case_at: string | null };
  type MapRow = { sw_account_id: string | null; hubspot_company_id: string | null };
  type ReviewRow = {
    case_id: string; reviewed_at: string; reviewed_by: string | null;
    overall_before: number | null; overall_after: number | null; overall_delta: number | null;
    liability_delta: number | null; crash_severity_delta: number | null; injury_causation_delta: number | null; evidence_integrity_delta: number | null;
    injury_synopses: number | null; reconstruction_texts: boolean | null; warnings: number | null; reviews: number; synced_at: string | null;
  };
  type InvRow = { case_id: string; account_id: string | null; company_hubspot_id: string | null; case_name: string | null; created_at: string | null };
  const sb = supabaseService();
  const [usage, companies, mappings, reviews, invoices, { data: caseData, error }] = await Promise.all([
    selectAll<UsageRow>("case_ui_usage", "*", "case_id"),
    selectAll<CoRow>("companies", "hubspot_id, name, domain, sw_account_id, signed_up_at, last_case_at", "hubspot_id"),
    selectAll<MapRow>("firm_mapping", "sw_account_id, hubspot_company_id", "sw_account_id"),
    selectAll<ReviewRow>("case_port_reviews", "*", "case_id"),
    selectAll<InvRow>("stripe_case_invoices", "case_id, account_id, company_hubspot_id, case_name, created_at", "invoice_id"),
    sb.from("cases").select("case_id, sw_id, company_hubspot_id, case_name, submitted_date").order("submitted_date", { ascending: false }),
  ]);
  if (error) throw error;
  const cases = (caseData ?? []) as CaseRow[];
  const usageById = new Map(usage.map((u) => [u.case_id, u]));
  const caseById = new Map(cases.map((c) => [c.case_id, c]));
  // A hand-entered row records the platform id of the matter it stands for
  // in sw_id (Cordova v. Stacy; CF Injury's June intake rows), so a review
  // of that platform id belongs to that row.
  for (const c of cases) if (c.sw_id && c.sw_id !== c.case_id && !caseById.has(c.sw_id)) caseById.set(c.sw_id, c);
  const reviewById = new Map(reviews.map((r) => [r.case_id, r]));
  // Stripe's case invoice names the firm (via its account) and the matter for
  // a case the cases table does not hold or could not attribute.
  const invoiceById = new Map<string, InvRow>();
  for (const i of invoices) if (!invoiceById.has(i.case_id)) invoiceById.set(i.case_id, i);
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
    const inv = invoiceById.get(caseId);
    if (inv?.company_hubspot_id) return inv.company_hubspot_id;
    if (inv?.account_id) return coByAccount.get(inv.account_id) ?? null;
    return null;
  };
  const reviewInfo = (r: ReviewRow | undefined): PortReviewInfo | null => (r ? {
    at: r.reviewed_at, by: r.reviewed_by,
    overallBefore: r.overall_before, overallAfter: r.overall_after, overallDelta: r.overall_delta,
    liabilityDelta: r.liability_delta, crashSeverityDelta: r.crash_severity_delta,
    injuryCausationDelta: r.injury_causation_delta, evidenceIntegrityDelta: r.evidence_integrity_delta,
    injurySynopses: r.injury_synopses, reconstructionTexts: r.reconstruction_texts, warnings: r.warnings, reviews: r.reviews,
  } : null);

  const firms = new Map<string | null, UiFirm>();
  const firmOf = (cid: string | null) => {
    const co = cid ? coById.get(cid) : undefined;
    const f = firms.get(cid) ?? {
      companyId: cid, name: cid ? co?.name ?? cid : "Unmatched (no firm found)",
      verdict: "unseen" as UiVerdict, lastUi: null, lastAt: null,
      lastActivity: maxIso(co?.signed_up_at ?? null, co?.last_case_at ?? null), signedUpAt: co?.signed_up_at ?? null,
      lastReviewAt: null,
      cases: [], counts: { new: 0, old: 0, both: 0, unseen: 0, reviewed: 0, awaiting: 0, native: 0 },
    };
    firms.set(cid, f);
    return f;
  };
  const staffOnly = { cases: 0, v1: 0, v2: 0, reviewed: 0 };
  const placed = new Set<string>();

  const addCase = (caseId: string, u: UsageRow | undefined) => {
    if (placed.has(caseId)) return;
    placed.add(caseId);
    const c = caseById.get(caseId);
    // The row we place under the firm is the table's row when there is one -
    // a review of the platform id a stand-in row carries in sw_id lands on
    // that row, not on a second line.
    if (c && c.case_id !== caseId) { if (placed.has(c.case_id)) return; placed.add(c.case_id); }
    const inv = invoiceById.get(caseId);
    const flagged = !!u && u.v1_events + u.v2_events > 0;
    const review = reviewInfo(reviewById.get(caseId) ?? (c?.sw_id ? reviewById.get(c.sw_id) : undefined) ?? (c ? reviewById.get(c.case_id) : undefined));
    const submitted = c?.submitted_date ?? inv?.created_at ?? u?.customer_first ?? null;
    const reviewState: ReviewState = review ? "reviewed" : submitted && submitted >= PORT_DATE ? "native" : "awaiting";
    const base = {
      caseId: c?.case_id ?? caseId, name: c?.case_name ?? inv?.case_name ?? null, submitted,
      lastActivity: maxIso(u?.customer_last ?? null, c?.submitted_date ?? null),
      staffLastUi: u?.staff_last_ui ?? null,
      review, reviewState,
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
    f.counts[row.reviewState] += 1;
    if (row.review) f.lastReviewAt = maxIso(f.lastReviewAt, row.review.at);
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
    // Staff-only in PostHog, but reviewed and invoiced to a firm: a real
    // matter an analyst entered for the customer, not a demo build.
    if (reviewById.has(u.case_id) && firmFor(u.case_id, u)) { addCase(u.case_id, u); continue; }
    staffOnly.cases += 1;
    if (u.staff_last_ui === "v1") staffOnly.v1 += 1; else if (u.staff_last_ui === "v2") staffOnly.v2 += 1;
    if (reviewById.has(u.case_id)) staffOnly.reviewed += 1;
  }
  // Reviewed cases PostHog's usage read never saw (older than its window, or
  // a PostHog-busy chunk) - placed by the table or the Stripe invoice.
  for (const r of reviews) {
    if (placed.has(r.case_id)) continue;
    if (firmFor(r.case_id, undefined)) addCase(r.case_id, usageById.get(r.case_id));
    else { staffOnly.cases += 1; staffOnly.reviewed += 1; }
  }
  // Firms that signed up for the app but have no case yet - they use the
  // product too, and will show which UI they land in once they open a case.
  for (const co of companies) if (co.signed_up_at && !firms.has(co.hubspot_id)) firmOf(co.hubspot_id);

  const rankReview = (c: UiCase) => (c.reviewState === "reviewed" ? 0 : c.reviewState === "awaiting" ? 1 : 2);
  for (const f of firms.values()) {
    const seen = f.counts.new + f.counts.old + f.counts.both;
    f.verdict = !seen ? "unseen"
      : f.counts.old && (f.counts.new || f.counts.both) ? "both"
      : f.counts.old ? "old" : f.counts.both ? "both" : "new";
    f.cases.sort((a, b) => rankReview(a) - rankReview(b)
      || (b.review?.at ?? "").localeCompare(a.review?.at ?? "")
      || byRecency(a, b) || (b.submitted ?? "").localeCompare(a.submitted ?? ""));
  }
  const list = [...firms.values()].sort((a, b) => byRecency(a, b) || a.name.localeCompare(b.name));
  const allCases = list.flatMap((f) => f.cases);
  const real = list.filter((f) => f.companyId);
  return {
    since: "2026-10-13",
    syncedAt: usage.map((u) => u.synced_at).filter((x): x is string => !!x).sort().at(-1) ?? null,
    reviewsSyncedAt: reviews.map((r) => r.synced_at).filter((x): x is string => !!x).sort().at(-1) ?? null,
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
      reviewed: allCases.filter((c) => c.reviewState === "reviewed").length,
      awaiting: allCases.filter((c) => c.reviewState === "awaiting").length,
      firmsToCall: real.filter((f) => f.counts.reviewed > 0).length,
    },
  };
}
