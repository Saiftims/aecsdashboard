import { NextRequest, NextResponse } from "next/server";
import { cronUnauthorized } from "@/lib/env";
import { must, supabaseService } from "@/lib/supabase/server";

/** Status report for the Read.ai -> HubSpot feed (`Authorization: Bearer
 * CRON_SECRET`): connected accounts and import progress, meeting counts by
 * outcome, and per-call detail for everything synced. */
export async function GET(req: NextRequest) {
  const denied = cronUnauthorized(req);
  if (denied) return denied;
  const sb = supabaseService();
  const { data: accounts } = await must("readai_accounts", sb.from("readai_accounts")
    .select("email,name,connected_at,backfill_done,backfill_seen,backfill_cursor,last_backfill_at,error"));
  const { data: rows } = await must("readai_meetings", sb.from("readai_meetings")
    .select("session_id,title,started_at,owner_email,status,source,error,attempts,extracted,hubspot_company_id,hubspot_deal_id,hubspot_contact_ids,hubspot_note_id,hubspot_task_id,hubspot_writes,report_url")
    .order("started_at", { ascending: false }).limit(1000));

  type Row = {
    session_id: string; title: string | null; started_at: string | null; owner_email: string | null; status: string; source: string;
    error: string | null; attempts: number; extracted: Record<string, unknown> | null; hubspot_company_id: string | null; hubspot_deal_id: string | null;
    hubspot_contact_ids: string[]; hubspot_note_id: string | null; hubspot_task_id: string | null;
    hubspot_writes: { fields_set: number; fields_new: number; note: string; task: string; older_call: boolean; by_object: Record<string, { set: string[]; fresh: string[] }> } | null; report_url: string | null;
  };
  const all = (rows ?? []) as Row[];
  const by = (f: (r: Row) => string) => all.reduce<Record<string, number>>((acc, r) => { const k = f(r); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const synced = all.filter((r) => r.status === "synced");
  const sum = (f: (r: Row) => number) => synced.reduce((n, r) => n + f(r), 0);
  const propertyTally: Record<string, number> = {};
  for (const r of synced) for (const o of Object.values(r.hubspot_writes?.by_object ?? {})) for (const k of o.fresh) propertyTally[k] = (propertyTally[k] ?? 0) + 1;

  return NextResponse.json({
    accounts: accounts ?? [],
    meetings: { total: all.length, by_status: by((r) => r.status), by_source: by((r) => r.source), skip_reasons: by((r) => r.status === "skipped" ? (r.error ?? "").split(":")[0].slice(0, 60) : "-") },
    hubspot: {
      calls_synced: synced.length,
      fields_set: sum((r) => r.hubspot_writes?.fields_set ?? 0),
      fields_newly_filled: sum((r) => r.hubspot_writes?.fields_new ?? 0),
      notes_created: synced.filter((r) => r.hubspot_writes?.note === "created").length,
      tasks_created: synced.filter((r) => r.hubspot_writes?.task === "created").length,
      companies_touched: new Set(synced.map((r) => r.hubspot_company_id).filter(Boolean)).size,
      deals_touched: new Set(synced.map((r) => r.hubspot_deal_id).filter(Boolean)).size,
      contacts_touched: new Set(synced.flatMap((r) => r.hubspot_contact_ids ?? [])).size,
      newly_filled_by_property: propertyTally,
    },
    calls: all.filter((r) => r.status !== "skipped" || r.source === "webhook").map((r) => {
      const x = r.extracted ?? {};
      return {
        date: (r.started_at ?? "").slice(0, 10), title: r.title, status: r.status, source: r.source, owner: r.owner_email,
        firm: x.firm_name ?? null, contact: (x.primary_contact as { name?: string; role?: string } | null)?.name ?? null,
        role: (x.primary_contact as { name?: string; role?: string } | null)?.role ?? null,
        cms: x.case_management_system ?? null, mva_per_month: x.mva_cases_per_month ?? null, caseload: x.total_caseload ?? null,
        plan: x.plan_chosen ?? x.plan_discussed ?? null, price_concerns: x.price_concerns ?? null, next_step: x.next_step ?? null, summary: x.summary ?? null,
        fields_new: r.hubspot_writes?.fields_new ?? 0, fields_set: r.hubspot_writes?.fields_set ?? 0, note: r.hubspot_writes?.note ?? null, task: r.hubspot_writes?.task ?? null,
        company_id: r.hubspot_company_id, deal_id: r.hubspot_deal_id, error: r.status === "synced" ? null : r.error, report_url: r.report_url,
      };
    }),
  });
}
