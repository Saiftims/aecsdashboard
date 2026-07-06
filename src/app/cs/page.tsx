import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionQueue } from "@/components/action-queue";
import { Badge, Card, CardHeader, Stat } from "@/components/ui";
import { ACTIVATION_STAGE_LABELS, ACTIVATION_STAGES } from "@/lib/hubspot/stages";
import { csDashboard } from "@/lib/queries";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function CsPage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role === "ae") redirect("/ae");

  const { metrics, queue, activationBoard } = await csDashboard();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Customer Success</h1>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="New handoffs" value={metrics.newHandoffs} tone={metrics.newHandoffs ? "warn" : "good"} href="/drill/activation_handoff_pending" />
        <Stat label="Awaiting acceptance" value={metrics.awaitingAcceptance} href="/drill/activation_handoff_pending" />
        <Stat label="Onboarding scheduled" value={metrics.onboardingScheduled} href="/drill/activation_onboarding_scheduled" />
        <Stat label="Onboarding completed" value={metrics.onboardingCompleted} href="/drill/activation_onboarding_completed" />
        <Stat label="No first case yet" value={metrics.firmsWithoutFirstCase} tone={metrics.firmsWithoutFirstCase ? "warn" : "good"} href="/drill/activation" />
        <Stat
          label="Time to first case"
          value={metrics.medianTimeToFirstCaseDays === null ? "-" : `${metrics.medianTimeToFirstCaseDays}d`}
          sub="median"
        />
        <Stat label="Activated firms" value={metrics.activatedFirms} tone="good" href="/drill/activation_activated" />
        <Stat label="Activation rate" value={metrics.activationRate === null ? "-" : `${metrics.activationRate}%`} />
        <Stat label="Repeat-user rate" value={metrics.repeatUserRate === null ? "-" : `${metrics.repeatUserRate}%`} />
        <Stat label="Monthly active firms" value={`${metrics.monthlyActiveFirms}/${metrics.totalCustomerFirms}`} href="/firms?active=yes" />
        <Stat label="Cases this month" value={metrics.casesThisMonth} />
        <Stat label="Revenue this month (est)" value={`$${Math.round(metrics.revenueThisMonth).toLocaleString()}`} />
        <Stat label="Inactive 30d+" value={metrics.inactive30} tone={metrics.inactive30 ? "warn" : "good"} href="/drill/inactive_30" />
        <Stat label="Inactive 45d+" value={metrics.inactive45} tone={metrics.inactive45 ? "bad" : "good"} href="/drill/inactive_45" />
        <Stat label="At risk" value={metrics.atRisk} tone={metrics.atRisk ? "bad" : "good"} href="/drill/activation_at_risk" />
        <Stat label="Reactivation in progress" value={metrics.reactivationInProgress} href="/drill/activation_reactivation_in_progress" />
        <Stat label="Reactivated" value={metrics.reactivated} tone="good" href="/drill/activation_repeat_user" />
        <Stat label="Open issues" value={metrics.openIssues} tone={metrics.openIssues ? "bad" : "good"} href="/firms?health=red" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ActionQueue title="Today's priorities" items={queue} />
        </div>
        <Card>
          <CardHeader title="Activation board" />
          <div className="max-h-[540px] space-y-3 overflow-y-auto p-4">
            {ACTIVATION_STAGES.map((s) => {
              const rows = activationBoard[s] ?? [];
              if (!rows.length) return null;
              return (
                <div key={s}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      {ACTIVATION_STAGE_LABELS[s]}
                    </span>
                    <Badge>{rows.length}</Badge>
                  </div>
                  <ul className="space-y-0.5 text-sm">
                    {rows.map((r) => (
                      <li key={r.id}>
                        <Link
                          href={r.companyId ? `/firms/${r.companyId}` : "#"}
                          className="hover:underline"
                        >
                          {r.name ?? r.id}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}
