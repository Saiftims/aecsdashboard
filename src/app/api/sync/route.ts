import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/supabase/server";
import { runSync, type SyncKind } from "@/lib/sync/run";

export const maxDuration = 300;

/** Manual sync trigger (admin/executive only). Body: { full?: boolean } */
export async function POST(req: Request) {
  const user = await currentAppUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "executive")
    return NextResponse.json({ error: "executives only" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const kinds: SyncKind[] = body.full
    ? ["hubspot_full", "cases", "rollup"]
    : ["hubspot_incremental", "cases", "rollup"];
  const results = await runSync(kinds);
  return NextResponse.json(results);
}
