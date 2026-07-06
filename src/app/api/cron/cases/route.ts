import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runSync } from "@/lib/sync/run";

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Nightly: case pull + rollups + lifecycle automation + HubSpot write-back. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const results = await runSync(["cases", "rollup"]);
  return NextResponse.json(results);
}
