import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BillingRetentionChart, DailyActivityChart, FunnelChart, MonthlyBarChart,
  RetentionChart, RevenueRetentionChart,
} from "@/components/charts";
import { Card, CardHeader, Stat, Table } from "@/components/ui";
import { CHANNEL_LABELS, OTHER_CHANNELS } from "@/lib/activity-channels";
import { activityReport, billingRetentionReport, retentionReport } from "@/lib/queries";
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

  const [report, retention, billing] = await Promise.all([
    activityReport(user.role === "ae" ? user.hubspot_owner_id : null),
    retentionReport(),
    billingRetentionReport(),
  ]);
  const revRetention = billing.revenue;
  const useRetention = billing.usage;
  const { settings, activityTotals, roleDaily, funnel, revenue, cohortSize, casesThisWeek, newCustomers, dealsWon } = report;
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
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-9">
          <Stat label="Total touches" value={activityTotals.touches} />
          <Stat label="Calls" value={activityTotals.calls} />
          <Stat label="Emails" value={activityTotals.emails} />
          <Stat label="Texts" value={activityTotals.sms} href="/drill/sms_7d" />
          <Stat label="Other channels" value={activityTotals.otherChannels}
            href="/drill/other_channels_7d" />
          <Stat label="Voicemails" value={activityTotals.voicemails} />
          <Stat label="Meetings" value={activityTotals.meetings} />
          <Stat label="In-person visits" value={activityTotals.inPersonVisits} />
          <Stat label="Connected" value={activityTotals.connected} tone="good" />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Texts come from Quo, the same source as dials. &ldquo;Other
          channels&rdquo; is every DM a rep logged:{" "}
          {OTHER_CHANNELS.map((c) => `${CHANNEL_LABELS[c]} ${activityTotals.byChannel[c]}`)
            .join(" · ")}
          .
        </p>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {roleDaily.map((r) => (
          <Card key={r.role}>
            <CardHeader
              title={`${r.label} — daily activity vs target`}
              action={
                <span className="text-xs text-zinc-500">
                  {r.dailyAverage} of {r.activityTarget} a day
                </span>
              }
            />
            <div className="p-4">
              <DailyActivityChart data={r.data} activityTarget={r.activityTarget} />
              <p className="mt-2 text-xs text-zinc-500">
                {r.people.length
                  ? <>{r.people.join(", ")} · every channel stacked to one
                      total against the {r.activityTarget}/day target · calls from{" "}
                      {r.callSource === "quo"
                        ? "Quo (every dial)"
                        : "HubSpot logged calls"}
                      {", texts from "}
                      {r.smsSource === "quo" ? "Quo" : "HubSpot logged messages"}.</>
                  : "No activity logged in this role over the last 7 days."}
              </p>
            </div>
          </Card>
        ))}
      </section>

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
          Revenue retention — dollars kept, by first-revenue month
        </h2>
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Revenue firms" value={billing.subscriptionFirms + billing.transactionalFirms} sub="have billed at least once" />
          <Stat label="On subscription" value={billing.subscriptionFirms} sub={`${money(billing.mrr)} / month`} tone="good" />
          <Stat label="Transactional" value={billing.transactionalFirms} sub={`$${settings.defaultCasePrice} per case`} />
          <Stat label="Cohorts tracked" value={revRetention.cohorts.length} sub="months with a first sale" />
        </div>
        <Card>
          <CardHeader
            title="Revenue retention curve (% of each cohort's month-0 dollars)"
            action={billing.partialMonth ? (
              <span className="text-xs text-amber-600">
                {billing.partialMonthLabel} is still running — its dollars are incomplete
              </span>
            ) : null}
          />
          <div className="p-4">
            <RevenueRetentionChart cohorts={revRetention.cohorts} monthCols={billing.monthCols} />
          </div>
        </Card>
        <div className="mt-3">
          <Table
            headers={["First-revenue cohort", "Firms", "Month 0", "Month 1", "Month 2", "Month 3"]}
            rows={revRetention.cohorts.map((c) => [
              <Link key="c" href={`/drill/revcohort_${c.key}`} className="font-medium text-blue-600 hover:underline">
                {c.label}
              </Link>,
              String(c.firms),
              ...c.retention.map((r, i) =>
                r === null || c.values[i] === null
                  ? "—"
                  : `${money(c.values[i]!)} · ${r}%`),
            ])}
          />
        </div>
        <div className="mt-3">
          <Table
            headers={["Cohort", "Still billing", "Stopped after month 0"]}
            rows={revRetention.cohorts.map((c) => [
              <Link key="c" href={`/drill/revcohort_${c.key}`} className="text-blue-600 hover:underline">
                {c.label}
              </Link>,
              c.members.filter((m) => !m.lapsed)
                .map((m) => `${m.name} (${money(m.latest || m.base)})`).join(", ") || "—",
              <span key="lapsed" className={c.members.some((m) => m.lapsed) ? "text-amber-600" : ""}>
                {c.members.filter((m) => m.lapsed)
                  .map((m) => `${m.name} (was ${money(m.base)})`).join(", ") || "—"}
              </span>,
            ])}
          />
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          A cohort is the firms that first billed in that month. Month N = the dollars that cohort
          billed N months later, as a share of what it billed in month 0 — above 100% means the
          cohort grew. Subscription firms count their flat monthly fee; everyone else counts
          cases × ${settings.defaultCasePrice}. A curve that falls is a named firm that stopped,
          listed above, not a data problem.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Usage retention — cases kept, by first-case month
        </h2>
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Firms with usage" value={billing.usageFirms} sub="submitted at least one case" />
          <Stat
            label="Stopped submitting"
            value={useRetention.members.filter((m) => m.lapsed).length}
            sub="used in month 0, nothing since"
            tone={useRetention.members.some((m) => m.lapsed) ? "warn" : "good"}
          />
          <Stat label="Still submitting" value={useRetention.members.filter((m) => !m.lapsed).length} tone="good" />
          <Stat label="Cohorts tracked" value={useRetention.cohorts.length} sub="months with a first case" />
        </div>
        <Card>
          <CardHeader
            title="Usage retention curve (% of each cohort's month-0 cases)"
            action={billing.partialMonth ? (
              <span className="text-xs text-amber-600">
                {billing.partialMonthLabel} is still running — its cases are incomplete
              </span>
            ) : null}
          />
          <div className="p-4">
            <RevenueRetentionChart cohorts={useRetention.cohorts} monthCols={billing.monthCols} />
          </div>
        </Card>
        <div className="mt-3">
          <Table
            headers={["First-case cohort", "Firms", "Month 0", "Month 1", "Month 2", "Month 3"]}
            rows={useRetention.cohorts.map((c) => [
              <Link key="c" href={`/drill/usecohort_${c.key}`} className="font-medium text-blue-600 hover:underline">
                {c.label}
              </Link>,
              String(c.firms),
              ...c.retention.map((r, i) =>
                r === null || c.values[i] === null
                  ? "—"
                  : `${c.values[i]} case${c.values[i] === 1 ? "" : "s"} · ${r}%`),
            ])}
          />
        </div>
        <div className="mt-3">
          <Table
            headers={["Cohort", "Still submitting", "Stopped after month 0"]}
            rows={useRetention.cohorts.map((c) => [
              <Link key="c" href={`/drill/usecohort_${c.key}`} className="text-blue-600 hover:underline">
                {c.label}
              </Link>,
              c.members.filter((m) => !m.lapsed)
                .map((m) => `${m.name} (${m.latest || m.base})`).join(", ") || "—",
              <span key="lapsed" className={c.members.some((m) => m.lapsed) ? "text-amber-600" : ""}>
                {c.members.filter((m) => m.lapsed)
                  .map((m) => `${m.name} (was ${m.base})`).join(", ") || "—"}
              </span>,
            ])}
          />
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          Same cohorts, counting cases instead of dollars, so a subscriber that keeps paying while
          it stops using shows up here even though the revenue curve holds. Firms that have never
          submitted a case are excluded entirely — there is no usage to retain.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Subscription vs transactional — each firm counts equally
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Dollar retention by billing model" />
            <div className="p-4">
              <BillingRetentionChart curves={revRetention.curves} monthCols={billing.monthCols} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Usage retention by billing model" />
            <div className="p-4">
              <BillingRetentionChart curves={useRetention.curves} monthCols={billing.monthCols} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Underlying dollars" />
            <Table
              headers={["Model", "Month", "Firms this far in", "Total month-0 $", "Total billed", "Avg firm retained"]}
              rows={revRetention.curves.flatMap((c) =>
                c.points.map((p) => [
                  p.month === 0 ? (
                    <Link key="m" href={`/drill/revbilling_${c.key}`} className="font-medium text-blue-600 hover:underline">
                      {c.label} ({c.firms})
                    </Link>
                  ) : "",
                  `Month ${p.month}`,
                  String(p.firms),
                  p.base === null ? "—" : money(p.base),
                  p.value === null ? "—" : money(p.value),
                  p.pct === null ? "—" : `${p.pct}%`,
                ]),
              )}
            />
          </Card>
          <Card>
            <CardHeader title="Underlying cases" />
            <Table
              headers={["Model", "Month", "Firms this far in", "Total month-0 cases", "Total cases", "Avg firm retained"]}
              rows={useRetention.curves.flatMap((c) =>
                c.points.map((p) => [
                  p.month === 0 ? (
                    <Link key="m" href={`/drill/usebilling_${c.key}`} className="font-medium text-blue-600 hover:underline">
                      {c.label} ({c.firms})
                    </Link>
                  ) : "",
                  `Month ${p.month}`,
                  String(p.firms),
                  p.base === null ? "—" : String(p.base),
                  p.value === null ? "—" : String(p.value),
                  p.pct === null ? "—" : `${p.pct}%`,
                ]),
              )}
            />
          </Card>
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          Retained % is the average of each firm&apos;s own (month N ÷ month 0), so a $750/month
          firm and a one-case firm each count as one — totals in the table are context only, not
          the denominator. Only firms that have actually reached month N are in that average.
          Read the two charts together: dollars are what we are paid, cases are whether the
          product is being used, and a subscription whose dollars hold while its cases fall is
          the one about to cancel.
          {billing.partialMonth ? ` ${billing.partialMonthLabel} is incomplete, which pulls whichever month lands on it down in both charts.` : ""}
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
