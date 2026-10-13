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
import { supabaseService } from "@/lib/supabase/server";

export type LeadSource =
  | "metaForm" | "metaUnqualified" | "metaBooking" | "metaRepeat" | "calendly"
  | "website" | "waitList" | "repAdded" | "other";

/** Meta form fills are split by whether FlyTech put the person on its sheet
 * (qualified) or not (unqualified). Both are MQLs (owner, 2026-10-13: "pull
 * them both in as MQLs and just identify the difference"); the raw feed is
 * `meta_leads`, read from the Graph API, and HubSpot's Facebook integration
 * also creates a contact for every one. */
export const LEAD_SOURCES: { key: LeadSource; label: string; color: string }[] = [
  { key: "metaForm", label: "Meta form - qualified (on FlyTech sheet)", color: "hsl(210 70% 50%)" },
  { key: "metaUnqualified", label: "Meta form - unqualified (not on sheet)", color: "hsl(200 45% 68%)" },
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
/** Reps test the website contact form and Calendly with names like "Alex test",
 * "Alex Q — tester", "Saif Altimimi — test"; those deals are not leads. */
export const TEST_LEAD = /\btest(er|ing)?\b|dummy data/i;
export const INTERNAL_EMAIL = /@(silentwitness\.ai|das\.es)$/i;
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

const utcMonthKey = (iso: string) => iso.slice(0, 7);

interface MetaLeadRow {
  leadgen_id: string; created_time: string; form_name: string | null;
  full_name: string | null; email: string | null; company: string | null; is_test: boolean;
}

/** Raw Meta submissions in the window from the `meta_leads` archive. Empty
 * (not null) when the table cannot be read: the HubSpot contacts the FB
 * integration creates still carry every submission, so nothing is lost -
 * only the few Meta test leads HubSpot never received would differ. */
async function loadMetaApiLeads(sinceIso: string, untilIso: string): Promise<MetaLeadRow[]> {
  try {
    const { data, error } = await supabaseService().from("meta_leads")
      .select("leadgen_id, created_time, form_name, full_name, email, company, is_test")
      .gte("created_time", sinceIso).lte("created_time", untilIso)
      .order("created_time", { ascending: true }).limit(5000);
    if (error) throw error;
    return (data ?? []) as MetaLeadRow[];
  } catch (e) {
    console.error("loadMetaApiLeads:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Every lead between `since` and `now`, each person counted once per `scope`
 * ("" = once in the whole window; a month key = once per calendar month, so a
 * lead from July who fills the form again in October is October's "existing
 * lead came back" rather than vanishing from October). Null when HubSpot
 * could not be read. This is THE definition of a lead: the 7-day tile and the
 * monthly MQL chart both call it, so they cannot disagree (owner, 2026-10-13). */
export async function collectLeads(since: Date, now = new Date(), scopeOf: (at: string) => string = () => ""): Promise<Lead[] | null> {
  const sinceIso = since.toISOString();
  const leads: Lead[] = [];
  try {
    const [deals, converted, sheet, metaApi] = await Promise.all([
      searchAll("deals", [{ filters: [
        { propertyName: "createdate", operator: "GTE", value: sinceIso },
        { propertyName: "pipeline", operator: "EQ", value: SALES_PIPELINE_ID },
      ] }], ["dealname", "createdate", "hs_object_source", "hs_object_source_detail_1", "sw_activation_stage"]),
      searchAll("contacts", [
        { filters: [{ propertyName: "recent_conversion_date", operator: "GTE", value: sinceIso }] },
        { filters: [{ propertyName: "first_conversion_date", operator: "GTE", value: sinceIso }] },
      ], CONTACT_PROPS),
      loadMetaSheetRows(),
      loadMetaApiLeads(sinceIso, now.toISOString()),
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
    // Everyone Meta itself says filled a form, qualified or not.
    const metaKeys = new Set<string>();
    for (const r of metaApi) {
      if (r.is_test) continue;
      for (const k of [r.email ?? "", normName(r.full_name)].filter(Boolean)) metaKeys.add(k);
    }
    // FlyTech's sheet is the qualification record: on it = qualified.
    const qualified = (keys: string[]) => keys.some((k) => sheetForm.has(k));
    const metaFormSource = (keys: string[]): LeadSource => qualified(keys) ? "metaForm" : "metaUnqualified";
    // Everyone already represented within a scope, so no person is counted
    // twice in it.
    const seen = new Map<string, Set<string>>();
    const remember = (at: string, keys: string[]) => {
      const s = seen.get(scopeOf(at)) ?? new Set<string>();
      keys.filter(Boolean).forEach((k) => s.add(k));
      seen.set(scopeOf(at), s);
    };
    const known = (at: string, keys: string[]) => {
      const s = seen.get(scopeOf(at));
      return !!s && keys.filter(Boolean).some((k) => s.has(k));
    };

    for (const d of newDeals.sort((a, b) => (a.properties.createdate ?? "").localeCompare(b.properties.createdate ?? ""))) {
      const c = contacts.get((dealContacts.get(d.id) ?? [])[0] ?? "");
      const name = d.properties.dealname ?? "";
      if (TEST_LEAD.test(name) || emailsOf(c).some((e) => INTERNAL_EMAIL.test(e))) continue;
      const at = d.properties.createdate ?? sinceIso;
      const keys = [...emailsOf(c), normName(fullName(c)), normName(name)];
      if (known(at, keys)) continue;
      const src = d.properties.hs_object_source;
      const app = d.properties.hs_object_source_detail_1 ?? "";
      let source: LeadSource;
      if (isMetaContact(c) || keys.some((k) => sheetForm.has(k) || metaKeys.has(k))) source = metaFormSource(keys);
      else if (keys.some((k) => sheetBooking.has(k))) source = "metaBooking";
      else if (/^contact form/i.test(name)) source = "website";
      else if (/^wait list/i.test(name)) source = "waitList";
      else if (/calendly|groiwth/i.test(app)) source = "calendly";
      else if (src === "CRM_UI" || src === "IMPORT") source = "repAdded";
      else source = "other";
      remember(at, keys);
      leads.push({
        at, name, source,
        detail: [fullName(c), c?.properties.email].filter(Boolean).join(" · ") || "no contact",
        dealId: d.id, contactId: c?.id ?? null,
      });
    }

    // Form submissions that have not become a new deal: a first-time ad lead
    // nobody has worked yet, or an existing lead submitting again. HubSpot
    // keeps only the first and the latest conversion per contact, so those
    // are the submissions that can be dated.
    for (const c of converted) {
      const name = fullName(c);
      if (TEST_LEAD.test(name) || emailsOf(c).some((e) => INTERNAL_EMAIL.test(e))) continue;
      const keys = [...emailsOf(c), normName(name)];
      const hasDeal = Number(c.properties.num_associated_deals ?? 0) > 0;
      const conversions = [
        [c.properties.first_conversion_date, c.properties.first_conversion_event_name],
        [c.properties.recent_conversion_date, c.properties.recent_conversion_event_name],
      ].filter((x): x is [string, string] => !!x[0] && x[0] >= sinceIso)
        .filter((x, i, all) => i === 0 || scopeOf(x[0]) !== scopeOf(all[0][0]));
      conversions.forEach(([at, event], i) => {
        if (known(at, keys)) return;
        remember(at, keys);
        const meta = META_FORM.test(event ?? "");
        const repeat = hasDeal || i > 0;
        leads.push({
          at, name: name || c.properties.email || c.id,
          source: meta ? (repeat ? "metaRepeat" : metaFormSource(keys)) : "website",
          detail: `${(event ?? "").replace(/^Facebook Lead Ads:\s*/i, "")}${hasDeal ? " · already had a deal" : i > 0 ? " · submitted again" : " · no deal yet"}`,
          dealId: null, contactId: c.id,
        });
      });
    }

    // Sheet rows in the window that nothing above accounts for. Someone HubSpot
    // already knew from before the window (a re-booking, a second form) is an
    // existing lead coming back, not a new one.
    const candidates = (sheet ?? []).filter((r) =>
      r.at && r.at >= sinceIso && r.at <= now.toISOString() &&
      !TEST_LEAD.test(r.name) && !known(r.at, [r.email, normName(r.name)]));
    // Likewise submissions Meta reports that nothing above produced. Usually a
    // MIDDLE submission: HubSpot keeps only a contact's first and latest
    // conversion, so a July lead who filled the form again in August and
    // again in September has no August date in HubSpot - Meta has it. Rarely
    // a form fill HubSpot's integration never received at all (it held 235 of
    // the 239 Meta still had on 2026-10-13; the rest were Meta's test leads).
    const metaLeft = metaApi.filter((r) =>
      !r.is_test && !TEST_LEAD.test(r.full_name ?? "") && !INTERNAL_EMAIL.test(r.email ?? "") &&
      !known(r.created_time, [r.email ?? "", normName(r.full_name)]));
    const emails = [...new Set([
      ...candidates.map((r) => r.email), ...metaLeft.map((r) => r.email ?? ""),
    ].filter(Boolean))];
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
      if (known(r.at!, keys)) continue;
      remember(r.at!, keys);
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

    for (const r of metaLeft) {
      const name = r.full_name ?? "";
      const keys = [r.email ?? "", normName(name)];
      if (known(r.created_time, keys)) continue;
      remember(r.created_time, keys);
      const c = existing.get(r.email ?? "");
      leads.push({
        at: r.created_time, name: name || r.email || r.leadgen_id,
        source: c ? "metaRepeat" : metaFormSource(keys),
        detail: `${r.form_name ?? "Meta form"}${r.company ? ` · ${r.company}` : ""}${
          c ? " · filled the form again · already in HubSpot" : " · from Meta only - not in HubSpot"}`,
        dealId: null, contactId: c?.id ?? null,
      });
    }
  } catch (e) {
    console.error("collectLeads:", e instanceof Error ? e.message : e);
    return null;
  }
  return leads.sort((a, b) => b.at.localeCompare(a.at));
}

const emptyBySource = () => Object.fromEntries(LEAD_SOURCES.map((s) => [s.key, 0])) as Record<LeadSource, number>;

export interface MonthlyLeads {
  ok: boolean;
  months: ({ month: string; key: string; count: number } & Record<LeadSource, number>)[];
  /** The leads behind each month, keyed "YYYY-MM". */
  members: Record<string, Lead[]>;
}

/** Leads per calendar month (UTC) since `since`, each person once per month.
 * This IS the "MQLs per month" series. */
export async function monthlyLeads(since: Date, now = new Date()): Promise<MonthlyLeads> {
  const leads = await collectLeads(since, now, utcMonthKey);
  if (!leads) return { ok: false, months: [], members: {} };
  const members: Record<string, Lead[]> = {};
  for (const l of leads) (members[utcMonthKey(l.at)] ??= []).push(l);
  const label = (key: string) =>
    new Date(`${key}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const months = Object.keys(members).sort().map((key) => {
    const row = { month: label(key), key, count: members[key].length, ...emptyBySource() };
    for (const l of members[key]) row[l.source] += 1;
    return row;
  });
  return { ok: true, months, members };
}

export async function leadsReport(tz: string, days = 7, now = new Date()): Promise<LeadsReport> {
  const leads = await collectLeads(new Date(now.getTime() - days * 86400000), now);
  if (!leads) return { ok: false, leads: [], daily: [] };
  const empty = emptyBySource;
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
