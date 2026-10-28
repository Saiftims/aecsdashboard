/** Minimal HubSpot CRM v3 client: pagination, 429 retry with backoff, and a
 * global write gate (HUBSPOT_APPLY) so the dashboard can run read-only. */
import { env } from "@/lib/env";

const BASE = "https://api.hubapi.com";

export class HubSpotError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function hsRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  // HubSpot's gateway answers a small share of requests with a 502/504 HTML
  // page or drops the connection (17 of ~4,000 five-minute syncs in the
  // fortnight to 2026-10-25), and the very next request succeeds. One retry
  // after a short pause absorbs that; a real outage still fails on the second.
  const GATEWAY_RETRIES = 2;
  let gatewayAttempt = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${env.hubspotToken()}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch (e) {
      if (gatewayAttempt++ < GATEWAY_RETRIES) { await sleep(3000 * gatewayAttempt); continue; }
      throw new HubSpotError(`${method} ${url.pathname} -> ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status >= 500 && gatewayAttempt++ < GATEWAY_RETRIES) {
      await res.text().catch(() => undefined);
      await sleep(3000 * gatewayAttempt);
      continue;
    }
    if (!res.ok) {
      // HubSpot's gateway errors are whole HTML pages; keep the first line so
      // the Slack alert says "504" rather than quoting a doctype.
      const text = (await res.text()).replace(/\s+/g, " ").trim();
      const detail = text.startsWith("<") ? text.slice(0, 80) + "…" : text;
      throw new HubSpotError(`${method} ${url.pathname} -> ${res.status}: ${detail}`, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
  throw new HubSpotError(`${method} ${url.pathname} -> repeated 429`);
}

export interface HsObject {
  id: string;
  properties: Record<string, string | null>;
  associations?: Record<string, { results: { id: string; type?: string }[] }>;
  createdAt?: string;
  updatedAt?: string;
}

interface HsPage {
  results: HsObject[];
  paging?: { next?: { after?: string } };
}

/** Paginate a full object list. */
export async function hsListAll(
  object: string,
  properties: string[],
  associations?: string[],
): Promise<HsObject[]> {
  const out: HsObject[] = [];
  let after: string | undefined;
  do {
    const params: Record<string, string> = {
      limit: "100",
      properties: properties.join(","),
    };
    if (associations?.length) params.associations = associations.join(",");
    if (after) params.after = after;
    const page = await hsRequest<HsPage>("GET", `/crm/v3/objects/${object}`, undefined, params);
    out.push(...page.results);
    after = page.paging?.next?.after;
  } while (after);
  return out;
}

/** Association ids for many objects at once (v4 batch read).
 *
 * `ok` reports whether HubSpot actually answered. Callers must not treat a
 * failed lookup as "this object has no associations", or they will erase links
 * that are still in the CRM.
 */
export async function hsAssociationsBatch(
  fromObject: string,
  toObject: string,
  ids: string[],
): Promise<{ map: Map<string, string[]>; ok: boolean }> {
  const map = new Map<string, string[]>();
  let ok = true;
  for (let i = 0; i < ids.length; i += 100) {
    const inputs = ids.slice(i, i + 100).map((id) => ({ id }));
    try {
      const data = await hsRequest<{
        results?: { from?: { id?: string | number }; to?: { toObjectId: string | number }[] }[];
      }>("POST", `/crm/v4/associations/${fromObject}/${toObject}/batch/read`, { inputs });
      for (const r of data.results ?? []) {
        const from = r.from?.id;
        if (from === undefined) continue;
        map.set(String(from), (r.to ?? []).map((t) => String(t.toObjectId)));
      }
    } catch (e) {
      ok = false;
      console.error(`hsAssociationsBatch ${fromObject}->${toObject}:`,
        e instanceof Error ? e.message : e);
    }
  }
  return { map, ok };
}

/** Incremental: objects modified since `sinceMs` (epoch millis), via search API.
 *
 * The search endpoint cannot return associations, so when `associations` are
 * requested they are filled in afterwards via the v4 batch read and attached in
 * the same shape `hsListAll` produces. Without this, an incremental sync reports
 * every object as having no associations at all.
 */
export async function hsListModifiedSince(
  object: string,
  properties: string[],
  sinceMs: number,
  associations?: string[],
): Promise<HsObject[]> {
  const out: HsObject[] = [];
  let after: string | undefined;
  const modifiedProp = object === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate";
  do {
    const body: Record<string, unknown> = {
      limit: 100,
      properties,
      sorts: [{ propertyName: modifiedProp, direction: "ASCENDING" }],
      filterGroups: [
        {
          filters: [
            { propertyName: modifiedProp, operator: "GTE", value: String(sinceMs) },
          ],
        },
      ],
    };
    if (after) body.after = after;
    const page = await hsRequest<HsPage>("POST", `/crm/v3/objects/${object}/search`, body);
    out.push(...page.results);
    after = page.paging?.next?.after;
    // HubSpot search caps at 10k results; incremental windows keep us far below.
  } while (after);

  if (associations?.length && out.length) {
    const ids = out.map((o) => o.id);
    for (const kind of associations) {
      const { map, ok } = await hsAssociationsBatch(object, kind, ids);
      if (!ok) continue; // leave undefined rather than claim "no associations"
      for (const o of out) {
        const linked = map.get(o.id) ?? [];
        o.associations = {
          ...(o.associations ?? {}),
          [kind]: { results: linked.map((id) => ({ id })) },
        };
      }
    }
  }
  return out;
}

export interface HsOwnerRow {
  owner_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  archived: boolean;
}

/** The full owner roster, including archived seats (their ids still appear as
 * history on activity logged before they left). */
export async function hsListOwners(): Promise<HsOwnerRow[]> {
  const out: HsOwnerRow[] = [];
  for (const archived of [false, true]) {
    let after: string | undefined;
    do {
      const params: Record<string, string> = { limit: "100", archived: String(archived) };
      if (after) params.after = after;
      const page = await hsRequest<{
        results: {
          id: string; email?: string | null;
          firstName?: string | null; lastName?: string | null;
        }[];
        paging?: { next?: { after?: string } };
      }>("GET", "/crm/v3/owners", undefined, params);
      for (const o of page.results ?? []) {
        out.push({
          owner_id: String(o.id),
          email: o.email ?? null,
          first_name: o.firstName ?? null,
          last_name: o.lastName ?? null,
          archived,
        });
      }
      after = page.paging?.next?.after;
    } while (after);
  }
  return out;
}

/** Association ids for one object (v4). */
export async function hsAssociations(
  fromObject: string,
  fromId: string,
  toObject: string,
): Promise<string[]> {
  const data = await hsRequest<{ results: { toObjectId: number | string }[] }>(
    "GET",
    `/crm/v4/objects/${fromObject}/${fromId}/associations/${toObject}`,
  );
  return (data.results ?? []).map((r) => String(r.toObjectId));
}

// ---------------------------------------------------------------------------
// Guarded writes. Every write goes through here so HUBSPOT_APPLY gates all of
// them and callers receive a uniform result for audit logging.
// ---------------------------------------------------------------------------
export interface WriteResult {
  ok: boolean;
  id?: string;
  skipped?: "writes_disabled";
  error?: string;
}

async function guardedWrite(fn: () => Promise<{ id?: string }>): Promise<WriteResult> {
  if (!env.hubspotWritesEnabled()) return { ok: false, skipped: "writes_disabled" };
  try {
    const res = await fn();
    return { ok: true, id: res.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Delete (archive) one CRM record. A 404 means it is already gone, which is
 * the state we wanted, so that reads as ok. Guarded like every other write. */
export async function hsDelete(object: string, id: string): Promise<WriteResult> {
  return guardedWrite(async () => {
    try {
      await hsRequest("DELETE", `/crm/v3/objects/${object}/${id}`);
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return { id };
      throw e;
    }
    return { id };
  });
}

/** Patch properties, dropping empty values so we never blank manual data. */
export async function hsUpdateProperties(
  object: string,
  id: string,
  properties: Record<string, string | number | boolean | null | undefined>,
): Promise<WriteResult> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v === null || v === undefined || v === "") continue;
    clean[k] = String(v);
  }
  if (!Object.keys(clean).length) return { ok: true };
  return guardedWrite(() =>
    hsRequest<{ id: string }>("PATCH", `/crm/v3/objects/${object}/${id}`, {
      properties: clean,
    }),
  );
}

export async function hsCreateObject(
  object: string,
  properties: Record<string, string>,
  associations?: {
    toId: string;
    associationTypeId: number;
  }[],
): Promise<WriteResult> {
  return guardedWrite(() =>
    hsRequest<{ id: string }>("POST", `/crm/v3/objects/${object}`, {
      properties,
      ...(associations?.length
        ? {
            associations: associations.map((a) => ({
              to: { id: a.toId },
              types: [
                {
                  associationCategory: "HUBSPOT_DEFINED",
                  associationTypeId: a.associationTypeId,
                },
              ],
            })),
          }
        : {}),
    }),
  );
}

/** HubSpot-defined association type ids used by the app. */
export const ASSOC = {
  dealToContact: 3,
  noteToContact: 202,
  noteToDeal: 214,
  noteToCompany: 190,
  taskToContact: 204,
  taskToDeal: 216,
  taskToCompany: 192,
  callToContact: 194,
  callToDeal: 206,
  meetingToContact: 200,
  meetingToDeal: 212,
  dealToCompany: 5,
} as const;
