import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { EXCLUDED_CASE_IDS, PostHogProvider, isTestCaseActor } from "@/lib/cases/provider";
import { supabaseService } from "@/lib/supabase/server";
import { runSync } from "@/lib/sync/run";

export const maxDuration = 300;

const STATE_KEY = "cases_probe_state";
const MINUTE = 60_000;
/** A new case's owner is resolved from its early events, which keep arriving
 * for a few minutes after submission, so an unknown id is retried for this
 * long before the hourly full sync is left to pick it up. */
const RETRY_FOR = 10 * MINUTE;
const MIN_GAP = 2 * MINUTE;
const FORGET_AFTER = 7 * 24 * 60 * MINUTE;

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

interface ProbeState { seen: Record<string, string>; lastFull: string | null }

/** Every minute: run the full cases sync only when PostHog shows a case id the
 * table does not have yet. The full sync reads 400 days of events four times,
 * which is too heavy for PostHog's query limits at one run a minute; this reads
 * fifteen minutes. Ids the full sync deliberately leaves out (test actors,
 * stand-in absorbed matters) stay unknown forever, so each one is retried for
 * ten minutes after it first appears and then left alone. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!env.posthogKey() || !env.posthogProjectId()) return NextResponse.json({ skipped: "posthog not configured" });

  const sb = supabaseService();
  const now = Date.now();
  const provider = new PostHogProvider(env.posthogKey(), env.posthogProjectId(), env.posthogHost());
  const recent = (await provider.listRecentCaseActivity(15)).filter((r) =>
    !EXCLUDED_CASE_IDS.includes(r.caseId)
    && !(r.actors.length && r.actors.every(([email, acc]) => email && isTestCaseActor(email, acc))));
  const ids = recent.map((r) => r.caseId);

  const { data: known } = ids.length
    ? await sb.from("cases").select("case_id").in("case_id", ids)
    : { data: [] as { case_id: string }[] };
  const knownIds = new Set((known ?? []).map((k) => k.case_id));
  const unknown = ids.filter((id) => !knownIds.has(id));

  const { data: row } = await sb.from("settings").select("value").eq("key", STATE_KEY).maybeSingle();
  const prev = (row?.value ?? {}) as Partial<ProbeState>;
  const seen: Record<string, string> = {};
  for (const [id, at] of Object.entries(prev.seen ?? {})) {
    if (now - Date.parse(at) < FORGET_AFTER) seen[id] = at;
  }
  for (const id of unknown) seen[id] ??= new Date(now).toISOString();
  const fresh = unknown.filter((id) => now - Date.parse(seen[id]) <= RETRY_FOR);

  const lastFull = prev.lastFull ? Date.parse(prev.lastFull) : 0;
  const { data: running } = await sb.from("sync_runs").select("id")
    .eq("kind", "cases").eq("status", "running")
    .gte("started_at", new Date(now - 5 * MINUTE).toISOString()).limit(1);

  let results: Record<string, unknown> | null = null;
  const trigger = fresh.length > 0 && now - lastFull >= MIN_GAP && !(running ?? []).length;
  if (trigger) results = await runSync(["cases", "rollup", "stripe"]);

  await sb.from("settings").upsert({
    key: STATE_KEY,
    value: { seen, lastFull: trigger ? new Date(now).toISOString() : prev.lastFull ?? null },
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });

  return NextResponse.json({ active: ids.length, unknown, triggered: trigger, results });
}
