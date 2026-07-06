import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runSync } from "@/lib/sync/run";

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  if (!secret) return true; // not configured yet (local dev)
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Every 15 min: incremental HubSpot sync. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const results = await runSync(["hubspot_incremental"]);
  return NextResponse.json(results);
}
