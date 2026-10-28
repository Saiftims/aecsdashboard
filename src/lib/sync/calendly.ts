/** Slim Calendly sync: stamps the real demo date (source of truth) onto deals.
 *
 * Looks at active events from the last 60 days + all upcoming, aggregates per
 * invitee email (earliest upcoming booking wins; else most recent attended),
 * maps email -> cached contact -> deal, and updates sw_demo_date /
 * sw_demo_completed in HubSpot when they changed. Stage moves remain with the
 * Python reconcile agent - this only keeps demo DATES fresh.
 *
 * It also REMOVES hiring interviews. Saif's "30 Minute Meeting" Calendly
 * event type is the interview calendar for job candidates, and HubSpot's own
 * Calendly integration turns every booking on it into a contact, a meeting
 * and a Demo Scheduled deal - 13 "self-serve demos" in the week of
 * 2026-10-26 were candidates (owner, 2026-10-28: "those are interviews for
 * candidates, exclude them and remove they are not leads"). Events on an
 * interview event type never stamp a demo date, and their invitees' contact,
 * deals, meetings and notes are deleted from HubSpot and from this cache on
 * every run (incremental sync never purges a deleted record on its own). A
 * candidate who is ALSO a worked lead - a company on the contact, or a deal
 * past Demo Scheduled - is left alone and reported for a human to look at.
 */
import { hsDelete, hsUpdateProperties } from "@/lib/hubspot/client";
import { SALES_STAGES } from "@/lib/hubspot/stages";
import { must, selectAll, supabaseService } from "@/lib/supabase/server";

const BASE = "https://api.calendly.com";

/** Calendly event types that are NOT demos. The Python agent carries the same
 * list in `config.INTERVIEW_EVENT_TYPES`; change both. If Saif ever runs a
 * real demo it has to be on a different event type. */
export const INTERVIEW_EVENT_TYPES = new Set<string>([
  // Saif Altimimi - "30 Minute Meeting" (candidate interviews)
  "https://api.calendly.com/event_types/7beedd22-a712-4834-b0d5-b2dbf8edc742",
]);

/** Deals a candidate may hold and still be purged: nothing a human has
 * progressed. Demo Completed or later means someone ran a demo - review. */
const PURGEABLE_STAGES = new Set<string>([
  SALES_STAGES.unqualified, SALES_STAGES.mql, SALES_STAGES.attemptingContact,
  SALES_STAGES.connected, SALES_STAGES.qualified, SALES_STAGES.demoScheduled,
]);

interface CalendlyEvent {
  uri: string;
  start_time: string;
  status: string;
  event_type?: string;
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

  // 1. events (active only, recent + upcoming). Calendly rejects page_token
  // when the original filter params are re-sent with it (started ~2026-09),
  // so follow the ready-made next_page URL instead of rebuilding the query.
  const events: CalendlyEvent[] = [];
  let next: string | null = "/scheduled_events";
  let firstParams: Record<string, string> | null = {
    organization: org, count: "100", status: "active",
    min_start_time: minStart,
  };
  while (next) {
    const data: {
      collection: CalendlyEvent[];
      pagination?: { next_page?: string | null };
    } = await calGet(next, firstParams ?? {});
    firstParams = null;
    events.push(...data.collection);
    next = data.pagination?.next_page ?? null;
  }

  // 2. invitees per event -> per-email aggregation
  const people = new Map<string, { nextUpcoming: Date | null; lastAttended: Date | null }>();
  // Interview invitees: email -> name as booked (HubSpot's integration names
  // a contact-less deal after the invitee, so the name is the only key then).
  const interviewees = new Map<string, string>();
  for (const ev of events) {
    const start = new Date(ev.start_time);
    const isInterview = INTERVIEW_EVENT_TYPES.has(ev.event_type ?? "");
    const invitees = await calGet<{
      collection: { email?: string; name?: string; no_show?: unknown }[];
    }>(`${ev.uri}/invitees`, { count: "100" });
    for (const inv of invitees.collection ?? []) {
      const email = (inv.email ?? "").trim().toLowerCase();
      if (!email) continue;
      if (isInterview) {
        interviewees.set(email, (inv.name ?? "").trim());
        continue;
      }
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
  // selectAll: `contacts` is ~2,000 rows and a plain select stops at 1,000,
  // so half the invitees silently matched no contact.
  const [contacts, deals] = await Promise.all([
    selectAll<{ hubspot_id: string; email: string | null; company_hubspot_id: string | null }>(
      "contacts", "hubspot_id, email, company_hubspot_id"),
    selectAll<{ hubspot_id: string; name: string | null; primary_contact_id: string | null; company_hubspot_id: string | null; properties: Record<string, unknown> | null; stage: string | null }>(
      "deals", "hubspot_id, name, primary_contact_id, company_hubspot_id, properties, stage"),
  ]);
  const contactByEmail = new Map(
    contacts.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c.hubspot_id]),
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
      await must(`deals demo-date update ${deal.hubspot_id}`, sb.from("deals").update({
        properties: { ...(deal.properties ?? {}), ...upd },
      }).eq("hubspot_id", deal.hubspot_id));
    }
  }
  // 4. hand-moved demos: a deal the CSM put in Demo Completed with no attended
  // Calendly event behind it still ran a demo - ad-hoc Zoom, phone - and the
  // stage move is the only record of it (owner-confirmed 2026-08-28). Stamp it
  // like an attended demo, dated by when the deal entered the stage, so every
  // consumer of sw_demo_completed sees one consistent truth. Write-once: an
  // existing stamp or demo date is never overwritten, and the stage itself is
  // never touched - the pipeline stays the CSM's.
  let handMoved = 0;
  for (const d of deals ?? []) {
    if (d.stage !== SALES_STAGES.demoCompleted) continue;
    const props = (d.properties ?? {}) as Record<string, unknown>;
    if (String(props.sw_demo_completed ?? "") === "true") continue;
    const entered = props.hs_v2_date_entered_current_stage;
    if (typeof entered !== "string" || !entered) continue;
    const upd: Record<string, string> = { sw_demo_completed: "true" };
    if (!props.sw_demo_date) upd.sw_demo_date = entered.slice(0, 10);
    const res = await hsUpdateProperties("deals", d.hubspot_id, upd);
    if (res.ok) {
      handMoved += 1;
      await must(`deals hand-moved demo update ${d.hubspot_id}`, sb.from("deals").update({
        properties: { ...props, ...upd },
      }).eq("hubspot_id", d.hubspot_id));
    }
  }

  // 5. interviews out of the CRM (see header).
  const interviews = await purgeInterviews(interviewees, people, contacts, deals);

  return {
    events: events.length, invitees: people.size, demoDatesUpdated: updated,
    handMovedStamped: handMoved, ...interviews,
  };
}

const normName = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function purgeInterviews(
  interviewees: Map<string, string>,
  demoPeople: Map<string, unknown>,
  contacts: { hubspot_id: string; email: string | null; company_hubspot_id: string | null }[],
  deals: { hubspot_id: string; name: string | null; primary_contact_id: string | null; company_hubspot_id: string | null; stage: string | null }[],
): Promise<{ interviewsPurged: number; interviewsNeedReview: string[] }> {
  const out = { interviewsPurged: 0, interviewsNeedReview: [] as string[] };
  if (!interviewees.size) return out;
  const sb = supabaseService();
  const contactByEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c]));
  const dealsByContact = new Map<string, typeof deals>();
  const bareDemoDealsByName = new Map<string, typeof deals>();
  const companyDeals = new Map<string, number>();
  const companyContacts = new Map<string, number>();
  for (const d of deals) {
    if (d.company_hubspot_id) companyDeals.set(d.company_hubspot_id, (companyDeals.get(d.company_hubspot_id) ?? 0) + 1);
    if (d.primary_contact_id) {
      dealsByContact.set(d.primary_contact_id, [...(dealsByContact.get(d.primary_contact_id) ?? []), d]);
    } else if (d.stage === SALES_STAGES.demoScheduled && d.name) {
      const k = normName(d.name);
      bareDemoDealsByName.set(k, [...(bareDemoDealsByName.get(k) ?? []), d]);
    }
  }
  for (const c of contacts) {
    if (c.company_hubspot_id) companyContacts.set(c.company_hubspot_id, (companyContacts.get(c.company_hubspot_id) ?? 0) + 1);
  }

  for (const [email, name] of interviewees) {
    const contact = contactByEmail.get(email);
    const linked = contact ? dealsByContact.get(contact.hubspot_id) ?? [] : [];
    // HubSpot's integration also makes contact-less deals named after the invitee.
    const bare = name ? bareDemoDealsByName.get(normName(name)) ?? [] : [];
    if (!contact && !bare.length) continue; // nothing cached for them (yet)
    // A company HubSpot auto-created from the candidate's email domain (only
    // this contact, no deal) is not a worked account; one with a deal or other
    // people behind it is, and that candidate is left for a human.
    const companyId = contact?.company_hubspot_id ?? null;
    const bareCompany = !!companyId && !(companyDeals.get(companyId) ?? 0) && (companyContacts.get(companyId) ?? 0) <= 1;
    if (demoPeople.has(email) || (companyId && !bareCompany) ||
        linked.some((d) => !PURGEABLE_STAGES.has(d.stage ?? ""))) {
      out.interviewsNeedReview.push(`${name || email} <${email}>`);
      continue;
    }
    const dealIds = [...linked, ...bare].map((d) => d.hubspot_id);
    const actFilter = [
      contact ? `contact_hubspot_id.eq.${contact.hubspot_id}` : null,
      dealIds.length ? `deal_hubspot_id.in.(${dealIds.join(",")})` : null,
    ].filter(Boolean).join(",");
    const acts = (await sb.from("activities").select("hubspot_id, kind").or(actFilter)).data ?? [];

    let ok = true;
    for (const a of acts as { hubspot_id: string; kind: string }[]) {
      // Only the integration's own records; a call Alex logged stays as history.
      if (a.kind !== "meeting" && a.kind !== "note") continue;
      ok = (await hsDelete(`${a.kind}s`, a.hubspot_id)).ok && ok;
    }
    for (const id of dealIds) ok = (await hsDelete("deals", id)).ok && ok;
    if (contact) ok = (await hsDelete("contacts", contact.hubspot_id)).ok && ok;
    if (ok && bareCompany) ok = (await hsDelete("companies", companyId!)).ok;
    if (!ok) {
      out.interviewsNeedReview.push(`${name || email} <${email}> (HubSpot delete failed)`);
      continue;
    }
    if (acts.length) {
      await must(`activities purge ${email}`, sb.from("activities").delete()
        .in("hubspot_id", acts.map((a: { hubspot_id: string }) => a.hubspot_id)));
    }
    if (dealIds.length) await must(`deals purge ${email}`, sb.from("deals").delete().in("hubspot_id", dealIds));
    if (contact) await must(`contacts purge ${email}`, sb.from("contacts").delete().eq("hubspot_id", contact.hubspot_id));
    if (bareCompany) await must(`companies purge ${email}`, sb.from("companies").delete().eq("hubspot_id", companyId!));
    out.interviewsPurged += 1;
  }
  return out;
}
