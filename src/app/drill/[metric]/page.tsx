import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Card, CardHeader, Cell, Note, PageHeader, Table, TextLink } from "@/components/ui";
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
    <div className="space-y-6">
      <PageHeader
        title={result.label}
        actions={<Badge tone="blue">{result.rows.length} records</Badge>}
      />

      <Card>
        <CardHeader title="Related records" />
        <Table
          headers={["Record", "Detail", "When", "Last touch", "Next step", "Links"]}
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
            r.lastTouch
              ? <span key="lt">{r.lastTouch}</span>
              : <span key="lt" className="text-zinc-400">no touch logged</span>,
            r.nextStep ? (
              <Cell key="n" sub={r.nextStepDate ? `by ${r.nextStepDate}` : undefined}>{r.nextStep}</Cell>
            ) : (
              <span key="n" className="text-zinc-400">none set</span>
            ),
            <span key="l" className="space-x-2 text-xs">
              {r.companyId ? (
                <TextLink href={`/firms/${r.companyId}`}>Account</TextLink>
              ) : null}
              {r.dealId ? (
                <a
                  href={hubspotDealUrl(settings.hubspotPortalId, r.dealId)}
                  target="_blank" rel="noreferrer"
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  HubSpot
                </a>
              ) : null}
            </span>,
          ])}
        />
      </Card>
      <Note className="px-0 pb-0">
        <TextLink href={user.role === "cs" ? "/cs" : "/ae"}>
          &larr; Back to dashboard
        </TextLink>
      </Note>
    </div>
  );
}
