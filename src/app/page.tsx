import { redirect } from "next/navigation";
import { FunnelChart } from "@/components/charts";
import { Card, CardBody, CardHeader, PageHeader, Section, Stat, StatGrid } from "@/components/ui";
import { leadsReport } from "@/lib/leads";
import { execOverview } from "@/lib/queries";
import { loadSettings } from "@/lib/settings";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ExecutivePage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");

  const [{ kpis, funnel, postSaleFunnel }, leads] = await Promise.all([
    execOverview(),
    loadSettings().then((s) => leadsReport(s.dashboardTimezone)),
  ]);
  const fmtMoney = (n: number | null) =>
    n === null ? "-" : `$${Math.round(n).toLocaleString()}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Executive overview" description="Sales, customers and usage at a glance. Click any tile for the list behind it." />

      <Section title="Sales">
        <StatGrid cols={5}>
          {leads.ok ? (
            <Stat label="New leads (7d)" value={leads.leads.length} tone="good" href="/drill/leads_7d" />
          ) : (
            <Stat label="New leads (7d)" value={kpis.newLeads7d} tone="good" href="/drill/funnel_leads" />
          )}
          <Stat label="New MQLs (30d)" value={kpis.newMqls30d} />
          <Stat
            label="Median speed-to-lead"
            value={kpis.medianSpeedToLeadHours === null ? "-" : `${kpis.medianSpeedToLeadHours.toFixed(1)}h`}
            tone={kpis.medianSpeedToLeadHours !== null && kpis.medianSpeedToLeadHours <= 2 ? "good" : "warn"}
          />
          <Stat label="Contact rate" value={kpis.contactRate === null ? "-" : `${kpis.contactRate}%`} />
          <Stat label="Demo booking rate" value={kpis.demoBookingRate === null ? "-" : `${kpis.demoBookingRate}%`} />
          <Stat label="Demo completion" value={kpis.demoCompletionRate === null ? "-" : `${kpis.demoCompletionRate}%`} />
          <Stat label="Qualified (open)" value={kpis.qualifiedOpen} href="/drill/qualified" />
          <Stat label="First-case commitments" value={kpis.firstCaseCommitted} href="/drill/first_case_commitments" />
          <Stat label="New firms this month" value={kpis.newFirmsThisMonth} tone="good" href="/drill/firms_closed" />
          <Stat label="Pipeline value (est)" value={fmtMoney(kpis.pipelineValue)} href="/drill/leads_assigned" />
          <Stat
            label="Revenue (month)"
            value={fmtMoney(kpis.estRevenueThisMonth)}
            tone="good"
            sub={kpis.actualRevenueThisMonth == null
              ? `${fmtMoney(kpis.mrr)} subscription + ${fmtMoney(kpis.transactionalRevenueThisMonth)} per-case`
              // Say which part is money and which is still a guess: the two are
              // not equally trustworthy and the total hides that.
              : `${fmtMoney(kpis.actualRevenueThisMonth)} collected in Stripe + ${fmtMoney(kpis.modelledRevenueThisMonth ?? 0)} estimated`}
          />
          <Stat
            label="MRR (subscriptions)"
            value={fmtMoney(kpis.mrr)}
            sub={`${kpis.subscriptionFirms} firm(s) on monthly plans`}
          />
        </StatGrid>
      </Section>

      <Section title="Customers & usage">
        <StatGrid cols={5}>
          <Stat label="Customer firms" value={kpis.totalCustomerFirms} href="/firms" />
          <Stat
            label="New customers (month)"
            value={kpis.newCustomersThisMonth}
            tone="good"
            sub="first case this month"
            href="/drill/new_customers_month"
          />
          <Stat label="Total cases" value={kpis.totalCases} sub="lifetime, all firms" />
          <Stat label="Cases / firm" value={kpis.casesPerFirm} sub="firms with ≥1 case" />
          <Stat label="Cases this month" value={kpis.casesThisMonth} href="/drill/cs_cases_month" />
          <Stat label="Healthy" value={kpis.healthyAccounts} tone="good" href="/drill/cs_healthy" />
          <Stat label="Active below target" value={kpis.activeBelowTarget} tone="warn" href="/drill/cs_below_target" />
          <Stat label="At risk" value={kpis.atRiskAccounts} tone={kpis.atRiskAccounts ? "bad" : "good"} href="/drill/cs_at_risk" />
          <Stat label="Churned" value={kpis.churnedAccounts} tone={kpis.churnedAccounts ? "bad" : "good"} href="/drill/cs_churned" />
          <Stat label="Avg cases / active firm" value={kpis.avgCasesPerActiveFirm} sub="last 30 days" />
        </StatGrid>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Sales funnel" description="MQL to Closed Won, open pipeline" />
          <CardBody><FunnelChart data={funnel} /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Post-sale funnel" description="Closed Won to healthy account" />
          <CardBody><FunnelChart data={postSaleFunnel} /></CardBody>
        </Card>
      </div>
    </div>
  );
}
