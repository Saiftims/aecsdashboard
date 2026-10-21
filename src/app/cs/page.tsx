import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionQueue } from "@/components/action-queue";
import {
  Badge, Card, CardHeader, Cell, PageHeader, Pills, Section, Stat, StatGrid, Table,
} from "@/components/ui";
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
      <PageHeader
        title="Customer Success"
        actions={
          <Pills
            items={SEGMENTS.map((s) => ({
              key: s.id,
              label: s.label,
              active: segment === s.id,
              href: s.id === "all" ? "/cs" : `/cs?segment=${s.id}`,
            }))}
          />
        }
      />

      <Section title="Accounts">
        <StatGrid cols={6}>
          <Stat label="Activated firms" value={metrics.activatedFirms} tone="good" href="/drill/cs_activated" />
          <Stat label="Healthy" value={metrics.healthyFirms} tone="good" href="/drill/cs_healthy" />
          <Stat label="Active below target" value={metrics.activeBelowTarget} tone="warn" href="/drill/cs_below_target" />
          <Stat label="At risk" value={metrics.atRiskFirms} tone={metrics.atRiskFirms ? "bad" : "good"} href="/drill/cs_at_risk" />
          <Stat label="Churned" value={metrics.churnedFirms} tone={metrics.churnedFirms ? "bad" : "good"} href="/drill/cs_churned" />
          <Stat label="Reactivation" value={metrics.reactivationInProgress} />
        </StatGrid>
      </Section>

      <Section title="Activation gaps">
        <StatGrid cols={3}>
          <Stat label="Signed up · no case" value={metrics.signedUpNoCase} tone={metrics.signedUpNoCase ? "warn" : "good"} href="/drill/cs_signed_up_no_case" />
          <Stat label="Case (intake) · no signup" value={metrics.caseNoSignup} tone={metrics.caseNoSignup ? "warn" : "good"} href="/drill/cs_case_no_signup" />
        </StatGrid>
      </Section>

      <Section title="Usage & revenue">
        <StatGrid cols={6}>
          <Stat label="Cases this month" value={metrics.casesThisMonth} href="/drill/cs_cases_month" />
          <Stat label="Revenue this month" value={money(metrics.revenueThisMonth)} tone="good" sub={`incl. ${money(metrics.mrr)} MRR`} href="/drill/cs_cases_month" />
          <Stat label="Monthly active firms" value={`${metrics.monthlyActiveFirms}/${metrics.totalCustomers}`} href="/drill/cs_active_firms" />
          <Stat label="Target attainment (avg)" value={metrics.targetAttainmentAvg == null ? "-" : `${metrics.targetAttainmentAvg}%`} />
          <Stat label="2nd-case conversion" value={metrics.secondCaseConversionRate == null ? "-" : `${metrics.secondCaseConversionRate}%`} />
          <Stat label="Avg days to first case" value={metrics.avgDaysToFirstCase == null ? "-" : `${metrics.avgDaysToFirstCase}d`} />
        </StatGrid>
      </Section>

      <Section title="Expert reviews">
        <StatGrid cols={3}>
          <Stat label="Offered" value={metrics.expertReviewsOffered} href="/drill/cs_expert_missing" />
          <Stat label="Booked" value={metrics.expertReviewsBooked} />
          <Stat label="Completed" value={metrics.expertReviewsCompleted} tone="good" />
        </StatGrid>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ActionQueue title="Today's CS priorities" items={queue} />

        <Card>
          <CardHeader title="Account health board" action={<Badge>{board.length} firms</Badge>} />
          <Table
            dense
            headers={[
              "Firm",
              "Seg",
              { label: "Target", align: "right" },
              { label: "MTD", align: "right" },
              { label: "30d", align: "right" },
              { label: "Attain", align: "right" },
              "Last case",
              { label: "Days", align: "right" },
              "Health",
              { label: "Issues", align: "right" },
              "Review",
              "Next action",
            ]}
            rows={board.map((r) => [
              <Link key="f" href={`/firms/${r.companyId}`} className="font-medium hover:underline">{r.firm}</Link>,
              r.segment ? r.segment.replace("_", " ") : "-",
              r.monthlyTarget ?? "-",
              String(r.casesThisMonth ?? 0),
              String(r.cases30d ?? 0),
              r.attainment == null ? "-" : `${r.attainment}%`,
              r.lastCaseDate ? new Date(r.lastCaseDate).toLocaleDateString() : "-",
              r.daysSinceLastCase ?? "-",
              <Badge key="h" tone={HEALTH_TONE[r.health ?? ""] ?? "default"}>{healthLabel(r.health)}</Badge>,
              r.openIssues || "-",
              r.expertReviewMissing ? <Badge key="r" tone="red">missing</Badge> : "-",
              r.nextAction
                ? <Cell key="n" sub={r.nextActionDue ? r.nextActionDue.slice(0, 10) : undefined}>{r.nextAction}</Cell>
                : <span key="n" className="text-zinc-400">none set</span>,
            ])}
          />
        </Card>
      </div>
    </div>
  );
}
