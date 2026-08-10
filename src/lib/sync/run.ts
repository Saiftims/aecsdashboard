/** Sync orchestrator with sync_runs bookkeeping. */
import { supabaseService } from "@/lib/supabase/server";
import { syncHubSpot } from "@/lib/sync/hubspot";
import { syncCalendly } from "@/lib/sync/calendly";
import { computeRollups, syncCases } from "@/lib/sync/cases";
import { syncQuo } from "@/lib/sync/quo";

export type SyncKind =
  | "hubspot_incremental" | "hubspot_full" | "calendly" | "cases" | "rollup"
  | "quo" | "quo_full" | "quo_messages_full";

export async function runSync(kinds: SyncKind[]) {
  const sb = supabaseService();
  const results: Record<string, unknown> = {};

  for (const kind of kinds) {
    const { data: run } = await sb.from("sync_runs")
      .insert({ kind, status: "running" }).select("id").single();
    const runId = run?.id;
    try {
      let stats: Record<string, unknown> = {};
      if (kind === "hubspot_full") {
        stats = await syncHubSpot("full");
      } else if (kind === "hubspot_incremental") {
        // window = last successful hubspot sync minus 5 min of slack
        const { data: last } = await sb.from("sync_runs")
          .select("finished_at")
          .in("kind", ["hubspot_incremental", "hubspot_full"])
          .eq("status", "ok")
          .order("finished_at", { ascending: false })
          .limit(1).maybeSingle();
        const sinceMs = last?.finished_at
          ? new Date(last.finished_at).getTime() - 5 * 60 * 1000
          : Date.now() - 7 * 24 * 60 * 60 * 1000;
        stats = await syncHubSpot("incremental", sinceMs);
      } else if (kind === "calendly") {
        stats = await syncCalendly();
      } else if (kind === "quo" || kind === "quo_full" || kind === "quo_messages_full") {
        // Routine runs only revisit threads that moved since the last success,
        // because cost is participants x lines and grows with every new number
        // a rep dials. A day of overlap covers a late-landing call.
        let sinceMs: number | undefined;
        if (kind === "quo") {
          const { data: last } = await sb.from("sync_runs")
            .select("finished_at").in("kind", ["quo", "quo_full"]).eq("status", "ok")
            .order("finished_at", { ascending: false }).limit(1).maybeSingle();
          if (last?.finished_at) {
            sinceMs = new Date(last.finished_at).getTime() - 24 * 60 * 60 * 1000;
          }
        }
        // Backfilling texts alone: the full CALL walk (every number x every
        // line) does not fit in the 300s function limit, but the message walk
        // is one request per thread and comfortably does.
        stats = await syncQuo(sinceMs, { skipCalls: kind === "quo_messages_full" });
      } else if (kind === "cases") {
        stats = await syncCases();
      } else if (kind === "rollup") {
        stats = await computeRollups();
      }
      results[kind] = stats;
      await sb.from("sync_runs").update({
        status: "ok", finished_at: new Date().toISOString(), stats,
      }).eq("id", runId);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      results[kind] = { error };
      await sb.from("sync_runs").update({
        status: "error", finished_at: new Date().toISOString(), error,
      }).eq("id", runId);
    }
  }
  return results;
}
