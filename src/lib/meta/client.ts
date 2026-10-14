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
