"use client";

import { clsx } from "clsx";
import { useMemo, useState } from "react";
import { Badge, Card, Stat, inputCls } from "@/components/ui";
import type { AdPerf, MarketingRange, MarketingReport } from "@/lib/marketing";

type SortKey = "spend" | "leads" | "cpl" | "ctr" | "cpc" | "cpm" | "clicks" | "impressions" | "leadRate" | "created" | "name";
type StatusFilter = "all" | "delivering" | "spent" | "paused" | "disapproved";
type View = "cards" | "table";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "spend", label: "Spend" }, { key: "leads", label: "Leads" }, { key: "cpl", label: "Cost per lead" },
  { key: "ctr", label: "CTR" }, { key: "cpc", label: "CPC" }, { key: "cpm", label: "CPM" },
  { key: "clicks", label: "Clicks" }, { key: "impressions", label: "Impressions" }, { key: "leadRate", label: "Leads / click" },
  { key: "created", label: "Newest" }, { key: "name", label: "Name" },
];
const STATUS: { key: StatusFilter; label: string }[] = [
  { key: "spent", label: "Spent in this window" }, { key: "delivering", label: "Delivering now" },
  { key: "paused", label: "Paused" }, { key: "disapproved", label: "Disapproved" }, { key: "all", label: "All ads" },
];

const usd = (n: number | null, dp = 0) => (n === null || !Number.isFinite(n) ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const num = (n: number) => n.toLocaleString("en-US");
const pct = (n: number | null, dp = 2) => (n === null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(dp)}%`);

/** Lower is better for cost metrics, so "best first" flips direction. */
const LOWER_BETTER: SortKey[] = ["cpl", "cpc", "cpm"];

function statusTone(s: string): "green" | "yellow" | "red" | "default" | "blue" {
  if (s === "ACTIVE") return "green";
  if (s === "DISAPPROVED" || s === "WITH_ISSUES") return "red";
  if (s === "PAUSED" || s === "ADSET_PAUSED" || s === "CAMPAIGN_PAUSED") return "yellow";
  if (s === "PENDING_REVIEW" || s === "IN_PROCESS") return "blue";
  return "default";
}
const statusLabel = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function Sparkline({ daily, metric }: { daily: AdPerf["daily"]; metric: "spend" | "leads" }) {
  if (daily.length < 2) return null;
  const vals = daily.map((d) => d[metric]);
  const max = Math.max(...vals, 1);
  const w = 120, h = 28;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(" ");
  return (
    <svg width={w} height={h} className="text-zinc-400" aria-label={`${metric} by day`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

function AdImage({ ad, className, thumb }: { ad: AdPerf; className?: string; thumb?: boolean }) {
  if (!ad.hasImage) {
    return <div className={clsx("flex items-center justify-center bg-zinc-100 text-xs text-zinc-400 dark:bg-zinc-800", className)}>No image</div>;
  }
  const src = `/api/marketing/image?ad=${ad.adId}${thumb ? "&thumb=1" : ""}`;
  return (
    <a href={`/api/marketing/image?ad=${ad.adId}`} target="_blank" rel="noreferrer" title="Open full-size image">
      {/* eslint-disable-next-line @next/next/no-img-element -- proxied Meta CDN image, not optimisable */}
      <img src={src} alt={ad.title ?? ad.name} loading="lazy" className={clsx("bg-zinc-100 object-contain dark:bg-zinc-800", className)} />
    </a>
  );
}

export function MarketingAds({ report, ranges }: { report: MarketingReport; ranges: { key: MarketingRange; label: string }[] }) {
  const [status, setStatus] = useState<StatusFilter>("spent");
  const [campaign, setCampaign] = useState("");
  const [adset, setAdset] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("spend");
  const [best, setBest] = useState(true);
  const [view, setView] = useState<View>("cards");

  const rows = useMemo(() => {
    let list = report.ads;
    if (status === "spent") list = list.filter((a) => a.spend > 0 || a.impressions > 0);
    else if (status === "delivering") list = list.filter((a) => a.effectiveStatus === "ACTIVE");
    else if (status === "paused") list = list.filter((a) => /PAUSED/.test(a.effectiveStatus));
    else if (status === "disapproved") list = list.filter((a) => a.effectiveStatus === "DISAPPROVED" || a.effectiveStatus === "WITH_ISSUES");
    if (campaign) list = list.filter((a) => a.campaignId === campaign);
    if (adset) list = list.filter((a) => a.adsetId === adset);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter((a) => [a.name, a.title, a.body, a.adset, a.campaign].some((s) => (s ?? "").toLowerCase().includes(needle)));
    }
    const dir = (LOWER_BETTER.includes(sort) ? !best : best) ? -1 : 1;
    const val = (a: AdPerf): number | string => {
      if (sort === "created") return a.created ?? "";
      if (sort === "name") return a.name.toLowerCase();
      const v = a[sort];
      // Ads with no denominator sort to the bottom whichever way we rank.
      return v === null ? (dir === -1 ? -Infinity : Infinity) : v;
    };
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      if (typeof x === "string" || typeof y === "string") return dir * String(x).localeCompare(String(y));
      return dir * (x - y);
    });
  }, [report.ads, status, campaign, adset, q, sort, best]);

  const t = useMemo(() => ({
    spend: rows.reduce((s, a) => s + a.spend, 0),
    impressions: rows.reduce((s, a) => s + a.impressions, 0),
    clicks: rows.reduce((s, a) => s + a.clicks, 0),
    leads: rows.reduce((s, a) => s + a.leads, 0),
  }), [rows]);
  const adsetsForCampaign = campaign ? report.adsets.filter((s) => s.campaignId === campaign) : report.adsets;
  const disapproved = report.ads.filter((a) => a.effectiveStatus === "DISAPPROVED").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Spend" value={usd(t.spend)} sub={`${rows.length} of ${report.ads.length} ads shown`} />
        <Stat label="Impressions" value={num(t.impressions)} sub={`CPM ${usd(t.impressions ? (t.spend / t.impressions) * 1000 : null, 2)}`} />
        <Stat label="Clicks" value={num(t.clicks)} sub={`CTR ${pct(t.impressions ? t.clicks / t.impressions : null)} · CPC ${usd(t.clicks ? t.spend / t.clicks : null, 2)}`} />
        <Stat label="Leads" value={num(t.leads)} sub={`${pct(t.clicks ? t.leads / t.clicks : null, 1)} of clicks`} />
        <Stat label="Cost per lead" value={usd(t.leads ? t.spend / t.leads : null, 2)} tone={t.leads && t.spend / t.leads > 100 ? "warn" : undefined} />
        <Stat label="Delivering" value={`${report.totals.delivering}`} sub={disapproved ? `${disapproved} disapproved` : "no disapprovals"} tone={disapproved ? "bad" : "good"} />
      </div>

      <Card className="p-3">
        <div className="grid gap-2 md:grid-cols-7">
          <label className="text-xs">
            <span className="mb-1 block font-medium text-zinc-500">Time</span>
            <select className={inputCls} value={report.range} onChange={(e) => { window.location.href = `/marketing?range=${e.target.value}`; }}>
              {ranges.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-zinc-500">Show</span>
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              {STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-zinc-500">Campaign</span>
            <select className={inputCls} value={campaign} onChange={(e) => { setCampaign(e.target.value); setAdset(""); }}>
              <option value="">All campaigns</option>
              {report.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-zinc-500">Ad set</span>
            <select className={inputCls} value={adset} onChange={(e) => setAdset(e.target.value)}>
              <option value="">All ad sets</option>
              {adsetsForCampaign.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-zinc-500">Rank by</span>
            <select className={inputCls} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-zinc-500">Order</span>
            <select className={inputCls} value={best ? "best" : "worst"} onChange={(e) => setBest(e.target.value === "best")}>
              <option value="best">{LOWER_BETTER.includes(sort) ? "Cheapest first" : "Highest first"}</option>
              <option value="worst">{LOWER_BETTER.includes(sort) ? "Most expensive first" : "Lowest first"}</option>
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-zinc-500">Search</span>
            <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, copy, ad set…" />
          </label>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
          <span>{report.since} → {report.until}. Leads are Meta form submissions (lead_grouped). Click an image for full size.</span>
          <span className="flex gap-1">
            {(["cards", "table"] as View[]).map((v) => (
              <button key={v} onClick={() => setView(v)}
                className={clsx("rounded-md px-2 py-0.5 font-medium", view === v ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800")}>
                {v === "cards" ? "Cards" : "Table"}
              </button>
            ))}
          </span>
        </div>
      </Card>

      {rows.length === 0 ? (
        <Card className="p-6 text-center text-sm text-zinc-500">No ads match. Widen the time window or the status filter.</Card>
      ) : view === "cards" ? (
        <div className="space-y-3">
          {rows.map((a, i) => (
            <Card key={a.adId} className="flex flex-col gap-4 p-4 md:flex-row">
              <div className="shrink-0 md:w-64">
                <AdImage ad={a} className="h-64 w-full rounded-lg md:w-64" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-zinc-400">#{i + 1}</span>
                      <h3 className="truncate text-base font-semibold">{a.name}</h3>
                      <Badge tone={statusTone(a.effectiveStatus)}>{statusLabel(a.effectiveStatus)}</Badge>
                      {a.isVideo ? <Badge tone="blue">Video</Badge> : null}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500">{a.campaign} › {a.adset}</div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    {a.firstDay ? <span>{a.activeDays} active day{a.activeDays === 1 ? "" : "s"} · {a.firstDay} → {a.lastDay}</span> : <span>no delivery in window</span>}
                    {a.postUrl ? <a href={a.postUrl} target="_blank" rel="noreferrer" className="underline">Post</a> : null}
                    <a href={`https://adsmanager.facebook.com/adsmanager/manage/ads?act=993053423296349&selected_ad_ids=${a.adId}`} target="_blank" rel="noreferrer" className="underline">Ads Manager</a>
                  </div>
                </div>
                {a.issues ? <div className="mt-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{a.issues}</div> : null}
                {a.title || a.body ? (
                  <div className="mt-2 text-sm">
                    {a.title ? <div className="font-medium">{a.title}</div> : null}
                    {a.body ? <p className="mt-0.5 line-clamp-3 text-zinc-600 dark:text-zinc-300">{a.body}</p> : null}
                    {a.cta ? <div className="mt-1 text-xs text-zinc-400">CTA: {statusLabel(a.cta)}{a.formId ? ` · lead form ${a.formId}` : ""}</div> : null}
                  </div>
                ) : null}
                <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2 text-sm sm:grid-cols-4 lg:grid-cols-8">
                  <Metric label="Spend" value={usd(a.spend, 2)} strong />
                  <Metric label="Leads" value={num(a.leads)} strong />
                  <Metric label="Cost / lead" value={usd(a.cpl, 2)} strong tone={a.cpl !== null && a.cpl > 100 ? "warn" : undefined} />
                  <Metric label="Impressions" value={num(a.impressions)} />
                  <Metric label="Clicks" value={num(a.clicks)} sub={a.linkClicks ? `${num(a.linkClicks)} link` : undefined} />
                  <Metric label="CTR" value={pct(a.ctr)} />
                  <Metric label="CPC" value={usd(a.cpc, 2)} />
                  <Metric label="CPM" value={usd(a.cpm, 2)} />
                </div>
                <div className="mt-2 flex items-center gap-6 text-xs text-zinc-400">
                  <span className="flex items-center gap-2">Spend by day <Sparkline daily={a.daily} metric="spend" /></span>
                  <span className="flex items-center gap-2">Leads by day <Sparkline daily={a.daily} metric="leads" /></span>
                  <span>Leads / click {pct(a.leadRate, 1)}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  {["#", "Ad", "Status", "Campaign › ad set", "Spend", "Impr.", "Clicks", "CTR", "CPC", "CPM", "Leads", "CPL", "Leads/click", "Active"].map((h, i) => (
                    <th key={h} className={clsx("px-3 py-2 font-medium", i >= 4 && "text-right")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((a, i) => (
                  <tr key={a.adId} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                    <td className="px-3 py-2 text-zinc-400">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <AdImage ad={a} thumb className="h-10 w-10 shrink-0 rounded" />
                        <div className="min-w-0">
                          <div className="truncate font-medium" title={a.name}>{a.name}</div>
                          {a.title ? <div className="truncate text-xs text-zinc-500" title={a.title}>{a.title}</div> : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2"><Badge tone={statusTone(a.effectiveStatus)}>{statusLabel(a.effectiveStatus)}</Badge></td>
                    <td className="max-w-[16rem] truncate px-3 py-2 text-xs text-zinc-500" title={`${a.campaign} › ${a.adset}`}>{a.campaign} › {a.adset}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{usd(a.spend, 2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(a.impressions)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(a.clicks)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(a.ctr)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{usd(a.cpc, 2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{usd(a.cpm, 2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{num(a.leads)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{usd(a.cpl, 2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(a.leadRate, 1)}</td>
                    <td className="px-3 py-2 text-right text-xs text-zinc-500">{a.activeDays ? `${a.activeDays}d` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value, sub, strong, tone }: { label: string; value: string; sub?: string; strong?: boolean; tone?: "warn" }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</div>
      <div className={clsx("tabular-nums", strong && "font-semibold", tone === "warn" && "text-amber-600")}>{value}</div>
      {sub ? <div className="text-[11px] text-zinc-400">{sub}</div> : null}
    </div>
  );
}
