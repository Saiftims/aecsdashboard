import { NextRequest, NextResponse } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { backfillIntake } from "@/lib/sync/readai-intake";

export const maxDuration = 300;

/** Re-read already-synced Read.ai calls for how the firm runs its intake and
 * write that to HubSpot (`Authorization: Bearer CRON_SECRET`). `?max=` caps
 * the calls read this request (default 30, up to 90); `?dry=1` reports what
 * it found without storing or writing (`&offset=` to sample older calls).
 * Call it again until `remaining` is 0. */
export async function POST(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  const q = req.nextUrl.searchParams;
  const max = Math.min(Math.max(Number(q.get("max") ?? 30) || 30, 1), 90);
  const offset = Math.max(Number(q.get("offset") ?? 0) || 0, 0);
  return NextResponse.json(await backfillIntake({ max, offset, dry: q.get("dry") === "1", deadline: Date.now() + 200_000 }));
}
