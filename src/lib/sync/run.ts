/** Sync orchestrator with sync_runs bookkeeping. */
import { supabaseService } from "@/lib/supabase/server";
import { syncHubSpot } from "@/lib/sync/hubspot";
import { computeRollups, syncCases } from "@/lib/sync/cases";

export type SyncKind = "hubspot_incremental" | "hubspot_full" | "cases" | "rollup";

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
