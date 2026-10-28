/** Speed to lead: how long an inbound MQL waits before a HUMAN touches it.
 *
 * Owner, 2026-10-28: "I want to track how fast we respond to a mql. If it
 * takes 2 hours, 3 hours, 6 hours. I dont want to count the hubspot email
 * automations we setup since that is instant. I only want to count the ones
 * where Alex our AE is actually calling, sms or other activity."
 *
 * LEADS measured: the inbound sources from `collectLeads` that arrive WITHOUT
 * a demo already booked - Meta form fills (qualified or not), website form,
 * wait list. A Calendly / Meta direct booking has answered itself (the demo is
 * the response), a repeat is not a new lead, and a rep-added or outbound deal
 * was made by the person who is already working it. Arrival is the lead's
 * `arrivedAt` - Meta's submission time, not the HubSpot deal - so the clock
 * starts when the person filled the form.
 *
 * TOUCHES counted, all of them things only a human does:
 *   - a Quo call to or from the lead's number (every dial, answered or not -
 *     an attempt IS the rep responding), matched by E.164 phone;
 *   - a Quo text to the lead's number;
 *   - a HubSpot call / SMS / LinkedIn-etc. communication / channel-marked
 *     note on the contact or deal, with a human owner;
 * and NOT counted:
 *   - EMAILS, any direction. Alex's owner id carried 637 sent emails in the 30
 *     days to 2026-10-28 and they are HubSpot sequences ("Car accident
 *     physics, automated for $150" x184, "Introducing Silent Witness" x183,
 *     "The crash file, {name}"...), logged under his name, so no owner or
 *     direction filter can separate a hand-written one. A reply the rep
 *     typed is lost with them; calls/texts come first in practice anyway;
 *   - MEETINGS. Every meeting row is a scheduled demo ("Hugh Bean and Chris
 *     Sanz", the Calendly twin) dated at its START time, usually days ahead -
 *     a booking is the outcome of a response, not the response;
 *   - unowned rows (the agent's "Lead context" notes, HubSpot's mirrored SMS
 *     rows with no owner) and tasks.
 *
 * Time is raw clock time, not business hours: a Meta lead that arrives at 3am
 * and is called at 9am reads 6h, which is the number the owner asked for.
 */
import { channelFromText, isOtherChannel, isSms } from "@/lib/activity-channels";
import { collectLeads, type Lead, type LeadSource } from "@/lib/leads";
import { ownerName, type OwnerRow } from "@/lib/rep-activity";
import { supabaseService } from "@/lib/supabase/server";

export const RESPONSE_SOURCES: readonly LeadSource[] = ["metaForm", "metaUnqualified", "website", "waitList"];

/** Buckets the owner asked for, in hours. `null` upper bound = open ended. */
export const SPEED_BUCKETS: { key: string; label: string; maxH: number | null }[] = [
  { key: "h1", label: "Within 1 hour", maxH: 1 },
  { key: "h2", label: "1 – 2 hours", maxH: 2 },
  { key: "h3", label: "2 – 3 hours", maxH: 3 },
  { key: "h6", label: "3 – 6 hours", maxH: 6 },
  { key: "h24", label: "6 – 24 hours", maxH: 24 },
  { key: "later", label: "Over 24 hours", maxH: null },
];

export type TouchChannel = "call" | "sms" | "dm" | "other";

export interface LeadResponse {
  name: string;
  source: LeadSource;
  detail: string;
  arrivedAt: string;
  dealId: string | null;
  contactId: string | null;
  /** First human touch, or null when nobody has reached out yet. */
  firstTouchAt: string | null;
  hours: number | null;
  channel: TouchChannel | null;
  by: string | null;
  byOwnerId: string | null;
  /** Hours since arrival for a lead still untouched. */
  waitingHours: number | null;
}

export interface SpeedToLeadReport {
  /** False when HubSpot could not be read live (collectLeads returned null). */
  ok: boolean;
  days: number;
  leads: LeadResponse[];
  total: number;
  touched: number;
  medianHours: number | null;
  /** Share of ALL leads in the window touched within N hours (untouched count against). */
  within: { h1: number; h3: number; h6: number; h24: number };
  buckets: { key: string; label: string; count: number }[];
  untouched: { count: number; oldestHours: number | null; under1h: number };
  /** Who made the first touch, with their median. */
  byRep: { ownerId: string; name: string; firsts: number; medianHours: number }[];
  byChannel: Record<TouchChannel, number>;
}

interface Touch { at: string; channel: TouchChannel; ownerId: string | null }

/** Digits only, US 10-digit numbers given a leading 1, so Quo's E.164 and
 * HubSpot's free-text phone compare. */
export function normPhone(p: string | null | undefined): string {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length === 10 ? `1${d}` : d;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Quo's clock and HubSpot's can disagree by a few seconds, and a rep who
 * dials the moment the Slack post lands can beat Meta's own timestamp. */
const TOLERANCE_MS = 5 * 60_000;

export async function speedToLeadReport(days = 7, now = new Date()): Promise<SpeedToLeadReport> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const empty: SpeedToLeadReport = {
    ok: false, days, leads: [], total: 0, touched: 0, medianHours: null,
    within: { h1: 0, h3: 0, h6: 0, h24: 0 },
    buckets: SPEED_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: 0 })),
    untouched: { count: 0, oldestHours: null, under1h: 0 },
    byRep: [], byChannel: { call: 0, sms: 0, dm: 0, other: 0 },
  };
  const all = await collectLeads(since, now).catch(() => null);
  if (!all) return empty;
  const leads: Lead[] = all.filter((l) => RESPONSE_SOURCES.includes(l.source));
  if (!leads.length) return { ...empty, ok: true };

  const sb = supabaseService();
  const contactIds = [...new Set(leads.map((l) => l.contactId).filter((x): x is string => !!x))];
  const dealIds = [...new Set(leads.map((l) => l.dealId).filter((x): x is string => !!x))];
  const sinceIso = new Date(since.getTime() - TOLERANCE_MS).toISOString();
  const [contactsRes, actsRes, callsRes, textsRes, ownersRes] = await Promise.all([
    contactIds.length
      ? sb.from("contacts").select("hubspot_id, properties").in("hubspot_id", contactIds)
      : Promise.resolve({ data: [] as { hubspot_id: string; properties: Record<string, unknown> | null }[] }),
    sb.from("activities")
      .select("kind, activity_type, subject, body, owner_id, occurred_at, contact_hubspot_id, deal_hubspot_id")
      .or([
        contactIds.length ? `contact_hubspot_id.in.(${contactIds.join(",")})` : null,
        dealIds.length ? `deal_hubspot_id.in.(${dealIds.join(",")})` : null,
      ].filter(Boolean).join(","))
      .gte("occurred_at", sinceIso),
    sb.from("quo_calls").select("participant, created_at, hubspot_owner_id").gte("created_at", sinceIso)
      .then((r) => r.data ?? [], () => []),
    sb.from("quo_messages").select("participant, direction, created_at, hubspot_owner_id").gte("created_at", sinceIso)
      .then((r) => r.data ?? [], () => []),
    sb.from("crm_owners").select("owner_id, email, first_name, last_name, archived")
      .then((r) => (r.data ?? []) as OwnerRow[], () => [] as OwnerRow[]),
  ]);
  const owners = new Map(ownersRes.map((o) => [o.owner_id, o]));
  const phoneOf = new Map<string, string>();
  for (const c of contactsRes.data ?? []) {
    const p = normPhone((c.properties as { phone?: string } | null)?.phone);
    if (p) phoneOf.set(c.hubspot_id, p);
  }

  // Touches by HubSpot record, humans only, no emails.
  const byContact = new Map<string, Touch[]>();
  const byDeal = new Map<string, Touch[]>();
  const push = (m: Map<string, Touch[]>, k: string | null, t: Touch) => {
    if (!k) return;
    const list = m.get(k) ?? [];
    list.push(t);
    m.set(k, list);
  };
  type Act = { kind: string; activity_type: string | null; subject: string | null; body: string | null;
    owner_id: string | null; occurred_at: string | null; contact_hubspot_id: string | null; deal_hubspot_id: string | null };
  for (const a of (actsRes.data ?? []) as Act[]) {
    if (!a.owner_id || !a.occurred_at) continue;
    let channel: TouchChannel | null = null;
    if (a.kind === "call") channel = "call";
    else if (a.kind === "communication" || a.kind === "note") {
      const type = a.activity_type ?? channelFromText(a.subject ?? a.body);
      if (isSms(type)) channel = "sms";
      else if (isOtherChannel(type)) channel = "dm";
      else if (a.kind === "communication") channel = "other";
    }
    if (!channel) continue;
    const t: Touch = { at: a.occurred_at, channel, ownerId: a.owner_id };
    push(byContact, a.contact_hubspot_id, t);
    push(byDeal, a.deal_hubspot_id, t);
  }
  // Quo by phone: every dial and every outgoing text.
  const byPhone = new Map<string, Touch[]>();
  for (const c of callsRes as { participant: string | null; created_at: string | null; hubspot_owner_id: string | null }[]) {
    if (!c.created_at) continue;
    push(byPhone, normPhone(c.participant) || null, { at: c.created_at, channel: "call", ownerId: c.hubspot_owner_id });
  }
  for (const m of textsRes as { participant: string | null; direction: string | null; created_at: string | null; hubspot_owner_id: string | null }[]) {
    if (!m.created_at || m.direction === "incoming") continue;
    push(byPhone, normPhone(m.participant) || null, { at: m.created_at, channel: "sms", ownerId: m.hubspot_owner_id });
  }

  const rows: LeadResponse[] = leads.map((l) => {
    const t0 = Date.parse(l.at);
    const candidates = [
      ...(l.contactId ? byContact.get(l.contactId) ?? [] : []),
      ...(l.dealId ? byDeal.get(l.dealId) ?? [] : []),
      ...(l.contactId && phoneOf.get(l.contactId) ? byPhone.get(phoneOf.get(l.contactId)!) ?? [] : []),
    ].filter((t) => Date.parse(t.at) >= t0 - TOLERANCE_MS)
      .sort((a, b) => a.at.localeCompare(b.at));
    const first = candidates[0] ?? null;
    const hours = first ? Math.max(0, (Date.parse(first.at) - t0) / 3_600_000) : null;
    return {
      name: l.name, source: l.source, detail: l.detail, arrivedAt: l.at,
      dealId: l.dealId, contactId: l.contactId,
      firstTouchAt: first?.at ?? null, hours, channel: first?.channel ?? null,
      by: first ? (first.ownerId ? ownerName(owners.get(first.ownerId), first.ownerId) : "Unassigned seat") : null,
      byOwnerId: first?.ownerId ?? null,
      waitingHours: first ? null : (now.getTime() - t0) / 3_600_000,
    };
  }).sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt));

  const touched = rows.filter((r) => r.hours !== null);
  const hoursList = touched.map((r) => r.hours!);
  const total = rows.length;
  const share = (h: number) => (total ? Math.round((hoursList.filter((x) => x <= h).length / total) * 100) : 0);
  const buckets = SPEED_BUCKETS.map((b, i) => {
    const lo = i === 0 ? -Infinity : SPEED_BUCKETS[i - 1].maxH!;
    const hi = b.maxH ?? Infinity;
    return { key: b.key, label: b.label, count: hoursList.filter((x) => x > lo && x <= hi).length };
  });
  const untouchedRows = rows.filter((r) => r.hours === null);
  const repMap = new Map<string, { name: string; hours: number[] }>();
  for (const r of touched) {
    const k = r.byOwnerId ?? "-";
    const e = repMap.get(k) ?? { name: r.by ?? "Unassigned seat", hours: [] };
    e.hours.push(r.hours!);
    repMap.set(k, e);
  }
  const byChannel: Record<TouchChannel, number> = { call: 0, sms: 0, dm: 0, other: 0 };
  for (const r of touched) byChannel[r.channel!] += 1;

  return {
    ok: true, days, leads: rows, total, touched: touched.length,
    medianHours: median(hoursList),
    within: { h1: share(1), h3: share(3), h6: share(6), h24: share(24) },
    buckets,
    untouched: {
      count: untouchedRows.length,
      oldestHours: untouchedRows.length ? Math.max(...untouchedRows.map((r) => r.waitingHours!)) : null,
      under1h: untouchedRows.filter((r) => r.waitingHours! < 1).length,
    },
    byRep: [...repMap.entries()]
      .map(([ownerId, e]) => ({ ownerId, name: e.name, firsts: e.hours.length, medianHours: median(e.hours)! }))
      .sort((a, b) => b.firsts - a.firsts),
    byChannel,
  };
}

/** "0.4h" -> "25 min", "2.5h" -> "2h 30m", "30h" -> "1d 6h". */
export function fmtHours(h: number | null): string {
  if (h === null || !Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) {
    const whole = Math.floor(h);
    const m = Math.round((h - whole) * 60);
    if (m === 60) return `${whole + 1}h`;
    return m ? `${whole}h ${m}m` : `${whole}h`;
  }
  const totalH = Math.round(h);
  const d = Math.floor(totalH / 24);
  const rem = totalH - d * 24;
  return rem ? `${d}d ${rem}h` : `${d}d`;
}

export const CHANNEL_WORD: Record<TouchChannel, string> = {
  call: "Call", sms: "Text", dm: "DM", other: "Message",
};
