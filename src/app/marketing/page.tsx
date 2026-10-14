import { redirect } from "next/navigation";
import { MarketingAds } from "@/components/marketing-ads";
import { marketingReport, type MarketingRange } from "@/lib/marketing";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const RANGES: { key: MarketingRange; label: string }[] = [
  { key: "7d", label: "7 days" }, { key: "14d", label: "14 days" }, { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" }, { key: "all", label: "All time" },
];

function monthOptions(now: Date): { key: MarketingRange; label: string }[] {
  const out: { key: MarketingRange; label: string }[] = [];
  for (let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); d >= new Date("2026-05-01T00:00:00Z");
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))) {
    out.push({ key: d.toISOString().slice(0, 7) as MarketingRange, label: d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) });
  }
  return out;
}

export default async function MarketingPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role !== "executive") redirect("/");
  const sp = await searchParams;
  const range = (sp.range && /^(\d+d|all|\d{4}-\d{2})$/.test(sp.range) ? sp.range : "30d") as MarketingRange;
  const now = new Date();
  const report = await marketingReport(range, now);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Marketing</h1>
          <p className="text-sm text-zinc-500">
            Every ad in the Meta account with its creative and {report.rangeLabel.toLowerCase()} performance.
            {report.syncedAt ? ` Synced ${new Date(report.syncedAt).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" })}.` : ""}
          </p>
        </div>
      </div>
      <MarketingAds report={report} ranges={[...RANGES, ...monthOptions(now)]} />
    </div>
  );
}
