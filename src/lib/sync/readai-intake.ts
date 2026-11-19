/** Read.ai: re-read stored calls for how the firm runs its intake.
 *
 * The intake fields were added to the extraction after ~170 calls had been
 * synced. Those calls already have a transcript in `readai_meetings.raw`, so
 * this reads each one again with the same prompt the webhook uses and keeps
 * only the intake answers:
 *
 *   - the answers are merged into the call's stored `extracted` (which also
 *     marks the call as done, so a run can stop and resume);
 *   - the call's HubSpot note gets the intake lines - only when the call
 *     said something, and without disturbing a note someone has edited;
 *   - the company's intake properties are set from all of its calls, the
 *     most recent call that spoke to a field winning.
 *
 * Nothing else about the call is re-judged or re-written: not the contact
 * matching, the deal, the other properties, or the next-step task.
 */
import { hsRequest, hsUpdateProperties, type HsObject } from "@/lib/hubspot/client";
import { must, supabaseService } from "@/lib/supabase/server";
import {
  ensureReadAiProperties, Extraction, extractCallFacts, INTAKE_FIELDS, intakeLines, intakeProps, internalEmailSet, latestIntake,
  noteBody, splitParticipants, type ReadAiPayload,
} from "@/lib/sync/readai";

type Stored = Record<string, unknown>;
interface Row {
  session_id: string; title: string | null; started_at: string | null; extracted: Stored | null;
  hubspot_company_id: string | null; hubspot_note_id: string | null;
}

export interface IntakeBackfillStats {
  synced_calls: number; remaining_before: number; examined: number; with_intake: number; failed: number;
  notes_updated: number; companies_updated: number; remaining: number; dry: boolean;
  properties: string[]; errors: string[];
  calls: { date: string; firm: unknown; handled_by: unknown; tools: unknown; documents: unknown; notes: unknown; quote: unknown; speaker: unknown }[];
}

const examined = (x: Stored | null) => !!x && "intake_handled_by" in x;
const hasIntake = (x: Stored | null) => !!x && INTAKE_FIELDS.some((k) => x[k]);

/** Put the intake lines on an existing call note. An untouched note is
 * rewritten whole (so the lines sit with the other facts); one that no longer
 * matches what we wrote - edited by a rep, or reformatted by HubSpot - only
 * has the lines appended. */
async function addIntakeToNote(noteId: string, p: ReadAiPayload, x: Extraction): Promise<boolean> {
  const cur = await hsRequest<HsObject>("GET", `/crm/v3/objects/notes/${noteId}`, undefined, { properties: "hs_note_body" }).catch(() => null);
  if (!cur) return false;
  const body = cur.properties.hs_note_body ?? "";
  const lines = intakeLines(x);
  if (body.includes(lines[0])) return false;
  const next = body.trim() === noteBody(p, x, { intake: false }).trim()
    ? noteBody(p, x)
    : /<(p|br|div)\b/i.test(body) ? `${body}<p>${lines.join("<br>")}</p>` : `${body}\n${lines.join("\n")}`;
  return (await hsUpdateProperties("notes", noteId, { hs_note_body: next })).ok;
}

/** Set a company's intake properties to what its calls say, newest first.
 * Returns whether anything changed. */
async function writeCompanyIntake(companyId: string, calls: Row[]): Promise<boolean> {
  const desired = intakeProps(latestIntake(calls.map((c) => ({ started_at: c.started_at, extracted: c.extracted as Parameters<typeof latestIntake>[0][number]["extracted"] }))));
  const keys = Object.keys(desired).filter((k) => desired[k]);
  if (!keys.length) return false;
  const cur = await hsRequest<HsObject>("GET", `/crm/v3/objects/companies/${companyId}`, undefined, { properties: keys.join(",") }).catch(() => null);
  if (!cur) return false;
  const changed = Object.fromEntries(keys.filter((k) => (cur.properties[k] ?? "") !== desired[k]).map((k) => [k, desired[k]]));
  if (!Object.keys(changed).length) return false;
  return (await hsUpdateProperties("companies", companyId, changed)).ok;
}

/** Examine up to `max` not-yet-examined synced calls, newest first, `concurrency`
 * at a time, stopping before `deadline`. `dry` reads and reports without
 * storing or writing anything. */
export async function backfillIntake(opts: { max?: number; deadline?: number; dry?: boolean; concurrency?: number; offset?: number } = {}): Promise<IntakeBackfillStats> {
  const sb = supabaseService();
  const max = opts.max ?? 30;
  const deadline = opts.deadline ?? Date.now() + 240_000;
  const dry = !!opts.dry;
  const { data } = await must("readai_meetings synced", sb.from("readai_meetings")
    .select("session_id,title,started_at,extracted,hubspot_company_id,hubspot_note_id").eq("status", "synced")
    .order("started_at", { ascending: false }).limit(2000));
  const rows = (data ?? []) as Row[];
  const todo = rows.filter((r) => !examined(r.extracted));
  const s: IntakeBackfillStats = {
    synced_calls: rows.length, remaining_before: todo.length, examined: 0, with_intake: 0, failed: 0,
    notes_updated: 0, companies_updated: 0, remaining: todo.length, dry, properties: [], errors: [], calls: [],
  };
  if (!todo.length) return s;
  if (!dry) s.properties = await ensureReadAiProperties();
  const internal = await internalEmailSet();
  const touched = new Set<string>();

  const one = async (row: Row) => {
    try {
      const { data: full } = await must("readai_meetings raw", sb.from("readai_meetings").select("raw").eq("session_id", row.session_id).single());
      const p = (full as { raw: ReadAiPayload } | null)?.raw;
      if (!p) throw new Error("stored payload missing");
      const firm = typeof row.extracted?.firm_name === "string" ? row.extracted.firm_name : null;
      const x = await extractCallFacts(p, { ...splitParticipants(p.participants, internal), knownContacts: [], knownCompany: firm });
      const merged: Stored = {
        ...(row.extracted ?? {}),
        intake_handled_by: x.intake_handled_by, intake_tools: x.intake_tools, intake_documents: x.intake_documents, intake_notes: x.intake_notes,
        evidence: { ...((row.extracted?.evidence as Stored | undefined) ?? {}), intake: x.evidence.intake ?? null, intake_speaker: x.evidence.intake_speaker ?? null },
      };
      s.examined++;
      const found = hasIntake(merged);
      if (found) s.with_intake++;
      if (found || dry) {
        s.calls.push({ date: (row.started_at ?? "").slice(0, 10), firm: firm ?? row.title, handled_by: x.intake_handled_by, tools: x.intake_tools, documents: x.intake_documents, notes: x.intake_notes, quote: x.evidence.intake ?? null, speaker: x.evidence.intake_speaker ?? null });
      }
      if (dry) return;
      await must("readai_meetings intake", sb.from("readai_meetings").update({ extracted: merged }).eq("session_id", row.session_id));
      row.extracted = merged;
      if (!found) return;
      if (row.hubspot_company_id) touched.add(row.hubspot_company_id);
      // The call is stored as examined by now, so a note that cannot be
      // updated is reported rather than retried with the whole call.
      if (row.hubspot_note_id) {
        try {
          if (await addIntakeToNote(row.hubspot_note_id, p, Extraction.parse(merged))) s.notes_updated++;
        } catch (e) {
          s.errors.push(`note ${row.hubspot_note_id} (${firm ?? row.title ?? row.session_id}): ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
        }
      }
    } catch (e) {
      s.failed++;
      s.errors.push(`${row.session_id} ${row.title ?? ""}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
  };

  // `offset` only makes sense with `dry`, to sample older calls: a real run
  // always takes the newest calls still to do.
  const start = dry ? Math.max(0, opts.offset ?? 0) : 0;
  const batch = todo.slice(start, start + max);
  const width = Math.max(1, Math.min(opts.concurrency ?? 3, 6));
  for (let i = 0; i < batch.length && Date.now() < deadline; i += width) {
    await Promise.all(batch.slice(i, i + width).map(one));
  }

  // Companies last and one at a time, from every call we hold for them, so
  // two calls with the same firm in one batch cannot race each other.
  for (const companyId of touched) {
    try {
      if (await writeCompanyIntake(companyId, rows.filter((r) => r.hubspot_company_id === companyId))) s.companies_updated++;
    } catch (e) {
      s.errors.push(`company ${companyId}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
  }
  s.remaining = dry ? todo.length : rows.filter((r) => !examined(r.extracted)).length;
  return s;
}
