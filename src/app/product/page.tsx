import Link from "next/link";
import { redirect } from "next/navigation";
import { FunnelChart } from "@/components/charts";
import { Badge, Card, CardHeader, Stat, Table } from "@/components/ui";
import { productDashboard } from "@/lib/product-analytics";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function percent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

const HEALTH_TONE = {
  healthy: "green",
  watch: "yellow",
  at_risk: "red",
  not_using_product: "yellow",
} as const;

export default async function ProductPage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role === "ae") redirect("/ae");

  const data = await productDashboard();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Product Analytics</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Live PostHog product telemetry · health uses 7 days · workflow, engagement,
          funnel, and errors use 30 days.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
        Product telemetry is joined to all reconciled cases. Form/CSV intakes are
        shown separately and firms using intake without creating product cases are
        flagged “not using product.” PostHog&apos;s <code>case_created</code> event is
        known to under-report, so the tracked funnel remains a telemetry floor.
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Product health · 7 days
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Active firms" value={data.health.activeFirms7d} tone="good" />
          <Stat label="Active users" value={data.health.activeUsers7d} tone="good" />
          <Stat
            label="Returning-user rate"
            value={percent(data.health.returningUserRate)}
            tone={data.health.returningUserRate !== null && data.health.returningUserRate >= 50 ? "good" : "warn"}
            sub="active this week + prior week"
          />
          <Stat
            label="Median session duration"
            value={duration(data.health.medianSessionSeconds)}
            sub="authenticated sessions"
          />
          <Stat
            label="Sessions / active firm"
            value={data.health.sessionsPerActiveFirm ?? "—"}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Workflow performance · 30 days
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          <Stat
            label="Tracked case starts"
            value={data.workflow.caseStarts}
            sub="PostHog case_created"
          />
          <Stat
            label="Product cases"
            value={data.workflow.productCases30d}
            tone="good"
            sub="reconciled · 30d"
          />
          <Stat
            label="Form / CSV intakes"
            value={data.workflow.intakeCases30d}
            sub="reconciled · 30d"
          />
          <Stat
            label="Case completion rate"
            value={percent(data.workflow.caseCompletionRate)}
            tone={data.workflow.caseCompletionRate !== null && data.workflow.caseCompletionRate >= 70 ? "good" : "warn"}
            sub="report completed / case started"
          />
          <Stat
            label="Median time to submit"
            value={duration(data.workflow.medianTimeToSubmitSeconds)}
            sub="proxy: first upload after start"
          />
          <Stat
            label="Analysis view rate"
            value={percent(data.workflow.analysisViewRate)}
            sub="report page viewed after completion"
          />
          <Stat
            label="Report download rate"
            value={percent(data.workflow.reportDownloadRate)}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Product funnel · 30 days
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Login → report downloaded" />
            <div className="p-4">
              <FunnelChart data={data.funnel.map((step) => ({
                label: step.label,
                count: step.count,
              }))} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Funnel conversion" />
            <Table
              headers={["Stage", "Users", "From previous"]}
              rows={data.funnel.map((step) => [
                step.label,
                String(step.count),
                step.conversion === null ? "—" : `${step.conversion}%`,
              ])}
            />
          </Card>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Account engagement · 30 days
        </h2>
        <Card>
          <CardHeader
            title="Product engagement by firm"
            action={<Badge tone="blue">{data.firms.length} firms</Badge>}
          />
          <Table
            headers={[
              "Firm", "Last product activity", "Active users", "Sessions",
              "Tracked starts", "Product cases", "Form intakes", "Total cases",
              "Reports viewed", "Health",
            ]}
            rows={data.firms.map((firm) => [
              firm.companyId ? (
                <Link
                  key="firm"
                  href={`/firms/${firm.companyId}`}
                  className="font-medium hover:underline"
                >
                  {firm.firm}
                </Link>
              ) : (
                <span key="firm" className="font-medium">{firm.firm}</span>
              ),
              firm.lastActive
                ? new Date(firm.lastActive).toLocaleDateString()
                : <span key="inactive" className="text-zinc-400">No product activity</span>,
              String(firm.activeUsers),
              String(firm.sessions30d),
              String(firm.casesStarted),
              String(firm.productCases30d),
              String(firm.intakeCases30d),
              String(firm.totalCases30d),
              String(firm.reportsViewed),
              <span key="health" title={firm.healthReason}>
                <Badge tone={HEALTH_TONE[firm.health]}>
                  {firm.health.replace("_", " ")}
                </Badge>
                <span className="ml-2 text-xs text-zinc-400">{firm.healthReason}</span>
              </span>,
            ])}
          />
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Friction and errors · 30 days
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Stat label="Failed login rate" value="—" sub="Not instrumented" />
          <Stat label="Forgot-password requests" value="—" sub="Not instrumented" />
          <Stat label="Upload failure rate" value="—" sub="Not instrumented" />
          <Stat label="Submission errors" value="—" sub="Not instrumented" />
          <Stat
            label="Users with repeated errors"
            value={data.friction.repeatedErrorUsers}
            tone={data.friction.repeatedErrorUsers ? "bad" : "good"}
            sub="2+ report-generation failures"
          />
          <Stat
            label="Report-generation failure"
            value={percent(data.friction.reportGenerationFailureRate)}
            tone={data.friction.reportGenerationFailureRate ? "bad" : "good"}
            sub="distinct failed / attempted cases"
          />
        </div>
      </section>

      <Card>
        <CardHeader title="Instrumentation required for complete product analytics" />
        <ul className="list-disc space-y-1 px-8 py-4 text-sm text-zinc-600 dark:text-zinc-300">
          {data.instrumentationNotes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      </Card>

      <p className="text-xs text-zinc-400">
        Generated {new Date(data.generatedAt).toLocaleString()}. Reload this page to query
        PostHog again; the global Refresh button also refreshes HubSpot/case rollups.
      </p>
    </div>
  );
}
