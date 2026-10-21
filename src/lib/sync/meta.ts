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
import { SALES_PIPELINE_ID, SALES_STAGES, SALES_STAGE_LABELS } from "@/lib/hubspot/stages";
import { env } from "@/lib/env";
import {
  dailyAccountSpend, dailyAdInsights, imageUrlsByHash, listAds, listForms, listLeads, pageAccessToken,
  readCreatives, type MetaCreative, type MetaLead,
} from "@/lib/meta/client";
import { loadMetaSheetRows, normName } from "@/lib/meta-leads";
import { must, supabaseService } from "@/lib/supabase/server";

/** Ahmad "Alex" Qoqazeh - every new Meta lead is his (owner, 2026-10-13). */
const ALEX_OWNER_ID = "36480771";
const CHRIS_OWNER_ID = "36148171";
/** Stages whose deals belong to Alex (mirror of ALEX_STAGES in config.py);
 * from Demo Scheduled onward the deal is Chris's and is never reassigned. */
const ALEX_STAGES = new Set<string>([SALES_STAGES.unqualified, SALES_STAGES.mql, SALES_STAGES.attemptingContact, SALES_STAGES.connected]);

/** Where a NEW Meta deal lands (owner, 2026-10-16): MQL when FlyTech has the
 * person on its sheet - form tab (qualified) or booking tab (booked a demo) -
 * else Unqualified Lead. The sheet's form tab fills within seconds of the
 * submission, so this is usually decidable at push time; a lead qualified
 * later is promoted by `promoteQualified`. */
function stageFor(qualified: boolean | null): string {
  return qualified ? SALES_STAGES.mql : SALES_STAGES.unqualified;
}

/** Same shape as slack_notify.py's MQL alert so #sales reads consistently.
 * A repeat (someone already in the pipeline submitting the form again) is
 * announced too - the owner wants every submission pinged (2026-10-15) - but
 * worded as a come-back with the deal's current stage, so nobody treats it as
 * a fresh lead. Never throws: a Slack outage must not fail the HubSpot push. */
export async function announceOnSlack(args: {
  dealId: string; dealName: string; name: string; email: string; phone: string | null;
  company: string | null; form: string | null; qualified: boolean | null; answers: string;
  /** Stage the new deal was created in (defaults to Unqualified Lead). */
  stage?: string;
  repeat?: { stage: string; ownerId: string | null; submittedAt: string };
  /** An existing Unqualified deal just moved to MQL because FlyTech qualified it. */
  promoted?: { via: string };
}): Promise<boolean> {
  const url = env.slackWebhookUrl();
  if (!url) return false;
  const dealUrl = `https://app-eu1.hubspot.com/contacts/${env.hubspotPortalId()}/record/0-3/${args.dealId}`;
  const owner = args.repeat ? (args.repeat.ownerId === CHRIS_OWNER_ID ? "Chris" : args.repeat.ownerId === ALEX_OWNER_ID ? "Alex" : "unassigned") : "Alex";
  const newStage = SALES_STAGE_LABELS[args.stage ?? SALES_STAGES.unqualified] ?? "Unqualified Lead";
  const stageLabel = args.repeat ? SALES_STAGE_LABELS[args.repeat.stage] ?? args.repeat.stage : newStage;
  const lines = [
    `*Contact:* ${args.name || "-"}  (${[args.email, args.phone].filter(Boolean).join(" · ")})`,
    args.company ? `*Company:* ${args.company}` : "",
    `*Owner:* ${owner}`,
    `*Source:* Meta ad form${args.form ? ` · ${args.form}` : ""}`,
    args.qualified === null ? "" : `*FlyTech sheet:* ${args.qualified ? "on it (qualified)" : "not on it yet (unqualified)"}`,
    args.answers ? `*Answers:* ${args.answers}` : "",
  ].filter(Boolean);
  const headline = args.promoted
    ? `:white_check_mark: *Meta lead qualified by FlyTech* (${args.promoted.via}) - moved from Unqualified Lead to *New MQL*`
    : args.repeat
      ? `:repeat: *Existing lead came back* - submitted the Meta form again ${args.repeat.submittedAt.slice(0, 16).replace("T", " ")} UTC (deal already in *${stageLabel}*, stage not changed)`
      : `:tada: *New Meta lead in HubSpot* (${newStage} stage)`;
  const text = args.promoted
    ? `:white_check_mark: Meta lead qualified -> New MQL: ${args.dealName}`
    : args.repeat ? `:repeat: Existing lead came back (${stageLabel}): ${args.dealName}` : `:tada: New Meta lead (${newStage} stage): ${args.dealName}`;
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `${headline}\n*<${dealUrl}|${args.dealName}>*` } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ];
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, blocks }) });
    return r.ok;
  } catch { return false; }
}

/** When the HubSpot push went live; submissions before it are never pushed. */
const PUSH_SINCE = "2026-10-13T15:00:00Z";

/** First day the ad account spent anything (Insights `maximum` range). */
const SPEND_SINCE = "2026-05-01";

/** Actual ad spend per day into `meta_ad_spend_daily`. Routine runs re-read
 * the last 45 days - Meta restates recent days as late conversions and
 * invalid-click credits land - and `full` re-reads from the account's first
 * spend. One request either way. */
export async function syncMetaSpend(full = false) {
  const sb = supabaseService();
  const until = new Date().toISOString().slice(0, 10);
  const since = full ? SPEND_SINCE : new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const days = await dailyAccountSpend(since, until);
  const rows = days.map((d) => ({
    day: d.day, spend_cents: d.spendCents, impressions: d.impressions, clicks: d.clicks,
    leads: d.leads, synced_at: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from("meta_ad_spend_daily").upsert(rows.slice(i, i + 200), { onConflict: "day" });
    if (error) throw new Error(`meta_ad_spend_daily upsert: ${error.message}`);
  }
  const spend = rows.reduce((a, r) => a + r.spend_cents, 0) / 100;
  const ads = await syncMetaAds(since, until);
  return { since, until, days: rows.length, spend, leads: rows.reduce((a, r) => a + r.leads, 0), ads };
}

/** What a creative shows and says. Dynamic-creative ads carry several titles
 * and bodies; the first is what Meta reports as the primary. */
export function creativeFields(c: MetaCreative | undefined) {
  const ld = c?.object_story_spec?.link_data;
  const vd = c?.object_story_spec?.video_data;
  const afs = c?.asset_feed_spec;
  return {
    title: c?.title ?? afs?.titles?.[0]?.text ?? vd?.title ?? null,
    body: c?.body ?? afs?.bodies?.[0]?.text ?? vd?.message ?? null,
    cta: c?.call_to_action_type ?? ld?.call_to_action?.type ?? vd?.call_to_action?.type ?? null,
    link: ld?.link ?? ld?.call_to_action?.value?.link ?? null,
    form_id: ld?.call_to_action?.value?.lead_gen_form_id ?? vd?.call_to_action?.value?.lead_gen_form_id ?? null,
    image_url: c?.image_url ?? vd?.image_url ?? null,
    thumbnail_url: c?.thumbnail_url ?? null,
    image_hash: c?.image_hash ?? ld?.image_hash ?? vd?.image_hash ?? afs?.images?.[0]?.hash ?? null,
    video_id: vd?.video_id ?? afs?.videos?.[0]?.video_id ?? null,
    post_id: c?.effective_object_story_id ?? null,
  };
}

/** Every ad with its creative, plus per-ad daily insights for the window. */
export async function syncMetaAds(since: string, until: string) {
  const sb = supabaseService();
  const ads = await listAds();
  const creativeIds = [...new Set(ads.map((a) => a.creative?.id).filter((x): x is string => !!x))];
  const creatives = await readCreatives(creativeIds);
  // An image-library URL by hash outlives the creative's signed CDN link, so
  // prefer it where the hash is known.
  const hashes = [...new Set([...creatives.values()].map((c) => creativeFields(c).image_hash).filter((x): x is string => !!x))];
  const byHash = await imageUrlsByHash(hashes);
  const now = new Date().toISOString();
  const adRows = ads.map((a) => {
    const f = creativeFields(a.creative?.id ? creatives.get(a.creative.id) : undefined);
    return {
      ad_id: a.id, name: a.name, status: a.status, effective_status: a.effective_status,
      adset_id: a.adset?.id ?? null, adset_name: a.adset?.name ?? null,
      campaign_id: a.campaign?.id ?? null, campaign_name: a.campaign?.name ?? null, objective: a.campaign?.objective ?? null,
      creative_id: a.creative?.id ?? null, ...f,
      image_url: (f.image_hash && byHash.get(f.image_hash)) || f.image_url,
      issues: a.issues_info ?? null, created_time: a.created_time, updated_time: a.updated_time, synced_at: now,
    };
  });
  for (let i = 0; i < adRows.length; i += 200) {
    const { error } = await sb.from("meta_ads").upsert(adRows.slice(i, i + 200), { onConflict: "ad_id" });
    if (error) throw new Error(`meta_ads upsert: ${error.message}`);
  }
  const daily = await dailyAdInsights(since, until);
  const insRows = daily.map((d) => ({
    ad_id: d.adId, day: d.day, spend_cents: d.spendCents, impressions: d.impressions, reach: d.reach,
    clicks: d.clicks, link_clicks: d.linkClicks, leads: d.leads, synced_at: now,
  }));
  for (let i = 0; i < insRows.length; i += 500) {
    const { error } = await sb.from("meta_ad_insights_daily").upsert(insRows.slice(i, i + 500), { onConflict: "ad_id,day" });
    if (error) throw new Error(`meta_ad_insights_daily upsert: ${error.message}`);
  }
  return { ads: adRows.length, creatives: creatives.size, withImage: adRows.filter((r) => r.image_url).length, insightRows: insRows.length };
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
    pushed: 0, contactsCreated: 0, dealsCreated: 0, repeats: 0, pushErrors: 0, slacked: 0, promoted: 0,
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
  // Only leads that arrived after the push went live. A full re-read can
  // surface an older submission the archive had missed; HubSpot already has
  // that person from its own Facebook integration, and announcing a July
  // lead as new would mislead the team. Mark those handled instead.
  await must("meta_leads mark pre-existing", sb.from("meta_leads").update({
    hubspot_pushed_at: new Date().toISOString(),
    hubspot_push_note: `pre-existing; not pushed (went live ${PUSH_SINCE.slice(0, 10)})`,
  }).is("hubspot_pushed_at", null).lt("created_time", PUSH_SINCE));
  const { data: pending } = await sb.from("meta_leads")
    .select("leadgen_id, created_time, form_name, ad_name, adset_name, campaign_name, full_name, email, phone, company, answers")
    .is("hubspot_pushed_at", null).eq("is_test", false)
    .order("created_time", { ascending: true }).limit(40);
  // The FlyTech sheet says whether a lead has been qualified (form tab) or
  // booked a demo (booking tab); either puts a new deal in MQL. Read once per
  // run. Null = sheet unreadable, in which case nobody is promoted this run.
  const sheet = await loadMetaSheetRows();
  const qualifiedVia = (lead: { email: string | null; full_name: string | null }): string | null => {
    if (!sheet) return null;
    const keys = [(lead.email ?? "").toLowerCase(), normName(lead.full_name)].filter(Boolean);
    const hit = (tab: "form" | "booking") => sheet.some((r) => r.tab === tab && (keys.includes(r.email) || keys.includes(normName(r.name))));
    return hit("booking") ? "booked a demo" : hit("form") ? "on the FlyTech sheet" : null;
  };
  for (const lead of (pending ?? []) as PendingLead[]) {
    const via = qualifiedVia(lead);
    const qualified = sheet ? via !== null : null;
    const r = await pushLeadToHubSpot(lead, stageFor(qualified));
    stats.pushed += 1;
    if (r.contactCreated) stats.contactsCreated += 1;
    if (r.dealCreated) stats.dealsCreated += 1;
    if ((r.dealCreated || r.repeat) && r.dealId) {
      const ok = await announceOnSlack({
        dealId: r.dealId, dealName: r.dealName ?? "", name: lead.full_name ?? "", email: lead.email ?? "",
        phone: lead.phone, company: lead.company, form: lead.form_name, qualified,
        answers: Object.entries(lead.answers ?? {})
          .filter(([k]) => !["full_name", "work_email", "email", "phone_number", "company_name"].includes(k))
          .map(([, v]) => v).join(" · "),
        stage: r.stage,
        repeat: r.repeat ? { stage: r.stage ?? "", ownerId: r.ownerId ?? null, submittedAt: lead.created_time } : undefined,
      });
      if (ok) { stats.slacked += 1; r.note += " · Slack posted"; } else r.note += " · Slack NOT posted";
    }
    if (r.repeat) stats.repeats += 1;
    if (r.error) stats.pushErrors += 1;
    // Fatal: if this write is lost the lead is pushed - and announced - again
    // next minute.
    await must(`meta_leads push state ${lead.leadgen_id}`, sb.from("meta_leads").update({
      hubspot_contact_id: r.contactId ?? null,
      hubspot_deal_id: r.dealId ?? null,
      // An error leaves hubspot_pushed_at null so the next minute retries it;
      // the note says why. Everything else is final.
      hubspot_pushed_at: r.error ? null : new Date().toISOString(),
      hubspot_push_note: r.note,
      ...(r.dealCreated && qualified ? { qualified_at: new Date().toISOString(), qualified_via: via } : {}),
    }).eq("leadgen_id", lead.leadgen_id));
  }
  if (sheet) {
    try { stats.promoted = await promoteQualified(sheet, qualifiedVia); } catch (e) { console.error("promoteQualified", e); }
  }
  if (metaError) {
    throw new Error(`${metaError instanceof Error ? metaError.message : String(metaError)} (push stage ran: ${JSON.stringify(stats)})`);
  }
  return stats;
}

/** FlyTech qualifies some leads AFTER we pushed them (the booking tab fills
 * when the person books, the form tab when FlyTech screens). A deal we
 * created that still sits in Unqualified Lead is moved to MQL the run the
 * person appears on the sheet, and #sales is told. A deal Alex has already
 * moved on is left alone and just marked qualified. Looks back 14 days. */
async function promoteQualified(
  sheet: NonNullable<Awaited<ReturnType<typeof loadMetaSheetRows>>>,
  qualifiedVia: (lead: { email: string | null; full_name: string | null }) => string | null,
): Promise<number> {
  const sb = supabaseService();
  const { data } = await sb.from("meta_leads")
    .select("leadgen_id, full_name, email, phone, company, form_name, hubspot_deal_id, hubspot_push_note")
    .is("qualified_at", null).eq("is_test", false).not("hubspot_deal_id", "is", null)
    .gt("created_time", new Date(Date.now() - 14 * 86400000).toISOString());
  const candidates = (data ?? []).map((l) => ({ ...l, via: qualifiedVia(l) })).filter((l) => l.via);
  if (!candidates.length) return 0;
  const read = await hsRequest<{ results: HsObject[] }>("POST", "/crm/v3/objects/deals/batch/read", {
    inputs: [...new Set(candidates.map((c) => c.hubspot_deal_id as string))].map((id) => ({ id })),
    properties: ["dealname", "dealstage", "hubspot_owner_id"],
  });
  const deals = new Map(read.results.map((d) => [d.id, d]));
  let promoted = 0;
  const now = new Date().toISOString();
  for (const c of candidates) {
    const deal = deals.get(c.hubspot_deal_id as string);
    let note = `qualified (${c.via}) ${now.slice(0, 16)}`;
    if (deal && deal.properties.dealstage === SALES_STAGES.unqualified) {
      await hsUpdateProperties("deals", deal.id, { dealstage: SALES_STAGES.mql });
      const ok = await announceOnSlack({
        dealId: deal.id, dealName: deal.properties.dealname ?? "", name: c.full_name ?? "", email: c.email ?? "",
        phone: c.phone, company: c.company, form: c.form_name, qualified: true, answers: "",
        stage: SALES_STAGES.mql, promoted: { via: c.via! },
      });
      note += ` - moved to MQL${ok ? ", Slack posted" : ", Slack NOT posted"}`;
      promoted += 1;
    } else if (deal) {
      note += ` - deal already in ${SALES_STAGE_LABELS[deal.properties.dealstage ?? ""] ?? deal.properties.dealstage}, left`;
    }
    await must(`meta_leads qualified ${c.leadgen_id}`, sb.from("meta_leads").update({
      qualified_at: now, qualified_via: c.via, hubspot_push_note: `${c.hubspot_push_note ?? ""} · ${note}`,
    }).eq("leadgen_id", c.leadgen_id));
  }
  return promoted;
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
  adset_name?: string | null;
  campaign_name: string | null; full_name: string | null; email: string | null; phone: string | null;
  company: string | null; answers: Record<string, string>;
}

/** The Meta placement a lead came from, as HubSpot properties on BOTH the
 * contact and the deal (owner, 2026-10-21: "a property tag on the meta leads
 * with the ad campaign name, for example rotator cuff"). All leads sit in
 * the one campaign (FlyTech_Leads), so the AD name is the tag that means
 * something - "SW Ad 3A - Rotator Cuff" - with the ad set and campaign
 * alongside. First touch wins: a repeat submission never overwrites these. */
export const META_PLACEMENT_PROPS = ["sw_meta_campaign", "sw_meta_adset", "sw_meta_ad"] as const;
export function metaPlacementProps(lead: Pick<PendingLead, "campaign_name" | "adset_name" | "ad_name">): Record<string, string> {
  const out: Record<string, string> = {};
  if (lead.campaign_name) out.sw_meta_campaign = lead.campaign_name;
  if (lead.adset_name) out.sw_meta_adset = lead.adset_name;
  if (lead.ad_name) out.sw_meta_ad = lead.ad_name;
  return out;
}

interface PushResult {
  contactId?: string; dealId?: string; dealName?: string;
  contactCreated?: boolean; dealCreated?: boolean; repeat?: boolean;
  /** Current stage / owner of the deal (set on repeats). */
  stage?: string; ownerId?: string | null;
  error?: boolean; note: string;
}

const splitName = (full: string) => {
  const parts = full.trim().split(/\s+/);
  return { first: parts.shift() ?? "", last: parts.join(" ") };
};

const CONTACT_PROPS = "email,hubspot_owner_id,firstname,lastname,sw_meta_ad";

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
export async function pushLeadToHubSpot(lead: PendingLead, stage: string = SALES_STAGES.unqualified): Promise<PushResult> {
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
        ...metaPlacementProps(lead),
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
    } else {
      // HubSpot's FB integration usually gets here first and leaves the
      // contact on the default owner (Chris) with no placement: the lead is
      // Alex's (the sweep agrees because the stage is in ALEX_STAGES), and
      // the ad it came from is stamped once, on the first submission only.
      await hsUpdateProperties("contacts", contact.id, {
        ...(contact.properties.hubspot_owner_id !== ALEX_OWNER_ID ? { hubspot_owner_id: ALEX_OWNER_ID } : {}),
        ...(contact.properties.sw_meta_ad ? {} : metaPlacementProps(lead)),
      });
    }

    // Any deal already in the sales pipeline?
    const dealIds = await hsAssociations("contacts", contact.id, "deals");
    let existingDeal: HsObject | undefined;
    if (dealIds.length) {
      const read = await hsRequest<{ results: HsObject[] }>("POST", "/crm/v3/objects/deals/batch/read", {
        inputs: dealIds.map((id) => ({ id })), properties: ["dealname", "dealstage", "pipeline", "createdate", "hubspot_owner_id", "sw_meta_ad"],
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
      // A come-back still in a pre-demo stage is Alex's to work (owner,
      // 2026-10-15). From Demo Scheduled onward the deal is Chris's - the
      // owner sweep would hand it back within hours anyway. Stage never moves.
      const stage = existingDeal.properties.dealstage ?? "";
      let ownerId = existingDeal.properties.hubspot_owner_id ?? null;
      let reassigned = "";
      const reassign = ALEX_STAGES.has(stage) && ownerId !== ALEX_OWNER_ID;
      await hsUpdateProperties("deals", existingDeal.id, {
        ...(reassign ? { hubspot_owner_id: ALEX_OWNER_ID } : {}),
        // A deal made by a rep or by the Calendly integration carries no
        // placement; the first Meta submission we see supplies it.
        ...(existingDeal.properties.sw_meta_ad ? {} : metaPlacementProps(lead)),
      });
      if (reassign) {
        ownerId = ALEX_OWNER_ID;
        reassigned = ", deal reassigned to Alex";
      }
      return {
        contactId: contact.id, dealId: existingDeal.id, dealName: existingDeal.properties.dealname ?? "", contactCreated, repeat: true,
        stage, ownerId,
        note: `repeat: already had deal "${existingDeal.properties.dealname}" (${SALES_STAGE_LABELS[stage] ?? stage}) - note added${reassigned}, no new deal`,
      };
    }

    const dealName = `${lead.company?.trim() || name || email} \u2014 ${name || email} (Meta)`;
    const deal = await hsCreateObject("deals", {
      dealname: dealName,
      pipeline: SALES_PIPELINE_ID,
      dealstage: stage,
      hubspot_owner_id: ALEX_OWNER_ID,
      sw_lead_source: "meta_ads",
      ...metaPlacementProps(lead),
    }, [{ toId: contact.id, associationTypeId: ASSOC.dealToContact }]);
    if (!deal.ok) return { contactId: contact.id, contactCreated, error: true, note: `deal create failed: ${deal.error ?? deal.skipped}` };
    await hsCreateObject("notes", { hs_timestamp: lead.created_time, hs_note_body: body },
      [{ toId: deal.id!, associationTypeId: ASSOC.noteToDeal }]);
    return {
      contactId: contact.id, dealId: deal.id, dealName, contactCreated, dealCreated: true, stage, ownerId: ALEX_OWNER_ID,
      note: `created deal "${dealName}" in ${SALES_STAGE_LABELS[stage] ?? stage} for Alex${contactCreated ? " (contact created too)" : ""}`,
    };
  } catch (e) {
    return { error: true, note: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
