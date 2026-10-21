/** Sync orchestrator with sync_runs bookkeeping.
 *
 * Every kind runs in isolation (one failing does not stop the next), every
 * kind leaves a `sync_runs` row (the heartbeat the ops view and the probe
 * read), a failure is posted to Slack ONCE per outage and once more on
 * recovery, and `syncResponse` turns any failure into an HTTP 500 so Vercel's
 * cron monitoring marks the invocation failed instead of green. */
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { must, supabaseService } from "@/lib/supabase/server";
import { syncHubSpot } from "@/lib/sync/hubspot";
import { syncCalendly } from "@/lib/sync/calendly";
import { computeRollups, syncCases } from "@/lib/sync/cases";
import { syncQuo } from "@/lib/sync/quo";
import { syncStripe } from "@/lib/sync/stripe";
import { syncMetaLeads, syncMetaSpend } from "@/lib/sync/meta";

export type SyncKind =
  | "hubspot_incremental" | "hubspot_full" | "calendly" | "cases" | "rollup"
  | "quo" | "quo_full" | "quo_messages_full" | "stripe" | "meta" | "meta_full"
  | "meta_spend" | "meta_spend_full";

/** Kinds recorded in `sync_runs` that are not run by `runSync` itself. */
export type RecordedKind = SyncKind | "cases_probe";

type Sb = ReturnType<typeof supabaseService>;

/** Status of the most recent FINISHED run of this kind, excluding `runId`. */
async function previousStatus(sb: Sb, kind: RecordedKind, runId: number | null): Promise<"ok" | "error" | null> {
  let q = sb.from("sync_runs").select("status").eq("kind", kind).in("status", ["ok", "error"]);
  if (runId !== null) q = q.neq("id", runId);
  const { data } = await q.order("started_at", { ascending: false }).limit(1).maybeSingle();
  return (data?.status as "ok" | "error" | undefined) ?? null;
}

/** Post one line to the #sales webhook. Never throws - an alert must not turn
 * a recorded failure into an unrecorded one. Skips silently when unset. */
async function slack(text: string) {
  const url = env.slackWebhookUrl();
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`slack alert: HTTP ${res.status}`);
  } catch (e) {
    console.error("slack alert:", e instanceof Error ? e.message : e);
  }
}

/** Alert on the ok/error EDGE only: a cron that fails every minute posts once
 * when it starts failing and once when it comes back, not 1,440 times a day. */
async function alertOnEdge(sb: Sb, kind: RecordedKind, runId: number | null, status: "ok" | "error", error?: string) {
  if (!env.slackWebhookUrl()) return;
  const prev = await previousStatus(sb, kind, runId).catch(() => null);
  if (status === "error" && prev !== "error") {
    await slack(`:rotating_light: Sync failed: ${kind} - ${(error ?? "").slice(0, 300)}`);
  } else if (status === "ok" && prev === "error") {
    await slack(`:white_check_mark: Sync recovered: ${kind}`);
  }
}

/** Open a `sync_runs` row. Throws if the bookkeeping write fails - a run
 * nobody can see is not a run. */
async function startRun(sb: Sb, kind: RecordedKind): Promise<number> {
  const { data } = await must(
    `sync_runs insert (${kind})`,
    sb.from("sync_runs").insert({ kind, status: "running" }).select("id").single(),
  );
  if (!data?.id) throw new Error(`sync_runs insert (${kind}): no id returned`);
  return data.id as number;
}

async function finishRun(
  sb: Sb, kind: RecordedKind, runId: number,
  outcome: { status: "ok"; stats: Record<string, unknown> } | { status: "error"; error: string },
) {
  const finished_at = new Date().toISOString();
  await alertOnEdge(sb, kind, runId, outcome.status, outcome.status === "error" ? outcome.error : undefined);
  await must(`sync_runs update (${kind} #${runId})`, sb.from("sync_runs").update(
    outcome.status === "ok"
      ? { status: "ok", finished_at, stats: outcome.stats }
      : { status: "error", finished_at, error: outcome.error },
  ).eq("id", runId));
}

/** One-shot `sync_runs` row for work that did not go through `runSync` (the
 * cases probe records itself only when it triggers or fails). Same edge
 * alerting as a real run. */
export async function recordRun(
  kind: RecordedKind,
  outcome: { status: "ok"; stats: Record<string, unknown> } | { status: "error"; error: string },
  startedAt: Date,
) {
  const sb = supabaseService();
  await alertOnEdge(sb, kind, null, outcome.status, outcome.status === "error" ? outcome.error : undefined);
  await must(`sync_runs insert (${kind})`, sb.from("sync_runs").insert({
    kind,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    ...(outcome.status === "ok" ? { status: "ok", stats: outcome.stats } : { status: "error", error: outcome.error }),
  }));
}

/** Finished time of the last successful run of any of `kinds` (watermark). */
async function lastOkFinishedMs(sb: Sb, kinds: SyncKind[]): Promise<number | null> {
  const { data } = await must(
    `sync_runs watermark (${kinds.join(",")})`,
    sb.from("sync_runs").select("finished_at").in("kind", kinds).eq("status", "ok")
      .order("finished_at", { ascending: false }).limit(1).maybeSingle(),
  );
  return data?.finished_at ? new Date(data.finished_at).getTime() : null;
}

async function runKind(sb: Sb, kind: SyncKind): Promise<Record<string, unknown>> {
  if (kind === "hubspot_full") return syncHubSpot("full");
  if (kind === "hubspot_incremental") {
    // window = last successful hubspot sync minus 5 min of slack
    const last = await lastOkFinishedMs(sb, ["hubspot_incremental", "hubspot_full"]);
    const sinceMs = last !== null ? last - 5 * 60 * 1000 : Date.now() - 7 * 24 * 60 * 60 * 1000;
    return syncHubSpot("incremental", sinceMs);
  }
  if (kind === "calendly") return syncCalendly();
  if (kind === "quo" || kind === "quo_full" || kind === "quo_messages_full") {
    // Routine runs only revisit threads that moved since the last success,
    // because cost is participants x lines and grows with every new number
    // a rep dials. A day of overlap covers a late-landing call.
    let sinceMs: number | undefined;
    if (kind === "quo") {
      const last = await lastOkFinishedMs(sb, ["quo", "quo_full"]);
      if (last !== null) sinceMs = last - 24 * 60 * 60 * 1000;
    }
    // Backfilling texts alone: the full CALL walk (every number x every
    // line) does not fit in the 300s function limit, but the message walk
    // is one request per thread and comfortably does.
    return syncQuo(sinceMs, { skipCalls: kind === "quo_messages_full" });
  }
  if (kind === "stripe") {
    // Always a full pull: the whole account is ~50 customers and a few
    // hundred charges, and refunds mutate rows that are already synced, so
    // an incremental window would miss money coming back out.
    return syncStripe();
  }
  if (kind === "meta" || kind === "meta_full") {
    // Incremental by default: each form is asked only for leads newer than
    // the last success, less a day of overlap. Full re-reads whatever Meta
    // still holds (~90 days) - the upsert makes that idempotent.
    let sinceMs: number | undefined;
    if (kind === "meta") {
      const last = await lastOkFinishedMs(sb, ["meta", "meta_full"]);
      if (last !== null) sinceMs = last - 24 * 60 * 60 * 1000;
    }
    return syncMetaLeads(sinceMs);
  }
  if (kind === "meta_spend" || kind === "meta_spend_full") return syncMetaSpend(kind === "meta_spend_full");
  if (kind === "cases") return syncCases();
  if (kind === "rollup") return computeRollups();
  throw new Error(`unknown sync kind ${kind satisfies never}`);
}

export async function runSync(kinds: SyncKind[]) {
  const sb = supabaseService();
  const results: Record<string, unknown> = {};

  for (const kind of kinds) {
    let runId: number;
    try {
      runId = await startRun(sb, kind);
    } catch (e) {
      // Supabase itself is unreachable: nothing could be cached anyway. Report
      // the kind as failed and move on to the next.
      results[kind] = { error: e instanceof Error ? e.message : String(e) };
      continue;
    }
    try {
      const stats = await runKind(sb, kind);
      results[kind] = stats;
      await finishRun(sb, kind, runId, { status: "ok", stats });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      results[kind] = { error };
      await finishRun(sb, kind, runId, { status: "error", error })
        .catch((e2) => console.error(`sync_runs update (${kind}):`, e2 instanceof Error ? e2.message : e2));
    }
  }
  return results;
}

/** True when any kind in a `runSync` result ended in error. */
export function syncFailed(results: Record<string, unknown>): boolean {
  return Object.values(results).some(
    (r) => typeof r === "object" && r !== null && "error" in r && (r as { error?: unknown }).error,
  );
}

/** The route response for a `runSync` result: same JSON body either way, but
 * HTTP 500 when any kind failed. Vercel only counts a cron invocation as
 * failed on a non-2xx, so a 200 carrying `{ error }` used to read as healthy
 * in its cron monitoring. */
export function syncResponse(results: Record<string, unknown>) {
  return NextResponse.json(results, { status: syncFailed(results) ? 500 : 200 });
}
