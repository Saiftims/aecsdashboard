import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Card, CardHeader, Table } from "@/components/ui";
import { drill } from "@/lib/drill";
import { hubspotDealUrl } from "@/lib/hubspot/stages";
import { loadSettings } from "@/lib/settings";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DrillPage({
  params,
}: {
  params: Promise<{ metric: string }>;
}) {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  const { metric } = await params;

  // AEs see their own records, same scoping as their dashboard.
  const result = await drill(metric, user.role === "ae" ? user.hubspot_owner_id : null);
  if (!result) notFound();
  const settings = await loadSettings();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{result.label}</h1>
        <Badge tone="blue">{result.rows.length} records</Badge>
      </div>

      <Card>
        <CardHeader title="Related records" />
        <Table
          headers={["Record", "Detail", "When", "Next step", "Links"]}
          rows={result.rows.map((r) => [
            r.companyId ? (
              <Link key="t" href={`/firms/${r.companyId}`} className="font-medium hover:underline">
                {r.title}
              </Link>
            ) : (
              <span key="t" className="font-medium">{r.title}</span>
            ),
            r.subtitle ?? "-",
            r.when ? new Date(r.when).toLocaleDateString() : "-",
            r.nextStep ? (
              <span key="n">
                {r.nextStep}
                {r.nextStepDate ? (
                  <span className="text-xs text-zinc-400"> (by {r.nextStepDate})</span>
                ) : null}
              </span>
            ) : (
              <span key="n" className="text-zinc-400">none set</span>
            ),
            <span key="l" className="space-x-2 text-xs">
              {r.companyId ? (
                <Link href={`/firms/${r.companyId}`} className="text-blue-600 hover:underline">
                  Account
                </Link>
              ) : null}
              {r.dealId ? (
                <a
                  href={hubspotDealUrl(settings.hubspotPortalId, r.dealId)}
                  target="_blank" rel="noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  HubSpot
                </a>
              ) : null}
            </span>,
          ])}
        />
      </Card>
      <p className="text-xs text-zinc-400">
        <Link href={user.role === "cs" ? "/cs" : "/ae"} className="hover:underline">
          &larr; Back to dashboard
        </Link>
      </p>
    </div>
  );
}
