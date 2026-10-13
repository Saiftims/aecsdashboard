/** Pull Meta Lead Ads submissions into `meta_leads`.
 *
 * This is the raw feed the FlyTech sheet is curated from: every form fill,
 * qualified or not, with the answers and the ad that produced it. It is kept
 * as an archive because Meta purges lead records after ~90 days.
 *
 * Routine runs ask each form only for leads newer than the last successful
 * run (with a day of overlap); `full` re-reads everything Meta still holds.
 * Upserts are keyed on Meta's leadgen id, so re-reading is idempotent. */
import {
  ASSOC, hsAssociations, hsCreateObject, hsRequest, hsUpdateProperties, type HsObject,
} from "@/lib/hubspot/client";
import { SALES_PIPELINE_ID, SALES_STAGES } from "@/lib/hubspot/stages";
import { env } from "@/lib/env";
import { listForms, listLeads, pageAccessToken, type MetaLead } from "@/lib/meta/client";
import { loadMetaSheetRows, normName } from "@/lib/meta-leads";
import { supabaseService } from "@/lib/supabase/server";

/** Ahmad "Alex" Qoqazeh - every new Meta lead is his (owner, 2026-10-13). */
const ALEX_OWNER_ID = "36480771";

/** Same shape as slack_notify.py's MQL alert so #sales reads consistently.
 * Never throws: a Slack outage must not fail the HubSpot push. */
async function announceOnSlack(args: {
  dealId: string; dealName: string; name: string; email: string; phone: string | null;
  company: string | null; form: string | null; qualified: boolean | null; answers: string;
}): Promise<boolean> {
  const url = env.slackWebhookUrl();
  if (!url) return false;
  const dealUrl = `https://app-eu1.hubspot.com/contacts/${env.hubspotPortalId()}/record/0-3/${args.dealId}`;
  const lines = [
    `*Contact:* ${args.name || "-"}  (${[args.email, args.phone].filter(Boolean).join(" · ")})`,
    args.company ? `*Company:* ${args.company}` : "",
    `*Owner:* Alex`,
    `*Source:* Meta ad form${args.form ? ` · ${args.form}` : ""}`,
    args.qualified === null ? "" : `*FlyTech sheet:* ${args.qualified ? "on it (qualified)" : "not on it yet (unqualified)"}`,
    args.answers ? `*Answers:* ${args.answers}` : "",
  ].filter(Boolean);
  const text = `:tada: New Meta lead (Unqualified Lead stage): ${args.dealName}`;
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `:tada: *New Meta lead in HubSpot* (Unqualified Lead stage)\n*<${dealUrl}|${args.dealName}>*` } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ];
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, blocks }) });
    return r.ok;
  } catch { return false; }
}

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
  const stats = {
    forms: 0, fetched: 0, upserted: 0, test: 0,
    pushed: 0, contactsCreated: 0, dealsCreated: 0, repeats: 0, pushErrors: 0, slacked: 0,
  };
  // Read Meta. A failure here (typically an expired token) must not stop the
  // HubSpot push of anything already fetched; it is re-thrown at the end so
  // the run still records the error.
  let metaError: unknown = null;
  const rows: Record<string, unknown>[] = [];
  try {
    await readMeta(sinceMs, rows, stats);
  } catch (e) {
    metaError = e;
  }
  for (let i = 0; i < rows.length; i += 500) {
    // Never touch the hubspot_* columns here: a re-read of an already-pushed
    // lead must not reset its push state.
    const { error } = await sb.from("meta_leads").upsert(rows.slice(i, i + 500), { onConflict: "leadgen_id" });
    if (error) throw new Error(`meta_leads upsert: ${error.message}`);
    stats.upserted += Math.min(500, rows.length - i);
  }

  // ---- push new submissions into HubSpot ----
  const { data: pending } = await sb.from("meta_leads")
    .select("leadgen_id, created_time, form_name, ad_name, campaign_name, full_name, email, phone, company, answers")
    .is("hubspot_pushed_at", null).eq("is_test", false)
    .order("created_time", { ascending: true }).limit(40);
  // The FlyTech sheet says whether a lead has been qualified; read once per
  // run, only if there is something to announce. Null = sheet unreadable.
  let sheetKeys: Set<string> | null = null;
  if (pending?.length) {
    const sheet = await loadMetaSheetRows();
    sheetKeys = sheet && new Set(sheet.filter((r) => r.tab === "form").flatMap((r) => [r.email, normName(r.name)]).filter(Boolean));
  }
  for (const lead of (pending ?? []) as PendingLead[]) {
    const r = await pushLeadToHubSpot(lead);
    stats.pushed += 1;
    if (r.contactCreated) stats.contactsCreated += 1;
    if (r.dealCreated && r.dealId) {
      stats.dealsCreated += 1;
      const ok = await announceOnSlack({
        dealId: r.dealId, dealName: r.dealName ?? "", name: lead.full_name ?? "", email: lead.email ?? "",
        phone: lead.phone, company: lead.company, form: lead.form_name,
        qualified: sheetKeys ? sheetKeys.has(lead.email ?? "") || sheetKeys.has(normName(lead.full_name)) : null,
        answers: Object.entries(lead.answers ?? {})
          .filter(([k]) => !["full_name", "work_email", "email", "phone_number", "company_name"].includes(k))
          .map(([, v]) => v).join(" · "),
      });
      if (ok) { stats.slacked += 1; r.note += " · Slack posted"; } else r.note += " · Slack NOT posted";
    }
    if (r.repeat) stats.repeats += 1;
    if (r.error) stats.pushErrors += 1;
    await sb.from("meta_leads").update({
      hubspot_contact_id: r.contactId ?? null,
      hubspot_deal_id: r.dealId ?? null,
      // An error leaves hubspot_pushed_at null so the next minute retries it;
      // the note says why. Everything else is final.
      hubspot_pushed_at: r.error ? null : new Date().toISOString(),
      hubspot_push_note: r.note,
    }).eq("leadgen_id", lead.leadgen_id);
  }
  if (metaError) {
    throw new Error(`${metaError instanceof Error ? metaError.message : String(metaError)} (push stage ran: ${JSON.stringify(stats)})`);
  }
  return stats;
}

async function readMeta(sinceMs: number | undefined, rows: Record<string, unknown>[], stats: { forms: number; fetched: number; test: number }) {
  const token = await pageAccessToken();
  const forms = await listForms(token);
  stats.forms = forms.length;
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
}

interface PendingLead {
  leadgen_id: string; created_time: string; form_name: string | null; ad_name: string | null;
  campaign_name: string | null; full_name: string | null; email: string | null; phone: string | null;
  company: string | null; answers: Record<string, string>;
}

interface PushResult {
  contactId?: string; dealId?: string; dealName?: string;
  contactCreated?: boolean; dealCreated?: boolean; repeat?: boolean;
  error?: boolean; note: string;
}

const splitName = (full: string) => {
  const parts = full.trim().split(/\s+/);
  return { first: parts.shift() ?? "", last: parts.join(" ") };
};

const CONTACT_PROPS = "email,hubspot_owner_id,firstname,lastname";

async function readContact(id: string): Promise<HsObject | null> {
  try {
    return await hsRequest<HsObject>("GET", `/crm/v3/objects/contacts/${id}?properties=${CONTACT_PROPS}`);
  } catch { return null; }
}

/** By primary email through the object API (consistent immediately - the
 * search index lags creation by seconds, which is exactly the window in which
 * HubSpot's Facebook integration may have just created this contact), then by
 * secondary email through search. */
async function findContactByEmail(email: string): Promise<HsObject | null> {
  try {
    return await hsRequest<HsObject>("GET",
      `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email&properties=${CONTACT_PROPS}`);
  } catch { /* 404: not a primary email */ }
  const r = await hsRequest<{ results: HsObject[] }>("POST", "/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "hs_additional_emails", operator: "CONTAINS_TOKEN", value: email }] }],
    properties: CONTACT_PROPS.split(","), limit: 5,
  });
  return r.results[0] ?? null;
}

/** One Meta submission -> HubSpot. Idempotent on the HubSpot side:
 *  - contact: found by email (HubSpot's own Facebook integration usually
 *    creates it within minutes of the submission, and HubSpot dedupes contacts
 *    on email anyway), created only if absent;
 *  - deal: created only if the contact has NO deal in the sales pipeline.
 *    Someone who already has one is an existing lead submitting again - an
 *    intent signal logged as a note, never a second deal and never a stage
 *    move backwards (standing rule). */
export async function pushLeadToHubSpot(lead: PendingLead): Promise<PushResult> {
  const email = (lead.email ?? "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { note: `skipped: no usable email (${lead.email ?? "blank"})` };
  }
  const name = (lead.full_name ?? "").trim();
  const { first, last } = splitName(name || email.split("@")[0]);
  try {
    let contact = await findContactByEmail(email);
    let contactCreated = false;
    if (!contact) {
      const created = await hsCreateObject("contacts", {
        email, firstname: first, lastname: last,
        ...(lead.phone ? { phone: lead.phone } : {}),
        ...(lead.company ? { company: lead.company } : {}),
        hubspot_owner_id: ALEX_OWNER_ID,
        sw_lead_source: "meta_ads",
        ...(lead.form_name ? { sw_lead_source_detail: lead.form_name } : {}),
        ...(lead.campaign_name ? { sw_original_campaign: lead.campaign_name } : {}),
      });
      if (created.skipped) return { error: true, note: "HubSpot writes disabled (HUBSPOT_APPLY)" };
      if (!created.ok) {
        // Lost the race with the Facebook integration: "Contact already
        // exists. Existing ID: 123". Use it.
        const m = /Existing ID:\s*(\d+)/.exec(created.error ?? "");
        if (!m) return { error: true, note: `contact create failed: ${created.error}` };
        contact = await readContact(m[1]);
        if (!contact) return { error: true, note: `contact ${m[1]} exists but cannot be read` };
      } else {
        contactCreated = true;
        contact = { id: created.id!, properties: { email } } as HsObject;
      }
    } else if (contact.properties.hubspot_owner_id !== ALEX_OWNER_ID) {
      // HubSpot's FB integration leaves the contact on the default owner
      // (Chris); the lead is Alex's. The sweep agrees because the stage is in
      // ALEX_STAGES.
      await hsUpdateProperties("contacts", contact.id, { hubspot_owner_id: ALEX_OWNER_ID });
    }

    // Any deal already in the sales pipeline?
    const dealIds = await hsAssociations("contacts", contact.id, "deals");
    let existingDeal: HsObject | undefined;
    if (dealIds.length) {
      const read = await hsRequest<{ results: HsObject[] }>("POST", "/crm/v3/objects/deals/batch/read", {
        inputs: dealIds.map((id) => ({ id })), properties: ["dealname", "dealstage", "pipeline", "createdate"],
      });
      existingDeal = read.results
        .filter((d) => (d.properties.pipeline ?? SALES_PIPELINE_ID) === SALES_PIPELINE_ID)
        .sort((a, b) => (b.properties.createdate ?? "").localeCompare(a.properties.createdate ?? ""))[0];
    }

    const answers = Object.entries(lead.answers ?? {})
      .filter(([k]) => !["full_name", "work_email", "email", "phone_number", "company_name"].includes(k))
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("\n");
    const body = [
      `Meta ad form submitted ${lead.created_time.slice(0, 16).replace("T", " ")} UTC`,
      `Form: ${lead.form_name ?? "?"}`, lead.ad_name ? `Ad: ${lead.ad_name}` : "",
      lead.campaign_name ? `Campaign: ${lead.campaign_name}` : "",
      lead.company ? `Company: ${lead.company}` : "", lead.phone ? `Phone: ${lead.phone}` : "",
      answers,
    ].filter(Boolean).join("\n");

    if (existingDeal) {
      await hsCreateObject("notes", {
        hs_timestamp: lead.created_time,
        hs_note_body: `Meta form submitted AGAIN (existing lead came back)\n${body}`,
      }, [{ toId: existingDeal.id, associationTypeId: ASSOC.noteToDeal }]);
      return {
        contactId: contact.id, dealId: existingDeal.id, contactCreated, repeat: true,
        note: `repeat: already had deal "${existingDeal.properties.dealname}" - note added, no new deal`,
      };
    }

    const dealName = `${lead.company?.trim() || name || email} \u2014 ${name || email} (Meta)`;
    const deal = await hsCreateObject("deals", {
      dealname: dealName,
      pipeline: SALES_PIPELINE_ID,
      dealstage: SALES_STAGES.unqualified,
      hubspot_owner_id: ALEX_OWNER_ID,
      sw_lead_source: "meta_ads",
    }, [{ toId: contact.id, associationTypeId: ASSOC.dealToContact }]);
    if (!deal.ok) return { contactId: contact.id, contactCreated, error: true, note: `deal create failed: ${deal.error ?? deal.skipped}` };
    await hsCreateObject("notes", { hs_timestamp: lead.created_time, hs_note_body: body },
      [{ toId: deal.id!, associationTypeId: ASSOC.noteToDeal }]);
    return {
      contactId: contact.id, dealId: deal.id, dealName, contactCreated, dealCreated: true,
      note: `created deal "${dealName}" in Unqualified Lead for Alex${contactCreated ? " (contact created too)" : ""}`,
    };
  } catch (e) {
    return { error: true, note: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
