import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { saveSetting } from "@/lib/settings";
import { currentAppUser } from "@/lib/supabase/server";

const ALLOWED_KEYS = new Set([
  "default_case_price", "at_risk_inactivity_days", "first_case_target_days",
  "second_case_target_days", "healthy_cases_per_30d", "stalled_deal_days",
  "hubspot_portal_id", "hubspot_sales_pipeline_id",
  "ae_weekly_targets", "cs_targets", "ae_scorecard_weights", "cs_scorecard_weights",
]);

const schema = z.object({ key: z.string(), value: z.unknown() });

export async function POST(req: Request) {
  const user = await currentAppUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "executive")
    return NextResponse.json({ error: "executives only" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !ALLOWED_KEYS.has(parsed.data.key)) {
    return NextResponse.json({ error: "invalid setting" }, { status: 400 });
  }
  await saveSetting(parsed.data.key, parsed.data.value, user.id);
  await logAudit({
    actor: user.id, actorEmail: user.email, action: "settings.update",
    objectType: "setting", objectId: parsed.data.key,
    payload: parsed.data, hubspotResult: "n/a",
  });
  return NextResponse.json({ ok: true });
}
