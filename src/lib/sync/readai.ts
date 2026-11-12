/** Read.ai call notes -> HubSpot.
 *
 * Read.ai pushes a meeting report (summary, participants, full transcript) to
 * /api/webhooks/readai when a recorded call ends. That handler stores the
 * payload in `readai_meetings` and calls `processMeeting`, which:
 *
 *   1. asks Claude for the sales facts in the transcript - firm, who we spoke
 *      to and their role, who else was there, case management system, motor
 *      vehicle accident cases a month and total caseload, plan discussed and
 *      price concerns, next step, one-sentence summary;
 *   2. finds the HubSpot contact(s) by the participants' emails, their
 *      company and open deal (creating a contact only when we have an
 *      external email, a company only when the call named the firm and no
 *      company matches, never a deal);
 *   3. writes the facts to properties on the company / deal / contact, logs
 *      one note with the full structured summary and a link to the report,
 *      and opens a task for the next step on the deal owner.
 *
 * Idempotent per session: a re-pushed report updates the same note and does
 * not open a second task. Nothing is ever blanked - properties are only set
 * when the call produced a value. `syncReadAi` (cron, every 10 min) retries
 * anything the webhook could not finish.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";
import { must, supabaseService } from "@/lib/supabase/server";
import {
  ASSOC, hsAssociate, hsAssociations, hsCreateObject, hsEnsureProperties, hsFindContactByEmail, hsRequest,
  hsUpdateProperties, type HsObject, type HsPropertySpec,
} from "@/lib/hubspot/client";
import { SALES_STAGES } from "@/lib/hubspot/stages";

// ---------------------------------------------------------------------------
// Read.ai payload
// ---------------------------------------------------------------------------
export interface ReadAiParticipant { name?: string | null; first_name?: string | null; last_name?: string | null; email?: string | null }
export interface ReadAiPayload {
  session_id: string;
  request_id?: string;
  trigger?: string;
  title?: string;
  start_time?: string;
  end_time?: string;
  participants?: ReadAiParticipant[];
  owner?: ReadAiParticipant;
  summary?: string;
  action_items?: { text: string }[];
  key_questions?: { text: string }[];
  topics?: { text: string }[];
  chapter_summaries?: { title?: string; description?: string }[];
  report_url?: string;
  platform?: string;
  transcript?: { speaker_blocks?: { start_time?: string; speaker?: { name?: string }; words?: string }[] };
}

/** Verify Read.ai's `X-Read-Signature`: lowercase hex HMAC-SHA256 of the raw
 * body, keyed with the base64-decoded signing key. */
export function verifyReadAiSignature(rawBody: string, header: string | null, base64Key: string): boolean {
  if (!header || !base64Key) return false;
  const expected = createHmac("sha256", Buffer.from(base64Key, "base64")).update(rawBody).digest("hex");
  const got = header.trim().toLowerCase().replace(/^sha256=/, "");
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export function tokensMatch(a: string | null | undefined, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const INTERNAL_DOMAINS = new Set(["silentwitness.ai", "read.ai"]);
const NOTETAKER_RE = /read\.ai|notetaker|otter\.ai|fireflies|fathom|gong/i;

export function emailDomain(email: string | null | undefined): string {
  const e = (email ?? "").trim().toLowerCase();
  return e.includes("@") ? e.split("@")[1] : "";
}

/** Split participants into our side and the firm's side. `internalEmails`
 * are the HubSpot owners' addresses; anyone at silentwitness.ai is ours too. */
export function splitParticipants(
  participants: ReadAiParticipant[] | undefined, internalEmails: Set<string>,
): { internal: ReadAiParticipant[]; external: ReadAiParticipant[] } {
  const internal: ReadAiParticipant[] = [];
  const external: ReadAiParticipant[] = [];
  for (const p of participants ?? []) {
    const email = (p.email ?? "").trim().toLowerCase();
    const name = (p.name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`).trim();
    if (NOTETAKER_RE.test(name) || NOTETAKER_RE.test(email)) continue;
    if (email && (INTERNAL_DOMAINS.has(emailDomain(email)) || internalEmails.has(email))) internal.push(p);
    else external.push(p);
  }
  return { internal, external };
}

/** Transcript as "Speaker: words" lines, trimmed to fit the model's context
 * comfortably (a 45-minute call is ~8k words; the cap only bites on
 * multi-hour recordings, and keeps the start and the end where the intro and
 * the next step live). */
export function transcriptText(p: ReadAiPayload, maxChars = 90_000): string {
  const lines = (p.transcript?.speaker_blocks ?? [])
    .map((b) => `${(b.speaker?.name ?? "Speaker").trim()}: ${(b.words ?? "").trim()}`)
    .filter((l) => !l.endsWith(": "));
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.65));
  const tail = text.slice(-Math.floor(maxChars * 0.35));
  return `${head}\n\n[... ${text.length - maxChars} characters omitted ...]\n\n${tail}`;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
export const CMS_OPTIONS = [
  "litify", "filevine", "clio", "smartadvocate", "casepeer", "mycase", "practicepanther", "needles_neos",
  "lawmatics", "cloudlex", "internal_server", "spreadsheets_or_email", "none", "other", "unknown",
] as const;
export const PLAN_OPTIONS = ["solo", "boutique", "growth", "custom", "undecided"] as const;
export const ROLE_OPTIONS = ["attorney", "case_manager", "decision_maker", "admin", "influencer", "other"] as const;

const Attendee = z.object({ name: z.string(), role: z.string().nullable().optional(), email: z.string().nullable().optional() });

export const Extraction = z.object({
  is_sales_or_cs_call: z.boolean(),
  not_a_call_reason: z.string().nullable().optional(),
  organization_type: z.enum(["law_firm", "insurance", "medical_provider", "other"]).nullable().optional(),
  firm_name: z.string().nullable(),
  primary_contact: Attendee.nullable(),
  primary_contact_role_category: z.enum(ROLE_OPTIONS).nullable().optional(),
  other_firm_attendees: z.array(Attendee).default([]),
  silent_witness_attendees: z.array(z.string()).default([]),
  case_management_system: z.enum(CMS_OPTIONS).default("unknown"),
  case_management_system_detail: z.string().nullable().optional(),
  mva_cases_per_month: z.number().nullable(),
  total_caseload: z.number().nullable(),
  caseload_notes: z.string().nullable().optional(),
  plan_discussed: z.enum(PLAN_OPTIONS).nullable(),
  plan_chosen: z.enum(PLAN_OPTIONS).nullable(),
  price_concerns: z.string().nullable(),
  next_step: z.string().nullable(),
  next_step_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  summary: z.string(),
  evidence: z.object({
    case_management_system: z.string().nullable().optional(),
    case_volume: z.string().nullable().optional(),
    plan: z.string().nullable().optional(),
  }).default({}),
});
export type Extraction = z.infer<typeof Extraction>;

const SYSTEM_PROMPT = `You read transcripts of Silent Witness sales and customer-success calls and extract CRM facts. Silent Witness sells AI case analysis for motor vehicle accident (MVA) cases, priced as monthly plans: Solo ($300/mo), Boutique ($500-700/mo), Growth ($1,000/mo) and Custom, plus a $1,500 "expert sign-off". Its customers and prospects are personal-injury law firms, insurance companies / adjusters, and chiropractors or other medical providers who treat MVA patients - treat a call with any of these (prospect, customer, partner, referral source) as a sales/CS call.

Answer with ONE JSON object and nothing else, matching this shape exactly:
{
  "is_sales_or_cs_call": boolean,            // false ONLY for internal team meetings, job interviews, vendor/investor calls, or anything with no prospect, customer or partner organisation on it
  "not_a_call_reason": string|null,
  "organization_type": "law_firm"|"insurance"|"medical_provider"|"other"|null,
  "firm_name": string|null,                  // the prospect's/customer's organisation name as said or shown (law firm, insurer, clinic); null if never identified
  "primary_contact": {"name": string, "role": string|null, "email": string|null} | null,   // the main person on their side we spoke with; role as they described it (e.g. "managing partner", "case manager", "intake director", "claims adjuster", "clinic owner")
  "primary_contact_role_category": "attorney"|"case_manager"|"decision_maker"|"admin"|"influencer"|"other"|null,
  "other_firm_attendees": [{"name": string, "role": string|null, "email": string|null}],   // everyone else from the firm on the call
  "silent_witness_attendees": [string],      // names of Silent Witness people on the call
  "case_management_system": one of ${JSON.stringify(CMS_OPTIONS)},
  "case_management_system_detail": string|null,   // exact wording if "other", or useful detail (e.g. "moving from Needles to Filevine in Q1")
  "mva_cases_per_month": number|null,        // motor vehicle accident / auto cases (or claims, or MVA patients) they handle per month; convert "about 40 a month" to 40, "500 a year" to 42; null if not stated
  "total_caseload": number|null,             // total active cases / open claims / active patients if given
  "caseload_notes": string|null,             // how the numbers were phrased, caveats
  "plan_discussed": "solo"|"boutique"|"growth"|"custom"|"undecided"|null,
  "plan_chosen": same options|null,          // only if they committed or clearly picked one
  "price_concerns": string|null,             // any pushback on price, budget, per-case cost, contract length; null if none voiced
  "next_step": string|null,                  // the concrete agreed next action, who does it (e.g. "Chris sends Boutique proposal; firm to submit 2 test cases by Friday")
  "next_step_due": "YYYY-MM-DD"|null,        // only if a date or clear timeframe was agreed; resolve relative dates from the call date given
  "summary": string,                         // one sentence, plain, past tense
  "evidence": {"case_management_system": string|null, "case_volume": string|null, "plan": string|null}   // short verbatim quotes supporting those three fields
}
Rules: never invent a value - use null when the transcript does not say. Numbers are numbers, not strings. Names as spoken; do not guess emails. Prefer the organisation name over a person's name for firm_name. "case_management_system" applies to law firms; for insurers or clinics use "other" with the system named in the detail field, or "unknown".`;

function userPrompt(p: ReadAiPayload, ctx: { internal: ReadAiParticipant[]; external: ReadAiParticipant[]; knownContacts: string[]; knownCompany: string | null }): string {
  const who = (list: ReadAiParticipant[]) => list.map((x) => `${x.name ?? ""}${x.email ? ` <${x.email}>` : ""}`).join(", ") || "(none listed)";
  return [
    `Call date: ${(p.start_time ?? "").slice(0, 10) || "unknown"}`,
    `Meeting title: ${p.title ?? ""}`,
    `Silent Witness participants (per calendar): ${who(ctx.internal)}`,
    `Firm-side participants (per calendar): ${who(ctx.external)}`,
    ctx.knownContacts.length ? `HubSpot already knows these attendees as: ${ctx.knownContacts.join("; ")}` : "",
    ctx.knownCompany ? `HubSpot company on record for them: ${ctx.knownCompany}` : "",
    p.summary ? `\nRead.ai summary:\n${p.summary}` : "",
    p.action_items?.length ? `\nRead.ai action items:\n${p.action_items.map((a) => `- ${a.text}`).join("\n")}` : "",
    `\nTranscript:\n${transcriptText(p) || "(no transcript in payload)"}`,
  ].filter(Boolean).join("\n");
}

/** Pull the first JSON object out of a model reply (tolerates code fences). */
export function parseModelJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model reply contained no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

async function askClaude(system: string, user: string): Promise<string> {
  const key = env.anthropicApiKey();
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.anthropicModel(), max_tokens: 1500, temperature: 0,
      system, messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`anthropic -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as { content?: { type: string; text?: string }[] };
  return (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/** Coerce the model's enum fields to the vocabulary before validation: on
 * a non-sales meeting it tends to answer null for the case management
 * system, and an off-list spelling should degrade to "other"/null rather
 * than fail the whole call. Everything else is still validated strictly. */
export function normalizeExtraction(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const pick = <T extends readonly string[]>(v: unknown, opts: T, fallback: T[number] | null) => {
    if (typeof v !== "string") return fallback;
    return (opts as readonly string[]).find((o) => squash(o) === squash(v)) ?? fallback;
  };
  r.case_management_system = pick(r.case_management_system, CMS_OPTIONS, typeof r.case_management_system === "string" && r.case_management_system.trim() ? "other" : "unknown");
  if (r.case_management_system === "other" && !r.case_management_system_detail && typeof (raw as Record<string, unknown>).case_management_system === "string") {
    r.case_management_system_detail = (raw as Record<string, unknown>).case_management_system;
  }
  r.plan_discussed = pick(r.plan_discussed, PLAN_OPTIONS, null);
  r.plan_chosen = pick(r.plan_chosen, PLAN_OPTIONS, null);
  r.primary_contact_role_category = pick(r.primary_contact_role_category, ROLE_OPTIONS, null);
  r.organization_type = pick(r.organization_type, ["law_firm", "insurance", "medical_provider", "other"] as const, null);
  if (typeof r.next_step_due === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(r.next_step_due)) r.next_step_due = null;
  for (const k of ["mva_cases_per_month", "total_caseload"]) {
    if (typeof r[k] === "string") { const n = Number(String(r[k]).replace(/[^\d.]/g, "")); r[k] = Number.isFinite(n) && String(r[k]).trim() ? n : null; }
  }
  if (typeof r.summary !== "string") r.summary = "";
  return r;
}

export async function extractCallFacts(
  p: ReadAiPayload, ctx: { internal: ReadAiParticipant[]; external: ReadAiParticipant[]; knownContacts: string[]; knownCompany: string | null },
): Promise<Extraction> {
  const reply = await askClaude(SYSTEM_PROMPT, userPrompt(p, ctx));
  return Extraction.parse(normalizeExtraction(parseModelJson(reply)));
}

// ---------------------------------------------------------------------------
// HubSpot properties this feature writes (created on first use)
// ---------------------------------------------------------------------------
const GROUP = "sw_gtm";
const label = (v: string) => v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const COMPANY_PROPS: HsPropertySpec[] = [
  { name: "sw_case_management_system", label: "Case management system", type: "enumeration", fieldType: "select",
    description: "From call transcripts (Read.ai). Litify, Filevine, Clio, internal server, none…",
    options: CMS_OPTIONS.map((v) => ({ label: label(v), value: v })) },
  { name: "sw_case_management_system_detail", label: "Case management system detail", type: "string", fieldType: "text" },
  { name: "sw_total_caseload", label: "Total active caseload", type: "number", fieldType: "number" },
  { name: "sw_last_call_date", label: "Last recorded call", type: "date", fieldType: "date" },
  { name: "sw_last_call_summary", label: "Last call summary", type: "string", fieldType: "textarea" },
];
const DEAL_PROPS: HsPropertySpec[] = [
  { name: "sw_plan_discussed", label: "Plan discussed", type: "enumeration", fieldType: "select",
    options: PLAN_OPTIONS.map((v) => ({ label: label(v), value: v })) },
  { name: "sw_plan_chosen", label: "Plan chosen", type: "enumeration", fieldType: "select",
    options: PLAN_OPTIONS.map((v) => ({ label: label(v), value: v })) },
  { name: "sw_price_concerns", label: "Price concerns", type: "string", fieldType: "textarea" },
  { name: "sw_last_call_date", label: "Last recorded call", type: "date", fieldType: "date" },
  { name: "sw_last_call_summary", label: "Last call summary", type: "string", fieldType: "textarea" },
  { name: "sw_last_call_report_url", label: "Last call report (Read.ai)", type: "string", fieldType: "text" },
];

let propertiesEnsured = false;
export async function ensureReadAiProperties(): Promise<string[]> {
  if (propertiesEnsured) return [];
  const notes: string[] = [];
  for (const [object, specs] of [["companies", COMPANY_PROPS], ["deals", DEAL_PROPS]] as const) {
    const r = await hsEnsureProperties(object, GROUP, specs);
    if (r.created.length) notes.push(`${object}: created ${r.created.join(", ")}`);
    if (r.missing.length) notes.push(`${object}: could not create ${r.missing.join(", ")} (${r.error ?? "writes disabled"})`);
  }
  propertiesEnsured = true;
  return notes;
}

// ---------------------------------------------------------------------------
// HubSpot resolution
// ---------------------------------------------------------------------------
const CONTACT_PROPS = ["email", "firstname", "lastname", "jobtitle", "company", "hubspot_owner_id", "sw_contact_role"];
const DEAL_PROPS_READ = ["dealname", "dealstage", "pipeline", "hubspot_owner_id", "closedate"];

const splitName = (full: string) => {
  const parts = full.trim().split(/\s+/);
  return { first: parts.shift() ?? "", last: parts.join(" ") };
};

async function findCompanyByDomain(domain: string): Promise<HsObject | null> {
  if (!domain) return null;
  const r = await hsRequest<{ results: HsObject[] }>("POST", "/crm/v3/objects/companies/search", {
    filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
    properties: ["name", "domain", "hubspot_owner_id"], limit: 3,
  });
  return r.results[0] ?? null;
}

async function findCompanyByName(name: string): Promise<HsObject | null> {
  const q = name.replace(/[^\w\s&'.-]/g, " ").trim();
  if (q.length < 3) return null;
  const r = await hsRequest<{ results: HsObject[]; total?: number }>("POST", "/crm/v3/objects/companies/search", {
    query: q, properties: ["name", "domain", "hubspot_owner_id"], limit: 5,
  });
  // Only trust a name search when the first hit shares the distinctive
  // first word; "Law Office of X" vs "Law Offices of Y" both match "law".
  const norm = (s: string) => s.toLowerCase().replace(/\b(the|law|office|offices|of|firm|group|llp|llc|pc|apc|p\.c\.|inc)\b/g, " ").replace(/\s+/g, " ").trim();
  const want = norm(name);
  const hit = r.results.find((c) => {
    const have = norm(c.properties.name ?? "");
    return want && have && (have.includes(want) || want.includes(have));
  });
  return hit ?? null;
}

/** Newest deal in the sales pipeline that is still open, else newest overall. */
async function pickDeal(dealIds: string[]): Promise<HsObject | null> {
  if (!dealIds.length) return null;
  const r = await hsRequest<{ results: HsObject[] }>("POST", "/crm/v3/objects/deals/batch/read", {
    properties: DEAL_PROPS_READ, inputs: dealIds.slice(0, 50).map((id) => ({ id })),
  });
  const deals = r.results ?? [];
  const open = deals.filter((d) => d.properties.dealstage !== SALES_STAGES.closedLost && d.properties.dealstage !== SALES_STAGES.closedWon);
  const byNewest = (a: HsObject, b: HsObject) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  return [...open].sort(byNewest)[0] ?? [...deals].sort(byNewest)[0] ?? null;
}

interface Resolved {
  contacts: HsObject[];
  contactsCreated: string[];
  company: HsObject | null;
  companyCreated: boolean;
  deal: HsObject | null;
  ownerId: string | null;
}

async function resolveHubSpot(external: ReadAiParticipant[], x: Extraction | null): Promise<Resolved> {
  const contacts: HsObject[] = [];
  const contactsCreated: string[] = [];
  const emails = Array.from(new Set(external.map((p) => (p.email ?? "").trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))));
  for (const email of emails) {
    const c = await hsFindContactByEmail(email, CONTACT_PROPS);
    if (c) contacts.push(c);
  }

  // Company: via a found contact, then the external email domain, then the
  // firm name the call gave us.
  let company: HsObject | null = null;
  for (const c of contacts) {
    const ids = await hsAssociations("contacts", c.id, "companies").catch(() => [] as string[]);
    if (ids[0]) {
      company = await hsRequest<HsObject>("GET", `/crm/v3/objects/companies/${ids[0]}?properties=name,domain,hubspot_owner_id`).catch(() => null);
      if (company) break;
    }
  }
  const PERSONAL = new Set(["gmail.com", "yahoo.com", "aol.com", "icloud.com", "hotmail.com", "outlook.com", "me.com", "live.com"]);
  const firmDomain = emails.map(emailDomain).find((d) => d && !PERSONAL.has(d)) ?? "";
  if (!company && firmDomain) company = await findCompanyByDomain(firmDomain);
  if (!company && x?.firm_name) company = await findCompanyByName(x.firm_name);

  // Create what is safely creatable: a contact when we have their email, a
  // company when the call named the firm and nothing matched. Never a deal.
  let companyCreated = false;
  if (!company && x?.is_sales_or_cs_call && x.firm_name) {
    const created = await hsCreateObject("companies", { name: x.firm_name, ...(firmDomain ? { domain: firmDomain } : {}) });
    if (created.ok && created.id) {
      company = { id: created.id, properties: { name: x.firm_name, domain: firmDomain || null } };
      companyCreated = true;
    }
  }
  if (x?.is_sales_or_cs_call) {
    for (const email of emails) {
      if (contacts.some((c) => (c.properties.email ?? "").toLowerCase() === email)) continue;
      const p = external.find((e) => (e.email ?? "").trim().toLowerCase() === email);
      const name = (p?.name ?? `${p?.first_name ?? ""} ${p?.last_name ?? ""}`).trim();
      const isPrimary = x.primary_contact?.email?.toLowerCase() === email
        || (!!x.primary_contact?.name && !!name && x.primary_contact.name.toLowerCase() === name.toLowerCase());
      const { first, last } = splitName(name || email.split("@")[0]);
      const created = await hsCreateObject("contacts", {
        email, firstname: first, lastname: last,
        ...(isPrimary && x.primary_contact?.role ? { jobtitle: x.primary_contact.role } : {}),
        ...(company?.properties.name ? { company: company.properties.name } : {}),
        sw_lead_source: "other",
      });
      if (created.ok && created.id) {
        const obj: HsObject = { id: created.id, properties: { email, firstname: first, lastname: last } };
        contacts.push(obj);
        contactsCreated.push(email);
      }
    }
  }
  if (company) {
    for (const c of contacts) await hsAssociate("contacts", c.id, "companies", company.id);
  }

  // Deal: through the contacts first, then the company.
  let dealIds: string[] = [];
  for (const c of contacts) dealIds.push(...await hsAssociations("contacts", c.id, "deals").catch(() => [] as string[]));
  if (!dealIds.length && company) dealIds = await hsAssociations("companies", company.id, "deals").catch(() => [] as string[]);
  const deal = await pickDeal(Array.from(new Set(dealIds)));

  const ownerId = deal?.properties.hubspot_owner_id || contacts[0]?.properties.hubspot_owner_id || company?.properties.hubspot_owner_id || null;
  return { contacts, contactsCreated, company, companyCreated, deal, ownerId };
}

// ---------------------------------------------------------------------------
// HubSpot writes
// ---------------------------------------------------------------------------
export function noteBody(p: ReadAiPayload, x: Extraction): string {
  const date = (p.start_time ?? "").slice(0, 10);
  const who = (a: { name: string; role?: string | null }) => a.role ? `${a.name} (${a.role})` : a.name;
  const lines = [
    `Call notes (Read.ai) - ${date}${p.title ? ` - ${p.title}` : ""}`,
    `Summary: ${x.summary}`,
    x.firm_name ? `Firm: ${x.firm_name}${x.organization_type && x.organization_type !== "law_firm" ? ` (${label(x.organization_type)})` : ""}` : "",
    x.primary_contact ? `Spoke with: ${who(x.primary_contact)}` : "",
    x.other_firm_attendees.length ? `Also from the firm: ${x.other_firm_attendees.map(who).join(", ")}` : "",
    x.silent_witness_attendees.length ? `Silent Witness: ${x.silent_witness_attendees.join(", ")}` : "",
    `Case management system: ${x.case_management_system === "unknown" ? "not discussed" : label(x.case_management_system)}${x.case_management_system_detail ? ` - ${x.case_management_system_detail}` : ""}`,
    `MVA cases / month: ${x.mva_cases_per_month ?? "not stated"}${x.total_caseload ? ` - total caseload ${x.total_caseload}` : ""}${x.caseload_notes ? ` (${x.caseload_notes})` : ""}`,
    `Plan: ${x.plan_chosen ? `chose ${label(x.plan_chosen)}` : x.plan_discussed ? `discussed ${label(x.plan_discussed)}` : "not discussed"}`,
    `Price concerns: ${x.price_concerns ?? "none voiced"}`,
    `Next step: ${x.next_step ?? "none agreed"}${x.next_step_due ? ` (by ${x.next_step_due})` : ""}`,
    x.evidence.case_management_system || x.evidence.case_volume || x.evidence.plan
      ? `Quotes: ${[x.evidence.case_management_system, x.evidence.case_volume, x.evidence.plan].filter(Boolean).map((q) => `"${q}"`).join(" / ")}`
      : "",
    p.report_url ? `Report: ${p.report_url}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** What a call wrote to HubSpot, for the status report: `fresh` are
 * properties that were empty before this call filled them. */
export interface HubSpotWrites {
  fields_set: number;
  fields_new: number;
  by_object: Record<string, { set: string[]; fresh: string[] }>;
  note: "created" | "updated" | "none";
  task: "created" | "kept" | "none";
  older_call: boolean;
}

type Props = Record<string, string | number | null | undefined>;
const hasValue = (v: unknown) => v !== null && v !== undefined && v !== "";
const toTime = (v: string | null | undefined) => !v ? NaN : /^\d{10,}$/.test(v) ? Number(v) : Date.parse(v);

/** Decide what to actually send for one object. `current` is what HubSpot
 * holds now. When the call is older than the last call already recorded
 * there (history import), it only fills blanks - a call from March must not
 * overwrite what the firm said in October - and leaves the "last call"
 * fields alone. */
export function planProps(current: Record<string, string | null>, desired: Props, olderCall: boolean, lastCallFields: string[]): { props: Props; set: string[]; fresh: string[] } {
  const props: Props = {};
  const set: string[] = [];
  const fresh: string[] = [];
  for (const [k, v] of Object.entries(desired)) {
    if (!hasValue(v)) continue;
    const had = hasValue(current[k]);
    if (olderCall && (had || lastCallFields.includes(k))) continue;
    props[k] = v; set.push(k);
    if (!had) fresh.push(k);
  }
  return { props, set, fresh };
}

async function currentProps(object: string, id: string, keys: string[]): Promise<Record<string, string | null>> {
  const r = await hsRequest<HsObject>("GET", `/crm/v3/objects/${object}/${id}`, undefined, { properties: keys.join(",") }).catch(() => null);
  return r?.properties ?? {};
}

async function writeHubSpot(p: ReadAiPayload, x: Extraction, r: Resolved, prior: { noteId: string | null; taskId: string | null }) {
  const callDate = (p.start_time ?? "").slice(0, 10) || undefined;
  const callMs = toTime(callDate);
  const summary = x.summary.slice(0, 1000);
  const writes: string[] = [];
  const acct: HubSpotWrites = { fields_set: 0, fields_new: 0, by_object: {}, note: "none", task: "none", older_call: false };

  const apply = async (object: string, id: string, desired: Props, lastCallField: string, lastCallFields: string[]) => {
    const cur = await currentProps(object, id, Object.keys(desired));
    const lastMs = toTime(cur[lastCallField]);
    const older = Number.isFinite(lastMs) && Number.isFinite(callMs) && lastMs > callMs;
    if (older) acct.older_call = true;
    const plan = planProps(cur, desired, older, lastCallFields);
    const res = plan.set.length ? await hsUpdateProperties(object, id, plan.props) : { ok: true } as const;
    if (res.ok) {
      acct.fields_set += plan.set.length; acct.fields_new += plan.fresh.length;
      acct.by_object[`${object}:${id}`] = { set: plan.set, fresh: plan.fresh };
    }
    writes.push(`${object} ${id}: ${res.ok ? `${plan.set.length} set, ${plan.fresh.length} new${older ? " (older call)" : ""}` : ("error" in res ? res.error : undefined) ?? ("skipped" in res ? res.skipped : "")}`);
  };

  if (r.company) {
    await apply("companies", r.company.id, {
      sw_case_management_system: x.case_management_system !== "unknown" ? x.case_management_system : undefined,
      sw_case_management_system_detail: x.case_management_system_detail ?? undefined,
      sw_estimated_monthly_case_volume: x.mva_cases_per_month ?? undefined,
      sw_total_caseload: x.total_caseload ?? undefined,
      sw_last_call_date: callDate,
      sw_last_customer_meeting: callDate,
      sw_last_call_summary: summary,
    }, "sw_last_call_date", ["sw_last_call_date", "sw_last_customer_meeting", "sw_last_call_summary"]);
  }
  if (r.deal) {
    await apply("deals", r.deal.id, {
      sw_plan_discussed: x.plan_discussed ?? undefined,
      sw_plan_chosen: x.plan_chosen ?? undefined,
      sw_price_concerns: x.price_concerns ?? undefined,
      sw_estimated_monthly_case_volume: x.mva_cases_per_month ?? undefined,
      sw_next_step: x.next_step ?? undefined,
      hs_next_step: x.next_step ? x.next_step.slice(0, 250) : undefined,
      sw_next_step_date: x.next_step_due ?? undefined,
      sw_last_call_date: callDate,
      sw_last_call_summary: summary,
      sw_last_call_report_url: p.report_url ?? undefined,
    }, "sw_last_call_date", ["sw_next_step", "hs_next_step", "sw_next_step_date", "sw_last_call_date", "sw_last_call_summary", "sw_last_call_report_url"]);
  }
  for (const c of r.contacts) {
    const email = (c.properties.email ?? "").toLowerCase();
    const name = `${c.properties.firstname ?? ""} ${c.properties.lastname ?? ""}`.trim().toLowerCase();
    const isPrimary = !!x.primary_contact && (
      (x.primary_contact.email ?? "").toLowerCase() === email || (!!name && x.primary_contact.name.toLowerCase() === name));
    const other = x.other_firm_attendees.find((a) => a.name.toLowerCase() === name || (a.email ?? "").toLowerCase() === email);
    const role = isPrimary ? x.primary_contact?.role : other?.role;
    await apply("contacts", c.id, {
      jobtitle: !c.properties.jobtitle && role ? role : undefined,
      sw_contact_role: !c.properties.sw_contact_role && isPrimary ? x.primary_contact_role_category ?? undefined : undefined,
      sw_last_meaningful_contact_date: callDate,
    }, "sw_last_meaningful_contact_date", ["sw_last_meaningful_contact_date"]);
  }

  // One note per session, attached to everything we matched.
  const body = noteBody(p, x);
  let noteId = prior.noteId;
  if (noteId) {
    const res = await hsUpdateProperties("notes", noteId, { hs_note_body: body });
    if (res.ok) acct.note = "updated";
    writes.push(`note ${noteId}: ${res.ok ? "updated" : res.error ?? res.skipped}`);
  } else {
    const assoc = [
      ...(r.deal ? [{ toId: r.deal.id, associationTypeId: ASSOC.noteToDeal }] : []),
      ...(r.company ? [{ toId: r.company.id, associationTypeId: ASSOC.noteToCompany }] : []),
      ...r.contacts.map((c) => ({ toId: c.id, associationTypeId: ASSOC.noteToContact })),
    ];
    if (assoc.length) {
      const res = await hsCreateObject("notes", {
        hs_timestamp: p.end_time ?? p.start_time ?? new Date().toISOString(), hs_note_body: body,
        ...(r.ownerId ? { hubspot_owner_id: r.ownerId } : {}),
      }, assoc);
      noteId = res.id ?? null;
      if (res.ok) acct.note = "created";
      writes.push(`note: ${res.ok ? `created ${res.id}` : res.error ?? res.skipped}`);
    }
  }

  // One task for the next step, on the deal owner, due on the agreed date
  // or in three working days. Only for recent calls: a next step agreed
  // months ago (history import) is context for the note, not a to-do.
  let taskId = prior.taskId;
  const recent = !Number.isFinite(callMs) || Date.now() - callMs < 14 * 864e5;
  if (taskId) acct.task = "kept";
  if (!taskId && recent && x.next_step && (r.deal || r.contacts.length || r.company)) {
    const due = x.next_step_due ? new Date(`${x.next_step_due}T16:00:00Z`) : new Date(Date.now() + 3 * 864e5);
    const assoc = [
      ...(r.deal ? [{ toId: r.deal.id, associationTypeId: ASSOC.taskToDeal }] : []),
      ...(r.company ? [{ toId: r.company.id, associationTypeId: ASSOC.taskToCompany }] : []),
      ...r.contacts.slice(0, 1).map((c) => ({ toId: c.id, associationTypeId: ASSOC.taskToContact })),
    ];
    const res = await hsCreateObject("tasks", {
      hs_task_subject: `Next step: ${x.next_step.slice(0, 180)}`,
      hs_task_body: `From the ${callDate ?? ""} call${x.firm_name ? ` with ${x.firm_name}` : ""}: ${x.next_step}\n${p.report_url ?? ""}`,
      hs_timestamp: String(due.getTime()),
      hs_task_status: "NOT_STARTED", hs_task_priority: "MEDIUM", hs_task_type: "TODO",
      ...(r.ownerId ? { hubspot_owner_id: r.ownerId } : {}),
    }, assoc);
    taskId = res.id ?? null;
    if (res.ok) acct.task = "created";
    writes.push(`task: ${res.ok ? `created ${res.id}` : res.error ?? res.skipped}`);
  }
  return { noteId, taskId, writes, acct };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
type Sb = ReturnType<typeof supabaseService>;

/** HubSpot owners by email, so the rep who was on the call can own the
 * note and task when the firm is new and has no deal owner yet. */
async function ownersByEmail(sb: Sb): Promise<Map<string, string>> {
  const { data } = await sb.from("crm_owners").select("owner_id,email").eq("archived", false);
  return new Map(((data ?? []) as { owner_id: string; email: string | null }[])
    .filter((o) => o.email).map((o) => [o.email!.toLowerCase(), o.owner_id]));
}

async function slackLine(text: string) {
  const url = env.slackWebhookUrl();
  if (!url) return;
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) })
    .catch((e) => console.error("readai slack:", e instanceof Error ? e.message : e));
}

/** Store a webhook delivery. Returns whether it is new work (false for a
 * replay of a request_id already processed). */
export async function storeMeeting(p: ReadAiPayload, source: "webhook" | "backfill" = "webhook"): Promise<{ fresh: boolean }> {
  const sb = supabaseService();
  const { data: existing } = await sb.from("readai_meetings").select("request_id,status").eq("session_id", p.session_id).maybeSingle();
  if (existing && existing.request_id && existing.request_id === p.request_id && existing.status !== "error") return { fresh: false };
  await must("readai_meetings upsert", sb.from("readai_meetings").upsert({
    session_id: p.session_id, request_id: p.request_id ?? null, title: p.title ?? null,
    started_at: p.start_time ?? null, ended_at: p.end_time ?? null, platform: p.platform ?? null,
    owner_email: p.owner?.email ?? null, participants: p.participants ?? [], report_url: p.report_url ?? null,
    raw: p, status: "received", error: null, received_at: new Date().toISOString(), source,
  }, { onConflict: "session_id" }));
  return { fresh: true };
}

/** Record a meeting we decided not to process (title filter, internal-only
 * attendee list) so the history import never fetches or re-judges it. */
export async function storeSkipped(p: ReadAiPayload, reason: string, source: "webhook" | "backfill" = "backfill"): Promise<void> {
  const sb = supabaseService();
  await must("readai_meetings skip", sb.from("readai_meetings").upsert({
    session_id: p.session_id, request_id: p.request_id ?? null, title: p.title ?? null,
    started_at: p.start_time ?? null, ended_at: p.end_time ?? null, platform: p.platform ?? null,
    owner_email: p.owner?.email ?? null, participants: p.participants ?? [], report_url: p.report_url ?? null,
    raw: p, status: "skipped", error: reason, received_at: new Date().toISOString(), processed_at: new Date().toISOString(), source,
  }, { onConflict: "session_id", ignoreDuplicates: true }));
}

/** Internal meetings we never want to spend a transcript read on: standups,
 * interviews, team syncs. Anything else goes to the model, which still
 * answers `is_sales_or_cs_call: false` for the rest. */
export const EXCLUDED_TITLE_RE = /\b(stand-?ups?|interviews?|daily sync|team sync|all[- ]hands|retro(spective)?|sprint planning|1:1|one[- ]on[- ]one)\b|\bgrowth\s+(sync|meeting|call|check-?in|huddle)\b/i;

export async function internalEmailSet(): Promise<Set<string>> {
  return new Set((await ownersByEmail(supabaseService())).keys());
}

/** True when every attendee has an email and all of them are ours. Attendee
 * lists with missing emails (dial-ins, guests) are left for the model. */
export function internalOnly(participants: ReadAiParticipant[] | undefined, internalEmails: Set<string>): boolean {
  const { internal, external } = splitParticipants(participants, internalEmails);
  if (external.length) return false;
  return internal.length > 0;
}

export async function processMeeting(sessionId: string): Promise<Record<string, unknown>> {
  const sb = supabaseService();
  const { data: row } = await must("readai_meetings read", sb.from("readai_meetings").select("*").eq("session_id", sessionId).single());
  const p = row.raw as ReadAiPayload;
  // Not configured yet is not an attempt: the meeting waits, unspent, until
  // the key is set, instead of burning its five retries in fifty minutes.
  if (!env.anthropicApiKey()) {
    await sb.from("readai_meetings").update({ status: "received", error: "waiting: ANTHROPIC_API_KEY is not set" }).eq("session_id", sessionId);
    return { status: "queued", reason: "ANTHROPIC_API_KEY is not set" };
  }
  const bump = { attempts: (row.attempts as number ?? 0) + 1, processed_at: new Date().toISOString() };
  try {
    const propNotes = await ensureReadAiProperties();
    const owners = await ownersByEmail(sb);
    const split = splitParticipants(p.participants, new Set(owners.keys()));
    const repOwnerId = split.internal.map((i) => owners.get((i.email ?? "").toLowerCase())).find(Boolean) ?? null;

    // A first HubSpot pass on the emails alone gives the model names and a
    // company to anchor on; the full resolution runs again after extraction
    // so a firm named only in conversation can still be matched.
    const pre = await resolveHubSpot(split.external, null);
    const knownContacts = pre.contacts.map((c) => `${c.properties.firstname ?? ""} ${c.properties.lastname ?? ""} <${c.properties.email ?? ""}>${c.properties.jobtitle ? `, ${c.properties.jobtitle}` : ""}`.trim());
    const x = await extractCallFacts(p, { ...split, knownContacts, knownCompany: pre.company?.properties.name ?? null });

    if (!x.is_sales_or_cs_call || (!split.external.length && !x.firm_name)) {
      await sb.from("readai_meetings").update({ ...bump, status: "skipped", extracted: x, error: x.not_a_call_reason ?? "no firm-side participant" }).eq("session_id", sessionId);
      return { status: "skipped", reason: x.not_a_call_reason ?? "no firm-side participant" };
    }

    const r = await resolveHubSpot(split.external, x);
    r.ownerId = r.ownerId ?? repOwnerId;
    const w = await writeHubSpot(p, x, r, { noteId: row.hubspot_note_id as string | null, taskId: row.hubspot_task_id as string | null });
    await sb.from("readai_meetings").update({
      ...bump, status: "synced", extracted: x, error: null, hubspot_writes: w.acct,
      hubspot_company_id: r.company?.id ?? null, hubspot_contact_ids: r.contacts.map((c) => c.id),
      hubspot_deal_id: r.deal?.id ?? null, hubspot_note_id: w.noteId, hubspot_task_id: w.taskId,
    }).eq("session_id", sessionId);

    // Slack once per live call; the history import reports in bulk instead.
    if (!row.hubspot_note_id && row.source !== "backfill") {
      const portal = env.hubspotPortalId();
      const link = r.deal ? `https://app.hubspot.com/contacts/${portal}/record/0-3/${r.deal.id}`
        : r.company ? `https://app.hubspot.com/contacts/${portal}/record/0-2/${r.company.id}` : p.report_url ?? "";
      await slackLine([
        `:telephone_receiver: Call logged: *${x.firm_name ?? r.company?.properties.name ?? "unknown firm"}*`,
        x.primary_contact ? `${x.primary_contact.name}${x.primary_contact.role ? ` (${x.primary_contact.role})` : ""}` : null,
        x.case_management_system !== "unknown" ? `CMS: ${label(x.case_management_system)}` : null,
        x.mva_cases_per_month != null ? `${x.mva_cases_per_month} MVA/mo` : null,
        x.plan_chosen ? `chose ${label(x.plan_chosen)}` : x.plan_discussed ? `discussed ${label(x.plan_discussed)}` : null,
        x.next_step ? `next: ${x.next_step}` : null,
        link ? `<${link}|HubSpot>` : null,
      ].filter(Boolean).join(" · "));
    }
    return { status: "synced", firm: x.firm_name, company: r.company?.id, deal: r.deal?.id, contacts: r.contacts.length, created: { contacts: r.contactsCreated, company: r.companyCreated }, writes: w.writes, fields_new: w.acct.fields_new, fields_set: w.acct.fields_set, properties: propNotes };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("readai_meetings").update({ ...bump, status: "error", error: msg.slice(0, 1000) }).eq("session_id", sessionId);
    throw e;
  }
}

/** Cron: finish anything the webhook could not (no key yet, HubSpot down,
 * function killed). Gives up after five attempts so a poison payload does
 * not fail every run forever. */
export async function syncReadAi(): Promise<Record<string, unknown>> {
  const sb = supabaseService();
  const { data } = await must("readai_meetings pending",
    sb.from("readai_meetings").select("session_id,status,attempts").in("status", ["received", "error"]).lt("attempts", 5)
      .order("received_at", { ascending: true }).limit(10));
  const out = { pending: (data ?? []).length, synced: 0, skipped: 0, failed: 0, errors: [] as string[] };
  for (const row of (data ?? []) as { session_id: string }[]) {
    try {
      const r = await processMeeting(row.session_id);
      if (r.status === "synced") out.synced++; else out.skipped++;
    } catch (e) {
      out.failed++;
      out.errors.push(`${row.session_id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
  }
  // A missing key is a configuration problem worth failing the run over;
  // individual bad meetings are not.
  if (out.pending && !env.anthropicApiKey()) throw new Error("ANTHROPIC_API_KEY is not set; Read.ai meetings are queued but not processed");
  return out;
}
