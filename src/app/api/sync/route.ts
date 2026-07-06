import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/supabase/server";
import { runSync, type SyncKind } from "@/lib/sync/run";

export const maxDuration = 300;

/** Manual sync trigger. Any signed-in user can refresh all sources; a FULL
 * HubSpot backfill stays executive-only. Body: { full?: boolean } */
export async function POST(req: Request) {
  const user = await currentAppUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (body.full && user.role !== "executive")
    return NextResponse.json({ error: "full sync is executives only" }, { status: 403 });

  const kinds: SyncKind[] = body.full
    ? ["hubspot_full", "calendly", "cases", "rollup"]
    : ["hubspot_incremental", "calendly", "cases", "rollup"];
  const results = await runSync(kinds);
  return NextResponse.json(results);
}
