import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, Empty, PageHeader, Pills, Stat, StatGrid, Table } from "@/components/ui";
import {
  caseUiReport, PORT_DATE, UI_SHOWS, UI_WINDOWS, viewFirms,
  type PortReviewInfo, type ReviewState, type Ui, type UiCase, type UiFirm, type UiShow, type UiSort, type UiVerdict, type UiWindow,
} from "@/lib/case-ui";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })
  : "—");
const dayOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");
/** Calendar day in Pacific time, as a UTC-midnight epoch, so "today" and
 * "yesterday" follow the CS rep's calendar rather than 24-hour blocks - a
 * review at 4 pm PT yesterday read "today" at 8 am the next morning. */
const ptDay = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(d).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day);
};
const ago = (iso: string | null, now: Date) => {
  if (!iso) return "never";
  const d = Math.round((ptDay(now) - ptDay(new Date(iso))) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d}d ago` : d < 365 ? `${Math.floor(d / 30)}mo ago` : `${Math.floor(d / 365)}y ago`;
};
const firstName = (email: string | null) => {
  const local = (email ?? "").split("@")[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1).replace(/[._+].*$/, "") : null;
};
const signed = (n: number | null) => (n === null ? "—" : n > 0 ? `+${n}` : String(n));

function VerdictBadge({ v, lastUi }: { v: UiVerdict; lastUi: Ui | null }) {
  if (v === "new") return <Badge tone="green">New UI</Badge>;
  if (v === "old") return <Badge tone="red">Old UI</Badge>;
  if (v === "both") return <Badge tone="yellow">Mixed · last {lastUi === "v1" ? "old" : "new"}</Badge>;
  return <Badge>Not seen yet</Badge>;
}

function ReviewBadge({ state, review, now }: { state: ReviewState; review: PortReviewInfo | null; now: Date }) {
  if (state === "reviewed" && review) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Badge tone="green">Reviewed · send</Badge>
        <span className="text-xs text-zinc-500" title={`${when(review.at)} PT`}>
          {ago(review.at, now)}{firstName(review.by) ? ` by ${firstName(review.by)}` : ""}
        </span>
      </span>
    );
  }
  if (state === "awaiting") return <Badge tone="yellow">Awaiting review</Badge>;
  return <Badge>Native new UI</Badge>;
}

/** What the port changed in the assessment: overall before → after, with the
 * per-score deltas on hover. Red when the overall score fell - the rep should
 * know before the call. */
function Scores({ r }: { r: PortReviewInfo }) {
  if (r.overallBefore === null && r.overallAfter === null) return <span className="text-xs text-zinc-400">—</span>;
  const delta = r.overallDelta ?? ((r.overallAfter ?? 0) - (r.overallBefore ?? 0));
  const tone = delta > 0 ? "text-emerald-600 dark:text-emerald-400" : delta < 0 ? "text-red-600 dark:text-red-400" : "text-zinc-500";
  const title = [
    `Liability ${signed(r.liabilityDelta)}`, `Crash severity ${signed(r.crashSeverityDelta)}`,
    `Injury causation ${signed(r.injuryCausationDelta)}`, `Evidence integrity ${signed(r.evidenceIntegrityDelta)}`,
    r.injurySynopses ? `${r.injurySynopses} injury synops${r.injurySynopses === 1 ? "is" : "es"} written` : null,
    r.reconstructionTexts ? "Reconstruction texts written" : null,
    r.reviews > 1 ? `Marked reviewed ${r.reviews} times` : null,
  ].filter(Boolean).join(" · ");
  return (
    <span className="whitespace-nowrap text-xs tabular-nums" title={title}>
      <span className="text-zinc-500">{r.overallBefore ?? "—"}</span>
      <span className="mx-1 text-zinc-400">→</span>
      <span className="font-medium text-zinc-800 dark:text-zinc-100">{r.overallAfter ?? "—"}</span>
      <span className={`ml-1.5 ${tone}`}>({signed(delta)})</span>
      {r.warnings ? <span className="ml-2 text-amber-600 dark:text-amber-400" title={`${r.warnings} warning${r.warnings === 1 ? "" : "s"} on the port`}>⚠ {r.warnings}</span> : null}
    </span>
  );
}

/** Share of a firm's cases by review state, as a thin bar. */
function Split({ counts }: { counts: UiFirm["counts"] }) {
  const total = counts.reviewed + counts.awaiting + counts.native || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex h-1.5 w-28 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" title={`${counts.reviewed} reviewed · ${counts.awaiting} awaiting review · ${counts.native} created after the port`}>
      <div className="bg-emerald-500" style={{ width: pct(counts.reviewed) }} />
      <div className="bg-amber-400" style={{ width: pct(counts.awaiting) }} />
    </div>
  );
}

/** Link-based pill items for one query parameter, keeping the others. */
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
  const sp = await searchParams;
  const show = (UI_SHOWS.some((s) => s.id === sp.show) ? sp.show : "reviewed") as UiShow;
  const window = (UI_WINDOWS.some((w) => w.id === sp.active) ? sp.active : "all") as UiWindow;
  const sort: UiSort = sp.sort === "status" ? "status" : sp.sort === "recent" ? "recent" : "reviewed";
  const now = new Date();
  const r = await caseUiReport();
  const firms = viewFirms(r, window, sort, show, now);
  const real = firms.filter((f) => f.companyId);
  const shownCases = firms.flatMap((f) => f.cases);
  const n = (v: UiVerdict) => shownCases.filter((c) => c.verdict === v).length;
  const windowLabel = UI_WINDOWS.find((w) => w.id === window)!.label.toLowerCase();

  const FirmRow = ({ f }: { f: UiFirm }) => (
    <details className={`group border-b border-zinc-100 last:border-0 dark:border-zinc-800/60 ${f.counts.reviewed ? "" : "opacity-80"}`} open={show === "reviewed"}>
      <summary className="flex cursor-pointer list-none items-center gap-4 px-4 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
        <span className="w-3 text-xs text-zinc-400 transition-transform group-open:rotate-90">▶</span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-zinc-800 dark:text-zinc-100">
            {f.companyId ? <Link href={`/firms/${f.companyId}`} className="hover:underline">{f.name}</Link> : f.name}
          </span>
          <span className="ml-2 text-xs text-zinc-500">
            {f.cases.length === 0 ? "signed up, no case yet" : `${f.cases.length} case${f.cases.length === 1 ? "" : "s"}`}
            {f.counts.reviewed ? <> · <span className="font-medium text-emerald-600 dark:text-emerald-400">{f.counts.reviewed} reviewed</span></> : null}
            {f.counts.awaiting ? ` · ${f.counts.awaiting} awaiting review` : ""}
          </span>
        </span>
        <Split counts={f.counts} />
        <span className="w-44 text-right text-xs text-zinc-500" title={f.lastReviewAt ? `${when(f.lastReviewAt)} PT` : f.lastActivity ? `${when(f.lastActivity)} PT` : undefined}>
          {f.lastReviewAt
            ? <>reviewed <span className="font-medium text-zinc-700 dark:text-zinc-300">{ago(f.lastReviewAt, now)}</span></>
            : f.lastActivity ? <>active <span className="font-medium text-zinc-700 dark:text-zinc-300">{ago(f.lastActivity, now)}</span></> : "no activity recorded"}
        </span>
        <span className="w-36 text-right"><VerdictBadge v={f.verdict} lastUi={f.lastUi} /></span>
      </summary>
      {f.cases.length > 0 && (
        <div className="bg-zinc-50/60 pb-2 pl-7 dark:bg-zinc-800/30">
          <Table
            dense
            headers={["Case", "Submitted", "Port review", "Score before → after", "Firm last opened", { label: "UI", align: "right" }]}
            rows={f.cases.map((c: UiCase) => [
              <span key="case">
                <span className="font-medium">{c.name ?? "Untitled case"}</span>
                <span className="ml-2 font-mono text-[11px] text-zinc-400">{c.caseId.replace(/^case_/, "").slice(0, 8)}</span>
              </span>,
              <span key="sub" className="tabular-nums text-zinc-500">{dayOf(c.submitted)}</span>,
              <ReviewBadge key="rev" state={c.reviewState} review={c.review} now={now} />,
              c.review ? <Scores key="sc" r={c.review} /> : <span key="sc" className="text-xs text-zinc-400">—</span>,
              <span key="last" className="text-xs text-zinc-500" title={c.lastActivity ? `${when(c.lastActivity)} PT` : undefined}>
                {ago(c.lastActivity, now)}
                {c.v1 || c.v2 ? <span className="ml-1 text-zinc-400">({c.v2 ? `${c.v2} new` : ""}{c.v2 && c.v1 ? " · " : ""}{c.v1 ? `${c.v1} old` : ""})</span> : null}
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
        eyebrow={<><Link href="/product" className="hover:underline">Product</Link> › New UI port</>}
        title="New UI port review"
        description={<>
          Every case was moved to the new UI in bulk on {dayOf(PORT_DATE)} and is being checked by hand. A case marked
          reviewed (<code>ui_port_reviewed</code>) is ready to go back to the firm: call them and send the re-processed
          case. Cases created after the port were born in the new UI and need no review.
          {r.reviewsSyncedAt ? ` Reviews updated ${when(r.reviewsSyncedAt)} PT.` : ""}
        </>}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500">
        <span className="flex items-center gap-2">Show <Pills items={pillItems(show, UI_SHOWS, "show", { active: window, sort })} /></span>
        <span className="flex items-center gap-2">Active <Pills items={pillItems(window, UI_WINDOWS, "active", { show, sort })} /></span>
        <span className="flex items-center gap-2">Sort <Pills items={pillItems(sort, [{ id: "reviewed", label: "Recently reviewed" }, { id: "recent", label: "Most active" }, { id: "status", label: "Old UI first" }], "sort", { show, active: window })} /></span>
        <span className="ml-auto">{real.length} firm{real.length === 1 ? "" : "s"} · {shownCases.length} case{shownCases.length === 1 ? "" : "s"}{window !== "all" ? ` active ${windowLabel}` : ""}</span>
      </div>

      <StatGrid cols={5}>
        <Stat label="Firms to call" value={String(r.totals.firmsToCall)} tone={r.totals.firmsToCall ? "good" : undefined} sub="have a reviewed case to send" />
        <Stat label="Cases reviewed" value={String(r.totals.reviewed)} tone="good" sub="ready to send to the firm" />
        <Stat label="Awaiting review" value={String(r.totals.awaiting)} tone={r.totals.awaiting ? "warn" : "good"} sub="ported, not yet checked" />
        <Stat label="Firms on new UI" value={String(r.totals.firmsOnNew)} sub="last activity was in v2" />
        <Stat label="Firms still on old UI" value={String(r.totals.firmsOnOld)} tone={r.totals.firmsOnOld ? "bad" : "good"} sub={`${n("old")} case${n("old") === 1 ? "" : "s"} last opened in v1`} />
      </StatGrid>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2.5 text-xs text-zinc-500 dark:border-zinc-800">
          <span>
            {show === "reviewed" ? "Firms with a reviewed case, most recent review first - the call list."
              : show === "awaiting" ? "Firms with ported cases still waiting for review."
              : sort === "status" ? "Firms still on the old UI first, then mixed, then new, then not seen."
              : sort === "reviewed" ? "Most recently reviewed firms first." : "Most recently active firms first."}
            {" "}Click a firm to see its cases.
          </span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> reviewed</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-amber-400" /> awaiting review</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-700" /> created after the port</span>
          </span>
        </div>
        {firms.length === 0
          ? <Empty>{show === "reviewed" ? "No reviewed case yet." : show === "awaiting" ? "Nothing awaiting review." : `No firm was active ${windowLabel}.`}</Empty>
          : firms.map((f) => <FirmRow key={f.companyId ?? f.name} f={f} />)}
      </Card>

      <p className="text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
        &quot;Score before → after&quot; is the case assessment&apos;s overall score before and after the port; hover for the
        liability, crash severity, injury causation and evidence integrity changes. A firm&apos;s UI badge is decided by its
        own people&apos;s activity (PostHog&apos;s <code>case_ui</code> flag, since {dayOf(r.since + "T00:00:00Z")}); staff
        opening a case does not move it.
        {r.staffOnly.cases
          ? ` ${r.staffOnly.cases} further case${r.staffOnly.cases === 1 ? "" : "s"} belonging to no firm ${r.staffOnly.cases === 1 ? "has" : "have"} only ever been opened by staff${r.staffOnly.reviewed ? ` (${r.staffOnly.reviewed} of them reviewed)` : ""} - demo builds, left out above.`
          : ""}
      </p>
    </div>
  );
}
