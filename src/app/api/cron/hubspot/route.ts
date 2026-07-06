import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runSync } from "@/lib/sync/run";

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  if (!secret) return true; // not configured yet (local dev)
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Every 15 min: incremental HubSpot sync. `?full=1` forces a full backfill
 * (admin use, still requires the cron secret). */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const full = req.nextUrl.searchParams.get("full") === "1";
  const results = await runSync([full ? "hubspot_full" : "hubspot_incremental"]);
  return NextResponse.json(results);
}
