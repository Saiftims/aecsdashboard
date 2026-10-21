import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, Empty, PageHeader, Pills, Stat, StatGrid, Table } from "@/components/ui";
import { caseUiReport, UI_WINDOWS, viewFirms, type Ui, type UiFirm, type UiSort, type UiVerdict, type UiWindow } from "@/lib/case-ui";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })
  : "—");
const dayOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");
const ago = (iso: string | null, now: Date) => {
  if (!iso) return "never";
  const d = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d}d ago` : d < 365 ? `${Math.floor(d / 30)}mo ago` : `${Math.floor(d / 365)}y ago`;
};

function VerdictBadge({ v, lastUi }: { v: UiVerdict; lastUi: Ui | null }) {
  if (v === "new") return <Badge tone="green">New UI</Badge>;
  if (v === "old") return <Badge tone="red">Old UI</Badge>;
  if (v === "both") return <Badge tone="yellow">Mixed · last {lastUi === "v1" ? "old" : "new"}</Badge>;
  return <Badge>Not seen yet</Badge>;
}

/** Share of a firm's cases on each UI, as a thin bar (grey = not opened since launch). */
function Split({ counts }: { counts: UiFirm["counts"] }) {
  const total = counts.new + counts.old + counts.both + counts.unseen || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex h-1.5 w-28 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" title={`${counts.new} new · ${counts.both} both · ${counts.old} old · ${counts.unseen} not seen since launch`}>
      <div className="bg-emerald-500" style={{ width: pct(counts.new) }} />
      <div className="bg-amber-400" style={{ width: pct(counts.both) }} />
      <div className="bg-red-500" style={{ width: pct(counts.old) }} />
    </div>
  );
}

/** Link-based pill items for one query parameter, keeping the other one. */
function pillItems<T extends string>(value: T, options: { id: T; label: string }[], param: string, other: Record<string, string>) {
  return options.map((o) => ({
    key: o.id,
    label: o.label,
    active: o.id === value,
    href: `/product/ui?${new URLSearchParams({ ...other, [param]: o.id }).toString()}`,
  }));
}

export default async function CaseUiPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role === "ae") redirect("/ae");
  const sp = await searchParams;
  const window = (UI_WINDOWS.some((w) => w.id === sp.active) ? sp.active : "all") as UiWindow;
  const sort: UiSort = sp.sort === "status" ? "status" : "recent";
  const now = new Date();
  const r = await caseUiReport();
  const firms = viewFirms(r, window, sort, now);
  const real = firms.filter((f) => f.companyId);
  const shownCases = firms.flatMap((f) => f.cases);
  const n = (v: UiVerdict) => shownCases.filter((c) => c.verdict === v).length;
  const windowLabel = UI_WINDOWS.find((w) => w.id === window)!.label.toLowerCase();

  const FirmRow = ({ f }: { f: UiFirm }) => (
    <details className={`group border-b border-zinc-100 last:border-0 dark:border-zinc-800/60 ${f.verdict === "unseen" ? "opacity-75" : ""}`}>
      <summary className="flex cursor-pointer list-none items-center gap-4 px-4 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
        <span className="w-3 text-xs text-zinc-400 transition-transform group-open:rotate-90">▶</span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-zinc-800 dark:text-zinc-100">
            {f.companyId ? <Link href={`/firms/${f.companyId}`} className="hover:underline">{f.name}</Link> : f.name}
          </span>
          <span className="ml-2 text-xs text-zinc-500">
            {f.cases.length === 0 ? "signed up, no case yet" : `${f.cases.length} case${f.cases.length === 1 ? "" : "s"}`}
            {f.counts.unseen && f.verdict !== "unseen" ? ` · ${f.counts.unseen} not opened since launch` : ""}
          </span>
        </span>
        <Split counts={f.counts} />
        <span className="w-44 text-right text-xs text-zinc-500" title={f.lastActivity ? `${when(f.lastActivity)} PT` : undefined}>
          {f.lastActivity ? <>active <span className="font-medium text-zinc-700 dark:text-zinc-300">{ago(f.lastActivity, now)}</span></> : "no activity recorded"}
        </span>
        <span className="w-36 text-right"><VerdictBadge v={f.verdict} lastUi={f.lastUi} /></span>
      </summary>
      {f.cases.length > 0 && (
        <div className="bg-zinc-50/60 pb-2 pl-7 dark:bg-zinc-800/30">
          <Table
            dense
            headers={["Case", "Submitted", "Last activity", "Since launch", { label: "UI", align: "right" }]}
            rows={f.cases.map((c) => [
              <span key="case">
                <span className="font-medium">{c.name ?? "Untitled case"}</span>
                <span className="ml-2 font-mono text-[11px] text-zinc-400">{c.caseId.replace(/^case_/, "").slice(0, 8)}</span>
              </span>,
              <span key="sub" className="tabular-nums text-zinc-500">{dayOf(c.submitted)}</span>,
              <span key="last" className="text-xs text-zinc-500" title={c.lastActivity ? `${when(c.lastActivity)} PT` : undefined}>{ago(c.lastActivity, now)}</span>,
              <span key="since" className="text-xs text-zinc-500">
                {c.v2 ? <span className="text-emerald-600 dark:text-emerald-400">{c.v2} new</span> : null}
                {c.v2 && c.v1 ? " · " : null}
                {c.v1 ? <span className="text-red-600 dark:text-red-400">{c.v1} old</span> : null}
                {!c.v1 && !c.v2 ? <span className="text-zinc-400">not opened</span> : null}
                {c.staffLastUi ? <span className="ml-2 text-zinc-400">staff on {c.staffLastUi === "v1" ? "old" : "new"}</span> : null}
              </span>,
              <VerdictBadge key="ui" v={c.verdict} lastUi={c.lastUi} />,
            ])}
          />
        </div>
      )}
    </details>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<><Link href="/product" className="hover:underline">Product</Link> › UI migration</>}
        title="Old UI vs new UI"
        description={<>
          Every firm that has used the product and every case it has had, with the UI each was last worked in
          from PostHog&apos;s <code>case_ui</code> flag. The flag only exists since {dayOf(r.since + "T00:00:00Z")}, so a
          case nobody from the firm has opened since then reads &quot;not seen yet&quot; rather than old or new.
          {r.syncedAt ? ` Updated ${when(r.syncedAt)} PT.` : ""}
        </>}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500">
        <span className="flex items-center gap-2">Active <Pills items={pillItems(window, UI_WINDOWS, "active", { sort })} /></span>
        <span className="flex items-center gap-2">Sort <Pills items={pillItems(sort, [{ id: "recent", label: "Most recent" }, { id: "status", label: "Old UI first" }], "sort", { active: window })} /></span>
        <span className="ml-auto">{real.length} firm{real.length === 1 ? "" : "s"} · {shownCases.length} case{shownCases.length === 1 ? "" : "s"} active {windowLabel}</span>
      </div>

      <StatGrid cols={5}>
        <Stat label="Firms on new UI" value={String(real.filter((f) => f.lastUi === "v2").length)} tone="good" sub="last activity was in v2" />
        <Stat label="Firms still on old UI" value={String(real.filter((f) => f.lastUi === "v1").length)} tone={real.some((f) => f.lastUi === "v1") ? "bad" : "good"} sub="last activity was in v1" />
        <Stat label="Firms not seen yet" value={String(real.filter((f) => f.verdict === "unseen").length)} sub="no case opened since launch" />
        <Stat label="Cases on new UI" value={String(n("new"))} sub={n("both") ? `+${n("both")} seen in both` : "customer activity since launch"} />
        <Stat label="Cases on old UI" value={String(n("old"))} tone={n("old") ? "warn" : undefined} sub={`${n("unseen")} not opened since launch`} />
      </StatGrid>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2.5 text-xs text-zinc-500 dark:border-zinc-800">
          <span>{sort === "status" ? "Firms still on the old UI first, then mixed, then new, then not seen." : "Most recently active firms first."} Click a firm to see its cases.</span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> new</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-amber-400" /> both</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-red-500" /> old</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-700" /> not seen</span>
          </span>
        </div>
        {firms.length === 0
          ? <Empty>No firm was active {windowLabel}.</Empty>
          : firms.map((f) => <FirmRow key={f.companyId ?? f.name} f={f} />)}
      </Card>

      <p className="text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
        A firm&apos;s UI is decided by its own people&apos;s activity; staff opening a case in the new UI does not move
        the firm, which is why a case an analyst is working can still read &quot;not seen yet&quot;. &quot;Active&quot; is the
        firm&apos;s latest customer activity in the app, signup or case submission.
        {r.staffOnly.cases
          ? ` ${r.staffOnly.cases} further case${r.staffOnly.cases === 1 ? "" : "s"} belonging to no firm ${r.staffOnly.cases === 1 ? "has" : "have"} only ever been opened by staff (${r.staffOnly.v2} new UI, ${r.staffOnly.v1} old since launch) - demo builds, left out above.`
          : ""}
      </p>
    </div>
  );
}
