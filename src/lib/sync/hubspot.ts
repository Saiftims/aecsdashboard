/** HubSpot -> Supabase cache sync (idempotent upserts keyed by HubSpot id).
 * Incremental via the search API (hs_lastmodifieddate); full for backfills. */
import { hsListAll, hsListModifiedSince, type HsObject } from "@/lib/hubspot/client";
import { SALES_STAGE_LABELS } from "@/lib/hubspot/stages";
import { supabaseService } from "@/lib/supabase/server";

const COMPANY_PROPS = [
  "name", "domain", "hubspot_owner_id",
  "sw_internal_firm_id", "sw_customer_status", "sw_cs_owner_id", "sw_ae_owner_id",
  "sw_estimated_monthly_case_volume", "sw_active_champion", "sw_onboarding_status",
  "sw_expansion_potential", "sw_at_risk_reason",
  "address", "city", "state", "zip", "country",
];

const CONTACT_PROPS = [
  "email", "firstname", "lastname", "phone", "company", "jobtitle",
  "lifecyclestage", "hubspot_owner_id", "hs_analytics_source",
  "hs_analytics_source_data_1", "createdate",
  "sw_contact_role", "sw_lead_source", "sw_lead_source_detail",
  "sw_original_campaign", "sw_mql_date", "sw_first_contact_date",
  "sw_last_meaningful_contact_date", "sw_qualification_status",
  "sw_primary_objection", "sw_next_step", "sw_next_step_date",
  "sw_champion_status",
];

const DEAL_PROPS = [
  "dealname", "dealstage", "pipeline", "amount", "hubspot_owner_id",
  "createdate", "closedate", "hs_lastmodifieddate",
  "sw_lead_source", "sw_first_response_hours", "sw_qualification_status",
  "sw_demo_date", "sw_demo_completed", "sw_estimated_monthly_case_volume",
  "sw_first_case_identified", "sw_first_case_target_date", "sw_first_case_committed",
  "sw_closed_lost_reason", "sw_primary_objection", "sw_competitor",
  "sw_handoff_completed", "sw_handoff_accepted_by_cs", "sw_next_step",
  "sw_next_step_date", "sw_activation_stage", "sw_onboarding_date",
  "sw_onboarding_completed", "sw_first_case_identified_date",
  "sw_first_case_submitted_date", "sw_first_case_delivered_date",
  "sw_activation_date", "sw_second_case_date", "sw_last_case_date",
  "sw_cases_last_30_days", "sw_cases_lifetime", "sw_usage_status",
  "sw_health_score", "sw_at_risk_reason", "sw_reactivation_status",
  "sw_handoff_summary", "sw_demo_recording_url",
];

const ENGAGEMENTS: Record<string, string[]> = {
  calls: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_direction",
          "hs_call_disposition", "hubspot_owner_id"],
  meetings: ["hs_timestamp", "hs_meeting_title", "hs_meeting_body",
             "hs_meeting_outcome", "hs_meeting_start_time", "hubspot_owner_id"],
  notes: ["hs_timestamp", "hs_note_body", "hubspot_owner_id"],
  tasks: ["hs_timestamp", "hs_task_subject", "hs_task_body", "hs_task_status",
          "hs_task_type", "hubspot_owner_id"],
};

function assocIds(o: HsObject, kind: string): string[] {
  return (o.associations?.[kind]?.results ?? []).map((r) => r.id);
}

/** Parse structured markers from activity bodies written by the app's quick
 * logger, e.g. "[type:call][outcome:connected]". */
function parseMarker(body: string | null, key: string): string | null {
  if (!body) return null;
  const m = body.match(new RegExp(`\\[${key}:([a-z0-9_ -]+)\\]`, "i"));
  return m ? m[1].trim() : null;
}

export async function syncHubSpot(mode: "full" | "incremental", sinceMs?: number) {
  const sb = supabaseService();
  const stats: Record<string, number> = {};

  const fetchObjects = async (object: string, props: string[], assoc?: string[]) =>
    mode === "full" || !sinceMs
      ? hsListAll(object, props, assoc)
      : hsListModifiedSince(object, props, sinceMs);

  // ---- companies ----
  const companies = await fetchObjects("companies", COMPANY_PROPS);
  stats.companies = companies.length;
  if (companies.length) {
    await sb.from("companies").upsert(
      companies.map((c) => ({
        hubspot_id: c.id,
        name: c.properties.name,
        domain: c.properties.domain,
        properties: c.properties,
        sw_account_id: c.properties.sw_internal_firm_id || null,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "hubspot_id" },
    );
  }

  // ---- contacts (associations to companies come from the company prop set by
  // HubSpot's domain auto-association; we fetch v4 assoc only in full mode) ----
  const contacts = await fetchObjects("contacts", CONTACT_PROPS, ["companies"]);
  stats.contacts = contacts.length;
  if (contacts.length) {
    await sb.from("contacts").upsert(
      contacts.map((c) => ({
        hubspot_id: c.id,
        email: c.properties.email,
        first_name: c.properties.firstname,
        last_name: c.properties.lastname,
        company_hubspot_id: assocIds(c, "companies")[0] ?? null,
        owner_id: c.properties.hubspot_owner_id,
        lifecycle_stage: c.properties.lifecyclestage,
        properties: c.properties,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "hubspot_id" },
    );
  }

  // ---- deals ----
  const deals = await fetchObjects("deals", DEAL_PROPS, ["companies", "contacts"]);
  stats.deals = deals.length;
  if (deals.length) {
    await sb.from("deals").upsert(
      deals.map((d) => ({
        hubspot_id: d.id,
        name: d.properties.dealname,
        pipeline: d.properties.pipeline,
        stage: d.properties.dealstage,
        stage_label: SALES_STAGE_LABELS[d.properties.dealstage ?? ""] ?? d.properties.dealstage,
        activation_stage: d.properties.sw_activation_stage || null,
        is_activation: Boolean(d.properties.sw_activation_stage),
        owner_id: d.properties.hubspot_owner_id,
        amount: d.properties.amount ? Number(d.properties.amount) : null,
        company_hubspot_id: assocIds(d, "companies")[0] ?? null,
        primary_contact_id: assocIds(d, "contacts")[0] ?? null,
        properties: d.properties,
        hs_created_at: d.properties.createdate,
        hs_updated_at: d.properties.hs_lastmodifieddate,
        closed_at: d.properties.closedate,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "hubspot_id" },
    );
  }

  // ---- engagements (always full: volumes are small; search API not available
  // for all engagement types on all tiers) ----
  for (const [kind, props] of Object.entries(ENGAGEMENTS)) {
    const rows = await hsListAll(kind, props, ["contacts", "deals", "companies"]);
    stats[kind] = rows.length;
    if (!rows.length) continue;
    await sb.from("activities").upsert(
      rows.map((a) => {
        const body =
          a.properties.hs_call_body ?? a.properties.hs_meeting_body ??
          a.properties.hs_note_body ?? a.properties.hs_task_body ?? null;
        const subject =
          a.properties.hs_call_title ?? a.properties.hs_meeting_title ??
          a.properties.hs_task_subject ?? null;
        return {
          hubspot_id: a.id,
          kind: kind.slice(0, -1), // call/meeting/note/task
          owner_id: a.properties.hubspot_owner_id,
          subject,
          body,
          outcome:
            parseMarker(body, "outcome") ??
            a.properties.hs_call_disposition ??
            a.properties.hs_meeting_outcome ??
            null,
          activity_type: parseMarker(body, "type"),
          contact_hubspot_id: assocIds(a, "contacts")[0] ?? null,
          deal_hubspot_id: assocIds(a, "deals")[0] ?? null,
          company_hubspot_id: assocIds(a, "companies")[0] ?? null,
          occurred_at: a.properties.hs_timestamp,
          due_at: kind === "tasks" ? a.properties.hs_timestamp : null,
          completed:
            kind === "tasks" ? a.properties.hs_task_status === "COMPLETED" : null,
          properties: a.properties,
          updated_at: new Date().toISOString(),
        };
      }),
      { onConflict: "hubspot_id" },
    );
  }

  return stats;
}
