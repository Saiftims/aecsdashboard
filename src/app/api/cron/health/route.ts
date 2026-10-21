import { NextRequest } from "next/server";
import { cronUnauthorized, env } from "@/lib/env";
import { must, supabaseService } from "@/lib/supabase/server";
import { systemHealth } from "@/lib/system-health";

export const maxDuration = 60;

/** Every 30 min: evaluate system health and post to Slack when the set of
 * RED problems changes (new outage, or everything cleared). The per-run
 * failure alert in `run.ts` catches a sync that throws; this catches the
 * quieter failures - a feed that stopped being scheduled, a token about to
 * expire, a table that silently stopped growing, data-quality traps filling
 * up. Also the JSON heartbeat an external monitor can poll.
 *
 * `POST ?agent=quick|full&status=ok|error` is the heartbeat the GitHub
 * Actions agent sends after each run, so the agent shows up as a feed here
 * even though it runs outside Vercel. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  const health = await systemHealth();
  const sb = supabaseService();

  const red = health.problems.filter((p) => p.level === "bad").map((p) => p.text).sort();
  const signature = red.join("\n");
  const { data: prev } = await sb.from("settings").select("value").eq("key", "health_alert_signature").maybeSingle();
  const previous = (prev?.value as string | null) ?? "";

  let posted = false;
  if (signature !== previous) {
    const url = env.slackWebhookUrl();
    if (url) {
      const text = red.length
        ? `:rotating_light: *Dashboard health: ${red.length} red*\n${red.map((r) => `• ${r}`).join("\n")}\n<https://gtm-dashboard-fawn.vercel.app/health|Open system health>`
        : ":white_check_mark: Dashboard health: all red items cleared.";
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => null);
      posted = Boolean(res?.ok);
    }
    await must("settings upsert health_alert_signature",
      sb.from("settings").upsert({ key: "health_alert_signature", value: signature }, { onConflict: "key" }));
  }

  return Response.json({ level: health.level, red: red.length, amber: health.problems.length - red.length, posted, generatedAt: health.generatedAt },
    { status: health.level === "bad" ? 503 : 200 });
}

export async function POST(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  const agent = req.nextUrl.searchParams.get("agent") === "full" ? "agent_full" : "agent_quick";
  const status = req.nextUrl.searchParams.get("status") === "error" ? "error" : "ok";
  const error = req.nextUrl.searchParams.get("error");
  const sb = supabaseService();
  await must("sync_runs insert (agent heartbeat)", sb.from("sync_runs").insert({
    kind: agent, status, finished_at: new Date().toISOString(),
    stats: { source: "github-actions", run: req.nextUrl.searchParams.get("run") ?? null },
    error: status === "error" ? (error ?? "GitHub Actions job failed") : null,
  }));
  return Response.json({ ok: true, kind: agent, status });
}
