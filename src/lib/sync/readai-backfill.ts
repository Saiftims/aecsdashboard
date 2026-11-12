/** Read.ai history import.
 *
 * The webhook only sees meetings recorded after it was added, and Read.ai's
 * REST API only shows a user their own reports, so each rep connects once
 * at /api/readai/connect (OAuth 2.1, authorization code + PKCE). The
 * refresh token is kept in `readai_accounts` and rotated on every use.
 *
 * `backfillAccount` walks that user's meetings newest-first, ten per page,
 * skips what is obviously internal (standups, interviews, only our own
 * emails on the attendee list), fetches the transcript for the rest and
 * hands them to the same `processMeeting` the webhook uses - so the model's
 * "is this a sales/CS call" gate, HubSpot matching and write rules are
 * identical. It stops when the time budget runs out and resumes from the
 * stored cursor on the next cron tick.
 */
import { createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { must, supabaseService } from "@/lib/supabase/server";
import {
  EXCLUDED_TITLE_RE, internalEmailSet, internalOnly, processMeeting, storeMeeting, storeSkipped, type ReadAiPayload,
} from "@/lib/sync/readai";

const AUTHORIZE_URL = "https://authn.read.ai/oauth2/auth";
const TOKEN_URL = "https://authn.read.ai/oauth2/token";
const API = "https://api.read.ai";
const SCOPE = "openid email profile offline_access meeting:read";
/** Holds state + PKCE verifier between /connect and /oauth/callback. */
export const OAUTH_COOKIE = "readai_oauth";

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(state: string, challenge: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", env.readaiClientId());
  u.searchParams.set("redirect_uri", env.readaiRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

interface TokenResponse { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string; scope?: string }

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const basic = Buffer.from(`${env.readaiClientId()}:${env.readaiClientSecret()}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`read.ai token -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<TokenResponse>;
}

export const exchangeCode = (code: string, verifier: string) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: env.readaiRedirectUri(), code_verifier: verifier });

/** Email/name from the id_token (a JWT; the signature was already checked
 * by the token endpoint we fetched it from over TLS). */
export function identityFromIdToken(idToken: string | undefined): { email: string | null; name: string | null } {
  try {
    const payload = JSON.parse(Buffer.from((idToken ?? "").split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    return { email: typeof payload.email === "string" ? payload.email.toLowerCase() : null, name: typeof payload.name === "string" ? payload.name : null };
  } catch {
    return { email: null, name: null };
  }
}

async function userinfo(accessToken: string): Promise<{ email: string | null; name: string | null }> {
  const res = await fetch("https://authn.read.ai/userinfo", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return { email: null, name: null };
  const d = await res.json() as Record<string, unknown>;
  return { email: typeof d.email === "string" ? d.email.toLowerCase() : null, name: typeof d.name === "string" ? d.name : null };
}

type Sb = ReturnType<typeof supabaseService>;
interface Account {
  email: string; name: string | null; refresh_token: string; access_token: string | null; access_expires_at: string | null;
  backfill_cursor: string | null; backfill_done: boolean; backfill_seen: number;
}

/** Finish the OAuth dance: store the tokens under the Read.ai user's email. */
export async function connectAccount(code: string, verifier: string): Promise<{ email: string; name: string | null }> {
  const t = await exchangeCode(code, verifier);
  if (!t.refresh_token) throw new Error("read.ai did not return a refresh token (offline_access scope missing?)");
  let who = identityFromIdToken(t.id_token);
  if (!who.email) who = await userinfo(t.access_token);
  if (!who.email) throw new Error("could not determine the Read.ai account email");
  const sb = supabaseService();
  await must("readai_accounts upsert", sb.from("readai_accounts").upsert({
    email: who.email, name: who.name, refresh_token: t.refresh_token, access_token: t.access_token,
    access_expires_at: new Date(Date.now() + ((t.expires_in ?? 600) - 30) * 1000).toISOString(),
    connected_at: new Date().toISOString(), error: null,
    // A reconnect restarts the walk so anything recorded since is picked up.
    backfill_cursor: null, backfill_done: false,
  }, { onConflict: "email" }));
  return { email: who.email, name: who.name };
}

/** A usable access token, refreshing (and persisting the rotated refresh
 * token) when the stored one has under a minute left. */
async function accessTokenFor(sb: Sb, a: Account): Promise<string> {
  const ttl = a.access_expires_at ? Date.parse(a.access_expires_at) - Date.now() : -1;
  if (a.access_token && ttl > 60_000) return a.access_token;
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: a.refresh_token });
  a.access_token = t.access_token;
  a.access_expires_at = new Date(Date.now() + ((t.expires_in ?? 600) - 30) * 1000).toISOString();
  if (t.refresh_token) a.refresh_token = t.refresh_token;
  await must("readai_accounts token", sb.from("readai_accounts").update({
    access_token: a.access_token, access_expires_at: a.access_expires_at, refresh_token: a.refresh_token, error: null,
  }).eq("email", a.email));
  return a.access_token;
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
interface ApiParticipant { name?: string; email?: string; invited?: boolean; attended?: boolean }
export interface ApiMeeting {
  id: string; title?: string; start_time_ms?: number; end_time_ms?: number | null; platform?: string; report_url?: string;
  participants?: ApiParticipant[]; owner?: { name?: string; email?: string };
  summary?: string | { text?: string } | null;
  action_items?: unknown; key_questions?: unknown; topics?: unknown;
  chapter_summaries?: { title?: string; description?: string }[] | null;
  transcript?: { turns?: { speaker?: { name?: string }; text?: string; start_time_ms?: number }[]; text?: string } | null;
}

async function api<T>(token: string, path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 429 || (res.status >= 500 && attempt < 2)) {
      await new Promise((r) => setTimeout(r, res.status === 429 ? 15_000 : 3_000));
      if (attempt < 3) continue;
    }
    if (!res.ok) throw new Error(`read.ai ${path.split("?")[0]} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json() as Promise<T>;
  }
}

export const listMeetings = (token: string, cursor: string | null) =>
  api<{ data: ApiMeeting[]; has_more: boolean }>(token, `/v1/meetings?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);

export const getMeeting = (token: string, id: string) =>
  api<ApiMeeting>(token, `/v1/meetings/${encodeURIComponent(id)}?expand[]=summary&expand[]=action_items&expand[]=transcript&expand[]=chapter_summaries`);

const textItems = (v: unknown): { text: string }[] => {
  if (!Array.isArray(v)) return [];
  return v.map((i) => typeof i === "string" ? i : (i as Record<string, unknown>)?.text ?? (i as Record<string, unknown>)?.description ?? (i as Record<string, unknown>)?.title)
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((text) => ({ text }));
};

/** Reshape an API meeting into the webhook payload shape `processMeeting`
 * expects, so one code path serves live and historical calls. */
export function meetingToPayload(m: ApiMeeting): ReadAiPayload {
  const iso = (ms: number | null | undefined) => typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : undefined;
  const participants = (m.participants ?? []).filter((p) => p.attended !== false).map((p) => ({ name: p.name ?? null, email: p.email ?? null }));
  const summary = typeof m.summary === "string" ? m.summary : m.summary?.text;
  return {
    session_id: m.id, request_id: `backfill:${m.id}`, trigger: "meeting_end", title: m.title,
    start_time: iso(m.start_time_ms), end_time: iso(m.end_time_ms), platform: m.platform, report_url: m.report_url,
    participants, owner: m.owner ? { name: m.owner.name ?? null, email: m.owner.email ?? null } : undefined,
    summary, action_items: textItems(m.action_items), key_questions: textItems(m.key_questions), topics: textItems(m.topics),
    chapter_summaries: m.chapter_summaries ?? undefined,
    transcript: { speaker_blocks: (m.transcript?.turns ?? []).map((t) => ({ speaker: { name: t.speaker?.name }, words: t.text, start_time: iso(t.start_time_ms) })) },
  };
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------
export interface BackfillStats {
  email: string; listed: number; already: number; filtered: number; processed: number; synced: number; skipped: number; failed: number;
  fields_new: number; done: boolean; errors: string[];
}

/** Import one account's history. `max` caps meetings sent to the model
 * this run; `deadline` (epoch ms) stops the walk early so a cron tick never
 * outlives its function. Progress is saved per page. */
export async function backfillAccount(email: string, opts: { max?: number; deadline?: number } = {}): Promise<BackfillStats> {
  const sb = supabaseService();
  const max = opts.max ?? 5;
  const deadline = opts.deadline ?? Date.now() + 240_000;
  const { data } = await must("readai_accounts read", sb.from("readai_accounts").select("*").eq("email", email).single());
  const a = data as Account;
  const s: BackfillStats = { email, listed: 0, already: 0, filtered: 0, processed: 0, synced: 0, skipped: 0, failed: 0, fields_new: 0, done: a.backfill_done, errors: [] };
  if (a.backfill_done) return s;

  const internal = await internalEmailSet();
  let cursor = a.backfill_cursor;
  try {
    while (s.processed < max && Date.now() < deadline) {
      const token = await accessTokenFor(sb, a);
      const page = await listMeetings(token, cursor);
      if (!page.data.length) { s.done = true; break; }
      s.listed += page.data.length;

      const ids = page.data.map((m) => m.id);
      const { data: known } = await sb.from("readai_meetings").select("session_id").in("session_id", ids);
      const knownIds = new Set(((known ?? []) as { session_id: string }[]).map((k) => k.session_id));

      let stoppedEarly = false;
      for (const m of page.data) {
        if (s.processed >= max || Date.now() >= deadline) { stoppedEarly = true; break; }
        if (knownIds.has(m.id)) { s.already++; continue; }
        if (!m.end_time_ms) { s.filtered++; continue; }  // still running
        const stub = meetingToPayload(m);
        if (m.title && EXCLUDED_TITLE_RE.test(m.title)) { await storeSkipped(stub, `title filter: ${m.title}`); s.filtered++; continue; }
        if (internalOnly(stub.participants, internal)) { await storeSkipped(stub, "internal attendees only"); s.filtered++; continue; }

        try {
          const full = meetingToPayload(await getMeeting(await accessTokenFor(sb, a), m.id));
          await storeMeeting(full, "backfill");
          s.processed++;
          const r = await processMeeting(m.id);
          if (r.status === "synced") { s.synced++; s.fields_new += Number(r.fields_new ?? 0); } else s.skipped++;
        } catch (e) {
          s.processed++; s.failed++;
          s.errors.push(`${m.id} ${m.title ?? ""}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
        }
      }

      if (stoppedEarly) {
        // Mid-page stop: Read.ai pages by id, so the same page is re-listed
        // next run and the meetings already stored are skipped cheaply.
        await sb.from("readai_accounts").update({ last_backfill_at: new Date().toISOString() }).eq("email", email);
        break;
      }
      // Whole page walked: move the saved cursor past it.
      cursor = page.data[page.data.length - 1].id;
      a.backfill_seen += page.data.length;
      if (!page.has_more) s.done = true;
      await sb.from("readai_accounts").update({ backfill_cursor: cursor, backfill_seen: a.backfill_seen, backfill_done: s.done, last_backfill_at: new Date().toISOString() }).eq("email", email);
      if (s.done) break;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    s.errors.push(msg.slice(0, 300));
    await sb.from("readai_accounts").update({ error: msg.slice(0, 500), last_backfill_at: new Date().toISOString() }).eq("email", email);
  }
  return s;
}

/** Cron: advance every connected account that still has history to walk. */
export async function backfillPending(opts: { maxPerAccount?: number; deadline?: number } = {}): Promise<Record<string, unknown>> {
  const sb = supabaseService();
  const { data } = await must("readai_accounts pending", sb.from("readai_accounts").select("email").eq("backfill_done", false));
  const accounts = ((data ?? []) as { email: string }[]).map((a) => a.email);
  const out: Record<string, unknown> = { accounts: accounts.length };
  for (const email of accounts) {
    out[email] = await backfillAccount(email, { max: opts.maxPerAccount ?? 4, deadline: opts.deadline });
  }
  return out;
}
