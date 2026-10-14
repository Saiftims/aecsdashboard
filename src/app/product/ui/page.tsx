import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, Stat } from "@/components/ui";
import { caseUiReport, type UiFirm, type UiVerdict } from "@/lib/case-ui";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })
  : "—");
const dayOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");

function VerdictBadge({ v, lastUi }: { v: UiVerdict; lastUi: "v1" | "v2" }) {
  if (v === "new") return <Badge tone="green">New UI</Badge>;
  if (v === "old") return <Badge tone="red">Old UI</Badge>;
  return <Badge tone="yellow">Mixed · last {lastUi === "v1" ? "old" : "new"}</Badge>;
}

/** Share of a firm's cases on each UI, as a thin two-tone bar. */
function Split({ counts }: { counts: UiFirm["counts"] }) {
  const total = counts.new + counts.old + counts.both || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex h-1.5 w-28 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" title={`${counts.new} new · ${counts.old} old · ${counts.both} both`}>
      <div className="bg-emerald-500" style={{ width: pct(counts.new) }} />
      <div className="bg-amber-400" style={{ width: pct(counts.both) }} />
      <div className="bg-red-500" style={{ width: pct(counts.old) }} />
    </div>
  );
}

export default async function CaseUiPage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role === "ae") redirect("/ae");
  const r = await caseUiReport();
  const onOld = r.firms.filter((f) => f.lastUi === "v1");
  const onNew = r.firms.filter((f) => f.lastUi === "v2");

  const FirmRow = ({ f }: { f: UiFirm }) => (
    <details className="group border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
      <summary className="flex cursor-pointer list-none items-center gap-4 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
        <span className="w-3 text-xs text-zinc-400 transition-transform group-open:rotate-90">▶</span>
        <span className="min-w-0 flex-1">
          <span className="font-medium">
            {f.companyId ? <Link href={`/firms/${f.companyId}`} className="hover:underline">{f.name}</Link> : f.name}
          </span>
          <span className="ml-2 text-xs text-zinc-500">{f.cases.length} case{f.cases.length === 1 ? "" : "s"}</span>
        </span>
        <Split counts={f.counts} />
        <span className="w-40 text-right text-xs text-zinc-500">last active {when(f.lastAt)}</span>
        <span className="w-36 text-right"><VerdictBadge v={f.verdict} lastUi={f.lastUi} /></span>
      </summary>
      <div className="bg-zinc-50/60 px-4 pb-3 pt-1 dark:bg-zinc-900/30">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-400">
              <th className="py-1 pl-7 font-medium">Case</th>
              <th className="py-1 font-medium">Submitted</th>
              <th className="py-1 font-medium">Customer activity</th>
              <th className="py-1 font-medium">Last used</th>
              <th className="py-1 text-right font-medium">UI</th>
            </tr>
          </thead>
          <tbody>
            {f.cases.map((c) => (
              <tr key={c.caseId} className="border-t border-zinc-100 dark:border-zinc-800/60">
                <td className="py-1.5 pl-7">
                  <span className="font-medium">{c.name ?? "Untitled case"}</span>
                  <span className="ml-2 font-mono text-[11px] text-zinc-400">{c.caseId.replace(/^case_/, "").slice(0, 8)}</span>
                </td>
                <td className="py-1.5 tabular-nums text-zinc-500">{dayOf(c.submitted)}</td>
                <td className="py-1.5 text-xs text-zinc-500">
                  {c.v2 ? <span className="text-emerald-600">{c.v2} new</span> : null}
                  {c.v2 && c.v1 ? " · " : null}
                  {c.v1 ? <span className="text-red-600">{c.v1} old</span> : null}
                  {c.staffLastUi ? <span className="ml-2 text-zinc-400">staff on {c.staffLastUi === "v1" ? "old" : "new"}</span> : null}
                </td>
                <td className="py-1.5 text-xs text-zinc-500">{when(c.lastAt)}</td>
                <td className="py-1.5 text-right"><VerdictBadge v={c.verdict} lastUi={c.lastUi} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-zinc-500"><Link href="/product" className="hover:underline">Product</Link> › UI migration</div>
        <h1 className="text-2xl font-bold">Old UI vs new UI</h1>
        <p className="text-sm text-zinc-500">
          Which firms and cases are still worked in the old case UI (v1) and which have moved to the new one (v2),
          from PostHog&apos;s <code>case_ui</code> flag. Tracking began {dayOf(r.since + "T00:00:00Z")}; only cases
          opened since then can be placed.
          {r.syncedAt ? ` Updated ${when(r.syncedAt)} PT.` : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Firms on new UI" value={String(onNew.length)} tone="good" sub="last activity was in v2" />
        <Stat label="Firms still on old UI" value={String(onOld.length)} tone={onOld.length ? "bad" : "good"} sub="last activity was in v1" />
        <Stat label="Cases on new UI" value={String(r.totals.new)} sub={r.totals.both ? `+${r.totals.both} seen in both` : "customer activity since launch"} />
        <Stat label="Cases on old UI" value={String(r.totals.old)} tone={r.totals.old ? "warn" : undefined} sub="customer activity since launch" />
      </div>

      <Card>
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
          <span>Firms still on the old UI first, then by most recent activity. Click a firm to see its cases.</span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> new</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-amber-400" /> both</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-red-500" /> old</span>
          </span>
        </div>
        {r.firms.length === 0
          ? <p className="px-4 py-6 text-center text-sm text-zinc-500">No customer has opened a case since tracking began.</p>
          : r.firms.map((f) => <FirmRow key={f.companyId ?? f.name} f={f} />)}
      </Card>

      <p className="text-xs text-zinc-400">
        {r.staffOnly.cases} further case{r.staffOnly.cases === 1 ? " has" : "s have"} only been opened by Silent Witness staff
        since tracking began ({r.staffOnly.v2} in the new UI, {r.staffOnly.v1} in the old) - analyst work and demo builds,
        not customer adoption, so they are left out above. A firm&apos;s UI is decided by its own people&apos;s activity;
        staff opening a case in the new UI does not move the firm.
      </p>
    </div>
  );
}
