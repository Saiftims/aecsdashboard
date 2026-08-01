/** Quo (OpenPhone) API client.
 *
 * Quo will not answer /v1/calls without BOTH a line and a participant number -
 * there is no "all calls on this line" query and no date range, and
 * /v1/conversations silently ignores phoneNumberId, userId and every date
 * filter. So enumerating calls means discovering counterparty numbers first
 * (conversation threads, most-recently-active first) and then asking each line
 * about each number. Asking every line rather than only the thread's own line
 * matters: a rep can dial the same person from a second line, and that call
 * lives on a thread we would otherwise never pair with it.
 */
const BASE = "https://api.quo.com";

export interface QuoPhoneNumber {
  id: string;
  number?: string;
  formattedNumber?: string;
  users?: { id?: string; email?: string; firstName?: string; lastName?: string }[];
}

export interface QuoCall {
  id: string;
  userId?: string | null;
  answeredBy?: string | null;
  initiatedBy?: string | null;
  phoneNumberId?: string | null;
  direction?: string | null;
  status?: string | null;
  duration?: number | null;
  createdAt?: string | null;
  answeredAt?: string | null;
  completedAt?: string | null;
}

function key(): string {
  const k = (process.env.QUO_API_KEY ?? "").trim();
  if (!k) throw new Error("QUO_API_KEY not configured");
  return k;
}

async function quoGet<T>(path: string, params: Record<string, string | string[]>): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, v);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: key() },
      cache: "no-store",
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Quo ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }
  throw new Error(`Quo ${path} -> repeated 429`);
}

interface Page<T> { data?: T[]; nextPageToken?: string | null }

/** Walk a paginated list, newest first, stopping after `maxPages`. */
async function paginate<T>(
  path: string,
  { pageSize = 100, maxPages = 50 }: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const out: T[] = [];
  let token: string | null | undefined;
  for (let i = 0; i < maxPages; i++) {
    const params: Record<string, string> = { maxResults: String(pageSize) };
    if (token) params.pageToken = token;
    const page = await quoGet<Page<T>>(path, params);
    out.push(...(page.data ?? []));
    token = page.nextPageToken;
    if (!token) break;
  }
  return out;
}

export async function listPhoneNumbers(): Promise<QuoPhoneNumber[]> {
  const res = await quoGet<Page<QuoPhoneNumber>>("/v1/phone-numbers", {});
  return res.data ?? [];
}

interface QuoConversation {
  participants?: string[];
  lastActivityAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

function conversationTouchedAt(c: QuoConversation): number | null {
  for (const v of [c.lastActivityAt, c.updatedAt, c.createdAt]) {
    if (v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

/** Counterparty numbers to ask each line about.
 *
 * Cost is participants x lines, so a full walk grows without bound as reps
 * dial more people. Passing `sinceMs` keeps a routine sync to threads that
 * have moved since the last run; the contact book (numbers whose thread has
 * aged out of the list) is only worth its pages on a full backfill.
 */
export async function listParticipants(
  { sinceMs, maxPages = 20 }: { sinceMs?: number; maxPages?: number } = {},
): Promise<string[]> {
  const numbers = new Set<string>();
  const convs = await paginate<QuoConversation>("/v1/conversations", { maxPages });
  for (const c of convs) {
    // A thread with no usable timestamp is always included: missing the call is
    // worse than one extra lookup.
    const touched = conversationTouchedAt(c);
    if (sinceMs && touched !== null && touched < sinceMs) continue;
    for (const p of c.participants ?? []) if (p) numbers.add(p);
  }
  if (!sinceMs) {
    const contacts = await paginate<{
      defaultFields?: { phoneNumbers?: { value?: string }[] };
    }>("/v1/contacts", { pageSize: 50, maxPages }); // contacts cap at 50 per page
    for (const c of contacts) {
      for (const f of c.defaultFields?.phoneNumbers ?? []) if (f.value) numbers.add(f.value);
    }
  }
  return [...numbers];
}

export async function listCalls(phoneNumberId: string, participant: string): Promise<QuoCall[]> {
  const out: QuoCall[] = [];
  let token: string | null | undefined;
  do {
    const params: Record<string, string | string[]> = {
      phoneNumberId,
      participants: [participant],
      maxResults: "100",
    };
    if (token) params.pageToken = token as string;
    const page = await quoGet<Page<QuoCall>>("/v1/calls", params);
    out.push(...(page.data ?? []));
    token = page.nextPageToken;
  } while (token);
  return out;
}
