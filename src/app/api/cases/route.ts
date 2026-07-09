/** Case + account CS workflow write-back. Cases live in Supabase (source of
 * truth for workflow); segment/target/next-action also mirror to the HubSpot
 * company. Every action is audited. CS + executive only. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { hsUpdateProperties } from "@/lib/hubspot/client";
import { currentAppUser, supabaseService } from "@/lib/supabase/server";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_case"),
    companyId: z.string(),
    caseName: z.string().min(1),
    submittedDate: z.string().optional(),
    revenueAmount: z.number().optional(),
  }),
  z.object({
    action: z.literal("update_case_status"),
    caseId: z.string(),
    status: z.enum(["submitted", "in_review", "completed", "delivered", "issue_open", "cancelled"]),
  }),
  z.object({ action: z.literal("offer_expert_review"), caseId: z.string() }),
  z.object({ action: z.literal("book_expert_review"), caseId: z.string() }),
  z.object({ action: z.literal("complete_expert_review"), caseId: z.string() }),
  z.object({ action: z.literal("flag_issue"), caseId: z.string(), notes: z.string().optional() }),
  z.object({ action: z.literal("resolve_issue"), caseId: z.string() }),
  z.object({
    action: z.literal("set_segment"),
    companyId: z.string(),
    segment: z.enum(["small", "mid_size", "large", "strategic"]),
  }),
  z.object({
    action: z.literal("set_monthly_target"),
    companyId: z.string(),
    target: z.number().nonnegative(),
  }),
  z.object({
    action: z.literal("set_next_cs_action"),
    companyId: z.string(),
    nextAction: z.string().min(1),
    dueDate: z.string().optional(),
  }),
]);

export async function POST(req: Request) {
  const user = await currentAppUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role === "ae") return NextResponse.json({ error: "CS/executive only" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;
  const sb = supabaseService();
  const nowIso = new Date().toISOString();
  let objectId = "";
  let hubspotResult = "n/a";

  switch (input.action) {
    case "create_case": {
      const caseId = `manual_${crypto.randomUUID()}`;
      objectId = caseId;
      await sb.from("cases").insert({
        case_id: caseId, sw_id: caseId,
        company_hubspot_id: input.companyId,
        case_name: input.caseName,
        case_status: "submitted",
        submitted_date: input.submittedDate ?? nowIso,
        submitted_at: input.submittedDate ?? nowIso,
        revenue_amount: input.revenueAmount ?? 250,
        source: "manual",
      });
      break;
    }
    case "update_case_status": {
      objectId = input.caseId;
      const patch: Record<string, unknown> = { case_status: input.status, updated_at: nowIso };
      if (input.status === "completed") patch.completed_date = nowIso;
      if (input.status === "delivered") patch.delivered_date = nowIso;
      await sb.from("cases").update(patch).eq("case_id", input.caseId);
      break;
    }
    case "offer_expert_review": {
      objectId = input.caseId;
      await sb.from("cases").update({
        expert_review_offered: true, expert_review_offered_date: nowIso, updated_at: nowIso,
      }).eq("case_id", input.caseId);
      break;
    }
    case "book_expert_review": {
      objectId = input.caseId;
      await sb.from("cases").update({ expert_review_booked: true, updated_at: nowIso }).eq("case_id", input.caseId);
      break;
    }
    case "complete_expert_review": {
      objectId = input.caseId;
      await sb.from("cases").update({
        expert_review_completed: true, expert_review_completed_date: nowIso, updated_at: nowIso,
      }).eq("case_id", input.caseId);
      break;
    }
    case "flag_issue": {
      objectId = input.caseId;
      await sb.from("cases").update({
        issue_flag: true, case_status: "issue_open", issue_notes: input.notes ?? null, updated_at: nowIso,
      }).eq("case_id", input.caseId);
      break;
    }
    case "resolve_issue": {
      objectId = input.caseId;
      await sb.from("cases").update({
        issue_flag: false, case_status: "delivered", updated_at: nowIso,
      }).eq("case_id", input.caseId);
      break;
    }
    case "set_segment": {
      objectId = input.companyId;
      await sb.from("companies").update({ firm_segment: input.segment }).eq("hubspot_id", input.companyId);
      const wb = await hsUpdateProperties("companies", input.companyId, { sw_firm_segment: input.segment });
      hubspotResult = wb.ok ? "ok" : wb.skipped ?? wb.error ?? "error";
      break;
    }
    case "set_monthly_target": {
      objectId = input.companyId;
      await sb.from("companies").update({ monthly_case_target: input.target }).eq("hubspot_id", input.companyId);
      const wb = await hsUpdateProperties("companies", input.companyId, { sw_monthly_case_target: input.target });
      hubspotResult = wb.ok ? "ok" : wb.skipped ?? wb.error ?? "error";
      break;
    }
    case "set_next_cs_action": {
      objectId = input.companyId;
      await sb.from("companies").update({
        next_cs_action: input.nextAction,
        next_cs_action_due_date: input.dueDate ?? null,
      }).eq("hubspot_id", input.companyId);
      const wb = await hsUpdateProperties("companies", input.companyId, {
        sw_next_cs_action: input.nextAction,
        sw_next_cs_action_due_date: input.dueDate,
      });
      hubspotResult = wb.ok ? "ok" : wb.skipped ?? wb.error ?? "error";
      break;
    }
  }

  await logAudit({
    actor: user.id, actorEmail: user.email, action: `case.${input.action}`,
    objectType: input.action.includes("case") || "caseId" in input ? "case" : "company",
    objectId, payload: input, hubspotResult,
  });
  return NextResponse.json({ ok: true, id: objectId });
}
