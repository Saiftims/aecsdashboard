"use client";

/** Write-back panel: quick activity logger, next step, stage moves, handoff. */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, CardHeader, inputCls } from "@/components/ui";
import {
  ACTIVATION_STAGE_LABELS, ACTIVATION_STAGES, SALES_STAGE_LABELS, SALES_STAGE_ORDER,
} from "@/lib/hubspot/stages";

const AE_TYPES = ["call", "email", "voicemail", "linkedin", "demo",
                  "in_person_visit", "follow_up", "other"] as const;
const AE_OUTCOMES = ["no_answer", "voicemail_left", "connected", "qualified",
  "disqualified", "demo_booked", "demo_completed", "follow_up_required",
  "first_case_identified", "first_case_committed", "closed_won", "closed_lost"];
const CS_OUTCOMES = ["handoff_accepted", "onboarding_scheduled",
  "onboarding_completed", "first_case_identified", "first_case_submitted",
  "first_result_reviewed", "training_completed", "usage_follow_up",
  "expansion_opportunity", "at_risk", "issue_escalated",
  "reactivation_started", "reactivated"];

interface Props {
  role: "executive" | "ae" | "cs";
  companyId: string;
  dealId?: string;
  contactId?: string;
  currentStage?: string;
  currentActivationStage?: string;
  owners: { id: string; label: string }[];
}

async function post(body: unknown): Promise<string | null> {
  const res = await fetch("/api/writeback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return typeof data.error === "string" ? data.error : "Request failed";
}

export function FirmActions(p: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<"log" | "next" | "stage" | "handoff">("log");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(body: unknown) {
    setBusy(true);
    setMsg(null);
    const err = await post(body);
    setBusy(false);
    setMsg(err ?? "Saved to HubSpot");
    if (!err) router.refresh();
  }

  const isCs = p.role === "cs";
  const outcomes = isCs ? CS_OUTCOMES : AE_OUTCOMES;

  return (
    <Card>
      <CardHeader
        title="Actions"
        action={
          <div className="flex gap-1 text-xs">
            {(["log", "next", "stage", "handoff"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-2 py-1 font-medium ${
                  tab === t ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                            : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                {t === "log" ? "Log activity" : t === "next" ? "Next step"
                  : t === "stage" ? "Stage" : "Handoff"}
              </button>
            ))}
          </div>
        }
      />
      <div className="p-4">
        {tab === "log" ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              submit({
                action: "log_activity",
                kind: f.get("type") === "demo" || f.get("type") === "in_person_visit" ? "meeting"
                     : f.get("type") === "call" || f.get("type") === "voicemail" ? "call" : "note",
                activityType: f.get("type"),
                outcome: f.get("outcome"),
                summary: f.get("summary"),
                objection: f.get("objection") || undefined,
                customerIssue: f.get("issue") || undefined,
                nextStep: f.get("nextStep") || undefined,
                nextStepDate: f.get("nextStepDate") || undefined,
                dealId: p.dealId, contactId: p.contactId, companyId: p.companyId,
                visit: f.get("type") === "in_person_visit" ? {
                  location: f.get("visitLocation") || undefined,
                  person: f.get("visitPerson") || undefined,
                  role: f.get("visitRole") || undefined,
                  interestLevel: f.get("visitInterest") || undefined,
                } : undefined,
              });
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <select name="type" className={inputCls} required>
                {(isCs ? ["cs_touch", ...AE_TYPES] : AE_TYPES).map((t) => (
                  <option key={t} value={t}>{t.replaceAll("_", " ")}</option>
                ))}
              </select>
              <select name="outcome" className={inputCls} required>
                {outcomes.map((o) => (
                  <option key={o} value={o}>{o.replaceAll("_", " ")}</option>
                ))}
              </select>
            </div>
            <textarea name="summary" placeholder="Short summary (1-2 lines)" required
              className={`${inputCls} h-16`} />
            <div className="grid grid-cols-2 gap-2">
              <input name="objection" placeholder="Objection (optional)" className={inputCls} />
              {isCs ? (
                <input name="issue" placeholder="Customer issue (optional)" className={inputCls} />
              ) : <span />}
            </div>
            <VisitFields />
            <div className="grid grid-cols-2 gap-2">
              <input name="nextStep" placeholder="Next step" className={inputCls} />
              <input name="nextStepDate" type="date" className={inputCls} />
            </div>
            <Button disabled={busy}>{busy ? "Saving..." : "Log to HubSpot"}</Button>
          </form>
        ) : null}

        {tab === "next" && p.dealId ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              submit({
                action: "next_step", objectType: "deals", objectId: p.dealId,
                nextStep: f.get("nextStep"), nextStepDate: f.get("nextStepDate"),
              });
            }}
          >
            <input name="nextStep" placeholder="Next step" required className={inputCls} />
            <input name="nextStepDate" type="date" required className={inputCls} />
            <Button disabled={busy}>Save next step</Button>
          </form>
        ) : null}
        {tab === "next" && !p.dealId ? (
          <p className="text-sm text-zinc-400">No deal on this firm yet.</p>
        ) : null}

        {tab === "stage" && p.dealId ? (
          <div className="space-y-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit({
                  action: "stage_move", dealId: p.dealId,
                  stage: new FormData(e.currentTarget).get("stage"),
                });
              }}
            >
              <select name="stage" defaultValue={p.currentStage} className={inputCls}>
                {SALES_STAGE_ORDER.map((s) => (
                  <option key={s} value={s}>{SALES_STAGE_LABELS[s]}</option>
                ))}
              </select>
              <Button disabled={busy}>Move</Button>
            </form>
            {p.role !== "ae" ? (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit({
                    action: "activation_move", dealId: p.dealId,
                    stage: new FormData(e.currentTarget).get("stage"),
                  });
                }}
              >
                <select name="stage" defaultValue={p.currentActivationStage} className={inputCls}>
                  {ACTIVATION_STAGES.map((s) => (
                    <option key={s} value={s}>{ACTIVATION_STAGE_LABELS[s]}</option>
                  ))}
                </select>
                <Button disabled={busy} variant="secondary">Move activation stage</Button>
              </form>
            ) : null}
          </div>
        ) : null}

        {tab === "handoff" && p.dealId ? (
          <HandoffForm dealId={p.dealId} owners={p.owners} busy={busy} submit={submit} />
        ) : null}

        {msg ? (
          <p className={`mt-3 text-sm ${msg === "Saved to HubSpot" ? "text-emerald-600" : "text-red-600"}`}>
            {msg}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function VisitFields() {
  return (
    <details className="rounded-lg border border-dashed border-zinc-300 p-2 text-sm dark:border-zinc-700">
      <summary className="cursor-pointer text-zinc-500">In-person visit details</summary>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <input name="visitLocation" placeholder="Office location" className={inputCls} />
        <input name="visitPerson" placeholder="Person spoken to" className={inputCls} />
        <input name="visitRole" placeholder="Their role" className={inputCls} />
        <select name="visitInterest" className={inputCls}>
          <option value="">Interest level</option>
          <option>high</option><option>medium</option><option>low</option>
        </select>
      </div>
    </details>
  );
}

function HandoffForm({
  dealId, owners, busy, submit,
}: {
  dealId: string;
  owners: { id: string; label: string }[];
  busy: boolean;
  submit: (b: unknown) => Promise<void>;
}) {
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const g = (k: string) => (f.get(k) as string) || undefined;
        submit({
          action: "handoff_submit",
          dealId,
          fields: {
            champion: g("champion"), decisionMaker: g("decisionMaker"),
            stakeholders: g("stakeholders"),
            estimatedCaseVolume: g("estimatedCaseVolume"),
            whyBought: g("whyBought"), primaryUseCase: g("primaryUseCase"),
            currentActiveCase: g("currentActiveCase"),
            firstCaseTargetDate: g("firstCaseTargetDate"),
            pricingAgreed: g("pricingAgreed"), paymentStatus: g("paymentStatus"),
            expectations: g("expectations"), objections: g("objections"),
            promises: g("promises"), risks: g("risks"), nextMeeting: g("nextMeeting"),
            aeNotes: g("aeNotes"), demoRecordingUrl: g("demoRecordingUrl"),
            csOwnerId: g("csOwnerId"),
          },
        });
      }}
    >
      <p className="text-xs text-zinc-500">
        Sales -&gt; CS handoff. Required fields marked *. Completing this sets the
        deal to Handoff Pending, assigns CS, and creates the onboarding task.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <input name="champion" placeholder="Primary champion *" required className={inputCls} />
        <input name="decisionMaker" placeholder="Decision-maker *" required className={inputCls} />
        <input name="stakeholders" placeholder="Other stakeholders" className={inputCls} />
        <input name="estimatedCaseVolume" placeholder="Est. cases / month *" required className={inputCls} />
        <input name="pricingAgreed" placeholder="Pricing agreed *" required className={inputCls} />
        <select name="paymentStatus" required className={inputCls}>
          <option value="">Payment status *</option>
          <option>not_invoiced</option><option>invoiced</option><option>paid</option>
        </select>
        <input name="firstCaseTargetDate" type="date" required className={inputCls} />
        <select name="csOwnerId" required className={inputCls}>
          <option value="">CS owner *</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </div>
      <textarea name="whyBought" placeholder="Why the firm bought *" required className={`${inputCls} h-12`} />
      <textarea name="primaryUseCase" placeholder="Primary use case *" required className={`${inputCls} h-12`} />
      <div className="grid grid-cols-2 gap-2">
        <input name="currentActiveCase" placeholder="Current active case" className={inputCls} />
        <input name="nextMeeting" placeholder="Next meeting" className={inputCls} />
        <input name="expectations" placeholder="Expectations" className={inputCls} />
        <input name="objections" placeholder="Objections raised" className={inputCls} />
        <input name="promises" placeholder="Promises made" className={inputCls} />
        <input name="risks" placeholder="Risks" className={inputCls} />
        <input name="demoRecordingUrl" placeholder="Demo recording link" className={inputCls} />
      </div>
      <textarea name="aeNotes" placeholder="AE notes" className={`${inputCls} h-12`} />
      <Button disabled={busy}>{busy ? "Submitting..." : "Complete handoff"}</Button>
    </form>
  );
}

export function AcceptHandoffButton({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await post({ action: "handoff_accept", dealId });
        setBusy(false);
        router.refresh();
      }}
    >
      Accept handoff
    </Button>
  );
}
