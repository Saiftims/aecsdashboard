import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runSync } from "@/lib/sync/run";

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  if (!secret) return true; // not configured yet (local dev)
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Actual Meta Ads spend per day into `meta_ad_spend_daily` (unit economics)
 * plus every ad, its creative and per-ad daily insights into `meta_ads` /
 * `meta_ad_insights_daily` (Marketing page). `?full=1` re-reads from the
 * account's first spend instead of the last 45 days. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const full = req.nextUrl.searchParams.get("full") === "1";
  return NextResponse.json(await runSync([full ? "meta_spend_full" : "meta_spend"]));
}
