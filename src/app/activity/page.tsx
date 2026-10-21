import { redirect } from "next/navigation";
import {
  DailyActivityChart, FunnelChart, LeadSourceChart, MonthlyBarChart, MonthlyMqlChart,
  MonthlyNewFirmsChart,
  MonthlyRevenueChart, RevenueRetentionChart,
} from "@/components/charts";
import {
  Badge, Card, CardBody, CardHeader, Note, PageHeader, Section, Stat, StatGrid, Table, TextLink,
} from "@/components/ui";
import { LogoRetention } from "@/components/logo-retention";
import { UnitEconomics } from "@/components/unit-economics";
import { CHANNEL_LABELS, OTHER_CHANNELS } from "@/lib/activity-channels";
import {
  activityReport, billingRetentionReport, demoCreditReport, retentionReport,
} from "@/lib/queries";
import { LEAD_SOURCES, leadsReport } from "@/lib/leads";
import { loadSettings } from "@/lib/settings";
import { currentAppUser } from "@/lib/supabase/server";
import { unitEconomicsSnapshot } from "@/lib/unit-economics";

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

  const [report, retention, billing, demoCredit, unitEcon, leads] = await Promise.all([
    activityReport(user.role === "ae" ? user.hubspot_owner_id : null),
    retentionReport(),
    billingRetentionReport(),
    demoCreditReport(),
    user.role === "executive" ? unitEconomicsSnapshot() : null,
    loadSettings().then((s) => leadsReport(s.dashboardTimezone)),
  ]);
  const revRetention = billing.revenue;
  const {
    settings, activityTotals, roleDaily, funnel, revenue, revenueCollected,
    revenueModelled, revenueFromStripe, cohortSize, casesThisWeek, newCustomers,
    dealsWon,
  } = report;
  const freq = retention.frequency;
  const scope = user.role === "ae" ? "your" : "team";
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
  // Same label format the monthly series use, so the current month can be found.
  const thisMonthLabel = new Date().toLocaleString("en-US", {
    month: "short", year: "numeric", timeZone: "UTC",
  });
  const thisMonth = <T extends { month: string }>(rows: T[]) =>
    rows.find((r) => r.month === thisMonthLabel);
  const progress = (value: number, target: number, fmt = (n: number) => String(n)) =>
    `${fmt(value)} of ${fmt(target)} this month (${Math.round((value / target) * 100)}%)`;
  // Only the networks actually used, so a quiet week isn't a row of zeroes.
  const dmSplit = OTHER_CHANNELS
    .filter((c) => activityTotals.byChannel[c] > 0)
    .map((c) => `${CHANNEL_LABELS[c]} ${activityTotals.byChannel[c]}`)
    .join(" · ");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity & funnel — last 7 days"
        description={<>
          {scope === "your" ? "Your" : "Team"} activity and this week&apos;s new-business
          funnel. Days are in the dashboard timezone.
        </>}
      />

      <Section title="Results (7 days)">
        <StatGrid cols={5}>
          {leads.ok ? (
            <Stat label="New leads" value={leads.leads.length} tone="good"
              sub="deals, ad forms & bookings" href="/drill/leads_7d" />
          ) : (
            <Stat label="New leads" value={cohortSize} tone="good" sub="deals created this week" href="/drill/funnel_leads" />
          )}
          <Stat label="New customers" value={newCustomers} tone="good" sub="new this week (case/signup/sub)" href="/drill/new_customers_7d" />
          <Stat label="Cases won" value={casesThisWeek} tone="good" sub="cases submitted this week" href="/drill/cases_7d" />
          <Stat
            label="Revenue"
            value={money(revenue)}
            tone="good"
            // Not "cases x $250" any more: this is money Stripe took in the last
            // 7 days, which is a different thing from the cases submitted in them.
            sub={revenueFromStripe
              ? `${money(revenueCollected)} collected${revenueModelled ? ` + ${money(revenueModelled)} est.` : ""}`
              : `${casesThisWeek} cases x $${settings.defaultCasePrice}`}
            href="/drill/cases_7d"
          />
          <Stat label="Deals signed" value={dealsWon} sub="closed-won this week" href="/drill/funnel_closed_won" />
        </StatGrid>
      </Section>

      {leads.ok ? (
        <Card>
          <CardHeader
            title="New leads by source — last 7 days"
            action={
              <TextLink href="/drill/leads_7d">
                {leads.leads.length} leads · see the list
              </TextLink>
            }
          />
          <CardBody>
            <LeadSourceChart data={leads.daily} series={LEAD_SOURCES} drillHref="/drill/leads_7d" />
          </CardBody>
          <Note>
            Every lead counted once, wherever it landed: new sales-pipeline deals,
            every Meta ad-form submission read directly from Meta (including ones
            nobody has turned into a deal yet), and sheet rows that never reached
            HubSpot. Meta form fills are split by FlyTech&rsquo;s screening:
            &ldquo;qualified&rdquo; is anyone FlyTech put on its lead sheet, &ldquo;unqualified&rdquo;
            is a submission Meta has that the sheet does not {"\u2014"} both are MQLs.
            &ldquo;Existing lead came back&rdquo; is someone already in HubSpot filling the
            form or booking again {"\u2014"} intent, not a new person. Case intakes and activation deals are not leads.
          </Note>
        </Card>
      ) : null}

      <Section title="Activity (7 days)">
        <StatGrid cols={5}>
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
        </StatGrid>
        <Note className="px-0 pb-0">
          Texts come from Quo, the same source as dials. &ldquo;Other
          channels&rdquo; is every touch that is not a dial, an email or a text
          — the DMs a rep logged plus meetings, demos and visits.
          {dmSplit ? <> DMs this week: {dmSplit}.</> : null}
        </Note>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        {roleDaily.map((r) => (
          <Card key={r.role}>
            <CardHeader
              title={`${r.label} — daily activity vs target`}
              action={<span>{r.dailyAverage} of {r.activityTarget} a day</span>}
            />
            <CardBody>
              <DailyActivityChart data={r.data} activityTarget={r.activityTarget} />
            </CardBody>
            <Note>
              {r.people.length
                ? <>{r.people.join(", ")} · every channel stacked to one
                    total against the {r.activityTarget}/day target · calls from{" "}
                    {r.callSource === "quo"
                      ? "Quo (every dial)"
                      : "HubSpot logged calls"}
                    {", texts from "}
                    {r.smsSource === "quo" ? "Quo" : "HubSpot logged messages"}.</>
                : "No activity logged in this role over the last 7 days."}
            </Note>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title={`Demos booked by rep \u2014 ${demoCredit.monthLabel}`}
          action={<span>{demoCredit.total} demos, {demoCredit.totalFirstCases} first cases</span>}
        />
        <Table
          headers={["Booked by", "Demos booked", "First case this month", "Cases this month"]}
          rows={demoCredit.rows.map((r) => [
            r.ownerId ? r.name : <span key={r.name} className="text-zinc-500">{r.name}</span>,
            String(r.demos),
            r.firstCases ? String(r.firstCases) : "\u2014",
            r.cases ? String(r.cases) : "\u2014",
          ])}
        />
        <Note>
          Credit is the rep who owned the deal in the minute BEFORE it entered
          Demo Scheduled, not the current deal owner {"\u2014"} the owner sweep hands
          every booked deal to Chris within hours, so the owner field cannot
          answer this. Self-serve means nobody was working the lead when it
          booked; those belong to marketing, not to whoever inherited the deal.
          &ldquo;First case this month&rdquo; counts firms whose FIRST EVER case
          landed this month, so it is genuinely new revenue rather than a repeat
          submission. Stamping began {demoCredit.creditFrom}, so demos booked
          earlier in a month that starts before then read as self-serve.
        </Note>
      </Card>

      <Section title={<>Full funnel — {cohortSize} deals created this week</>}>
        <StatGrid cols={4}>
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
        </StatGrid>
      </Section>

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

      <Section title="Monthly MQLs">
        <Card>
          <CardHeader
            title="MQLs per month"
            action={
              <span>
                {progress(thisMonth(retention.monthlyMqls)?.count ?? 0, settings.monthlyMqlsTarget)}
                {" \u00b7 "}
                {retention.monthlyMqls.reduce((s, m) => s + m.count, 0)} MQLs all-time
              </span>
            }
          />
          <CardBody>
            {retention.mqlSourcesKnown ? (
              <MonthlyMqlChart data={retention.monthlyMqls} series={LEAD_SOURCES}
                target={settings.monthlyMqlsTarget} drillBase="/drill/month_mqls_" />
            ) : (
              <MonthlyBarChart data={retention.monthlyMqls} color="hsl(210 70% 50%)"
                target={settings.monthlyMqlsTarget} drillBase="/drill/month_mqls_" />
            )}
          </CardBody>
          <Note>
            An MQL is a new lead {"\u2014"} the same definition and the same records as the
            &ldquo;New leads&rdquo; tile above, so month-to-date here always covers the
            7-day figure. Every person who arrived is counted once per month, whichever
            way they came in: a new deal in the sales pipeline, a Meta ad-form submission
            read straight from Meta (qualified if FlyTech put them on its sheet, unqualified
            if not {"\u2014"} and whether or not a rep has made a deal yet), a Calendly booking,
            a website or wait-list form, or a lead a rep added. Someone already in HubSpot who submits again is &ldquo;existing lead
            came back&rdquo;. Reps&rsquo; test submissions and staff addresses are excluded.
            {!retention.mqlSourcesKnown && " HubSpot could not be read live, so this shows cached sales deals only."}
          </Note>
        </Card>
      </Section>

      <Section title="Monthly demos">
        <Card>
          <CardHeader
            title="Demos run per month"
            action={
              <span>
                {progress(thisMonth(retention.monthlyDemos)?.count ?? 0, settings.monthlyDemosTarget)}
                {" \u00b7 "}
                {retention.monthlyDemos.reduce((s, m) => s + m.count, 0)} demos all-time
              </span>
            }
          />
          <CardBody>
            <MonthlyBarChart data={retention.monthlyDemos} color="hsl(160 55% 42%)"
              target={settings.monthlyDemosTarget} drillBase="/drill/month_demos_" />
          </CardBody>
          <Note>
            A demo counts only once someone actually attended it. Calendly is the
            source of truth: a no-show stays a booking and never lands here, and
            demos still on the calendar are not counted until they happen.
          </Note>
        </Card>
      </Section>

      <Section title="Monthly new firms">
        <Card>
          <CardHeader
            title="New firms per month"
            action={
              <span>
                {progress(thisMonth(retention.monthlyNewFirms)?.count ?? 0, settings.monthlyNewFirmsTarget)}
                {" \u00b7 "}
                {retention.monthlyNewFirms.reduce((s, m) => s + m.count, 0)} firms all-time
              </span>
            }
          />
          <CardBody>
            <MonthlyNewFirmsChart data={retention.monthlyNewFirms}
              target={settings.monthlyNewFirmsTarget} drillBase="/drill/month_firms_" />
          </CardBody>
          <Note>
            A firm counts once, in the month it first signed up for the app or
            submitted its first case, whichever came first. The dark part has
            submitted a case; the pale part has signed up but not sent one yet,
            and moves into the dark part of its own month when it does. A
            closed-won deal with no signup and no case is still pipeline. The
            cohort tables below stay on first-case months.
          </Note>
        </Card>
      </Section>

      <Section title="Monthly case volume">
        <Card>
          <CardHeader
            title="Total cases submitted per month"
            action={
              <span>
                {progress(thisMonth(retention.monthlyCases)?.count ?? 0, settings.monthlyCasesTarget)}
                {" \u00b7 "}
                {retention.monthlyCases.reduce((s, m) => s + m.count, 0)} cases all-time
              </span>
            }
          />
          <CardBody>
            <MonthlyBarChart data={retention.monthlyCases} target={settings.monthlyCasesTarget}
              drillBase="/drill/month_cases_" />
          </CardBody>
        </Card>
      </Section>

      <Section title="Monthly revenue">
        <Card>
          <CardHeader
            title="Revenue per month"
            action={
              <span>
                {progress(thisMonth(retention.monthlyRevenue)?.total ?? 0, settings.monthlyRevenueTarget, money)}
                {" \u00b7 "}
                {money(retention.monthlyRevenue.reduce((s, m) => s + m.total, 0))} all-time
              </span>
            }
          />
          <CardBody>
            <MonthlyRevenueChart data={retention.monthlyRevenue} target={settings.monthlyRevenueTarget}
              drillBase="/drill/month_revenue_" />
          </CardBody>
          <Note>
            The solid bar is cash Stripe actually collected that month, net of
            refunds {"\u2014"} a refunded payment is not revenue, so a firm that was
            billed and refunded in full reads as zero. The pale bar is the firms
            Stripe has never billed, still priced by the old rules: a flat plan
            where one is recorded, otherwise {money(settings.defaultCasePrice)} a
            case. That part is an estimate, not money in the bank. Revenue counts
            in the month it was TAKEN, which is not always the month the case was
            submitted, so this will not track the case chart above exactly.
          </Note>
        </Card>
      </Section>

      <Section title={<>Retention funnel — {freq.activatedFirms} activated firms</>}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Activation → repeat → retained" />
            <CardBody>
              <FunnelChart data={retention.funnel.map((f) => ({ label: f.label, count: f.count }))} />
            </CardBody>
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
        <Note className="px-0 pb-0">
          Activation = firm submitted ≥1 case. 2nd/3rd = firms with ≥2/≥3 lifetime cases.
          &ldquo;Active in N-day window&rdquo; = submitted an additional case in that window after the first case.
        </Note>
      </Section>

      <Section title="Cohort retention — still a customer">
        <LogoRetention
          cohorts={retention.cohorts}
          monthCols={retention.monthCols}
          partialMonthLabel={billing.partialMonth ? billing.partialMonthLabel : null}
        />
      </Section>

      <Section title="Revenue retention — dollars kept, by first-revenue month">
        <div className="mb-3">
          <StatGrid cols={4}>
            <Stat label="Revenue firms" value={billing.subscriptionFirms + billing.transactionalFirms} sub="have billed at least once" />
            <Stat label="On subscription" value={billing.subscriptionFirms} sub={`${money(billing.mrr)} / month`} tone="good" />
            <Stat label="Transactional" value={billing.transactionalFirms} sub={`$${settings.defaultCasePrice} per case`} />
            <Stat label="Cohorts tracked" value={revRetention.cohorts.length} sub="months with a first sale" />
          </StatGrid>
        </div>
        <Card>
          <CardHeader
            title="Revenue retention curve (% of each cohort's month-0 dollars)"
            action={billing.partialMonth ? (
              <Badge tone="yellow">
                {billing.partialMonthLabel} is still running — its dollars are incomplete
              </Badge>
            ) : null}
          />
          <CardBody>
            <RevenueRetentionChart cohorts={revRetention.cohorts} monthCols={billing.monthCols} />
          </CardBody>
        </Card>
        <Card className="mt-3">
          <Table
            headers={["First-revenue cohort", "Firms", "Month 0", "Month 1", "Month 2", "Month 3"]}
            rows={revRetention.cohorts.map((c) => [
              <TextLink key="c" href={`/drill/revcohort_${c.key}`} className="font-medium">
                {c.label}
              </TextLink>,
              String(c.firms),
              ...c.retention.map((r, i) =>
                r === null || c.values[i] === null
                  ? "—"
                  : `${money(c.values[i]!)} · ${r}%`),
            ])}
          />
        </Card>
        <Card className="mt-3">
          <Table
            headers={["Cohort", "Still billing", "Stopped after month 0"]}
            rows={revRetention.cohorts.map((c) => [
              <TextLink key="c" href={`/drill/revcohort_${c.key}`}>
                {c.label}
              </TextLink>,
              c.members.filter((m) => !m.lapsed)
                .map((m) => `${m.name} (${money(m.latest || m.base)})`).join(", ") || "—",
              <span key="lapsed" className={c.members.some((m) => m.lapsed) ? "text-amber-600 dark:text-amber-400" : ""}>
                {c.members.filter((m) => m.lapsed)
                  .map((m) => `${m.name} (was ${money(m.base)})`).join(", ") || "—"}
              </span>,
            ])}
          />
        </Card>
        <Note className="px-0 pb-0">
          A cohort is the firms that first billed in that month. Month N = the dollars that cohort
          billed N months later, as a share of what it billed in month 0 — above 100% means the
          cohort grew. Subscription firms count their flat monthly fee; everyone else counts
          cases × ${settings.defaultCasePrice}. A curve that falls is a named firm that stopped,
          listed above, not a data problem.
        </Note>
      </Section>

      <Section title="Usage frequency">
        <StatGrid cols={5}>
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
        </StatGrid>
      </Section>

      {unitEcon ? (
        <Section title={<>Unit economics — paid acquisition payback, {unitEcon.monthLabel}</>}>
          <UnitEconomics snap={unitEcon} />
        </Section>
      ) : null}

      <Note className="px-0 pb-0">
        Funnel cohort = deals created in the last 7 days, shown at the furthest stage
        each has reached (Closed Won counts as passing every prior stage). Activity
        counts every logged call/email/meeting in the window.
        <span className="mx-1">·</span>
        <TextLink href={user.role === "cs" ? "/cs" : "/ae"}>
          Back to dashboard
        </TextLink>
      </Note>
    </div>
  );
}
