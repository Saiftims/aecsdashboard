import { NextRequest } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { runSync, syncResponse } from "@/lib/sync/run";

export const maxDuration = 300;

/** Every 5 min: Calendly bookings. Without this the only thing that refreshes
 * demo data is a signed-in user pressing Refresh, so demo counts drift
 * whenever nobody does. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  return syncResponse(await runSync(["calendly"]));
}
