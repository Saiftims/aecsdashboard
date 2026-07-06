import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { hsUpdateProperties } from "@/lib/hubspot/client";
import { currentAppUser, supabaseService } from "@/lib/supabase/server";

const schema = z.object({
  swAccountId: z.string().min(1),
  swOrganizationId: z.string().optional().nullable(),
  hubspotCompanyId: z.string().min(1),
  perCasePrice: z.number().positive().optional().nullable(),
  confirmed: z.boolean().default(true),
});

/** Create/update a firm <-> HubSpot company mapping (executive only). */
export async function POST(req: Request) {
  const user = await currentAppUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "executive")
    return NextResponse.json({ error: "executives only" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const m = parsed.data;

  const sb = supabaseService();
  const { error } = await sb.from("firm_mapping").upsert(
    {
      sw_account_id: m.swAccountId,
      sw_organization_id: m.swOrganizationId ?? null,
      hubspot_company_id: m.hubspotCompanyId,
      per_case_price: m.perCasePrice ?? null,
      confirmed: m.confirmed,
    },
    { onConflict: "hubspot_company_id" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Mirror the stable id onto the HubSpot company (source of truth).
  const wb = await hsUpdateProperties("companies", m.hubspotCompanyId, {
    sw_internal_firm_id: m.swOrganizationId ?? m.swAccountId,
  });

  await logAudit({
    actor: user.id, actorEmail: user.email, action: "mapping.upsert",
    objectType: "company", objectId: m.hubspotCompanyId, payload: m,
    hubspotResult: wb.ok ? "ok" : wb.skipped ?? wb.error ?? "error",
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const user = await currentAppUser();
  if (!user || user.role !== "executive")
    return NextResponse.json({ error: "executives only" }, { status: 403 });
  const { hubspotCompanyId } = await req.json().catch(() => ({}));
  if (!hubspotCompanyId)
    return NextResponse.json({ error: "hubspotCompanyId required" }, { status: 400 });
  const sb = supabaseService();
  await sb.from("firm_mapping").delete().eq("hubspot_company_id", hubspotCompanyId);
  await logAudit({
    actor: user.id, actorEmail: user.email, action: "mapping.delete",
    objectType: "company", objectId: hubspotCompanyId, hubspotResult: "n/a",
  });
  return NextResponse.json({ ok: true });
}
