/** Marketing page: every Meta ad with its creative and performance over a
 * chosen window. Reads the `meta_ads` / `meta_ad_insights_daily` cache that
 * /api/cron/meta-spend fills every 6 hours; nothing here calls Meta. */
import { selectAll, supabaseService } from "@/lib/supabase/server";

export type MarketingRange = "7d" | "14d" | "30d" | "90d" | "all" | `${number}-${number}`;

export interface AdPerf {
  adId: string;
  name: string;
  status: string;
  effectiveStatus: string;
  campaign: string;
  campaignId: string;
  adset: string;
  adsetId: string;
  title: string | null;
  body: string | null;
  cta: string | null;
  formId: string | null;
  hasImage: boolean;
  isVideo: boolean;
  postUrl: string | null;
  issues: string | null;
  created: string | null;
  /** Window totals. */
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  /** Derived; null when the denominator is zero. */
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpl: number | null;
  leadRate: number | null;
  /** Days in the window with any delivery. */
  activeDays: number;
  firstDay: string | null;
  lastDay: string | null;
  /** Daily spend/leads for the window, oldest first, for a sparkline. */
  daily: { day: string; spend: number; leads: number; clicks: number }[];
}

export interface MarketingReport {
  range: MarketingRange;
  rangeLabel: string;
  since: string;
  until: string;
  syncedAt: string | null;
  ads: AdPerf[];
  campaigns: { id: string; name: string }[];
  adsets: { id: string; name: string; campaignId: string }[];
  totals: { spend: number; impressions: number; clicks: number; leads: number; ads: number; delivering: number };
}

const ISO_DAY = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

export function rangeBounds(range: MarketingRange, now = new Date()): { since: string; until: string; label: string } {
  const today = ISO_DAY(now);
  if (range === "all") return { since: "2026-05-01", until: today, label: "All time (since 6 May 2026)" };
  const m = /^(\d{4})-(\d{2})$/.exec(range);
  if (m) {
    const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0));
    return { since: ISO_DAY(start), until: ISO_DAY(end < now ? end : now),
      label: start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) };
  }
  const days = Number(range.replace("d", "")) || 30;
  return { since: ISO_DAY(addDays(now, -(days - 1))), until: today, label: `Last ${days} days` };
}

export async function marketingReport(range: MarketingRange = "30d", now = new Date()): Promise<MarketingReport> {
  const { since, until, label } = rangeBounds(range, now);
  type AdRow = {
    ad_id: string; name: string | null; status: string | null; effective_status: string | null;
    adset_id: string | null; adset_name: string | null; campaign_id: string | null; campaign_name: string | null;
    title: string | null; body: string | null; cta: string | null; form_id: string | null;
    image_url: string | null; thumbnail_url: string | null; video_id: string | null; post_id: string | null;
    issues: unknown; created_time: string | null; synced_at: string | null;
  };
  type InsRow = { ad_id: string; day: string; spend_cents: number; impressions: number; reach: number; clicks: number; link_clicks: number; leads: number };
  const sb = supabaseService();
  const [ads, ins] = await Promise.all([
    selectAll<AdRow>("meta_ads", "*", "ad_id"),
    (async () => {
      const out: InsRow[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from("meta_ad_insights_daily")
          .select("ad_id, day, spend_cents, impressions, reach, clicks, link_clicks, leads")
          .gte("day", since).lte("day", until).order("day").range(from, from + 999);
        if (error) throw error;
        out.push(...((data ?? []) as InsRow[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    })(),
  ]);

  const byAd = new Map<string, InsRow[]>();
  for (const r of ins) byAd.set(r.ad_id, [...(byAd.get(r.ad_id) ?? []), r]);

  const issueText = (x: unknown): string | null => {
    if (!Array.isArray(x) || !x.length) return null;
    return x.map((i) => {
      const o = i as { error_summary?: string; error_message?: string; level?: string };
      return o.error_summary ?? o.error_message ?? "";
    }).filter(Boolean).join(" · ") || null;
  };

  const perf: AdPerf[] = ads.map((a) => {
    const rows = (byAd.get(a.ad_id) ?? []).sort((x, y) => x.day.localeCompare(y.day));
    const sum = (f: (r: InsRow) => number) => rows.reduce((s, r) => s + f(r), 0);
    const spend = sum((r) => r.spend_cents) / 100;
    const impressions = sum((r) => r.impressions);
    const clicks = sum((r) => r.clicks);
    const linkClicks = sum((r) => r.link_clicks);
    const leads = sum((r) => r.leads);
    const active = rows.filter((r) => r.impressions > 0 || r.spend_cents > 0);
    return {
      adId: a.ad_id, name: a.name ?? a.ad_id, status: a.status ?? "", effectiveStatus: a.effective_status ?? "",
      campaign: a.campaign_name ?? "", campaignId: a.campaign_id ?? "", adset: a.adset_name ?? "", adsetId: a.adset_id ?? "",
      title: a.title, body: a.body, cta: a.cta, formId: a.form_id,
      hasImage: !!(a.image_url || a.thumbnail_url), isVideo: !!a.video_id,
      postUrl: a.post_id && a.post_id.includes("_") ? `https://www.facebook.com/${a.post_id.split("_")[0]}/posts/${a.post_id.split("_")[1]}` : null,
      issues: issueText(a.issues), created: a.created_time,
      spend, impressions, reach: sum((r) => r.reach), clicks, linkClicks, leads,
      ctr: impressions ? clicks / impressions : null,
      cpc: clicks ? spend / clicks : null,
      cpm: impressions ? (spend / impressions) * 1000 : null,
      cpl: leads ? spend / leads : null,
      leadRate: clicks ? leads / clicks : null,
      activeDays: active.length,
      firstDay: active[0]?.day ?? null,
      lastDay: active.at(-1)?.day ?? null,
      daily: rows.map((r) => ({ day: r.day, spend: r.spend_cents / 100, leads: r.leads, clicks: r.clicks })),
    };
  });

  const campaigns = [...new Map(perf.filter((p) => p.campaignId).map((p) => [p.campaignId, { id: p.campaignId, name: p.campaign }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const adsets = [...new Map(perf.filter((p) => p.adsetId).map((p) => [p.adsetId, { id: p.adsetId, name: p.adset, campaignId: p.campaignId }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const totals = {
    spend: perf.reduce((s, p) => s + p.spend, 0),
    impressions: perf.reduce((s, p) => s + p.impressions, 0),
    clicks: perf.reduce((s, p) => s + p.clicks, 0),
    leads: perf.reduce((s, p) => s + p.leads, 0),
    ads: perf.length,
    delivering: perf.filter((p) => p.effectiveStatus === "ACTIVE").length,
  };
  const syncedAt = ads.map((a) => a.synced_at).filter((x): x is string => !!x).sort().at(-1) ?? null;
  return { range, rangeLabel: label, since, until, syncedAt, ads: perf, campaigns, adsets, totals };
}
