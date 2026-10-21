import { NextRequest } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { runSync, syncResponse } from "@/lib/sync/run";

export const maxDuration = 300;

/** Every 5 min: incremental HubSpot sync. `?full=1` forces a full backfill
 * (admin use, still requires the cron secret). Answers 500 when the sync
 * failed so Vercel's cron monitoring shows it. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  const full = req.nextUrl.searchParams.get("full") === "1";
  return syncResponse(await runSync([full ? "hubspot_full" : "hubspot_incremental"]));
}
