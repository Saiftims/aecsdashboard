import { NextRequest, NextResponse } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { backfillAccount, backfillPending } from "@/lib/sync/readai-backfill";

export const maxDuration = 300;

/** Manually advance the Read.ai history import (`Authorization: Bearer
 * CRON_SECRET`). `?email=` limits to one account, `?max=` caps meetings
 * sent to the model this call (default 5). The cron does the same thing on
 * its own; this is for running a batch and reading the result straight away. */
export async function POST(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  const q = req.nextUrl.searchParams;
  const max = Math.min(Math.max(Number(q.get("max") ?? 5) || 5, 1), 25);
  const deadline = Date.now() + 270_000;
  const email = q.get("email");
  const result = email ? await backfillAccount(email.toLowerCase(), { max, deadline }) : await backfillPending({ maxPerAccount: max, deadline });
  return NextResponse.json(result);
}
