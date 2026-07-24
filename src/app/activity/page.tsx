import Link from "next/link";
import { redirect } from "next/navigation";
import { DailyActivityChart, FunnelChart, MonthlyBarChart, RetentionChart } from "@/components/charts";
import { Card, CardHeader, Stat, Table } from "@/components/ui";
import { activityReport, retentionReport } from "@/lib/queries";
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

  const [report, retention] = await Promise.all([
    activityReport(user.role === "ae" ? user.hubspot_owner_id : null),
    retentionReport(),
  ]);
  const { settings, activityTotals, daily, funnel, revenue, cohortSize, casesThisWeek, newCustomers, dealsWon } = report;
  const freq = retention.frequency;
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
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="New leads" value={cohortSize} tone="good" sub="deals created this week" href="/drill/funnel_leads" />
          <Stat label="New customers" value={newCustomers} tone="good" sub="new this week (case/signup/sub)" href="/drill/new_customers_7d" />
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

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Monthly case volume
        </h2>
        <Card>
          <CardHeader
            title="Total cases submitted per month"
            action={<span className="text-xs text-zinc-500">{retention.monthlyCases.reduce((s, m) => s + m.count, 0)} cases all-time</span>}
          />
          <div className="p-4">
            <MonthlyBarChart data={retention.monthlyCases} />
          </div>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Retention funnel — {freq.activatedFirms} activated firms
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Activation → repeat → retained" />
            <div className="p-4">
              <FunnelChart data={retention.funnel.map((f) => ({ label: f.label, count: f.count }))} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Stage conversion" />
            <Table
              headers={["Stage", "Firms", "Conv. from prev", "% of activated"]}
              rows={retention.funnel.map((f) => [
                f.label,
                String(f.count),
                f.convFromPrev === null ? "—" : `${f.convFromPrev}%`,
                f.convFromTop === null ? "—" : `${f.convFromTop}%`,
              ])}
            />
          </Card>
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          Activation = firm submitted ≥1 case. 2nd/3rd = firms with ≥2/≥3 lifetime cases.
          &ldquo;Active in N-day window&rdquo; = submitted an additional case in that window after the first case.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Cohort retention — grouped by first-case month
        </h2>
        <Card>
          <CardHeader title="Retention curve (% of cohort still submitting)" />
          <div className="p-4">
            <RetentionChart cohorts={retention.cohorts} monthCols={retention.monthCols} />
          </div>
        </Card>
        <div className="mt-3">
          <Table
            headers={["First-case cohort", "Firms", "Month 0", "Month 1", "Month 2", "Month 3"]}
            rows={retention.cohorts.map((c) => [
              <Link key="c" href={`/drill/cohort_${c.key}`} className="font-medium text-blue-600 hover:underline">
                {c.label}
              </Link>,
              String(c.firms),
              ...c.retention.map((r) => (r === null ? "—" : `${r}%`)),
            ])}
          />
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          Each cohort = firms whose first case landed that month. Month N = % of the cohort that
          submitted a case N calendar months later. &ldquo;—&rdquo; = that month hasn&apos;t elapsed yet.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Usage frequency
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <Stat label="Cases / activated firm" value={freq.casesPerActivatedFirm} />
          <Stat label="Cases / active firm (30d)" value={freq.casesPerActiveFirm} />
          <Stat label="Median cases / active firm" value={freq.medianCasesPerActiveFirm} />
          <Stat label="Top-3 firm concentration" value={freq.top3ConcentrationPct === null ? "-" : `${freq.top3ConcentrationPct}%`} sub="share of all cases" tone={freq.top3ConcentrationPct !== null && freq.top3ConcentrationPct >= 60 ? "warn" : undefined} />
          <Stat label="Active firms (30d)" value={freq.activeFirms30d} />
          <Stat label="Zero cases this month" value={freq.zeroCasesThisMonth} tone={freq.zeroCasesThisMonth ? "warn" : "good"} />
          <Stat label="One case only (lifetime)" value={freq.oneCaseOnly} />
          <Stat label="Two-plus cases" value={freq.twoPlusCases} tone="good" />
          <Stat label="Three-plus cases" value={freq.threePlusCases} tone="good" />
          <Stat label="Active 2+ consecutive months" value={freq.activeTwoPlusConsecutiveMonths} tone="good" />
        </div>
      </section>

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
