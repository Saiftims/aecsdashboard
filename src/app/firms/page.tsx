import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Badge, Button, Card, CardBody, CardHeader, PageHeader, Table, healthTone, inputCls,
} from "@/components/ui";
import { supabaseService, currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function FirmsPage({
  searchParams,
}: {
  searchParams: Promise<{ health?: string; active?: string; q?: string }>;
}) {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  const params = await searchParams;

  const sb = supabaseService();
  let query = sb.from("companies").select("*").order("cases_lifetime", { ascending: false });
  if (params.health) query = query.eq("health_category", params.health);
  const { data: companies } = await query;

  let rows = companies ?? [];
  if (params.q) {
    const q = params.q.toLowerCase();
    rows = rows.filter(
      (c) => (c.name ?? "").toLowerCase().includes(q) || (c.domain ?? "").includes(q),
    );
  }
  if (params.active === "yes") rows = rows.filter((c) => c.cases_30d > 0);
  if (params.active === "no") rows = rows.filter((c) => c.cases_30d === 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Firms" />

      <Card>
        <CardBody className="p-3">
          <form className="flex flex-wrap items-center gap-2" action="/firms">
            <div className="min-w-48 flex-1">
              <input name="q" placeholder="Search firms..." defaultValue={params.q ?? ""} className={inputCls} />
            </div>
            <div className="w-full sm:w-44">
              <select name="health" defaultValue={params.health ?? ""} className={inputCls}>
                <option value="">Any health</option>
                <option value="green">Green</option>
                <option value="yellow">Yellow</option>
                <option value="red">Red</option>
              </select>
            </div>
            <div className="w-full sm:w-48">
              <select name="active" defaultValue={params.active ?? ""} className={inputCls}>
                <option value="">Active + inactive</option>
                <option value="yes">Active (case in 30d)</option>
                <option value="no">Inactive</option>
              </select>
            </div>
            <Button type="submit">Filter</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`${rows.length} firms`} />
        <Table
          headers={[
            "Firm",
            "Health",
            "Cases (30d)",
            { label: "Lifetime", align: "right" },
            "Last case",
            { label: "Est. revenue", align: "right" },
            "Trend",
          ]}
          rows={rows.map((c) => [
            <Link key="l" href={`/firms/${c.hubspot_id}`} className="font-medium hover:underline">
              {c.name ?? c.domain ?? c.hubspot_id}
            </Link>,
            c.health_score !== null ? (
              <Badge key="h" tone={healthTone(c.health_category)}>
                {c.health_score} {c.health_category}
              </Badge>
            ) : (
              <span key="h" className="text-zinc-400">-</span>
            ),
            String(c.cases_30d),
            String(c.cases_lifetime),
            c.last_case_at ? new Date(c.last_case_at).toLocaleDateString() : "-",
            `$${Math.round(c.est_revenue).toLocaleString()}`,
            c.usage_trend ?? "-",
          ])}
        />
      </Card>
    </div>
  );
}
