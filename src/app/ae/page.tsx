import { redirect } from "next/navigation";
import { ActionQueue } from "@/components/action-queue";
import { Card, CardHeader, Stat, Table } from "@/components/ui";
import { aeDashboard } from "@/lib/queries";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AePage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role === "cs") redirect("/cs");

  // AEs see their own book; executives see everything.
  const { metrics, queue, stageCounts } = await aeDashboard(
    user.role === "ae" ? user.hubspot_owner_id : null,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">AE Dashboard</h1>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Leads assigned" value={metrics.leadsAssigned} />
        <Stat
          label="Awaiting first contact"
          value={metrics.newAwaitingContact}
          tone={metrics.newAwaitingContact ? "warn" : "good"}
        />
        <Stat
          label="Speed to lead (median)"
          value={metrics.medianSpeedToLeadHours === null ? "-" : `${metrics.medianSpeedToLeadHours.toFixed(1)}h`}
          tone={metrics.medianSpeedToLeadHours !== null && metrics.medianSpeedToLeadHours <= 2 ? "good" : "warn"}
        />
        <Stat label="Calls (7d)" value={metrics.calls} />
        <Stat label="Emails (7d)" value={metrics.emails} />
        <Stat label="Voicemails (7d)" value={metrics.voicemails} />
        <Stat label="LinkedIn (7d)" value={metrics.linkedin} />
        <Stat label="In-person visits (7d)" value={metrics.inPersonVisits} />
        <Stat label="Connected convos (7d)" value={metrics.connected} />
        <Stat label="Qualified (open)" value={metrics.qualified} />
        <Stat label="Demos booked" value={metrics.demosBooked} />
        <Stat label="Demos completed" value={metrics.demosCompleted} />
        <Stat label="Demo no-shows (7d)" value={metrics.demoNoShows} />
        <Stat label="First cases identified" value={metrics.firstCasesIdentified} />
        <Stat label="First-case commitments" value={metrics.firstCaseCommitments} tone="good" />
        <Stat label="Firms closed" value={metrics.newFirmsClosed} tone="good" />
        <Stat label="Revenue closed" value={`$${Math.round(metrics.revenueClosed).toLocaleString()}`} />
        <Stat label="Overdue tasks" value={metrics.overdueTasks} tone={metrics.overdueTasks ? "bad" : "good"} />
        <Stat
          label="Deals w/o future task"
          value={metrics.dealsNoFutureTask}
          tone={metrics.dealsNoFutureTask ? "bad" : "good"}
          sub="target: zero"
        />
        <Stat label="Stalled deals" value={metrics.stalledDeals} tone={metrics.stalledDeals ? "warn" : "good"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ActionQueue title="Today's priorities" items={queue} />
        </div>
        <Card>
          <CardHeader title="Open deals by stage" />
          <Table
            headers={["Stage", "Deals"]}
            rows={Object.entries(stageCounts).map(([k, v]) => [k, String(v)])}
          />
        </Card>
      </div>
    </div>
  );
}
