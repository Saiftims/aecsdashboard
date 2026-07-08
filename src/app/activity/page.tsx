import Link from "next/link";
import { redirect } from "next/navigation";
import { DailyActivityChart } from "@/components/charts";
import { Card, CardHeader, Stat, Table } from "@/components/ui";
import { activityReport } from "@/lib/queries";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");

  const { settings, activityTotals, daily, funnel, revenue, cohortSize } = await activityReport(
    user.role === "ae" ? user.hubspot_owner_id : null,
  );
  const scope = user.role === "ae" ? "your" : "team";

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
            />
          ))}
          <Stat
            label="Revenue (won this week)"
            value={`$${Math.round(revenue).toLocaleString()}`}
            tone="good"
            sub="actual, from this week's cohort"
          />
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
