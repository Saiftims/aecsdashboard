import { redirect } from "next/navigation";
import { FunnelChart } from "@/components/charts";
import { Card, CardHeader, Stat } from "@/components/ui";
import { execOverview } from "@/lib/queries";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ExecutivePage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role === "ae") redirect("/ae");
  if (user.role === "cs") redirect("/cs");

  const { kpis, funnel, postSaleFunnel } = await execOverview();
  const fmtMoney = (n: number | null) =>
    n === null ? "-" : `$${Math.round(n).toLocaleString()}`;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Executive Overview</h1>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Sales</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
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
            sub={`${fmtMoney(kpis.mrr)} subscription + ${fmtMoney(kpis.transactionalRevenueThisMonth)} per-case`}
          />
          <Stat
            label="MRR (subscriptions)"
            value={fmtMoney(kpis.mrr)}
            sub={`${kpis.subscriptionFirms} firm(s) on monthly plans`}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Customers & Usage</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Customer firms" value={kpis.totalCustomerFirms} href="/firms" />
          <Stat label="Activated" value={kpis.activatedFirms} tone="good" href="/drill/activation_activated" />
          <Stat label="Repeat users" value={kpis.repeatUsers} href="/drill/activation_repeat_user" />
          <Stat label="Healthy accounts" value={kpis.healthyAccounts} tone="good" href="/firms?health=green" />
          <Stat label="At risk" value={kpis.atRiskAccounts} tone={kpis.atRiskAccounts ? "bad" : "good"} href="/drill/activation_at_risk" />
          <Stat label="Cases this month" value={kpis.casesThisMonth} href="/drill/cs_cases_month" />
          <Stat
            label="New customers (month)"
            value={kpis.newCustomersThisMonth}
            tone="good"
            sub="first case this month"
            href="/drill/new_customers_month"
          />
          <Stat label="Avg cases / active firm" value={kpis.avgCasesPerActiveFirm} />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Sales funnel (MQL -> Closed Won)" />
          <div className="p-4">
            <FunnelChart data={funnel} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Post-sale funnel (Closed Won -> Healthy)" />
          <div className="p-4">
            <FunnelChart data={postSaleFunnel} />
          </div>
        </Card>
      </div>
    </div>
  );
}
