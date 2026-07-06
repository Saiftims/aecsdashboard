/** Slim Calendly sync: stamps the real demo date (source of truth) onto deals.
 *
 * Looks at active events from the last 60 days + all upcoming, aggregates per
 * invitee email (earliest upcoming booking wins; else most recent attended),
 * maps email -> cached contact -> deal, and updates sw_demo_date /
 * sw_demo_completed in HubSpot when they changed. Stage moves remain with the
 * Python reconcile agent - this only keeps demo DATES fresh.
 */
import { hsUpdateProperties } from "@/lib/hubspot/client";
import { supabaseService } from "@/lib/supabase/server";

const BASE = "https://api.calendly.com";

interface CalendlyEvent {
  uri: string;
  start_time: string;
  status: string;
}

async function calGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const token = (process.env.CALENDLY_TOKEN ?? "").trim();
  if (!token) throw new Error("CALENDLY_TOKEN not configured");
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Calendly ${url.pathname} -> ${res.status}`);
    return (await res.json()) as T;
  }
  throw new Error(`Calendly ${url.pathname} -> repeated 429`);
}

export async function syncCalendly() {
  const org = (process.env.CALENDLY_ORG ?? "").trim();
  if (!org) throw new Error("CALENDLY_ORG not configured");
  const sb = supabaseService();
  const now = new Date();
  const minStart = new Date(now.getTime() - 60 * 24 * 3600 * 1000).toISOString();

  // 1. events (active only, recent + upcoming)
  const events: CalendlyEvent[] = [];
  let page: string | undefined;
  do {
    const data = await calGet<{
      collection: CalendlyEvent[];
      pagination: { next_page_token?: string };
    }>("/scheduled_events", {
      organization: org, count: "100", status: "active",
      min_start_time: minStart,
      ...(page ? { page_token: page } : {}),
    });
    events.push(...data.collection);
    page = data.pagination?.next_page_token;
  } while (page);

  // 2. invitees per event -> per-email aggregation
  const people = new Map<string, { nextUpcoming: Date | null; lastAttended: Date | null }>();
  for (const ev of events) {
    const start = new Date(ev.start_time);
    const invitees = await calGet<{
      collection: { email?: string; no_show?: unknown }[];
    }>(`${ev.uri}/invitees`, { count: "100" });
    for (const inv of invitees.collection ?? []) {
      const email = (inv.email ?? "").trim().toLowerCase();
      if (!email) continue;
      const p = people.get(email) ?? { nextUpcoming: null, lastAttended: null };
      if (start > now) {
        if (!p.nextUpcoming || start < p.nextUpcoming) p.nextUpcoming = start;
      } else if (inv.no_show === null || inv.no_show === undefined) {
        if (!p.lastAttended || start > p.lastAttended) p.lastAttended = start;
      }
      people.set(email, p);
    }
  }

  // 3. map email -> contact -> deal (from cache), stamp date when changed
  const [{ data: contacts }, { data: deals }] = await Promise.all([
    sb.from("contacts").select("hubspot_id, email"),
    sb.from("deals").select("hubspot_id, primary_contact_id, properties, stage"),
  ]);
  const contactByEmail = new Map(
    (contacts ?? []).filter((c) => c.email).map((c) => [c.email.toLowerCase(), c.hubspot_id]),
  );
  const dealsByContact = new Map<string, typeof deals>();
  for (const d of deals ?? []) {
    if (!d.primary_contact_id) continue;
    dealsByContact.set(d.primary_contact_id,
      [...(dealsByContact.get(d.primary_contact_id) ?? []), d]);
  }

  let updated = 0;
  for (const [email, p] of people) {
    const demoDt = p.nextUpcoming ?? p.lastAttended;
    if (!demoDt) continue;
    const contactId = contactByEmail.get(email);
    if (!contactId) continue;
    const candidates = dealsByContact.get(contactId) ?? [];
    if (!candidates.length) continue;
    const deal = candidates[0];
    const desired = demoDt.toISOString().slice(0, 10);
    const completed = p.lastAttended && !p.nextUpcoming ? "true" : null;
    const curDate = ((deal.properties?.sw_demo_date as string) ?? "").slice(0, 10);
    const curDone = (deal.properties?.sw_demo_completed as string) ?? "";
    const upd: Record<string, string> = {};
    if (curDate !== desired) upd.sw_demo_date = desired;
    if (completed === "true" && curDone !== "true") upd.sw_demo_completed = "true";
    if (!Object.keys(upd).length) continue;
    const res = await hsUpdateProperties("deals", deal.hubspot_id, upd);
    if (res.ok) {
      updated += 1;
      await sb.from("deals").update({
        properties: { ...(deal.properties ?? {}), ...upd },
      }).eq("hubspot_id", deal.hubspot_id);
    }
  }
  return { events: events.length, invitees: people.size, demoDatesUpdated: updated };
}
