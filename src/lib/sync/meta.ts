/** Pull Meta Lead Ads submissions into `meta_leads`.
 *
 * This is the raw feed the FlyTech sheet is curated from: every form fill,
 * qualified or not, with the answers and the ad that produced it. It is kept
 * as an archive because Meta purges lead records after ~90 days.
 *
 * Routine runs ask each form only for leads newer than the last successful
 * run (with a day of overlap); `full` re-reads everything Meta still holds.
 * Upserts are keyed on Meta's leadgen id, so re-reading is idempotent. */
import { listForms, listLeads, pageAccessToken, type MetaLead } from "@/lib/meta/client";
import { supabaseService } from "@/lib/supabase/server";

/** Meta's "Test lead" button submits placeholders like
 * "<test lead: dummy data for full_name>". */
const TEST_VALUE = /^<test lead:/i;

const field = (l: MetaLead, ...names: string[]) => {
  for (const f of l.field_data ?? []) {
    if (names.includes(f.name)) return (f.values?.[0] ?? "").trim();
  }
  return "";
};

export async function syncMetaLeads(sinceMs?: number) {
  const sb = supabaseService();
  const stats = { forms: 0, fetched: 0, upserted: 0, test: 0 };
  const token = await pageAccessToken();
  const forms = await listForms(token);
  stats.forms = forms.length;

  const rows: Record<string, unknown>[] = [];
  for (const form of forms) {
    // Archived forms keep their leads; Meta just stops accepting new ones.
    const leads = await listLeads(form.id, token, sinceMs);
    stats.fetched += leads.length;
    for (const l of leads) {
      const answers: Record<string, string> = {};
      for (const f of l.field_data ?? []) answers[f.name] = (f.values ?? []).join(" | ");
      const fullName = field(l, "full_name");
      const isTest = TEST_VALUE.test(fullName) || TEST_VALUE.test(field(l, "work_email", "email"));
      if (isTest) stats.test += 1;
      rows.push({
        leadgen_id: l.id,
        created_time: l.created_time,
        form_id: l.form_id ?? form.id,
        form_name: form.name,
        page_id: process.env.META_PAGE_ID?.trim() || "852956741232072",
        ad_id: l.ad_id ?? null,
        ad_name: l.ad_name ?? null,
        adset_name: l.adset_name ?? null,
        campaign_id: l.campaign_id ?? null,
        campaign_name: l.campaign_name ?? null,
        platform: l.platform ?? null,
        is_organic: !!l.is_organic,
        full_name: fullName || null,
        email: field(l, "work_email", "email").toLowerCase() || null,
        phone: field(l, "phone_number", "phone") || null,
        company: field(l, "company_name", "company") || null,
        answers,
        is_test: isTest,
        synced_at: new Date().toISOString(),
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("meta_leads").upsert(rows.slice(i, i + 500), { onConflict: "leadgen_id" });
    if (error) throw new Error(`meta_leads upsert: ${error.message}`);
    stats.upserted += Math.min(500, rows.length - i);
  }
  return stats;
}
