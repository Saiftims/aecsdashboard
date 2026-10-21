import { NextRequest } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { runSync, syncResponse } from "@/lib/sync/run";

export const maxDuration = 300;

/** Every 15 min: pull Stripe customers, charges and subscriptions - the source
 * of truth for revenue. Always a full pull: the account is small, and a refund
 * changes a row that was already synced, so an incremental window would keep
 * counting money that has since gone back. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  return syncResponse(await runSync(["stripe"]));
}
