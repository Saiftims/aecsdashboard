import { NextRequest, NextResponse } from "next/server";
import { cronUnauthorized, env } from "@/lib/env";
import { EXCLUDED_CASE_IDS, PostHogProvider, isTestCaseActor } from "@/lib/cases/provider";
import { must, supabaseService } from "@/lib/supabase/server";
import { recordRun, runSync, syncFailed } from "@/lib/sync/run";

export const maxDuration = 300;

const STATE_KEY = "cases_probe_state";
const HEALTH_KEY = "cases_probe_health";
const MINUTE = 60_000;
/** PostHog answers a share of minutes with 503 `clickhouse_at_capacity` or a
 * 504 execution-time limit even for this fifteen-minute read (6 of ~1,440
 * probes on 2026-10-21, every triggered sync fine). One such minute costs
 * nothing - the next probe re-reads the same window - so it is retried once,
 * then skipped quietly; only this many busy minutes IN A ROW is an outage
 * worth a Slack alert. */
const BUSY_RETRY_AFTER = 4_000;
const BUSY_STREAK_ALERT = 5;
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
 * 1,440 rows a day saying nothing. The triggered syncs record their own rows.
 * A PostHog-busy minute is not a failure (see BUSY_STREAK_ALERT): it leaves
 * no row until the streak is long enough to be an outage, and the first good
 * probe after an alert records an `ok` so the recovery posts at once instead
 * of waiting for the next new case to trigger a sync. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  if (!env.posthogKey() || !env.posthogProjectId()) return NextResponse.json({ skipped: "posthog not configured" });

  const startedAt = new Date();
  const sb = supabaseService();
  try {
    const out = await probe(startedAt.getTime());
    const streak = await readBusyStreak(sb);
    if (streak > 0) {
      await writeBusyStreak(sb, 0, null);
      if (streak >= BUSY_STREAK_ALERT && !out.triggered) {
        await recordRun("cases_probe", { status: "ok", stats: { recoveredAfterBusyMinutes: streak, active: out.active } }, startedAt);
      }
    }
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
    if (isPostHogBusy(error)) {
      const streak = (await readBusyStreak(sb).catch(() => 0)) + 1;
      await writeBusyStreak(sb, streak, error).catch((e2) => console.error("cases_probe health:", e2 instanceof Error ? e2.message : e2));
      if (streak < BUSY_STREAK_ALERT) {
        console.warn(`cases_probe: PostHog busy (${streak} in a row), skipping this minute: ${error.slice(0, 160)}`);
        return NextResponse.json({ skipped: "posthog busy", streak, error: error.slice(0, 300) });
      }
    }
    // Best-effort: if Supabase is the thing that is down this cannot land
    // either, and the 500 below is still the loud part.
    await recordRun("cases_probe", { status: "error", error }, startedAt)
      .catch((e2) => console.error("cases_probe record:", e2 instanceof Error ? e2.message : e2));
    return NextResponse.json({ error }, { status: 500 });
  }
}

/** PostHog capacity / execution-time answers - transient on their side. */
function isPostHogBusy(error: string): boolean {
  return /PostHog query -> (429|50[234])\b/.test(error)
    || /clickhouse_at_capacity|max execution time|too busy right now/i.test(error);
}

type Sb = ReturnType<typeof supabaseService>;

async function readBusyStreak(sb: Sb): Promise<number> {
  const { data } = await must("cases probe health read",
    sb.from("settings").select("value").eq("key", HEALTH_KEY).maybeSingle());
  const v = (data?.value ?? {}) as { busyStreak?: number };
  return Number(v.busyStreak) || 0;
}

async function writeBusyStreak(sb: Sb, busyStreak: number, lastError: string | null) {
  await must("cases probe health upsert", sb.from("settings").upsert({
    key: HEALTH_KEY,
    value: { busyStreak, lastError: lastError?.slice(0, 500) ?? null, at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" }));
}

/** The probe read, retried once when PostHog is busy - the window is small
 * enough that a second attempt a few seconds later usually goes through. */
async function readRecent(provider: PostHogProvider, minutes: number) {
  try {
    return await provider.listRecentCaseActivity(minutes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isPostHogBusy(msg)) throw e;
    await new Promise((r) => setTimeout(r, BUSY_RETRY_AFTER));
    return provider.listRecentCaseActivity(minutes);
  }
}

async function probe(now: number) {
  const sb = supabaseService();
  const provider = new PostHogProvider(env.posthogKey(), env.posthogProjectId(), env.posthogHost());
  const recent = (await readRecent(provider, 15)).filter((r) =>
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
