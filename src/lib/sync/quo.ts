/** Pull Quo (OpenPhone) calls into `quo_calls` and texts into `quo_messages`.
 *
 * Quo is the source of truth for dial AND text activity. HubSpot's Quo
 * integration only logs an interaction when the number already exists as a
 * contact, so it drops every touch to a new prospect - exactly the ones a rep
 * working a target is making. See src/lib/quo/client.ts for why enumeration is
 * a line x participant walk rather than a date query.
 *
 * Calls and messages are collected in the SAME walk: the walk is what costs
 * (participants x lines requests), so splitting it into two syncs would double
 * the bill for no benefit.
 *
 * Each row carries the HubSpot owner id, resolved by matching the Quo seat's
 * email to a HubSpot owner. A rep who gets a Quo seat and a HubSpot seat on the
 * same address is wired up by the next sync with no config change.
 */
import { hsListOwners } from "@/lib/hubspot/client";
import {
  listCalls, listMessages, listPhoneNumbers, listThreads, QuoCall, QuoMessage,
} from "@/lib/quo/client";
import { supabaseService } from "@/lib/supabase/server";

async function ownerIdByEmail(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const o of await hsListOwners()) {
    if (o.email) out.set(o.email.toLowerCase(), o.owner_id);
  }
  return out;
}

/** @param sinceMs only walk conversation threads touched since this time.
 * Omit for a full backfill.
 * @param skipCalls collect texts only. The full call walk is every number x
 * every line and does not fit in a serverless function; texts are one request
 * per thread, so they can be backfilled on their own. */
export async function syncQuo(
  sinceMs?: number, { skipCalls = false }: { skipCalls?: boolean } = {},
) {
  const sb = supabaseService();

  const phones = await listPhoneNumbers();
  // Quo seat -> email, so a call can be attributed even when the call itself
  // only names the line.
  const seatEmail = new Map<string, string>();
  const lineSeats = new Map<string, string[]>();
  for (const p of phones) {
    const ids: string[] = [];
    for (const u of p.users ?? []) {
      if (u.id) {
        ids.push(u.id);
        if (u.email) seatEmail.set(u.id, u.email.toLowerCase());
      }
    }
    lineSeats.set(p.id, ids);
  }
  const lineNumber = new Map(
    phones.map((p) => [p.id, p.formattedNumber ?? p.number ?? ""]),
  );

  const { participants, threads } = await listThreads({ sinceMs });
  const callById = new Map<string, QuoCall & { participant: string }>();
  const msgById = new Map<string, QuoMessage & { participant: string }>();
  let errors = 0;
  // Calls: every line x every number (see quo/client.ts for why the net is
  // this wide).
  if (!skipCalls) {
    for (const part of participants) {
      for (const p of phones) {
        try {
          for (const call of await listCalls(p.id, part)) {
            callById.set(call.id, { ...call, participant: part });
          }
        } catch {
          errors += 1;
        }
      }
    }
  }
  // Texts: only where a thread exists, because sending one creates the thread.
  // Asking every line as well would double the request count for nothing.
  for (const { participant, phoneNumberId } of threads) {
    try {
      for (const msg of await listMessages(phoneNumberId, participant)) {
        msgById.set(msg.id, { ...msg, participant });
      }
    } catch {
      errors += 1;
    }
  }

  const owners = await ownerIdByEmail();
  const now = new Date().toISOString();

  /** Resolve the Quo seat that owns an interaction, then the HubSpot owner.
   * An interaction usually names its seat; failing that a single-seat line is
   * unambiguous. Multi-seat lines stay unattributed rather than guess. */
  const attribute = (lineId: string | null | undefined, named: (string | null | undefined)[]) => {
    const seats = lineSeats.get(lineId ?? "") ?? [];
    const seat = named.find(Boolean) ?? (seats.length === 1 ? seats[0] : null);
    const email = seat ? seatEmail.get(seat) ?? null : null;
    return {
      quo_user_id: seat ?? null,
      user_email: email,
      hubspot_owner_id: email ? owners.get(email) ?? null : null,
    };
  };

  const callRows = [...callById.values()].map((c) => ({
    call_id: c.id,
    ...attribute(c.phoneNumberId, [c.userId, c.answeredBy, c.initiatedBy]),
    direction: c.direction ?? null,
    status: c.status ?? null,
    duration_sec: c.duration ?? null,
    participant: c.participant,
    quo_number: lineNumber.get(c.phoneNumberId ?? "") ?? null,
    phone_number_id: c.phoneNumberId ?? null,
    created_at: c.createdAt ?? null,
    answered_at: c.answeredAt ?? null,
    completed_at: c.completedAt ?? null,
    synced_at: now,
  }));

  const msgRows = [...msgById.values()].map((m) => ({
    message_id: m.id,
    ...attribute(m.phoneNumberId, [m.userId]),
    direction: m.direction ?? null,
    status: m.status ?? null,
    body: m.text ?? null,
    participant: m.participant,
    quo_number: lineNumber.get(m.phoneNumberId ?? "") ?? null,
    phone_number_id: m.phoneNumberId ?? null,
    conversation_id: m.conversationId ?? null,
    created_at: m.createdAt ?? null,
    synced_at: now,
  }));

  const upsert = async (
    table: string, conflict: string, rows: Record<string, unknown>[],
  ) => {
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from(table).upsert(chunk, { onConflict: conflict });
      if (error) throw new Error(`${table} upsert failed: ${error.message}`);
      written += chunk.length;
    }
    return written;
  };

  const written = await upsert("quo_calls", "call_id", callRows);
  const messagesWritten = await upsert("quo_messages", "message_id", msgRows);

  return {
    mode: sinceMs ? "incremental" : "full",
    scope: skipCalls ? "messages" : "calls+messages",
    lines: phones.length,
    participants: participants.length,
    threads: threads.length,
    calls: callRows.length,
    attributed: callRows.filter((r) => r.hubspot_owner_id).length,
    written,
    messages: msgRows.length,
    messagesAttributed: msgRows.filter((r) => r.hubspot_owner_id).length,
    messagesWritten,
    lookupErrors: errors,
  };
}
