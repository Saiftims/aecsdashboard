/** One HubSpot timeline note per customer case.
 *
 * The cases table is the ledger (PostHog, the intake form, Stripe invoices,
 * hand entries), and HubSpot only ever saw the per-firm totals the rollup
 * writes back (`sw_total_lifetime_cases`, `sw_last_case_date`, ...). The CS
 * team works in HubSpot, so each case now also lands on the firm's record as
 * a note dated when the case was submitted, associated to the company and -
 * where the submitter's email is a known contact - to the person (owner,
 * 2026-11-27: "can we add the cases being submitted from customers to
 * hubspot?").
 *
 * Why a NOTE and not a deal: this portal's deals are read everywhere as
 * pipeline - the dashboard's funnel, "revenue won", the intake-deal branch of
 * the cases sync and the agent's owner sweep all take every cached deal, with
 * no pipeline filter - so a deal per case would count 300-odd cases as wins.
 * A note is inert: it carries no `[type:...]` marker and no owner, so
 * `isOutreach` never reads it as a rep touch and speed-to-lead ignores it.
 *
 * Write-once: `cases.hubspot_note_id` holds the note's id (migration 0022);
 * a row with one is never written again, and a run that fails mid-way simply
 * resumes. The timestamp is the case's submitted date, so the back-fill sits
 * at the right place in each timeline instead of arriving as one day's flood.
 */
import { ASSOC, hsCreateObject } from "@/lib/hubspot/client";
import { must, selectAll, supabaseService } from "@/lib/supabase/server";

const DASHBOARD = "https://gtm-dashboard-fawn.vercel.app";

/** How the case reached the ledger, in the CS rep's words. */
const SOURCE_LABELS: Record<string, string> = {
  posthog: "submitted in the app",
  app: "submitted in the app",
  posthog_intake: "submitted through the intake form",
  intake_form: "submitted through the intake form",
  hubspot_intake: "submitted through the intake form",
  manual: "entered by hand",
  stripe_invoice: "entered by Silent Witness on the firm's behalf (Stripe-invoiced)",
  reprocessed: "re-processed in the new UI and reviewed",
};

interface CaseNoteRow {
  sw_id: string;
  case_id: string;
  case_name: string | null;
  company_hubspot_id: string | null;
  submitted_date: string | null;
  source: string | null;
  creator_email: string | null;
  hubspot_note_id: string | null;
}

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function caseNoteBody(
  c: Pick<CaseNoteRow, "case_id" | "case_name" | "company_hubspot_id" | "submitted_date" | "source">,
  firm: string,
  nth: number,
  firstCaseAt: string | null,
): string {
  const name = c.case_name && !/^Case [0-9a-f]{8}$/i.test(c.case_name) ? c.case_name : null;
  const how = SOURCE_LABELS[c.source ?? ""] ?? "submitted";
  const lines = [
    `<strong>Case submitted${name ? `: ${esc(name)}` : ""}</strong>`,
    `${esc(firm)} · ${c.submitted_date ? day(c.submitted_date) : "date unknown"} · ${how}`,
    nth === 1
      ? "First case for this firm"
      : `${ordinal(nth)} case for this firm${firstCaseAt ? ` (first case ${day(firstCaseAt)})` : ""}`,
    `Case id: ${esc(c.case_id)}`,
    `<a href="${DASHBOARD}/firms/${c.company_hubspot_id}">Firm on the GTM dashboard</a>`,
    `[case:${esc(c.case_id)}]`,
  ];
  return lines.join("<br>");
}

/** Write a note for every case that has a firm and no note yet, oldest
 * first, at most `limit` per call so the hourly run stays inside its budget
 * (a back-fill is a few calls, or one with no limit from a script). */
export async function pushCaseNotes({ limit = 150 }: { limit?: number } = {}) {
  const sb = supabaseService();
  const stats = { pending: 0, created: 0, failed: 0, writesDisabled: false };

  const cases = await selectAll<CaseNoteRow>(
    "cases",
    "sw_id, case_id, case_name, company_hubspot_id, submitted_date, source, creator_email, hubspot_note_id",
    "sw_id",
  );
  const todo = cases
    .filter((c) => c.company_hubspot_id && c.submitted_date && !c.hubspot_note_id)
    .sort((a, b) => (a.submitted_date ?? "").localeCompare(b.submitted_date ?? ""));
  stats.pending = todo.length;
  if (!todo.length) return stats;

  const [companies, contacts] = await Promise.all([
    selectAll<{ hubspot_id: string; name: string | null }>("companies", "hubspot_id, name"),
    selectAll<{ hubspot_id: string; email: string | null }>("contacts", "hubspot_id, email"),
  ]);
  const firmName = new Map(companies.map((c) => [c.hubspot_id, c.name]));
  const contactByEmail = new Map<string, string>();
  for (const k of contacts) if (k.email) contactByEmail.set(k.email.toLowerCase(), k.hubspot_id);

  // The case's place in its firm's history, over ALL the firm's cases (not
  // just the unwritten ones), so a late-arriving row still reads "4th".
  const rank = new Map<string, { nth: number; first: string | null }>();
  const byFirm = new Map<string, CaseNoteRow[]>();
  for (const c of cases) {
    if (!c.company_hubspot_id || !c.submitted_date) continue;
    byFirm.set(c.company_hubspot_id, [...(byFirm.get(c.company_hubspot_id) ?? []), c]);
  }
  for (const list of byFirm.values()) {
    list.sort((a, b) => (a.submitted_date ?? "").localeCompare(b.submitted_date ?? ""));
    list.forEach((c, i) => rank.set(c.sw_id, { nth: i + 1, first: list[0]?.submitted_date ?? null }));
  }

  for (const c of todo.slice(0, limit)) {
    const companyId = c.company_hubspot_id as string;
    const firm = firmName.get(companyId) ?? `Company ${companyId}`;
    const r = rank.get(c.sw_id) ?? { nth: 1, first: null };
    const props = {
      hs_note_body: caseNoteBody(c, firm, r.nth, r.first),
      hs_timestamp: new Date(c.submitted_date as string).toISOString(),
    };
    const contactId = c.creator_email ? contactByEmail.get(c.creator_email.toLowerCase()) : undefined;
    const withContact = [
      { toId: companyId, associationTypeId: ASSOC.noteToCompany },
      ...(contactId ? [{ toId: contactId, associationTypeId: ASSOC.noteToContact }] : []),
    ];
    let res = await hsCreateObject("notes", props, withContact);
    // A contact the cache still holds but HubSpot has merged or deleted fails
    // the whole create; the firm association is the one that matters.
    if (!res.ok && !res.skipped && contactId) {
      res = await hsCreateObject("notes", props, [withContact[0]]);
    }
    if (res.skipped) { stats.writesDisabled = true; break; }
    if (!res.ok || !res.id) { stats.failed += 1; continue; }
    await must(
      `cases hubspot_note_id ${c.sw_id}`,
      sb.from("cases").update({ hubspot_note_id: res.id, hubspot_note_at: new Date().toISOString() }).eq("sw_id", c.sw_id),
    );
    stats.created += 1;
  }
  return stats;
}
