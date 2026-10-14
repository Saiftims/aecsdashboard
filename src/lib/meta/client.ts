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

/** Per-ad, per-day insights. Asked a month at a time so no single response
 * trips Meta's "reduce the amount of data" limit. */
export async function dailyAdInsights(since: string, until: string): Promise<MetaAdDaily[]> {
  type Row = {
    ad_id: string; date_start: string; spend?: string; impressions?: string; reach?: string; clicks?: string;
    inline_link_clicks?: string; actions?: { action_type: string; value: string }[];
  };
  const out: MetaAdDaily[] = [];
  let cursor = new Date(since + "T00:00:00Z");
  const end = new Date(until + "T00:00:00Z");
  while (cursor <= end) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const chunkEnd = monthEnd < end ? monthEnd : end;
    const rows = await allPages<Row>(`${env.metaAdAccountId()}/insights`, env.metaAdsToken(), {
      level: "ad",
      fields: "ad_id,spend,impressions,reach,clicks,inline_link_clicks,actions",
      time_increment: "1",
      time_range: JSON.stringify({ since: cursor.toISOString().slice(0, 10), until: chunkEnd.toISOString().slice(0, 10) }),
      limit: "500",
    });
    for (const r of rows) {
      out.push({
        adId: r.ad_id, day: r.date_start,
        spendCents: Math.round(Number(r.spend ?? 0) * 100),
        impressions: Number(r.impressions ?? 0), reach: Number(r.reach ?? 0),
        clicks: Number(r.clicks ?? 0), linkClicks: Number(r.inline_link_clicks ?? 0),
        leads: Number(r.actions?.find((a) => a.action_type === "onsite_conversion.lead_grouped")?.value ?? 0),
      });
    }
    cursor = new Date(Date.UTC(chunkEnd.getUTCFullYear(), chunkEnd.getUTCMonth(), chunkEnd.getUTCDate() + 1));
  }
  return out;
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
  type Row = {
    date_start: string; spend?: string; impressions?: string; clicks?: string;
    actions?: { action_type: string; value: string }[];
  };
  const rows = await allPages<Row>(`${env.metaAdAccountId()}/insights`, env.metaAdsToken(), {
    level: "account",
    fields: "spend,impressions,clicks,actions",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    limit: "500",
  });
  return rows.map((r) => ({
    day: r.date_start,
    spendCents: Math.round(Number(r.spend ?? 0) * 100),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    leads: Number(r.actions?.find((a) => a.action_type === "onsite_conversion.lead_grouped")?.value ?? 0),
  }));
}
