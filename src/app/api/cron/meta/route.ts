import { NextRequest } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { runSync, syncResponse } from "@/lib/sync/run";

export const maxDuration = 300;

/** Every minute (owner rule: a Meta lead is in HubSpot within 60s): pull Meta
 * Lead Ads submissions into `meta_leads` and push the new ones to HubSpot.
 * `?full=1` re-reads every lead Meta still holds instead of only those since
 * the last run. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  const full = req.nextUrl.searchParams.get("full") === "1";
  return syncResponse(await runSync([full ? "meta_full" : "meta"]));
}
