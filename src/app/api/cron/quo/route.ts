import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runSync } from "@/lib/sync/run";

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  if (!secret) return true; // not configured yet (local dev)
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Hourly: pull Quo calls and texts, the source of truth for both.
 *
 * `?full=1` re-walks every known number instead of only threads that moved.
 * `?messages=1` backfills texts only - the full call walk is every number x
 * every line and outgrows the 300s limit, while the message walk is one
 * request per thread and fits.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = req.nextUrl.searchParams;
  if (params.get("messages") === "1") {
    return NextResponse.json(await runSync(["quo_messages_full"]));
  }
  const full = params.get("full") === "1";
  return NextResponse.json(await runSync([full ? "quo_full" : "quo"]));
}
