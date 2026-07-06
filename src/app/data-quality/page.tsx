import { redirect } from "next/navigation";
import { Badge, Card, CardHeader } from "@/components/ui";
import { dataQuality } from "@/lib/queries";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DataQualityPage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  const { checks } = await dataQuality();
  const issues = checks.filter((c) => c.count > 0);
  const clean = checks.filter((c) => c.count === 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Data Quality</h1>
        <Badge tone={issues.length ? "red" : "green"}>
          {issues.length ? `${issues.length} checks failing` : "All checks passing"}
        </Badge>
      </div>
      <p className="text-sm text-zinc-500">
        Non-negotiable rule: every open lead, deal and customer account must have an
        owner, a stage, a next step and a next-step date.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {issues.map((c) => (
          <Card key={c.label}>
            <CardHeader title={c.label} action={<Badge tone="red">{c.count}</Badge>} />
            <ul className="max-h-56 divide-y divide-zinc-100 overflow-y-auto text-sm dark:divide-zinc-800">
              {c.items.map((it) => (
                <li key={it.id} className="px-4 py-1.5">{it.name}</li>
              ))}
              {c.count > c.items.length ? (
                <li className="px-4 py-1.5 text-xs text-zinc-400">
                  +{c.count - c.items.length} more
                </li>
              ) : null}
            </ul>
          </Card>
        ))}
      </div>

      {clean.length ? (
        <Card>
          <CardHeader title="Passing checks" />
          <div className="flex flex-wrap gap-2 p-4">
            {clean.map((c) => (
              <Badge key={c.label} tone="green">{c.label}</Badge>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
