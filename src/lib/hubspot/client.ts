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

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env.hubspotToken()}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    if (res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      throw new HubSpotError(
        `${method} ${url.pathname} -> ${res.status}: ${await res.text()}`,
        res.status,
      );
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

/** Incremental: objects modified since `sinceMs` (epoch millis), via search API. */
export async function hsListModifiedSince(
  object: string,
  properties: string[],
  sinceMs: number,
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
