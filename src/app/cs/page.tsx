import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionQueue } from "@/components/action-queue";
import { Badge, Card, CardHeader, Stat, Table } from "@/components/ui";
import { csDashboard, type CsSegment } from "@/lib/queries";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SEGMENTS: { id: CsSegment; label: string }[] = [
  { id: "all", label: "All" },
  { id: "small", label: "Small" },
  { id: "mid_size", label: "Mid-size" },
  { id: "large", label: "Large" },
  { id: "strategic", label: "Strategic" },
];

const HEALTH_TONE: Record<string, "green" | "yellow" | "red" | "default"> = {
  healthy: "green", activated: "green", active_below_target: "yellow",
  awaiting_first_case: "yellow", new_handoff: "default", at_risk: "red", churned: "red",
};

function healthLabel(h: string | null): string {
  return (h ?? "-").replace(/_/g, " ");
}

export default async function CsPage({
  searchParams,
}: {
  searchParams: Promise<{ segment?: string }>;
}) {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role === "ae") redirect("/ae");

  const params = await searchParams;
  const segment = (SEGMENTS.some((s) => s.id === params.segment)
    ? params.segment : "all") as CsSegment;

  const { metrics, board, queue } = await csDashboard(segment);
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Customer Success</h1>
        <div className="flex gap-1">
          {SEGMENTS.map((s) => (
            <Link
              key={s.id}
              href={s.id === "all" ? "/cs" : `/cs?segment=${s.id}`}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                segment === s.id
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "border border-zinc-300 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Accounts</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <Stat label="Activated firms" value={metrics.activatedFirms} tone="good" href="/drill/cs_activated" />
          <Stat label="Healthy" value={metrics.healthyFirms} tone="good" href="/drill/cs_healthy" />
          <Stat label="Active below target" value={metrics.activeBelowTarget} tone="warn" href="/drill/cs_below_target" />
          <Stat label="At risk" value={metrics.atRiskFirms} tone={metrics.atRiskFirms ? "bad" : "good"} href="/drill/cs_at_risk" />
          <Stat label="Churned" value={metrics.churnedFirms} tone={metrics.churnedFirms ? "bad" : "good"} href="/drill/cs_churned" />
          <Stat label="Reactivation" value={metrics.reactivationInProgress} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Usage & revenue</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <Stat label="Cases this month" value={metrics.casesThisMonth} />
          <Stat label="Revenue this month" value={money(metrics.revenueThisMonth)} tone="good" />
          <Stat label="Monthly active firms" value={`${metrics.monthlyActiveFirms}/${metrics.totalCustomers}`} />
          <Stat label="Target attainment (avg)" value={metrics.targetAttainmentAvg === null ? "-" : `${metrics.targetAttainmentAvg}%`} />
          <Stat label="2nd-case conversion" value={metrics.secondCaseConversionRate === null ? "-" : `${metrics.secondCaseConversionRate}%`} />
          <Stat label="Avg days to first case" value={metrics.avgDaysToFirstCase === null ? "-" : `${metrics.avgDaysToFirstCase}d`} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Expert reviews</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label="Offered" value={metrics.expertReviewsOffered} href="/drill/cs_expert_missing" />
          <Stat label="Booked" value={metrics.expertReviewsBooked} />
          <Stat label="Completed" value={metrics.expertReviewsCompleted} tone="good" />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ActionQueue title="Today's CS priorities" items={queue} />

        <Card>
          <CardHeader title="Account health board" action={<Badge>{board.length} firms</Badge>} />
          <Table
            headers={["Firm", "Seg", "Target", "MTD", "30d", "Attain", "Last case", "Days", "Health", "Issues", "Review", "Next action"]}
            rows={board.map((r) => [
              <Link key="f" href={`/firms/${r.companyId}`} className="font-medium hover:underline">{r.firm}</Link>,
              r.segment ? r.segment.replace("_", " ") : "-",
              r.monthlyTarget ?? "-",
              String(r.casesThisMonth),
              String(r.cases30d),
              r.attainment === null ? "-" : `${r.attainment}%`,
              r.lastCaseDate ? new Date(r.lastCaseDate).toLocaleDateString() : "-",
              r.daysSinceLastCase ?? "-",
              <Badge key="h" tone={HEALTH_TONE[r.health ?? ""] ?? "default"}>{healthLabel(r.health)}</Badge>,
              r.openIssues || "-",
              r.expertReviewMissing ? <Badge key="r" tone="red">missing</Badge> : "-",
              r.nextAction
                ? <span>{r.nextAction}{r.nextActionDue ? <span className="text-xs text-zinc-400"> ({r.nextActionDue.slice(0, 10)})</span> : null}</span>
                : <span className="text-zinc-400">none set</span>,
            ])}
          />
        </Card>
      </div>
    </div>
  );
}
