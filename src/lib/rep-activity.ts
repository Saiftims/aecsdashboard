/** Daily calls, emails, texts & other-channel touches per role, measured
 * against that role's own targets.
 *
 * An AE prospecting cold lists and a CSM working a book of customers are doing
 * different jobs at different volumes, so one shared target line flatters one
 * and punishes the other. Reps are grouped by role and each group is charted
 * against its own numbers.
 *
 * Calls AND texts come from Quo where we can map the rep to a Quo seat, because
 * HubSpot's Quo integration only logs an interaction when the number already
 * exists as a contact - it dropped 6 of Chris's 24 dials on 2026-07-31. Emails
 * stay on HubSpot, which sees all of them. Social DMs (LinkedIn, Instagram, ...)
 * exist only where a rep logged them; see lib/activity-channels.ts.
 */
import { bucketOf, isSms } from "@/lib/activity-channels";
import { supabaseService } from "@/lib/supabase/server";
import type { GtmSettings } from "@/lib/settings";

export type RepRole = "ae" | "cs" | "exec";

export interface QuoCallRow {
  call_id: string;
  hubspot_owner_id: string | null;
  direction: string | null;
  created_at: string | null;
}

export interface QuoMessageRow {
  message_id: string;
  hubspot_owner_id: string | null;
  direction: string | null;
  created_at: string | null;
}

export interface OwnerRow {
  owner_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  archived: boolean;
}

export interface DayBucket {
  day: string;
  calls: number;
  emails: number;
  /** SMS/texts, from Quo where available. */
  sms: number;
  /** Every other channel in one band: LinkedIn / Instagram / Facebook /
   * WhatsApp DMs, plus meetings, demos and in-person visits. Unmarked notes
   * and tasks are excluded - see buildRoleActivity. */
  other: number;
  /** The stack height, and the number judged against the activity target. */
  total: number;
}

export interface RoleActivity {
  role: Exclude<RepRole, "exec">;
  label: string;
  /** Names of the reps whose activity is in this series. */
  people: string[];
  /** Total touches per day expected of this role, across all channels. */
  activityTarget: number;
  callSource: "quo" | "hubspot";
  smsSource: "quo" | "hubspot";
  data: DayBucket[];
  /** Mean daily total over the window, for "45 of 75 a day" style captions. */
  dailyAverage: number;
}

export const ROLE_LABEL: Record<Exclude<RepRole, "exec">, string> = {
  ae: "AE",
  cs: "CSM",
};

/** Anyone not named in `rep_roles` is an AE, so a new rep is measured against
 * prospecting targets from their first day without a settings change. */
export function roleOf(ownerId: string | null, settings: GtmSettings): RepRole {
  if (!ownerId) return "ae";
  return settings.repRoles[ownerId] ?? "ae";
}

export function ownerName(o: OwnerRow | undefined, ownerId: string): string {
  if (!o) return `Owner ${ownerId}`;
  const n = [o.first_name, o.last_name].filter(Boolean).join(" ").trim();
  return n || o.email || `Owner ${ownerId}`;
}

/** Quo calls, Quo texts and the owner roster. All optional: before the 0006 /
 * 0007 migrations run the tables are absent and the dashboard falls back to
 * HubSpot rows and bare owner ids rather than erroring. */
export async function fetchRepSources(sinceIso: string) {
  const sb = supabaseService();
  const [quo, messages, owners] = await Promise.all([
    sb.from("quo_calls")
      .select("call_id, hubspot_owner_id, direction, created_at")
      .gte("created_at", sinceIso)
      .then((r) => (r.data ?? []) as QuoCallRow[], () => [] as QuoCallRow[]),
    sb.from("quo_messages")
      .select("message_id, hubspot_owner_id, direction, created_at")
      .gte("created_at", sinceIso)
      .then((r) => (r.data ?? []) as QuoMessageRow[], () => [] as QuoMessageRow[]),
    sb.from("crm_owners")
      .select("owner_id, email, first_name, last_name, archived")
      .then((r) => (r.data ?? []) as OwnerRow[], () => [] as OwnerRow[]),
  ]);
  return { quoCalls: quo, quoMessages: messages, owners };
}

/** Owners that Quo can account for. Their HubSpot rows for the same channel are
 * ignored so the two sources never stack. */
export function quoBackedOwners(
  rows: { hubspot_owner_id: string | null }[],
): Set<string> {
  return new Set(
    rows.map((c) => c.hubspot_owner_id).filter((id): id is string => Boolean(id)),
  );
}

/** Whether HubSpot's SMS rows should be ignored wholesale.
 *
 * Unlike calls, HubSpot never learns of a text independently - its SMS
 * Communications records are mirrored FROM Quo - so every one duplicates a
 * quo_messages row. Matching per owner is not enough: HubSpot leaves some of
 * them unowned (7 of 30 in the week of 2026-08-10), and an unowned row cannot
 * be paired with a rep, so it would both double the total and default into the
 * AE series. Once Quo has produced any text in the window it is the only source
 * counted; when it has produced none (sync down, no seats yet) HubSpot's copy
 * is still better than showing zero.
 */
export function textsComeFromQuo(quoMessages: unknown[]): boolean {
  return quoMessages.length > 0;
}

export function localDayLabel(ts: string | Date, tz: string): string {
  const d = new Date(ts);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  const md = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, month: "numeric", day: "numeric",
  }).format(d);
  return `${wd} ${md}`;
}

/** Rolling window of `days` local-day buckets ending today. */
export function emptyDays(days: number, tz: string, now = new Date()): DayBucket[] {
  const out: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push({
      day: localDayLabel(new Date(now.getTime() - i * 86400000), tz),
      calls: 0, emails: 0, sms: 0, other: 0, total: 0,
    });
  }
  return out;
}

interface TouchRow {
  owner_id: string | null;
  occurred_at: string | null;
  /** Derived channel, falling back to the HubSpot object name. */
  type: string;
  /** HubSpot object name. Optional, but without it a task the quick logger
   * stamped with a type (`walk_in`) reads as a channel and counts as contact. */
  kind?: string | null;
}

/** Build one series per role over the last `days` days. */
export function buildRoleActivity({
  touches, quoCalls, quoMessages = [], owners, settings, days = 7, now = new Date(),
}: {
  touches: TouchRow[];
  quoCalls: QuoCallRow[];
  quoMessages?: QuoMessageRow[];
  owners: OwnerRow[];
  settings: GtmSettings;
  days?: number;
  now?: Date;
}): RoleActivity[] {
  const tz = settings.dashboardTimezone;
  const ownerById = new Map(owners.map((o) => [o.owner_id, o]));
  const quoOwners = quoBackedOwners(quoCalls);
  const quoTexts = textsComeFromQuo(quoMessages);

  const roles: Exclude<RepRole, "exec">[] = ["ae", "cs"];
  const series = new Map<string, RoleActivity>();
  for (const role of roles) {
    series.set(role, {
      role,
      label: ROLE_LABEL[role],
      people: [],
      activityTarget: role === "ae"
        ? settings.aeDailyActivityTarget
        : settings.csDailyActivityTarget,
      callSource: "hubspot",
      smsSource: "hubspot",
      data: emptyDays(days, tz, now),
      dailyAverage: 0,
    });
  }
  const index = new Map(
    roles.map((r) => [r, new Map(series.get(r)!.data.map((b, i) => [b.day, i]))]),
  );
  const contributors = new Map<string, Set<string>>(roles.map((r) => [r, new Set()]));

  const bucket = (role: Exclude<RepRole, "exec">, ts: string) => {
    const i = index.get(role)!.get(localDayLabel(ts, tz));
    return i === undefined ? null : series.get(role)!.data[i];
  };

  for (const t of touches) {
    if (!t.occurred_at) continue;
    // A logged touch always carries a type, so a bare "note" is either the
    // agent's own context note or a jotting - not outreach. Counting those
    // would inflate the day's total against the activity target.
    if (t.kind === "task" || t.type === "note" || t.type === "task") continue;
    const role = roleOf(t.owner_id, settings);
    if (role === "exec") continue;
    // Quo owns this rep's dial and text counts; counting HubSpot's copy of the
    // same channel would double it.
    const isCall = t.type === "call" || t.type === "voicemail";
    if (isCall && t.owner_id && quoOwners.has(t.owner_id)) continue;
    if (isSms(t.type) && quoTexts) continue;
    const b = bucket(role, t.occurred_at);
    if (!b) continue;
    b[bucketOf(t.type)] += 1;
    if (t.owner_id) contributors.get(role)!.add(t.owner_id);
  }

  for (const c of quoCalls) {
    if (!c.created_at) continue;
    const role = roleOf(c.hubspot_owner_id, settings);
    if (role === "exec") continue;
    const b = bucket(role, c.created_at);
    if (!b) continue;
    b.calls += 1;
    if (c.hubspot_owner_id) {
      contributors.get(role)!.add(c.hubspot_owner_id);
      series.get(role)!.callSource = "quo";
    }
  }

  for (const m of quoMessages) {
    if (!m.created_at) continue;
    const role = roleOf(m.hubspot_owner_id, settings);
    if (role === "exec") continue;
    const b = bucket(role, m.created_at);
    if (!b) continue;
    b.sms += 1;
    if (m.hubspot_owner_id) {
      contributors.get(role)!.add(m.hubspot_owner_id);
      series.get(role)!.smsSource = "quo";
    }
  }

  for (const role of roles) {
    const s = series.get(role)!;
    s.people = [...contributors.get(role)!]
      .map((id) => ownerName(ownerById.get(id), id))
      .sort();
    for (const b of s.data) b.total = b.calls + b.emails + b.sms + b.other;
    s.dailyAverage = s.data.length
      ? Math.round(s.data.reduce((n, b) => n + b.total, 0) / s.data.length)
      : 0;
  }
  return roles.map((r) => series.get(r)!);
}

/** Today's total activity for one rep, and the channel split behind it.
 *
 * The same source rules as the daily charts: Quo owns dials and texts for a rep
 * it can account for, and unmarked notes are not outreach. */
export function activityTodayFor({
  ownerId, touches, quoCalls, quoMessages = [], settings, now = new Date(),
}: {
  ownerId: string | null;
  touches: TouchRow[];
  quoCalls: QuoCallRow[];
  quoMessages?: QuoMessageRow[];
  settings: GtmSettings;
  now?: Date;
}): { total: number; calls: number; emails: number; sms: number; other: number } {
  const tz = settings.dashboardTimezone;
  const today = localDayLabel(now, tz);
  const quoOwners = quoBackedOwners(quoCalls);
  const quoTexts = textsComeFromQuo(quoMessages);
  const inScope = (id: string | null) => !ownerId || id === ownerId;
  const isTodayFor = (ts: string | null) => Boolean(ts && localDayLabel(ts, tz) === today);

  const out = { total: 0, calls: 0, emails: 0, sms: 0, other: 0 };
  for (const t of touches) {
    if (!isTodayFor(t.occurred_at) || !inScope(t.owner_id)) continue;
    if (t.kind === "task" || t.type === "note" || t.type === "task") continue;
    const isCall = t.type === "call" || t.type === "voicemail";
    if (isCall && t.owner_id && quoOwners.has(t.owner_id)) continue;
    if (isSms(t.type) && quoTexts) continue;
    out[bucketOf(t.type)] += 1;
  }
  for (const c of quoCalls) {
    if (isTodayFor(c.created_at) && inScope(c.hubspot_owner_id)) out.calls += 1;
  }
  for (const m of quoMessages) {
    if (isTodayFor(m.created_at) && inScope(m.hubspot_owner_id)) out.sms += 1;
  }
  out.total = out.calls + out.emails + out.sms + out.other;
  return out;
}

/** Today's call count for one rep, from Quo when Quo knows them. */
export function callsTodayFor({
  ownerId, touches, quoCalls, settings, now = new Date(),
}: {
  ownerId: string | null;
  touches: TouchRow[];
  quoCalls: QuoCallRow[];
  settings: GtmSettings;
  now?: Date;
}): number {
  const tz = settings.dashboardTimezone;
  const today = localDayLabel(now, tz);
  const quoOwners = quoBackedOwners(quoCalls);
  const inScope = (id: string | null) => !ownerId || id === ownerId;

  const fromQuo = quoCalls.filter(
    (c) => c.created_at && inScope(c.hubspot_owner_id) &&
      localDayLabel(c.created_at, tz) === today,
  ).length;
  const fromHubSpot = touches.filter(
    (t) => t.occurred_at && inScope(t.owner_id) &&
      (t.type === "call" || t.type === "voicemail") &&
      !(t.owner_id && quoOwners.has(t.owner_id)) &&
      localDayLabel(t.occurred_at, tz) === today,
  ).length;
  return fromQuo + fromHubSpot;
}
