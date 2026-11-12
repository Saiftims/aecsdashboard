import { NextRequest } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { runSync, syncResponse } from "@/lib/sync/run";

export const maxDuration = 300;

/** Every 10 min: finish Read.ai meetings the webhook could not process
 * (extraction or HubSpot failed, function killed, key not yet set). The
 * webhook itself does the work in the normal case; this is the retry. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  return syncResponse(await runSync(["readai"]));
}
