import { NextRequest } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { runSync, syncResponse } from "@/lib/sync/run";

export const maxDuration = 300;

/** Every 6 hours (at :20): actual Meta Ads spend per day into
 * `meta_ad_spend_daily` (unit economics) plus every ad, its creative and
 * per-ad daily insights into `meta_ads` / `meta_ad_insights_daily` (Marketing
 * page). `?full=1` re-reads from the account's first spend instead of the last
 * 45 days. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  const full = req.nextUrl.searchParams.get("full") === "1";
  return syncResponse(await runSync([full ? "meta_spend_full" : "meta_spend"]));
}
