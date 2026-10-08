/** Every new lead in a recent window, from every place one can land, each
 * counted once and tagged with where it came from.
 *
 * A deal alone undercounts: HubSpot's Facebook Lead Ads integration creates a
 * CONTACT for each ad-form submission and no deal, so a form fill nobody has
 * worked yet is invisible to a deal count. The marketing sheet alone
 * undercounts the other way - it never sees website forms, Calendly bookings
 * or leads a rep adds. So the window is read live from HubSpot (deals created
 * plus contacts that converted) and merged with the sheet, keyed by person. */
import { hsAssociationsBatch, hsRequest, type HsObject } from "@/lib/hubspot/client";
import { SALES_PIPELINE_ID } from "@/lib/hubspot/stages";
import { loadMetaSheetRows, normName } from "@/lib/meta-leads";
import { localDayLabel } from "@/lib/rep-activity";

export type LeadSource =
  | "metaForm" | "metaBooking" | "metaRepeat" | "calendly"
  | "website" | "waitList" | "repAdded" | "other";

export const LEAD_SOURCES: { key: LeadSource; label: string; color: string }[] = [
  { key: "metaForm", label: "Meta form fill", color: "hsl(210 70% 50%)" },
  { key: "metaBooking", label: "Meta direct booking", color: "hsl(265 55% 58%)" },
  { key: "metaRepeat", label: "Meta - existing lead came back", color: "hsl(205 60% 75%)" },
  { key: "calendly", label: "Calendly booking", color: "hsl(160 55% 42%)" },
  { key: "website", label: "Website form", color: "hsl(38 92% 50%)" },
  { key: "waitList", label: "Wait list", color: "hsl(15 70% 55%)" },
  { key: "repAdded", label: "Added by a rep", color: "hsl(330 55% 55%)" },
  { key: "other", label: "Other", color: "hsl(220 9% 70%)" },
];

export interface Lead {
  at: string;
  name: string;
  source: LeadSource;
  detail: string;
  dealId: string | null;
  contactId: string | null;
}

export interface LeadsReport {
  /** False when HubSpot could not be read; callers fall back to their own count. */
  ok: boolean;
  leads: Lead[];
  daily: ({ day: string; total: number } & Record<LeadSource, number>)[];
}

const NOT_A_LEAD = /intake|silent\s?witness|laura\s*saint\s*clair|nathan\s*nale|chris\s*sanz/i;
const TEST_LEAD = /test lead|dummy data/i;
const META_FORM = /facebook lead ads/i;
const CONTACT_PROPS = [
  "email", "firstname", "lastname", "hs_additional_emails", "hs_analytics_source",
  "recent_conversion_date", "recent_conversion_event_name",
  "first_conversion_date", "first_conversion_event_name", "num_associated_deals",
];

async function searchAll(object: string, filterGroups: unknown[], properties: string[]): Promise<HsObject[]> {
  const out: HsObject[] = [];
  let after: string | undefined;
  do {
    const page = await hsRequest<{ results: HsObject[]; paging?: { next?: { after?: string } } }>(
      "POST", `/crm/v3/objects/${object}/search`,
      { filterGroups, properties, limit: 100, ...(after ? { after } : {}) });
    out.push(...page.results);
    after = page.paging?.next?.after;
  } while (after);
  return out;
}

async function readContacts(ids: string[]): Promise<HsObject[]> {
  const out: HsObject[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hsRequest<{ results: HsObject[] }>("POST", "/crm/v3/objects/contacts/batch/read", {
      inputs: ids.slice(i, i + 100).map((id) => ({ id })), properties: CONTACT_PROPS,
    });
    out.push(...r.results);
  }
  return out;
}

const fullName = (c: HsObject | undefined) =>
  `${c?.properties.firstname ?? ""} ${c?.properties.lastname ?? ""}`.trim();
const emailsOf = (c: HsObject | undefined) =>
  [c?.properties.email, ...(c?.properties.hs_additional_emails ?? "").split(";")]
    .map((e) => (e ?? "").trim().toLowerCase()).filter(Boolean);
const isMetaContact = (c: HsObject | undefined) =>
  META_FORM.test(c?.properties.first_conversion_event_name ?? "") ||
  META_FORM.test(c?.properties.recent_conversion_event_name ?? "");

export async function leadsReport(tz: string, days = 7, now = new Date()): Promise<LeadsReport> {
  const since = new Date(now.getTime() - days * 86400000);
  const sinceIso = since.toISOString();
  const leads: Lead[] = [];
  try {
    const [deals, converted, sheet] = await Promise.all([
      searchAll("deals", [{ filters: [
        { propertyName: "createdate", operator: "GTE", value: sinceIso },
        { propertyName: "pipeline", operator: "EQ", value: SALES_PIPELINE_ID },
      ] }], ["dealname", "createdate", "hs_object_source", "hs_object_source_detail_1", "sw_activation_stage"]),
      searchAll("contacts", [
        { filters: [{ propertyName: "recent_conversion_date", operator: "GTE", value: sinceIso }] },
        { filters: [{ propertyName: "first_conversion_date", operator: "GTE", value: sinceIso }] },
      ], CONTACT_PROPS),
      loadMetaSheetRows(),
    ]);
    const newDeals = deals.filter((d) =>
      !NOT_A_LEAD.test(d.properties.dealname ?? "") && !d.properties.sw_activation_stage);

    const { map: dealContacts } = await hsAssociationsBatch("deals", "contacts", newDeals.map((d) => d.id));
    const contacts = new Map((await readContacts(
      [...new Set([...dealContacts.values()].flat())])).map((c) => [c.id, c]));

    const sheetForm = new Set<string>();
    const sheetBooking = new Set<string>();
    for (const r of sheet ?? []) {
      for (const k of [r.email, normName(r.name)].filter(Boolean)) {
        (r.tab === "form" ? sheetForm : sheetBooking).add(k);
      }
    }
    // Everyone already represented, so no person is counted twice.
    const seen = new Set<string>();
    const remember = (keys: string[]) => keys.filter(Boolean).forEach((k) => seen.add(k));
    const known = (keys: string[]) => keys.filter(Boolean).some((k) => seen.has(k));

    for (const d of newDeals) {
      const c = contacts.get((dealContacts.get(d.id) ?? [])[0] ?? "");
      const name = d.properties.dealname ?? "";
      const keys = [...emailsOf(c), normName(fullName(c)), normName(name)];
      const src = d.properties.hs_object_source;
      const app = d.properties.hs_object_source_detail_1 ?? "";
      let source: LeadSource;
      if (isMetaContact(c) || keys.some((k) => sheetForm.has(k))) source = "metaForm";
      else if (keys.some((k) => sheetBooking.has(k))) source = "metaBooking";
      else if (/^contact form/i.test(name)) source = "website";
      else if (/^wait list/i.test(name)) source = "waitList";
      else if (/calendly|groiwth/i.test(app)) source = "calendly";
      else if (src === "CRM_UI" || src === "IMPORT") source = "repAdded";
      else source = "other";
      remember(keys);
      leads.push({
        at: d.properties.createdate ?? sinceIso, name, source,
        detail: [fullName(c), c?.properties.email].filter(Boolean).join(" · ") || "no contact",
        dealId: d.id, contactId: c?.id ?? null,
      });
    }

    // Form submissions that have not become a new deal: a first-time ad lead
    // nobody has worked yet, or an existing lead submitting again.
    for (const c of converted) {
      const event = c.properties.recent_conversion_event_name ?? c.properties.first_conversion_event_name ?? "";
      const name = fullName(c);
      if (TEST_LEAD.test(name)) continue;
      const keys = [...emailsOf(c), normName(name)];
      if (known(keys)) continue;
      remember(keys);
      const meta = META_FORM.test(event);
      const hasDeal = Number(c.properties.num_associated_deals ?? 0) > 0;
      leads.push({
        at: c.properties.recent_conversion_date ?? c.properties.first_conversion_date ?? sinceIso,
        name: name || c.properties.email || c.id,
        source: meta ? (hasDeal ? "metaRepeat" : "metaForm") : "website",
        detail: `${event.replace(/^Facebook Lead Ads:\s*/i, "")}${hasDeal ? " · already had a deal" : " · no deal yet"}`,
        dealId: null, contactId: c.id,
      });
    }

    // Sheet rows in the window that nothing above accounts for. Someone HubSpot
    // already knew from before the window (a re-booking, a second form) is an
    // existing lead coming back, not a new one.
    const candidates = (sheet ?? []).filter((r) =>
      r.at && r.at >= sinceIso && r.at <= now.toISOString() &&
      !TEST_LEAD.test(r.name) && !known([r.email, normName(r.name)]));
    const emails = [...new Set(candidates.map((r) => r.email).filter(Boolean))];
    const existing = new Map<string, HsObject>();
    for (let i = 0; i < emails.length; i += 50) {
      const chunk = emails.slice(i, i + 50);
      for (const c of await searchAll("contacts", [
        { filters: [{ propertyName: "email", operator: "IN", values: chunk }] },
        { filters: [{ propertyName: "hs_additional_emails", operator: "IN", values: chunk }] },
      ], CONTACT_PROPS)) {
        for (const e of emailsOf(c)) existing.set(e, c);
      }
    }
    for (const r of candidates) {
      const keys = [r.email, normName(r.name)];
      if (known(keys)) continue;
      remember(keys);
      const c = existing.get(r.email);
      leads.push({
        at: r.at!, name: r.name || r.email,
        source: c ? "metaRepeat" : r.tab === "form" ? "metaForm" : "metaBooking",
        detail: c
          ? `${r.tab === "form" ? "filled the form" : "booked"} again · already in HubSpot`
          : "on the Meta sheet only - not in HubSpot",
        dealId: null, contactId: c?.id ?? null,
      });
    }
  } catch (e) {
    console.error("leadsReport:", e instanceof Error ? e.message : e);
    return { ok: false, leads: [], daily: [] };
  }

  leads.sort((a, b) => b.at.localeCompare(a.at));
  const empty = () => Object.fromEntries(LEAD_SOURCES.map((s) => [s.key, 0])) as Record<LeadSource, number>;
  // A rolling window starts part-way through a local day, so it can touch
  // days + 1 calendar days; keep that partial day only if it holds a lead, so
  // the bars always add up to the total.
  const labels = [...new Set(Array.from({ length: days + 1 }, (_, i) =>
    localDayLabel(new Date(now.getTime() - (days - i) * 86400000), tz)))];
  const daily = labels.map((day) => ({ day, total: 0, ...empty() }));
  const index = new Map(daily.map((d, i) => [d.day, i]));
  for (const l of leads) {
    const i = index.get(localDayLabel(l.at, tz));
    if (i === undefined) continue;
    daily[i][l.source] += 1;
    daily[i].total += 1;
  }
  if (daily.length > days && daily[0].total === 0) daily.shift();
  return { ok: true, leads, daily };
}
