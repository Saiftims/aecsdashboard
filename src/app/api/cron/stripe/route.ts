import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runSync } from "@/lib/sync/run";

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  if (!secret) return true; // not configured yet (local dev)
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Pull Stripe customers, charges and subscriptions - the source of truth for
 * revenue. Always a full pull: the account is small, and a refund changes a row
 * that was already synced, so an incremental window would keep counting money
 * that has since gone back. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await runSync(["stripe"]));
}
