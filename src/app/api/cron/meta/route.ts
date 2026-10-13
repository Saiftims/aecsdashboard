import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runSync } from "@/lib/sync/run";

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  if (!secret) return true; // not configured yet (local dev)
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Pull Meta Lead Ads submissions into `meta_leads`. `?full=1` re-reads every
 * lead Meta still holds instead of only those since the last run. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const full = req.nextUrl.searchParams.get("full") === "1";
  return NextResponse.json(await runSync([full ? "meta_full" : "meta"]));
}
