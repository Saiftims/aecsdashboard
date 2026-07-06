import { supabaseService } from "@/lib/supabase/server";

/** Record every dashboard-originated HubSpot write. */
export async function logAudit(entry: {
  actor?: string | null;
  actorEmail?: string | null;
  action: string;
  objectType: string;
  objectId: string;
  payload?: unknown;
  hubspotResult: string;
}) {
  const sb = supabaseService();
  await sb.from("audit_log").insert({
    actor: entry.actor ?? null,
    actor_email: entry.actorEmail ?? null,
    action: entry.action,
    object_type: entry.objectType,
    object_id: entry.objectId,
    payload: entry.payload ?? {},
    hubspot_result: entry.hubspotResult,
  });
}
