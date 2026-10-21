import { NextRequest, NextResponse } from "next/server";
import { cronUnauthorized, env } from "@/lib/env";
import { EXCLUDED_CASE_IDS, PostHogProvider, isTestCaseActor } from "@/lib/cases/provider";
import { must, supabaseService } from "@/lib/supabase/server";
import { recordRun, runSync, syncFailed } from "@/lib/sync/run";

export const maxDuration = 300;

const STATE_KEY = "cases_probe_state";
const MINUTE = 60_000;
/** A new case's owner is resolved from its early events, which keep arriving
 * for a few minutes after submission, so an unknown id is retried for this
 * long before the hourly full sync is left to pick it up. */
const RETRY_FOR = 10 * MINUTE;
const MIN_GAP = 2 * MINUTE;
const FORGET_AFTER = 7 * 24 * 60 * MINUTE;

interface ProbeState { seen: Record<string, string>; lastFull: string | null }

/** Every minute: run the full cases sync only when PostHog shows a case id the
 * table does not have yet. The full sync reads 400 days of events four times,
 * which is too heavy for PostHog's query limits at one run a minute; this reads
 * fifteen minutes. Ids the full sync deliberately leaves out (test actors,
 * stand-in absorbed matters) stay unknown forever, so each one is retried for
 * ten minutes after it first appears and then left alone.
 *
 * Heartbeat: a `sync_runs` row of kind `cases_probe` is written only when the
 * probe TRIGGERS a sync or FAILS - not on every quiet minute, which would be
 * 1,440 rows a day saying nothing. The triggered syncs record their own rows. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  if (!env.posthogKey() || !env.posthogProjectId()) return NextResponse.json({ skipped: "posthog not configured" });

  const startedAt = new Date();
  try {
    const out = await probe(startedAt.getTime());
    if (out.triggered) {
      const failed = out.results !== null && syncFailed(out.results);
      await recordRun("cases_probe", failed
        ? { status: "error", error: `triggered sync failed: ${JSON.stringify(out.results)}`.slice(0, 2000) }
        : { status: "ok", stats: { active: out.active, unknown: out.unknown, results: out.results } }, startedAt);
      return NextResponse.json(out, { status: failed ? 500 : 200 });
    }
    return NextResponse.json(out);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Best-effort: if Supabase is the thing that is down this cannot land
    // either, and the 500 below is still the loud part.
    await recordRun("cases_probe", { status: "error", error }, startedAt)
      .catch((e2) => console.error("cases_probe record:", e2 instanceof Error ? e2.message : e2));
    return NextResponse.json({ error }, { status: 500 });
  }
}

async function probe(now: number) {
  const sb = supabaseService();
  const provider = new PostHogProvider(env.posthogKey(), env.posthogProjectId(), env.posthogHost());
  const recent = (await provider.listRecentCaseActivity(15)).filter((r) =>
    !EXCLUDED_CASE_IDS.includes(r.caseId)
    && !(r.actors.length && r.actors.every(([email, acc]) => email && isTestCaseActor(email, acc))));
  const ids = recent.map((r) => r.caseId);

  // Checked: an unchecked failed read here returned null, every id looked
  // unknown, and the probe fired the heavy sync for nothing.
  const { data: known } = ids.length
    ? await must("cases probe known-ids read", sb.from("cases").select("case_id").in("case_id", ids))
    : { data: [] as { case_id: string }[] };
  const knownIds = new Set((known ?? []).map((k) => k.case_id));
  const unknown = ids.filter((id) => !knownIds.has(id));

  const { data: row } = await must(
    "cases probe state read",
    sb.from("settings").select("value").eq("key", STATE_KEY).maybeSingle(),
  );
  const prev = (row?.value ?? {}) as Partial<ProbeState>;
  const seen: Record<string, string> = {};
  for (const [id, at] of Object.entries(prev.seen ?? {})) {
    if (now - Date.parse(at) < FORGET_AFTER) seen[id] = at;
  }
  for (const id of unknown) seen[id] ??= new Date(now).toISOString();
  const fresh = unknown.filter((id) => now - Date.parse(seen[id]) <= RETRY_FOR);

  const lastFull = prev.lastFull ? Date.parse(prev.lastFull) : 0;
  const { data: running } = await must(
    "cases probe running-sync read",
    sb.from("sync_runs").select("id")
      .eq("kind", "cases").eq("status", "running")
      .gte("started_at", new Date(now - 5 * MINUTE).toISOString()).limit(1),
  );

  let results: Record<string, unknown> | null = null;
  const trigger = fresh.length > 0 && now - lastFull >= MIN_GAP && !(running ?? []).length;
  if (trigger) results = await runSync(["cases", "rollup", "stripe"]);

  // Fatal: if the state is lost, `seen` resets and every unknown id reads as
  // fresh again, so the probe re-triggers the heavy sync every two minutes.
  await must("cases probe state upsert", sb.from("settings").upsert({
    key: STATE_KEY,
    value: { seen, lastFull: trigger ? new Date(now).toISOString() : prev.lastFull ?? null },
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" }));

  return { active: ids.length, unknown, triggered: trigger, results };
}
