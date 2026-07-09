"use client";

/** Firm-page CS panel: segment/target, cases list with quick workflow actions,
 * and a manual add-case form. Writes to /api/cases (Supabase, audited). */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, CardHeader, inputCls } from "@/components/ui";

export interface CaseItem {
  case_id: string;
  case_name: string | null;
  case_status: string | null;
  submitted_date: string | null;
  delivered_date: string | null;
  revenue_amount: number | null;
  expert_review_offered: boolean;
  expert_review_booked: boolean;
  expert_review_completed: boolean;
  issue_flag: boolean;
  source: string | null;
}

const STATUS_TONE: Record<string, "green" | "yellow" | "red" | "blue" | "default"> = {
  submitted: "blue", in_review: "yellow", completed: "green",
  delivered: "green", issue_open: "red", cancelled: "default",
};

async function post(body: unknown): Promise<string | null> {
  const res = await fetch("/api/cases", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const d = await res.json().catch(() => ({}));
  return typeof d.error === "string" ? d.error : "Request failed";
}

export function CaseWorkflow({
  companyId, segment, monthlyTarget, cases, canEdit,
}: {
  companyId: string;
  segment: string | null;
  monthlyTarget: number | null;
  cases: CaseItem[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(body: unknown) {
    setBusy(true); setMsg(null);
    const err = await post(body);
    setBusy(false); setMsg(err ?? "Saved");
    if (!err) router.refresh();
  }

  return (
    <Card>
      <CardHeader
        title="Cases & CS workflow"
        action={<Badge tone="blue">{cases.length} cases</Badge>}
      />
      <div className="space-y-4 p-4">
        {canEdit ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-500">
              Segment
              <select
                className={inputCls} defaultValue={segment ?? ""}
                onChange={(e) => e.target.value && run({ action: "set_segment", companyId, segment: e.target.value })}
              >
                <option value="">- set segment -</option>
                <option value="small">Small (2/mo)</option>
                <option value="mid_size">Mid-size (5/mo)</option>
                <option value="large">Large (10/mo)</option>
                <option value="strategic">Strategic (custom)</option>
              </select>
            </label>
            <form
              className="text-xs text-zinc-500"
              onSubmit={(e) => {
                e.preventDefault();
                const v = Number(new FormData(e.currentTarget).get("target"));
                if (!Number.isNaN(v)) run({ action: "set_monthly_target", companyId, target: v });
              }}
            >
              Monthly target
              <div className="flex gap-1">
                <input name="target" type="number" defaultValue={monthlyTarget ?? ""} className={inputCls} />
                <Button variant="secondary" disabled={busy}>Set</Button>
              </div>
            </form>
          </div>
        ) : null}

        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {cases.length === 0 ? (
            <p className="py-4 text-sm text-zinc-400">No cases yet.</p>
          ) : cases.map((c) => (
            <div key={c.case_id} className="py-2.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{c.case_name ?? c.case_id}</span>
                <Badge tone={STATUS_TONE[c.case_status ?? ""] ?? "default"}>
                  {(c.case_status ?? "-").replace("_", " ")}
                </Badge>
                {c.source && c.source !== "manual" ? <Badge>{c.source}</Badge> : null}
                {c.expert_review_completed ? <Badge tone="green">review done</Badge>
                  : c.expert_review_booked ? <Badge tone="blue">review booked</Badge>
                  : c.expert_review_offered ? <Badge tone="yellow">review offered</Badge>
                  : c.case_status === "delivered" ? <Badge tone="red">review missing</Badge> : null}
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {c.submitted_date ? `Submitted ${new Date(c.submitted_date).toLocaleDateString()}` : ""}
                {c.delivered_date ? ` · Delivered ${new Date(c.delivered_date).toLocaleDateString()}` : ""}
                {c.revenue_amount ? ` · $${c.revenue_amount}` : ""}
              </div>
              {canEdit ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {c.case_status !== "delivered" ? (
                    <Button variant="secondary" disabled={busy}
                      onClick={() => run({ action: "update_case_status", caseId: c.case_id, status: "delivered" })}>
                      Mark delivered
                    </Button>
                  ) : null}
                  {c.case_status === "delivered" && !c.expert_review_offered ? (
                    <Button variant="secondary" disabled={busy}
                      onClick={() => run({ action: "offer_expert_review", caseId: c.case_id })}>
                      Offer review
                    </Button>
                  ) : null}
                  {c.expert_review_offered && !c.expert_review_booked ? (
                    <Button variant="secondary" disabled={busy}
                      onClick={() => run({ action: "book_expert_review", caseId: c.case_id })}>
                      Booked
                    </Button>
                  ) : null}
                  {c.expert_review_booked && !c.expert_review_completed ? (
                    <Button variant="secondary" disabled={busy}
                      onClick={() => run({ action: "complete_expert_review", caseId: c.case_id })}>
                      Review done
                    </Button>
                  ) : null}
                  {c.issue_flag ? (
                    <Button variant="secondary" disabled={busy}
                      onClick={() => run({ action: "resolve_issue", caseId: c.case_id })}>
                      Resolve issue
                    </Button>
                  ) : (
                    <Button variant="danger" disabled={busy}
                      onClick={() => run({ action: "flag_issue", caseId: c.case_id })}>
                      Flag issue
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {canEdit ? (
          <form
            className="flex gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const name = String(f.get("caseName") ?? "").trim();
              if (name) run({ action: "create_case", companyId, caseName: name });
              e.currentTarget.reset();
            }}
          >
            <input name="caseName" placeholder="Add a case (name)" className={inputCls} />
            <Button disabled={busy}>Add case</Button>
          </form>
        ) : null}

        {msg ? (
          <p className={`text-sm ${msg === "Saved" ? "text-emerald-600" : "text-red-600"}`}>{msg}</p>
        ) : null}
      </div>
    </Card>
  );
}
