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
        <Stat label="Leads assigned" value={metrics.leadsAssigned} href="/drill/leads_assigned" />
        <Stat
          label="Awaiting first contact"
          value={metrics.newAwaitingContact}
          tone={metrics.newAwaitingContact ? "warn" : "good"}
          href="/drill/awaiting_first_contact"
        />
        <Stat
          label="Speed to lead (median)"
          value={metrics.medianSpeedToLeadHours === null ? "-" : `${metrics.medianSpeedToLeadHours.toFixed(1)}h`}
          tone={metrics.medianSpeedToLeadHours !== null && metrics.medianSpeedToLeadHours <= 2 ? "good" : "warn"}
        />
        <Stat label="Calls (7d)" value={metrics.calls} href="/drill/calls_7d" />
        <Stat label="Emails (7d)" value={metrics.emails} href="/drill/emails_7d" />
        <Stat label="Voicemails (7d)" value={metrics.voicemails} href="/drill/voicemails_7d" />
        <Stat label="LinkedIn (7d)" value={metrics.linkedin} href="/drill/linkedin_7d" />
        <Stat label="In-person visits (7d)" value={metrics.inPersonVisits} href="/drill/visits_7d" />
        <Stat label="Connected convos (7d)" value={metrics.connected} href="/drill/connected_7d" />
        <Stat label="Qualified (open)" value={metrics.qualified} href="/drill/qualified" />
        <Stat label="Demos booked" value={metrics.demosBooked} href="/drill/demos_booked" />
        <Stat label="Demos completed" value={metrics.demosCompleted} href="/drill/demos_completed" />
        <Stat label="Demo no-shows (7d)" value={metrics.demoNoShows} href="/drill/demo_noshows_7d" />
        <Stat
          label="First-case commitments"
          value={metrics.firstCaseCommitments}
          tone="good"
          sub="committed, no case yet"
          href="/drill/first_case_commitments"
        />
        <Stat
          label="First cases identified"
          value={metrics.firstCasesIdentified}
          sub="1 case in motion"
          href="/drill/first_cases_identified"
        />
        <Stat
          label="Firms closed"
          value={metrics.newFirmsClosed}
          tone="good"
          sub="closed won (3+ cases)"
          href="/drill/firms_closed"
        />
        <Stat label="Revenue closed" value={`$${Math.round(metrics.revenueClosed).toLocaleString()}`} href="/drill/firms_closed" />
        <Stat label="Overdue tasks" value={metrics.overdueTasks} tone={metrics.overdueTasks ? "bad" : "good"} href="/drill/overdue_tasks" />
        <Stat
          label="Deals w/o future task"
          value={metrics.dealsNoFutureTask}
          tone={metrics.dealsNoFutureTask ? "bad" : "good"}
          sub="target: zero"
          href="/drill/deals_no_future_task"
        />
        <Stat label="Stalled deals" value={metrics.stalledDeals} tone={metrics.stalledDeals ? "warn" : "good"} href="/drill/stalled" />
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
