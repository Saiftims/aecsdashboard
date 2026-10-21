import { NextRequest } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { runSync, syncResponse } from "@/lib/sync/run";

export const maxDuration = 300;

/** Every 5 min: pull Quo calls and texts, the source of truth for both.
 *
 * `?full=1` re-walks every known number instead of only threads that moved.
 * `?messages=1` backfills texts only - the full call walk is every number x
 * every line and outgrows the 300s limit, while the message walk is one
 * request per thread and fits.
 */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  const params = req.nextUrl.searchParams;
  if (params.get("messages") === "1") {
    return syncResponse(await runSync(["quo_messages_full"]));
  }
  const full = params.get("full") === "1";
  return syncResponse(await runSync([full ? "quo_full" : "quo"]));
}
