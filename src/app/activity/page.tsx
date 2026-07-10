import Link from "next/link";
import { redirect } from "next/navigation";
import { DailyActivityChart } from "@/components/charts";
import { Card, CardHeader, Stat, Table } from "@/components/ui";
import { activityReport } from "@/lib/queries";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const FUNNEL_HREF: Record<string, string> = {
  "Leads": "/drill/funnel_leads",
  "Contacted": "/drill/funnel_contacted",
  "Connected": "/drill/funnel_connected",
  "Demo Scheduled": "/drill/funnel_demo_scheduled",
  "Demo Completed": "/drill/funnel_demo_completed",
  "First Case Identified": "/drill/funnel_first_case_identified",
  "First Case Committed": "/drill/funnel_first_case_committed",
  "Closed Won": "/drill/funnel_closed_won",
};

export default async function ActivityPage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");

  const { settings, activityTotals, daily, funnel, revenue, cohortSize, casesThisWeek, newCustomers, dealsWon } =
    await activityReport(user.role === "ae" ? user.hubspot_owner_id : null);
  const scope = user.role === "ae" ? "your" : "team";
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Activity &amp; funnel — last 7 days</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {scope === "your" ? "Your" : "Team"} activity and this week&apos;s new-business
          funnel. Days are in the dashboard timezone.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Results (7 days)
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="New customers" value={newCustomers} tone="good" sub="first case this week" href="/drill/new_customers_7d" />
          <Stat label="Cases won" value={casesThisWeek} tone="good" sub="cases submitted this week" href="/drill/cases_7d" />
          <Stat label="Revenue" value={money(revenue)} tone="good" sub={`${casesThisWeek} cases x $${settings.defaultCasePrice}`} href="/drill/cases_7d" />
          <Stat label="Deals signed" value={dealsWon} sub="closed-won this week" href="/drill/funnel_closed_won" />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Activity (7 days)
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
          <Stat label="Total touches" value={activityTotals.touches} />
          <Stat label="Calls" value={activityTotals.calls} />
          <Stat label="Emails" value={activityTotals.emails} />
          <Stat label="Voicemails" value={activityTotals.voicemails} />
          <Stat label="LinkedIn" value={activityTotals.linkedin} />
          <Stat label="Meetings" value={activityTotals.meetings} />
          <Stat label="In-person visits" value={activityTotals.inPersonVisits} />
          <Stat label="Connected" value={activityTotals.connected} tone="good" />
        </div>
      </section>

      <Card>
        <CardHeader
          title="Daily calls & emails vs targets"
          action={
            <span className="text-xs text-zinc-500">
              targets: {settings.dailyCallsTarget} calls · {settings.dailyEmailsTarget} emails / day
            </span>
          }
        />
        <div className="p-4">
          <DailyActivityChart
            data={daily}
            callsTarget={settings.dailyCallsTarget}
            emailsTarget={settings.dailyEmailsTarget}
          />
        </div>
      </Card>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Full funnel — {cohortSize} leads created this week
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {funnel.map((f) => (
            <Stat
              key={f.label}
              label={f.label}
              value={f.count}
              sub={f.convFromPrev === null ? "top of funnel" : `${f.convFromPrev}% from prev · ${f.convFromTop}% of leads`}
              tone={f.label === "Closed Won" ? "good" : undefined}
              href={FUNNEL_HREF[f.label]}
            />
          ))}
        </div>
      </section>

      <Card>
        <CardHeader title="Funnel conversion" />
        <Table
          headers={["Stage", "Count", "Conv. from previous", "Conv. from leads"]}
          rows={funnel.map((f) => [
            f.label,
            String(f.count),
            f.convFromPrev === null ? "—" : `${f.convFromPrev}%`,
            f.convFromTop === null ? "—" : `${f.convFromTop}%`,
          ])}
        />
      </Card>

      <p className="text-xs text-zinc-400">
        Funnel cohort = deals created in the last 7 days, shown at the furthest stage
        each has reached (Closed Won counts as passing every prior stage). Activity
        counts every logged call/email/meeting in the window.
        <span className="mx-1">·</span>
        <Link href={user.role === "cs" ? "/cs" : "/ae"} className="hover:underline">
          Back to dashboard
        </Link>
      </p>
    </div>
  );
}
