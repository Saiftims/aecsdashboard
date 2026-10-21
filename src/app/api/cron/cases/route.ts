import { NextRequest } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { runSync, syncResponse } from "@/lib/sync/run";

export const maxDuration = 300;

/** Hourly (at :05): case pull + rollups + lifecycle automation + HubSpot
 * write-back. The cases-probe cron triggers the same pair early when PostHog
 * shows a case the table does not have yet. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  return syncResponse(await runSync(["cases", "rollup"]));
}
