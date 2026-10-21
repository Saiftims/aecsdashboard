/** Meta Graph API: Lead Ads forms and their submissions.
 *
 * Lead records can only be read with a PAGE access token carrying
 * `leads_retrieval`. The page token is derived from the user/system token in
 * `META_ACCESS_TOKEN` via `/{page_id}?fields=access_token` on every run, so
 * nothing page-specific has to be stored - but the derived token lives and
 * dies with the token it came from, so that one must be long-lived (a system
 * user token, or a user token exchanged for a 60-day one).
 *
 * The Silent Witness page is 852956741232072; every ad in act_993053423296349
 * runs on it. */
import { env } from "@/lib/env";

const GRAPH = "https://graph.facebook.com/v21.0";

export interface MetaForm {
  id: string;
  name: string;
  status: string;
  leads_count?: number;
  created_time: string;
}

export interface MetaLead {
  id: string;
  created_time: string;
  form_id: string;
  ad_id?: string;
  ad_name?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  platform?: string;
  is_organic?: boolean;
  field_data: { name: string; values: string[] }[];
}

async function graph<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json() as T & { error?: { message?: string; code?: number } };
  if (!res.ok || body.error) {
    throw new Error(`Meta ${path.replace(/\?.*/, "")} -> ${res.status}: ${body.error?.message ?? "unknown"}`);
  }
  return body;
}

async function allPages<T>(path: string, token: string, params: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  let page = await graph<{ data: T[]; paging?: { next?: string } }>(path, token, params);
  for (;;) {
    out.push(...(page.data ?? []));
    const next = page.paging?.next;
    if (!next) return out;
    // `next` already carries the token and cursor.
    const res = await fetch(next, { cache: "no-store" });
    page = await res.json();
    if (!res.ok || (page as { error?: unknown }).error) throw new Error(`Meta paging -> ${res.status}`);
  }
}

export async function pageAccessToken(): Promise<string> {
  const r = await graph<{ access_token?: string }>(env.metaPageId(), env.metaAccessToken(), { fields: "access_token" });
  if (!r.access_token) throw new Error("Meta: page access token not returned - the token has no role on the page");
  return r.access_token;
}

export async function listForms(pageToken: string): Promise<MetaForm[]> {
  return allPages<MetaForm>(`${env.metaPageId()}/leadgen_forms`, pageToken, {
    fields: "id,name,status,leads_count,created_time", limit: "100",
  });
}

/** Submissions on one form, newest first. `sinceMs` (unix millis) limits the
 * read to leads created after that moment - Meta's `time_created` filter. */
export async function listLeads(formId: string, pageToken: string, sinceMs?: number): Promise<MetaLead[]> {
  const params: Record<string, string> = {
    fields: "id,created_time,field_data,ad_id,ad_name,adset_name,campaign_id,campaign_name,form_id,is_organic,platform",
    limit: "500",
  };
  if (sinceMs) {
    params.filtering = JSON.stringify([
      { field: "time_created", operator: "GREATER_THAN", value: Math.floor(sinceMs / 1000) },
    ]);
  }
  return allPages<MetaLead>(`${formId}/leads`, pageToken, params);
}

export interface MetaAd {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  adset?: { id: string; name: string };
  campaign?: { id: string; name: string; objective?: string };
  creative?: { id: string };
  created_time: string;
  updated_time: string;
  issues_info?: unknown[];
}

/** Every ad in the account, any status. */
export async function listAds(): Promise<MetaAd[]> {
  return allPages<MetaAd>(`${env.metaAdAccountId()}/ads`, env.metaAdsToken(), {
    fields: "id,name,status,effective_status,adset{id,name},campaign{id,name,objective},creative{id},created_time,updated_time,issues_info",
    limit: "200",
  });
}

export interface MetaCreative {
  id: string;
  title?: string;
  body?: string;
  image_url?: string;
  thumbnail_url?: string;
  image_hash?: string;
  effective_object_story_id?: string;
  call_to_action_type?: string;
  object_story_spec?: {
    link_data?: { link?: string; image_hash?: string; call_to_action?: { type?: string; value?: { lead_gen_form_id?: string; link?: string } } };
    video_data?: { video_id?: string; image_url?: string; image_hash?: string; title?: string; message?: string; call_to_action?: { type?: string; value?: { lead_gen_form_id?: string } } };
  };
  asset_feed_spec?: {
    titles?: { text: string }[]; bodies?: { text: string }[]; images?: { hash: string }[]; videos?: { video_id: string }[];
  };
}

/** Creatives by id, 50 per request. */
export async function readCreatives(ids: string[]): Promise<Map<string, MetaCreative>> {
  const out = new Map<string, MetaCreative>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const r = await graph<Record<string, MetaCreative>>("", env.metaAdsToken(), {
      ids: batch.join(","),
      fields: "id,title,body,image_url,thumbnail_url,image_hash,effective_object_story_id,call_to_action_type,object_story_spec,asset_feed_spec",
      // Page-post creatives (and videos) expose no image_url; their thumbnail
      // is 64px unless a size is asked for, so ask for a full-size render.
      thumbnail_width: "1080",
      thumbnail_height: "1080",
    });
    for (const [id, c] of Object.entries(r)) if (id !== "error") out.set(id, c);
  }
  return out;
}

/** Permanent-ish URLs for ad images by hash (the account's image library). */
export async function imageUrlsByHash(hashes: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < hashes.length; i += 50) {
    const r = await graph<{ data: { hash: string; url?: string; permalink_url?: string }[] }>(
      `${env.metaAdAccountId()}/adimages`, env.metaAdsToken(),
      { hashes: JSON.stringify(hashes.slice(i, i + 50)), fields: "hash,url,permalink_url" },
    ).catch(() => ({ data: [] }));
    for (const im of r.data ?? []) if (im.url) out.set(im.hash, im.url);
  }
  return out;
}

export interface MetaAdDaily {
  adId: string;
  day: string;
  spendCents: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  leads: number;
}

type ActionRow = { actions?: { action_type: string; value: string }[] };
/** Form submissions (`onsite_conversion.lead_grouped`). Not `lead`, which
 * also counts the pixel's MQL/SQL custom events and runs ~2x. */
const leadsIn = (r: ActionRow) =>
  Number(r.actions?.find((a) => a.action_type === "onsite_conversion.lead_grouped")?.value ?? 0);

/** Core metrics and the action-type fields are fetched in SEPARATE requests
 * and merged. Since about 2026-09-06 Meta answers a daily request that names
 * `spend,impressions,clicks` together with `actions` (account level) or
 * `inline_link_clicks` (ad level, multi-day) with spend/impressions/clicks
 * all "0" while still returning the other fields - the sync trusted it and
 * overwrote six weeks of real spend with zeros (found 2026-10-21; Sep read
 * $1,141 against $7,225). Asked on their own, the metrics come back correct. */
async function insightsSplit<K extends string>(
  params: Record<string, string>, metricFields: string, actionFields: string,
  key: (r: { date_start: string } & Record<string, unknown>) => K,
) {
  const path = `${env.metaAdAccountId()}/insights`;
  type Row = { date_start: string } & Record<string, unknown> & ActionRow;
  const [metrics, actions] = await Promise.all([
    allPages<Row>(path, env.metaAdsToken(), { ...params, fields: metricFields }),
    allPages<Row>(path, env.metaAdsToken(), { ...params, fields: actionFields }),
  ]);
  const extra = new Map<K, Row>();
  for (const r of actions) extra.set(key(r), r);
  return { metrics, extra };
}

/** Throws when the daily rows do not add up to what Meta says the account
 * spent over the same window - a zeroed breakdown must never be written. */
async function assertMatchesAccountTotal(since: string, until: string, sumCents: number, what: string) {
  const total = await accountSpendTotal(since, until);
  if (total > 0 && Math.abs(sumCents - total) > Math.max(100, total * 0.01)) {
    throw new Error(`Meta ${what} ${since}..${until} sums to ${sumCents} cents but the account total is ${total}; not writing`);
  }
}

/** Per-ad, per-day insights. Asked a month at a time so no single response
 * trips Meta's "reduce the amount of data" limit. */
export async function dailyAdInsights(since: string, until: string): Promise<MetaAdDaily[]> {
  const out: MetaAdDaily[] = [];
  let cursor = new Date(since + "T00:00:00Z");
  const end = new Date(until + "T00:00:00Z");
  while (cursor <= end) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const chunkEnd = monthEnd < end ? monthEnd : end;
    const from = cursor.toISOString().slice(0, 10);
    const to = chunkEnd.toISOString().slice(0, 10);
    const { metrics, extra } = await insightsSplit({
      level: "ad",
      time_increment: "1",
      time_range: JSON.stringify({ since: from, until: to }),
      limit: "500",
    }, "ad_id,spend,impressions,reach,clicks", "ad_id,inline_link_clicks,actions", (r) => `${r.ad_id}|${r.date_start}`);
    let sum = 0;
    for (const r of metrics) {
      const e = extra.get(`${r.ad_id}|${r.date_start}`);
      const spendCents = Math.round(Number(r.spend ?? 0) * 100);
      sum += spendCents;
      out.push({
        adId: String(r.ad_id), day: r.date_start, spendCents,
        impressions: Number(r.impressions ?? 0), reach: Number(r.reach ?? 0),
        clicks: Number(r.clicks ?? 0), linkClicks: Number(e?.inline_link_clicks ?? 0),
        leads: e ? leadsIn(e) : 0,
      });
    }
    await assertMatchesAccountTotal(from, to, sum, "per-ad daily spend");
    cursor = new Date(Date.UTC(chunkEnd.getUTCFullYear(), chunkEnd.getUTCMonth(), chunkEnd.getUTCDate() + 1));
  }
  return out;
}

/** Account spend over a whole window in ONE number, for checking that the
 * daily rows add up to what Meta says the account spent. */
export async function accountSpendTotal(since: string, until: string): Promise<number> {
  const rows = await allPages<{ spend?: string }>(`${env.metaAdAccountId()}/insights`, env.metaAdsToken(), {
    level: "account", fields: "spend", time_range: JSON.stringify({ since, until }),
  });
  return Math.round(rows.reduce((a, r) => a + Number(r.spend ?? 0), 0) * 100);
}

export interface MetaDailySpend {
  day: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  /** Form submissions (`onsite_conversion.lead_grouped`). Not `lead`, which
   * also counts the pixel's MQL/SQL custom events and runs ~2x. */
  leads: number;
}

/** Account-level spend per day between two YYYY-MM-DD dates (inclusive).
 * Needs only `ads_read`, so it uses `META_ADS_TOKEN` when set. Meta caps a
 * single insights request at 37 months, far beyond anything asked here. */
export async function dailyAccountSpend(since: string, until: string): Promise<MetaDailySpend[]> {
  const { metrics, extra } = await insightsSplit({
    level: "account",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    limit: "500",
  }, "spend,impressions,clicks", "actions", (r) => r.date_start);
  const days = metrics.map((r) => {
    const e = extra.get(r.date_start);
    return {
      day: r.date_start,
      spendCents: Math.round(Number(r.spend ?? 0) * 100),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      leads: e ? leadsIn(e) : 0,
    };
  });
  await assertMatchesAccountTotal(since, until, days.reduce((a, d) => a + d.spendCents, 0), "daily spend");
  return days;
}
