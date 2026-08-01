/** Pull Quo (OpenPhone) calls into `quo_calls`.
 *
 * Quo is the source of truth for dial activity. HubSpot's Quo integration only
 * logs a call when the dialled number already exists as a contact, so it drops
 * every dial to a new prospect - exactly the calls a rep working a target is
 * making. See src/lib/quo/client.ts for why enumeration is a line x participant
 * walk rather than a date query.
 *
 * Each row carries the HubSpot owner id, resolved by matching the Quo seat's
 * email to a HubSpot owner. A rep who gets a Quo seat and a HubSpot seat on the
 * same address is wired up by the next sync with no config change.
 */
import { hsListOwners } from "@/lib/hubspot/client";
import { listCalls, listParticipants, listPhoneNumbers, QuoCall } from "@/lib/quo/client";
import { supabaseService } from "@/lib/supabase/server";

async function ownerIdByEmail(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const o of await hsListOwners()) {
    if (o.email) out.set(o.email.toLowerCase(), o.owner_id);
  }
  return out;
}

export async function syncQuo() {
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

  const participants = await listParticipants();
  const byId = new Map<string, QuoCall & { participant: string }>();
  let errors = 0;
  for (const part of participants) {
    for (const p of phones) {
      try {
        for (const call of await listCalls(p.id, part)) {
          byId.set(call.id, { ...call, participant: part });
        }
      } catch {
        errors += 1;
      }
    }
  }

  const owners = await ownerIdByEmail();
  const rows = [...byId.values()].map((c) => {
    // A call names its seat directly; failing that, a single-seat line is
    // unambiguous. Multi-seat lines stay unattributed rather than guess.
    const seats = lineSeats.get(c.phoneNumberId ?? "") ?? [];
    const seat = c.userId ?? c.answeredBy ?? c.initiatedBy ??
      (seats.length === 1 ? seats[0] : null);
    const email = seat ? seatEmail.get(seat) ?? null : null;
    return {
      call_id: c.id,
      quo_user_id: seat,
      user_email: email,
      hubspot_owner_id: email ? owners.get(email) ?? null : null,
      direction: c.direction ?? null,
      status: c.status ?? null,
      duration_sec: c.duration ?? null,
      participant: c.participant,
      quo_number: lineNumber.get(c.phoneNumberId ?? "") ?? null,
      phone_number_id: c.phoneNumberId ?? null,
      created_at: c.createdAt ?? null,
      answered_at: c.answeredAt ?? null,
      completed_at: c.completedAt ?? null,
      synced_at: new Date().toISOString(),
    };
  });

  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await sb.from("quo_calls").upsert(chunk, { onConflict: "call_id" });
    if (error) throw new Error(`quo_calls upsert failed: ${error.message}`);
    written += chunk.length;
  }

  return {
    lines: phones.length,
    participants: participants.length,
    calls: rows.length,
    attributed: rows.filter((r) => r.hubspot_owner_id).length,
    written,
    lookupErrors: errors,
  };
}
