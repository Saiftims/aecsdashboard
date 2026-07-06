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
          <Stat label="Qualified (open)" value={kpis.qualifiedOpen} />
          <Stat label="First-case commitments" value={kpis.firstCaseCommitted} />
          <Stat label="New firms this month" value={kpis.newFirmsThisMonth} tone="good" />
          <Stat label="Pipeline value (est)" value={fmtMoney(kpis.pipelineValue)} />
          <Stat label="Revenue closed (month)" value={fmtMoney(kpis.revenueClosedThisMonth)} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Customers & Usage</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Customer firms" value={kpis.totalCustomerFirms} />
          <Stat label="Activated" value={kpis.activatedFirms} tone="good" />
          <Stat label="Repeat users" value={kpis.repeatUsers} />
          <Stat label="Healthy accounts" value={kpis.healthyAccounts} tone="good" />
          <Stat label="At risk" value={kpis.atRiskAccounts} tone={kpis.atRiskAccounts ? "bad" : "good"} />
          <Stat label="Cases this month" value={kpis.casesThisMonth} />
          <Stat
            label="Est. case revenue (month)"
            value={fmtMoney(kpis.estRevenueThisMonth)}
            sub="estimated: cases x default price"
          />
          <Stat
            label="Actual revenue (month)"
            value={kpis.actualRevenueThisMonth === null ? "n/a" : fmtMoney(kpis.actualRevenueThisMonth)}
            sub="no invoice source connected"
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
