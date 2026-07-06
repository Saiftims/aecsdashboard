/** Dashboard -> HubSpot write-back. Every action is audited.
 *
 * Actions:
 *  - next_step         { objectType, objectId, nextStep, nextStepDate }
 *  - stage_move        { dealId, stage }              (sales pipeline)
 *  - activation_move   { dealId, stage }              (virtual CS pipeline)
 *  - log_activity      { kind, dealId?, contactId?, companyId?, activityType,
 *                        outcome, summary, objection?, nextStep?, nextStepDate?,
 *                        visit? { location, person, role, interestLevel } }
 *  - handoff_submit    { dealId, fields {...} }       (guided sales->CS handoff)
 *  - handoff_accept    { dealId }
 *  - create_task       { title, body?, dueAt, dealId?, companyId?, ownerId? }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import {
  ASSOC, hsCreateObject, hsUpdateProperties, type WriteResult,
} from "@/lib/hubspot/client";
import { ACTIVATION_STAGES, SALES_STAGES } from "@/lib/hubspot/stages";
import { currentAppUser, supabaseService } from "@/lib/supabase/server";

const nextStepSchema = z.object({
  action: z.literal("next_step"),
  objectType: z.enum(["deals", "contacts"]),
  objectId: z.string(),
  nextStep: z.string().min(1),
  nextStepDate: z.string().min(8),
});

const stageMoveSchema = z.object({
  action: z.literal("stage_move"),
  dealId: z.string(),
  stage: z.string().refine((s) => Object.values(SALES_STAGES).includes(s as never)),
});

const activationMoveSchema = z.object({
  action: z.literal("activation_move"),
  dealId: z.string(),
  stage: z.enum(ACTIVATION_STAGES),
});

const logActivitySchema = z.object({
  action: z.literal("log_activity"),
  kind: z.enum(["call", "meeting", "note"]),
  activityType: z.enum(["call", "email", "voicemail", "linkedin", "demo",
                        "in_person_visit", "follow_up", "cs_touch", "other"]),
  outcome: z.string().min(1),
  summary: z.string().min(1),
  objection: z.string().optional(),
  customerIssue: z.string().optional(),
  nextStep: z.string().optional(),
  nextStepDate: z.string().optional(),
  dealId: z.string().optional(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  visit: z.object({
    location: z.string().optional(),
    person: z.string().optional(),
    role: z.string().optional(),
    interestLevel: z.string().optional(),
  }).optional(),
});

const handoffSubmitSchema = z.object({
  action: z.literal("handoff_submit"),
  dealId: z.string(),
  fields: z.object({
    champion: z.string().min(1),
    decisionMaker: z.string().min(1),
    stakeholders: z.string().optional(),
    estimatedCaseVolume: z.string().min(1),
    whyBought: z.string().min(1),
    primaryUseCase: z.string().min(1),
    currentActiveCase: z.string().optional(),
    firstCaseTargetDate: z.string().min(8),
    pricingAgreed: z.string().min(1),
    paymentStatus: z.string().min(1),
    expectations: z.string().optional(),
    objections: z.string().optional(),
    promises: z.string().optional(),
    risks: z.string().optional(),
    nextMeeting: z.string().optional(),
    aeNotes: z.string().optional(),
    demoRecordingUrl: z.string().optional(),
    csOwnerId: z.string().min(1),
  }),
});

const handoffAcceptSchema = z.object({
  action: z.literal("handoff_accept"),
  dealId: z.string(),
});

const createTaskSchema = z.object({
  action: z.literal("create_task"),
  title: z.string().min(1),
  body: z.string().optional(),
  dueAt: z.string().min(8),
  dealId: z.string().optional(),
  companyId: z.string().optional(),
  ownerId: z.string().optional(),
});

const schema = z.discriminatedUnion("action", [
  nextStepSchema, stageMoveSchema, activationMoveSchema, logActivitySchema,
  handoffSubmitSchema, handoffAcceptSchema, createTaskSchema,
]);

export async function POST(req: Request) {
  const user = await currentAppUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;
  const sb = supabaseService();
  let result: WriteResult = { ok: false, error: "unhandled" };
  let objectType = "deal";
  let objectId = "";

  switch (input.action) {
    case "next_step": {
      objectType = input.objectType === "deals" ? "deal" : "contact";
      objectId = input.objectId;
      result = await hsUpdateProperties(input.objectType, input.objectId, {
        sw_next_step: input.nextStep,
        sw_next_step_date: input.nextStepDate,
      });
      if (result.ok) {
        // Mirror into the cache so queues update immediately (sync also refreshes).
        const { data: row } = await sb.from(input.objectType)
          .select("properties").eq("hubspot_id", input.objectId).maybeSingle();
        await sb.from(input.objectType).update({
          properties: {
            ...(row?.properties ?? {}),
            sw_next_step: input.nextStep,
            sw_next_step_date: input.nextStepDate,
          },
        }).eq("hubspot_id", input.objectId);
      }
      break;
    }
    case "stage_move": {
      objectId = input.dealId;
      result = await hsUpdateProperties("deals", input.dealId, {
        dealstage: input.stage,
      });
      if (result.ok) {
        await sb.from("deals").update({ stage: input.stage })
          .eq("hubspot_id", input.dealId);
      }
      break;
    }
    case "activation_move": {
      objectId = input.dealId;
      result = await hsUpdateProperties("deals", input.dealId, {
        sw_activation_stage: input.stage,
        ...(input.stage === "reactivation_in_progress"
          ? { sw_reactivation_status: "in_progress" } : {}),
      });
      if (result.ok) {
        await sb.from("deals").update({
          activation_stage: input.stage, is_activation: true,
        }).eq("hubspot_id", input.dealId);
      }
      break;
    }
    case "log_activity": {
      objectType = input.kind;
      // Structured, greppable body - the sync parses [type:..][outcome:..].
      const lines = [
        `[type:${input.activityType}][outcome:${input.outcome}]`,
        input.summary,
        input.objection ? `Objection: ${input.objection}` : null,
        input.customerIssue ? `Customer issue: ${input.customerIssue}` : null,
        input.visit?.location ? `Visit location: ${input.visit.location}` : null,
        input.visit?.person
          ? `Spoke to: ${input.visit.person}${input.visit.role ? ` (${input.visit.role})` : ""}`
          : null,
        input.visit?.interestLevel ? `Interest level: ${input.visit.interestLevel}` : null,
        input.nextStep
          ? `Next step: ${input.nextStep}${input.nextStepDate ? ` (by ${input.nextStepDate})` : ""}`
          : null,
      ].filter(Boolean);
      const body = lines.join("\n");
      const now = new Date().toISOString();

      const assoc: { toId: string; associationTypeId: number }[] = [];
      if (input.kind === "call") {
        if (input.contactId) assoc.push({ toId: input.contactId, associationTypeId: ASSOC.callToContact });
        if (input.dealId) assoc.push({ toId: input.dealId, associationTypeId: ASSOC.callToDeal });
        result = await hsCreateObject("calls", {
          hs_timestamp: now, hs_call_title: input.summary.slice(0, 80),
          hs_call_body: body, hubspot_owner_id: user.hubspot_owner_id ?? "",
        }, assoc);
      } else if (input.kind === "meeting") {
        if (input.contactId) assoc.push({ toId: input.contactId, associationTypeId: ASSOC.meetingToContact });
        if (input.dealId) assoc.push({ toId: input.dealId, associationTypeId: ASSOC.meetingToDeal });
        result = await hsCreateObject("meetings", {
          hs_timestamp: now, hs_meeting_title: input.summary.slice(0, 80),
          hs_meeting_body: body, hubspot_owner_id: user.hubspot_owner_id ?? "",
        }, assoc);
      } else {
        if (input.contactId) assoc.push({ toId: input.contactId, associationTypeId: ASSOC.noteToContact });
        if (input.dealId) assoc.push({ toId: input.dealId, associationTypeId: ASSOC.noteToDeal });
        if (input.companyId) assoc.push({ toId: input.companyId, associationTypeId: ASSOC.noteToCompany });
        result = await hsCreateObject("notes", {
          hs_timestamp: now, hs_note_body: body,
          hubspot_owner_id: user.hubspot_owner_id ?? "",
        }, assoc);
      }
      objectId = result.id ?? input.dealId ?? input.contactId ?? "new";

      // Also stamp next step on the deal, and mirror into the cache
      if (result.ok && input.dealId && input.nextStep) {
        await hsUpdateProperties("deals", input.dealId, {
          sw_next_step: input.nextStep,
          sw_next_step_date: input.nextStepDate,
        });
      }
      break;
    }
    case "handoff_submit": {
      objectId = input.dealId;
      const f = input.fields;
      const summary = [
        `Champion: ${f.champion}`, `Decision maker: ${f.decisionMaker}`,
        f.stakeholders ? `Stakeholders: ${f.stakeholders}` : null,
        `Estimated case volume: ${f.estimatedCaseVolume}/mo`,
        `Why bought: ${f.whyBought}`, `Primary use case: ${f.primaryUseCase}`,
        f.currentActiveCase ? `Current active case: ${f.currentActiveCase}` : null,
        `First-case target: ${f.firstCaseTargetDate}`,
        `Pricing agreed: ${f.pricingAgreed}`, `Payment status: ${f.paymentStatus}`,
        f.expectations ? `Expectations: ${f.expectations}` : null,
        f.objections ? `Objections raised: ${f.objections}` : null,
        f.promises ? `Promises made: ${f.promises}` : null,
        f.risks ? `Risks: ${f.risks}` : null,
        f.nextMeeting ? `Next meeting: ${f.nextMeeting}` : null,
        f.aeNotes ? `AE notes: ${f.aeNotes}` : null,
      ].filter(Boolean).join("\n");

      result = await hsUpdateProperties("deals", input.dealId, {
        sw_handoff_completed: "true",
        sw_handoff_summary: summary,
        sw_first_case_target_date: f.firstCaseTargetDate,
        sw_demo_recording_url: f.demoRecordingUrl,
        sw_activation_stage: "handoff_pending",
        hubspot_owner_id: f.csOwnerId, // activation ownership moves to CS
        sw_estimated_monthly_case_volume: f.estimatedCaseVolume,
      });
      if (result.ok) {
        await hsCreateObject("tasks", {
          hs_task_subject: "Accept handoff + schedule onboarding",
          hs_task_body: `[type:handoff]\n${summary}`,
          hs_task_status: "NOT_STARTED",
          hs_timestamp: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          hubspot_owner_id: f.csOwnerId,
        }, [{ toId: input.dealId, associationTypeId: ASSOC.taskToDeal }]);
        await sb.from("deals").update({
          activation_stage: "handoff_pending", is_activation: true, owner_id: f.csOwnerId,
        }).eq("hubspot_id", input.dealId);
      }
      break;
    }
    case "handoff_accept": {
      if (user.role === "ae") {
        return NextResponse.json({ error: "CS/executive only" }, { status: 403 });
      }
      objectId = input.dealId;
      result = await hsUpdateProperties("deals", input.dealId, {
        sw_handoff_accepted_by_cs: "true",
        sw_activation_stage: "onboarding_scheduled",
      });
      if (result.ok) {
        await sb.from("deals").update({ activation_stage: "onboarding_scheduled" })
          .eq("hubspot_id", input.dealId);
      }
      break;
    }
    case "create_task": {
      objectType = "task";
      const assoc: { toId: string; associationTypeId: number }[] = [];
      if (input.dealId) assoc.push({ toId: input.dealId, associationTypeId: ASSOC.taskToDeal });
      if (input.companyId) assoc.push({ toId: input.companyId, associationTypeId: ASSOC.taskToCompany });
      result = await hsCreateObject("tasks", {
        hs_task_subject: input.title,
        hs_task_body: input.body ?? "",
        hs_task_status: "NOT_STARTED",
        hs_timestamp: new Date(input.dueAt).toISOString(),
        hubspot_owner_id: input.ownerId ?? user.hubspot_owner_id ?? "",
      }, assoc);
      objectId = result.id ?? "new";
      break;
    }
  }

  await logAudit({
    actor: user.id,
    actorEmail: user.email,
    action: input.action,
    objectType,
    objectId,
    payload: input,
    hubspotResult: result.ok ? "ok" : result.skipped ?? result.error ?? "error",
  });

  if (result.skipped === "writes_disabled") {
    return NextResponse.json(
      { error: "HubSpot writes are disabled (set HUBSPOT_APPLY=true)" },
      { status: 409 },
    );
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ ok: true, id: result.id });
}
