/** Demos per qualified lead, by week - the AE's conversion rate on the leads
 * he is given, which is the number weekly demo counts cannot show.
 *
 * Owner, 2026-10-28, after a deep dive into "Alex is really slow at booking
 * demos this week": his bookings were on pace like-for-like, but 15 of his 16
 * demos the week before were booked the SAME DAY the lead arrived, so his
 * weekly total is fresh qualified-lead supply times connect rate and swings
 * with FlyTech's volume and the day of the week. "yes lets measure demos per
 * qualified lead."
 *
 * QUALIFIED LEAD = an inbound lead the AE is expected to book: a Meta form
 * fill FlyTech put on its sheet (`metaForm`), a website form, or the wait
 * list. Unqualified Meta fills (chiropractors, "YOUTUBE") are counted as MQLs
 * elsewhere but are not his to convert; repeats, Calendly/Meta direct bookings
 * (already demos) and rep-added deals are not inbound supply.
 *
 * A lead is CONVERTED when its deal has a demo: `sw_demo_booked_at` stamped by
 * the agent's demo credit, `sw_demo_date` from Calendly, or the deal sitting
 * at Demo Scheduled or beyond. Cohort basis - a lead that arrived on Friday and
 * booked on Monday counts for Friday's week - so the latest weeks will still
 * move. Who booked it comes from `sw_demo_booked_by` (write-once): a rep with
 * the `ae` role, blank = self-serve, anyone else = another rep.
 */
import { collectLeads, type Lead, type LeadSource } from "@/lib/leads";
import { SALES_PIPELINE_ID, SALES_STAGES } from "@/lib/hubspot/stages";
import { roleOf } from "@/lib/rep-activity";
import { loadSettings, type GtmSettings } from "@/lib/settings";
import { selectAll } from "@/lib/supabase/server";

export const QUALIFIED_SOURCES: readonly LeadSource[] = ["metaForm", "website", "waitList"];

const DEMO_STAGES = new Set<string>([
  SALES_STAGES.demoScheduled, SALES_STAGES.demoCompleted, SALES_STAGES.firstCaseIdentified,
  SALES_STAGES.firstCaseCommitted, SALES_STAGES.closedWon,
]);

export type BookedBy = "ae" | "self" | "other" | "pending";

export interface LeadConversion {
  name: string;
  source: LeadSource;
  detail: string;
  arrivedAt: string;
  weekStart: string;
  dealId: string | null;
  contactId: string | null;
  stage: string | null;
  booked: boolean;
  bookedAt: string | null;
  bookedBy: BookedBy | null;
}

export interface WeekConversion {
  /** Monday, YYYY-MM-DD in the dashboard timezone. */
  weekStart: string;
  label: string;
  partial: boolean;
  qualified: number;
  booked: number;
  /** booked / qualified, null with no leads. */
  rate: number | null;
  bookedByAe: number;
  selfServe: number;
  otherOrPending: number;
  /** Every demo the AE booked in the week, whatever the lead's age or source. */
  aeDemos: number;
}

export interface DemosPerLeadReport {
  ok: boolean;
  weeks: WeekConversion[];
  current: WeekConversion | null;
  /** The completed weeks before this one, pooled. */
  trailing: { weeks: number; qualified: number; booked: number; rate: number | null };
  leads: LeadConversion[];
}

const WEEKS = 8;

function localYmd(d: Date, tz: string): { y: number; m: number; d: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), dow };
}

/** Monday of the local week holding `d`, as YYYY-MM-DD. */
export function weekStartOf(d: Date, tz: string): string {
  const { y, m, d: day, dow } = localYmd(d, tz);
  const back = (dow + 6) % 7; // Mon=0 ... Sun=6
  const u = new Date(Date.UTC(y, m - 1, day - back));
  return u.toISOString().slice(0, 10);
}

/** The instant local midnight falls on for a YYYY-MM-DD in `tz`. */
function zonedMidnight(ymd: string, tz: string): Date {
  const guess = new Date(`${ymd}T00:00:00Z`);
  // The zone's offset at that instant: what the wall clock reads, as if UTC,
  // minus the instant itself. Local midnight is the UTC guess shifted by it.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(guess);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second"));
  return new Date(guess.getTime() - (wall - guess.getTime()));
}

function weekLabel(ymd: string): string {
  const a = new Date(`${ymd}T00:00:00Z`);
  const b = new Date(a.getTime() + 6 * 86_400_000);
  const f = (d: Date, withMonth: boolean) =>
    d.toLocaleDateString("en-US", { timeZone: "UTC", ...(withMonth ? { month: "short" } : {}), day: "numeric" });
  return `${f(a, true)} – ${f(b, a.getUTCMonth() !== b.getUTCMonth())}`;
}

export async function demosPerLeadReport(now = new Date(), settingsIn?: GtmSettings): Promise<DemosPerLeadReport> {
  const settings = settingsIn ?? await loadSettings();
  const tz = settings.dashboardTimezone;
  const thisWeek = weekStartOf(now, tz);
  const weekStarts: string[] = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const d = new Date(`${thisWeek}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7 * i);
    weekStarts.push(d.toISOString().slice(0, 10));
  }
  const since = zonedMidnight(weekStarts[0], tz);
  const empty: DemosPerLeadReport = {
    ok: false, weeks: [], current: null, trailing: { weeks: 0, qualified: 0, booked: 0, rate: null }, leads: [],
  };

  const [all, deals] = await Promise.all([
    collectLeads(since, now).catch(() => null),
    selectAll<{
      hubspot_id: string; stage: string | null; pipeline: string | null; is_activation: boolean | null;
      primary_contact_id: string | null; properties: Record<string, unknown> | null;
    }>("deals", "hubspot_id, stage, pipeline, is_activation, primary_contact_id, properties"),
  ]);
  if (!all) return empty;

  const byId = new Map(deals.map((d) => [d.hubspot_id, d]));
  const byContact = new Map<string, typeof deals>();
  for (const d of deals) {
    if (!d.primary_contact_id || d.is_activation) continue;
    if (d.pipeline && d.pipeline !== SALES_PIPELINE_ID) continue;
    byContact.set(d.primary_contact_id, [...(byContact.get(d.primary_contact_id) ?? []), d]);
  }
  const prop = (d: (typeof deals)[number] | undefined, k: string) => {
    const v = d?.properties?.[k];
    return typeof v === "string" && v ? v : null;
  };
  const isDemo = (d: (typeof deals)[number] | undefined) =>
    !!d && (!!prop(d, "sw_demo_booked_at") || !!prop(d, "sw_demo_date") || DEMO_STAGES.has(d.stage ?? ""));
  const bookedBy = (d: (typeof deals)[number]): BookedBy => {
    const by = prop(d, "sw_demo_booked_by");
    if (by) return roleOf(by, settings) === "ae" ? "ae" : "other";
    return prop(d, "sw_demo_booked_at") ? "self" : "pending";
  };

  const leads: LeadConversion[] = all
    .filter((l: Lead) => QUALIFIED_SOURCES.includes(l.source))
    .map((l) => {
      let deal = l.dealId ? byId.get(l.dealId) : undefined;
      if (!deal && l.contactId) {
        const cands = byContact.get(l.contactId) ?? [];
        deal = cands.find(isDemo) ?? cands[0];
      }
      const booked = isDemo(deal);
      return {
        name: l.name, source: l.source, detail: l.detail, arrivedAt: l.at,
        weekStart: weekStartOf(new Date(l.at), tz),
        dealId: deal?.hubspot_id ?? l.dealId, contactId: l.contactId,
        stage: deal?.stage ?? null, booked,
        bookedAt: booked ? prop(deal, "sw_demo_booked_at") ?? prop(deal, "sw_demo_date") : null,
        bookedBy: booked && deal ? bookedBy(deal) : null,
      };
    })
    .sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt));

  // AE demos by week, every lead: the output number the conversion explains.
  const aeDemosByWeek = new Map<string, number>();
  for (const d of deals) {
    const by = prop(d, "sw_demo_booked_by");
    const at = prop(d, "sw_demo_booked_at");
    if (!by || !at || roleOf(by, settings) !== "ae") continue;
    const w = weekStartOf(new Date(at), tz);
    aeDemosByWeek.set(w, (aeDemosByWeek.get(w) ?? 0) + 1);
  }

  const weeks: WeekConversion[] = weekStarts.map((ws) => {
    const rows = leads.filter((l) => l.weekStart === ws);
    const booked = rows.filter((l) => l.booked);
    const n = (k: BookedBy) => booked.filter((l) => l.bookedBy === k).length;
    return {
      weekStart: ws, label: weekLabel(ws), partial: ws === thisWeek,
      qualified: rows.length, booked: booked.length,
      rate: rows.length ? booked.length / rows.length : null,
      bookedByAe: n("ae"), selfServe: n("self"), otherOrPending: n("other") + n("pending"),
      aeDemos: aeDemosByWeek.get(ws) ?? 0,
    };
  });
  const done = weeks.filter((w) => !w.partial);
  const tq = done.reduce((s, w) => s + w.qualified, 0);
  const tb = done.reduce((s, w) => s + w.booked, 0);
  return {
    ok: true, weeks, current: weeks.find((w) => w.partial) ?? null,
    trailing: { weeks: done.length, qualified: tq, booked: tb, rate: tq ? tb / tq : null },
    leads,
  };
}

export const pctOf = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);
