/** System health: is every feed running, how fresh is each table, and which
 * known data-quality traps currently have rows in them. This is the page the
 * owner opens instead of asking "did we miss something" - every check here
 * is a failure mode that has actually bitten (see the business rules).
 *
 * Read-only. `/health` renders it; `/api/cron/health` posts the red items to
 * Slack on a change. */
import { REAL_DESPITE_STAFF_EMAIL } from "@/lib/cases/provider";
import { env } from "@/lib/env";
import { selectAll, supabaseService } from "@/lib/supabase/server";

export type Level = "ok" | "warn" | "bad" | "unknown";

export interface FeedStatus {
  key: string;
  label: string;
  /** What the feed produces, in one line. */
  what: string;
  cadence: string;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastStatus: "ok" | "error" | "running" | null;
  lastError: string | null;
  lastStats: Record<string, unknown> | null;
  /** Minutes since the last successful run. */
  ageMin: number | null;
  level: Level;
  note: string | null;
}

export interface Watermark {
  key: string;
  label: string;
  latest: string | null;
  ageHours: number | null;
  level: Level;
  note: string;
}

export interface Check {
  key: string;
  label: string;
  /** Why this matters, in one line - what goes wrong when it is non-zero. */
  why: string;
  count: number;
  level: Level;
  /** Up to 12 example rows for the drill table. */
  examples: { id: string; label: string; detail: string; href?: string }[];
  fix: string;
}

export interface TokenStatus {
  key: string;
  label: string;
  expiresAt: string | null;
  daysLeft: number | null;
  level: Level;
  note: string;
}

export interface SystemHealth {
  generatedAt: string;
  level: Level;
  feeds: FeedStatus[];
  watermarks: Watermark[];
  checks: Check[];
  tokens: TokenStatus[];
  /** Red + amber items as one-line strings, for Slack and the summary bar. */
  problems: { level: Level; text: string }[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Every scheduled feed and how stale it may get before that is a problem.
 * `staleMin` is roughly 3x the schedule, so one skipped run is not an alarm. */
const FEEDS: { key: string; label: string; what: string; cadence: string; staleMin: number; kinds: string[] }[] = [
  { key: "hubspot", label: "HubSpot", what: "Deals, contacts, companies, activities", cadence: "every 5 min", staleMin: 20, kinds: ["hubspot_incremental", "hubspot_full"] },
  { key: "meta", label: "Meta leads", what: "Lead-form submissions into HubSpot + Slack", cadence: "every minute", staleMin: 6, kinds: ["meta", "meta_full"] },
  { key: "stripe", label: "Stripe", what: "Customers, payments, subscriptions", cadence: "every 15 min", staleMin: 50, kinds: ["stripe"] },
  { key: "cases", label: "Cases (PostHog)", what: "Submitted cases, rollups, UI usage", cadence: "hourly + on new case", staleMin: 150, kinds: ["cases"] },
  { key: "calendly", label: "Calendly", what: "Demo dates onto deals", cadence: "every 5 min", staleMin: 20, kinds: ["calendly"] },
  { key: "quo", label: "Quo calls & texts", what: "Dials and SMS per rep", cadence: "every 5 min", staleMin: 20, kinds: ["quo", "quo_full", "quo_messages_full"] },
  { key: "meta_spend", label: "Meta ad spend", what: "Daily spend, per-ad insights", cadence: "every 6 h", staleMin: 13 * 60, kinds: ["meta_spend", "meta_spend_full"] },
  { key: "agent", label: "HubSpot agent (GitHub Actions)", what: "Owner sweep, Calendly stages, demo credit, Slack MQLs", cadence: "every 3 h (GitHub may delay)", staleMin: 8 * 60, kinds: ["agent_quick", "agent_full"] },
];

function level(ageMin: number | null, staleMin: number, lastStatus: string | null): Level {
  if (ageMin === null) return "unknown";
  if (lastStatus === "error" && ageMin > staleMin) return "bad";
  if (ageMin > staleMin * 3) return "bad";
  if (ageMin > staleMin || lastStatus === "error") return "warn";
  return "ok";
}

const worst = (levels: Level[]): Level =>
  levels.includes("bad") ? "bad" : levels.includes("warn") ? "warn" : levels.includes("unknown") ? "unknown" : "ok";

const fmtAge = (min: number | null) => {
  if (min === null) return "never";
  if (min < 1) return "just now";
  if (min < 90) return `${Math.round(min)} min ago`;
  if (min < 48 * 60) return `${(min / 60).toFixed(1)} h ago`;
  return `${Math.round(min / 60 / 24)} d ago`;
};

/** Expiry of the Meta leads token from Meta's own debug endpoint. The ads
 * token is a never-expiring system-user token, so only the leads one ages. */
async function metaTokenStatus(): Promise<TokenStatus> {
  const base = { key: "meta_leads_token", label: "Meta leads token (META_ACCESS_TOKEN)" };
  let token: string;
  try { token = env.metaAccessToken(); } catch {
    return { ...base, expiresAt: null, daysLeft: null, level: "bad", note: "Not configured - Meta leads cannot be read." };
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(`https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
      { cache: "no-store", signal: ctl.signal });
    clearTimeout(t);
    const body = await res.json() as { data?: { expires_at?: number; is_valid?: boolean; scopes?: string[] } };
    const d = body.data;
    if (!d) return { ...base, expiresAt: null, daysLeft: null, level: "unknown", note: "Meta did not describe the token." };
    if (d.is_valid === false) return { ...base, expiresAt: null, daysLeft: 0, level: "bad", note: "Token is INVALID - Meta leads have stopped. Re-mint it in Business Manager." };
    if (!d.expires_at) return { ...base, expiresAt: null, daysLeft: null, level: "ok", note: `Never expires. Scopes: ${(d.scopes ?? []).join(", ")}` };
    const expiresAt = new Date(d.expires_at * 1000).toISOString();
    const daysLeft = (d.expires_at * 1000 - Date.now()) / (24 * HOUR);
    return {
      ...base, expiresAt, daysLeft: Math.floor(daysLeft),
      level: daysLeft < 7 ? "bad" : daysLeft < 21 ? "warn" : "ok",
      note: daysLeft < 21
        ? "Re-mint a long-lived System User token (leads_retrieval, pages_show_list, pages_read_engagement) and update META_ACCESS_TOKEN in Vercel before it expires."
        : `Expires ${expiresAt.slice(0, 10)}. Scopes: ${(d.scopes ?? []).join(", ")}`,
    };
  } catch {
    return { ...base, expiresAt: null, daysLeft: null, level: "unknown", note: "Could not reach Meta to check the token." };
  }
}

export async function systemHealth(): Promise<SystemHealth> {
  const sb = supabaseService();
  const now = Date.now();
  type Run = { kind: string; status: "ok" | "error" | "running"; started_at: string; finished_at: string | null; stats: Record<string, unknown> | null; error: string | null };
  type Co = { hubspot_id: string; name: string | null; domain: string | null; signed_up_at: string | null; first_case_at: string | null };

  const [
    { data: runs }, companies, { data: cases }, { data: stripeCustomers }, { data: subs }, { data: metaLeads },
    { data: deals }, { data: lastQuo }, { data: lastPay }, { data: lastSpend }, { data: lastDeal }, { data: lastActivity },
    { data: lastSignup }, { data: uiRows }, token, { data: caseInvoices },
  ] = await Promise.all([
    sb.from("sync_runs").select("kind, status, started_at, finished_at, stats, error").order("started_at", { ascending: false }).limit(400),
    selectAll<Co>("companies", "hubspot_id, name, domain, signed_up_at, first_case_at", "hubspot_id"),
    sb.from("cases").select("case_id, sw_id, company_hubspot_id, submitted_date, source, creator_email").order("submitted_date", { ascending: false }).limit(2000),
    sb.from("stripe_customers").select("customer_id, email, name, company_hubspot_id, is_internal"),
    sb.from("stripe_subscriptions").select("subscription_id, company_hubspot_id, status, is_internal, customer_id"),
    sb.from("meta_leads").select("leadgen_id, created_time, full_name, email, company, is_test, hubspot_pushed_at, hubspot_deal_id").order("created_time", { ascending: false }).limit(1000),
    sb.from("deals").select("hubspot_id, name, pipeline, stage_label, company_hubspot_id, primary_contact_id, is_activation, closed_at, hs_created_at").order("hs_created_at", { ascending: false }).limit(3000),
    sb.from("quo_calls").select("created_at").order("created_at", { ascending: false }).limit(1),
    sb.from("stripe_payments").select("created_at").order("created_at", { ascending: false }).limit(1),
    sb.from("meta_ad_spend_daily").select("day, spend_cents").order("day", { ascending: false }).limit(3),
    sb.from("deals").select("hs_updated_at").not("hs_updated_at", "is", null).order("hs_updated_at", { ascending: false }).limit(1),
    // Tasks carry a future occurred_at (their due date), so cap at now.
    sb.from("activities").select("occurred_at").neq("kind", "task").lte("occurred_at", new Date(now).toISOString()).order("occurred_at", { ascending: false }).limit(1),
    sb.from("companies").select("signed_up_at").not("signed_up_at", "is", null).order("signed_up_at", { ascending: false }).limit(1),
    sb.from("case_ui_usage").select("case_id").limit(1),
    metaTokenStatus(),
    sb.from("stripe_case_invoices").select("invoice_id, case_id, customer_id, case_name, company_hubspot_id, created_at, status, is_internal").order("created_at", { ascending: false }).limit(1000),
  ]);

  // ---- feeds ----
  const runRows = (runs ?? []) as Run[];
  const feeds: FeedStatus[] = FEEDS.map((f) => {
    const mine = runRows.filter((r) => f.kinds.includes(r.kind));
    const last = mine[0] ?? null;
    const lastOk = mine.find((r) => r.status === "ok") ?? null;
    const okAt = lastOk ? (lastOk.finished_at ?? lastOk.started_at) : null;
    const ageMin = okAt ? (now - Date.parse(okAt)) / MIN : null;
    const lvl = level(ageMin, f.staleMin, last?.status ?? null);
    let note: string | null = null;
    if (last?.status === "error") note = `Last run failed ${fmtAge((now - Date.parse(last.started_at)) / MIN)}`;
    else if (last?.status === "running" && now - Date.parse(last.started_at) > 10 * MIN) note = "A run has been 'running' for over 10 minutes - it probably hit the 300 s limit.";
    else if (lvl === "unknown") note = "No run recorded yet.";
    else if (lvl !== "ok") note = `Expected ${f.cadence}; last success ${fmtAge(ageMin)}.`;
    // PostHog returning nothing looks like success - call it out (rule: fromUrls 0 + uiCases 0 = PostHog failure).
    const st = (lastOk?.stats ?? {}) as Record<string, unknown>;
    if (f.key === "cases" && st && Number(st.fromUrls ?? -1) === 0 && Number(st.uiCases ?? -1) === 0) {
      note = "Last run saw 0 cases from URLs and 0 UI rows - that is PostHog timing out, not a quiet day.";
    }
    return {
      key: f.key, label: f.label, what: f.what, cadence: f.cadence,
      lastRunAt: last?.started_at ?? null, lastOkAt: okAt, lastStatus: last?.status ?? null,
      lastError: last?.error ?? null, lastStats: lastOk?.stats ?? null, ageMin,
      level: f.key === "cases" && note?.startsWith("Last run saw 0") ? worst([lvl, "warn"]) : lvl,
      note,
    };
  });

  // ---- watermarks: when did each table last see something new ----
  const wm = (key: string, label: string, latest: string | null | undefined, warnH: number, badH: number, note: string): Watermark => {
    const ageHours = latest ? (now - Date.parse(latest)) / HOUR : null;
    const lvl: Level = ageHours === null ? "unknown" : ageHours > badH ? "bad" : ageHours > warnH ? "warn" : "ok";
    return { key, label, latest: latest ?? null, ageHours, level: lvl, note };
  };
  const spendDays = (lastSpend ?? []) as { day: string; spend_cents: number }[];
  const lastSpendDay = spendDays.find((d) => d.spend_cents > 0)?.day ?? null;
  const watermarks: Watermark[] = [
    wm("deal", "Latest deal change (HubSpot)", (lastDeal?.[0] as { hs_updated_at: string } | undefined)?.hs_updated_at, 6, 24, "Reps edit deals all day; a day with none means the HubSpot sync is stuck."),
    wm("activity", "Latest logged activity", (lastActivity?.[0] as { occurred_at: string } | undefined)?.occurred_at, 18, 48, "Calls, emails, notes. Quiet over a weekend is normal."),
    wm("meta_lead", "Latest Meta lead", (metaLeads?.[0] as { created_time: string } | undefined)?.created_time, 48, 96, "Ads run every day; two days with no form fill means the token or the forms broke."),
    wm("case", "Latest case", (cases?.[0] as { submitted_date: string } | undefined)?.submitted_date, 72, 168, "Firms submit most weekdays."),
    wm("signup", "Latest app signup", (lastSignup?.[0] as { signed_up_at: string } | undefined)?.signed_up_at, 7 * 24, 14 * 24, "From PostHog signup events, matched to a HubSpot company by domain."),
    wm("payment", "Latest Stripe payment", (lastPay?.[0] as { created_at: string } | undefined)?.created_at, 5 * 24, 10 * 24, "Subscriptions renew daily across 40+ plans."),
    wm("quo", "Latest Quo call", (lastQuo?.[0] as { created_at: string } | undefined)?.created_at, 30, 72, "Dial volume is the activity target; quiet over a weekend is normal."),
    wm("spend", "Latest day with Meta spend", lastSpendDay ? `${lastSpendDay}T23:59:59Z` : null, 36, 72, "Yesterday should always have spend. A gap means Insights returned zeros - the sync now refuses to write those, so the gap shows here instead of as $0."),
  ];

  // ---- checks: traps that have bitten before ----
  const checks: Check[] = [];
  const mk = (key: string, label: string, why: string, fix: string, rows: Check["examples"], warnAt = 1, badAt = Infinity) => {
    checks.push({
      key, label, why, fix, count: rows.length, examples: rows.slice(0, 12),
      level: rows.length >= badAt ? "bad" : rows.length >= warnAt ? "warn" : "ok",
    });
  };

  // Meta leads that never reached HubSpot (push failed) - the 60-second promise.
  const unpushed = ((metaLeads ?? []) as { leadgen_id: string; created_time: string; full_name: string | null; email: string | null; company: string | null; is_test: boolean; hubspot_pushed_at: string | null }[])
    .filter((l) => !l.is_test && !l.hubspot_pushed_at && now - Date.parse(l.created_time) > 5 * MIN);
  mk("meta_unpushed", "Meta leads not in HubSpot", "Owner rule: every form fill is a HubSpot deal within 60 s, owned by Alex, posted to #sales. These are older than 5 min and still unpushed.",
    "Check the Meta feed above for the error; the next run retries them automatically once it is fixed.",
    unpushed.map((l) => ({ id: l.leadgen_id, label: l.full_name ?? l.email ?? l.leadgen_id, detail: `${l.company ?? ""} · ${l.created_time.slice(0, 16).replace("T", " ")}` })), 1, 3);

  // Stripe customers no company could be matched to - their cash is invisible to every firm figure.
  const unmatchedStripe = ((stripeCustomers ?? []) as { customer_id: string; email: string | null; name: string | null; company_hubspot_id: string | null; is_internal: boolean }[])
    .filter((c) => !c.is_internal && !c.company_hubspot_id);
  mk("stripe_unmatched", "Stripe customers with no firm", "Revenue from these payers counts in the month total but in no firm's rollup, cohort or plan check.",
    "Add the billing email's domain to the HubSpot company, or name the pair in EMAIL_TO_COMPANY_NAME in sync/stripe.ts for a consumer-email payer.",
    unmatchedStripe.map((c) => ({ id: c.customer_id, label: c.name ?? c.email ?? c.customer_id, detail: c.email ?? "" })), 1, 5);

  // Live subscriptions with no firm.
  const subNoCo = ((subs ?? []) as { subscription_id: string; company_hubspot_id: string | null; status: string; is_internal: boolean; customer_id: string }[])
    .filter((s) => !s.is_internal && !s.company_hubspot_id && ["active", "trialing", "past_due"].includes(s.status));
  mk("sub_unmatched", "Live plans with no firm", "A plan nobody can see on a firm page: MRR is right, the subscriber list and retention are not.",
    "Same fix as unmatched Stripe customers.",
    subNoCo.map((s) => ({ id: s.subscription_id, label: s.subscription_id, detail: `${s.status} · customer ${s.customer_id}` })), 1, 2);

  // Cases attributed to no firm in the last 30 days (excluding hand-added on-behalf rows, which are expected to lack one).
  const noFirmCases = ((cases ?? []) as { case_id: string; company_hubspot_id: string | null; submitted_date: string | null; source: string; creator_email: string | null }[])
    .filter((c) => !c.company_hubspot_id && c.submitted_date && now - Date.parse(c.submitted_date) < 30 * 24 * HOUR && c.source === "posthog");
  mk("case_no_firm", "Cases with no firm (30 d)", "Counts in monthly totals but invisible to the firm, its cohort and its plan allowance. Usually a firm on personal email or with no domain on its company record.",
    "Set the company domain in HubSpot, or add a firm_mapping row (PostHog account id -> company id). The next cases sync attributes them in place.",
    noFirmCases.map((c) => ({ id: c.case_id, label: c.case_id.slice(0, 22), detail: `${c.submitted_date?.slice(0, 10)} · ${c.creator_email ?? "no actor email"}` })), 1, 4);

  // Cases the platform invoiced that the table does not hold. Stripe stamps the
  // real case id on every case invoice, so this is the complete ledger; a gap
  // here is a case nobody counted (2026-10-23: four October cases staff
  // entered for The Injury Firm and Kass & Moses). The cases sync now inserts
  // these itself, so anything left is an invoice whose customer matched no
  // firm, or a stand-in row absorbing the wrong matter.
  const caseIds = new Set(((cases ?? []) as { case_id: string; sw_id: string | null }[]).flatMap((c) => [c.case_id, ...(c.sw_id ? [c.sw_id] : [])]));
  const invoicedMissing = ((caseInvoices ?? []) as { invoice_id: string; case_id: string; customer_id: string | null; case_name: string | null; company_hubspot_id: string | null; created_at: string | null; status: string | null; is_internal: boolean }[])
    .filter((i) => (!i.is_internal || REAL_DESPITE_STAFF_EMAIL.stripeCustomers.has(i.customer_id ?? "")) && !["void", "draft"].includes(i.status ?? "") && !caseIds.has(i.case_id) && i.created_at && now - Date.parse(i.created_at) < 60 * 24 * HOUR);
  mk("invoiced_not_counted", "Invoiced cases not in the table (60 d)", "Stripe raised a case invoice for a matter the cases table does not hold, so the month total, the firm and the plan allowance all under-count.",
    "If the payer has no firm, match the Stripe customer first (see above); otherwise the next cases sync inserts it as source 'stripe_invoice'. Check no hand-entered stand-in row is absorbing it.",
    invoicedMissing.map((i) => ({ id: i.invoice_id, label: i.case_name ?? i.case_id, detail: `${i.created_at?.slice(0, 10)} · ${i.company_hubspot_id ? `firm ${i.company_hubspot_id}` : "no firm"} · ${i.case_id.slice(0, 18)}` })), 1, 3);

  // Firms with a case or signup but no domain - their next case will drop.
  const noDomain = companies.filter((c) => !c.domain && (c.first_case_at || c.signed_up_at));
  mk("firm_no_domain", "Customer firms with no domain", "The account-id fallback is the email domain, so these firms' cases cannot be matched and silently drop.",
    "Set `domain` on the HubSpot company.",
    noDomain.map((c) => ({ id: c.hubspot_id, label: c.name ?? c.hubspot_id, detail: c.first_case_at ? `first case ${c.first_case_at.slice(0, 10)}` : `signed up ${c.signed_up_at?.slice(0, 10)}`, href: `/firms/${c.hubspot_id}` })), 1, 3);

  // Duplicate companies by domain.
  const byDomain = new Map<string, Co[]>();
  for (const c of companies) {
    const d = (c.domain ?? "").toLowerCase().replace(/^www\./, "");
    if (!d) continue;
    byDomain.set(d, [...(byDomain.get(d) ?? []), c]);
  }
  const dupes = [...byDomain.entries()].filter(([, v]) => v.length > 1 && v.some((c) => c.first_case_at || c.signed_up_at));
  mk("dup_company", "Duplicate company records", "Two HubSpot companies for one firm split its cases, plan and contacts (RAM Law, 2026-10-20: signup on one, Stripe plan on the other).",
    "Merge the companies in HubSpot (keep the one with the cases), then Refresh. The unit-economics table already folds them by domain.",
    dupes.map(([d, v]) => ({ id: d, label: v[0].name ?? d, detail: `${v.length} records: ${v.map((c) => c.hubspot_id).join(", ")}`, href: `/firms/${v[0].hubspot_id}` })), 1, 3);

  // A HubSpot app ("groiwth", id 42251876) runs at ~00:20 UTC on the 1st of
  // every month and re-creates one closed-won "Case intake — Name" deal for
  // every intake submitted the month before (found 2026-10-21: 1 Aug x3,
  // 1 Sep x2, 1 Oct x2). The real deal is the "case-intake — Name — Firm" one
  // the intake form made on the day; these are pure duplicates and each adds
  // $250 of "revenue won" that was never a second case.
  type DealRow = { hubspot_id: string; name: string; company_hubspot_id: string | null; is_activation: boolean; stage_label: string | null; hs_created_at: string };
  const isMonthlyDupe = (d: DealRow) => {
    const t = new Date(d.hs_created_at);
    return /^Case intake — /.test(d.name) && t.getUTCDate() === 1 && t.getUTCHours() < 2;
  };
  const intakeDeals = ((deals ?? []) as DealRow[]).filter((d) => /intake/i.test(d.name));
  const monthlyDupes = intakeDeals.filter(isMonthlyDupe);
  mk("intake_monthly_dupes", "Monthly duplicate intake deals", "Created by HubSpot app 42251876 at 00:20 UTC on the 1st, one per intake from the previous month. Each is a second closed-won $250 for a case that already has its own deal, and one with a company becomes a second CASE too.",
    "Delete these deals in HubSpot and switch off (or re-point) the monthly workflow in that app; the agent's tombstones keep them deleted.",
    monthlyDupes.map((d) => ({ id: d.hubspot_id, label: d.name, detail: `${d.company_hubspot_id ? "HAS COMPANY - counts as a case" : "no company"} · created ${d.hs_created_at.slice(0, 16).replace("T", " ")}`, href: `https://app.hubspot.com/contacts/148349267/record/0-3/${d.hubspot_id}` })), 1);

  // Real intake deals with no company never become cases.
  const intakeNoCo = intakeDeals.filter((d) => !d.company_hubspot_id && !/unknown/i.test(d.name) && !isMonthlyDupe(d));
  mk("intake_no_company", "Intake deals with no company", "The cases sync turns an 'intake' deal into a case only when it has a company; without one the case never exists and the month under-counts.",
    "Associate the deal to the firm in HubSpot (the contact on the deal usually names it), then Refresh. The sync dedupes it against a same-day row for the firm, so a matter already in the table is not doubled.",
    intakeNoCo.map((d) => ({ id: d.hubspot_id, label: d.name, detail: `${d.stage_label ?? ""} · created ${d.hs_created_at.slice(0, 10)}`, href: `https://app.hubspot.com/contacts/148349267/record/0-3/${d.hubspot_id}` })), 1);

  // Signups the dashboard could not match to any HubSpot company do not exist in companies; surface via a rough proxy:
  // Meta leads with a deal but their person later paid under a different domain is not detectable here - skip.

  // Sync runs stuck in "running".
  const stuck = runRows.filter((r) => r.status === "running" && now - Date.parse(r.started_at) > 15 * MIN);
  mk("stuck_runs", "Sync runs stuck 'running'", "A run that never finished hit the 300 s function limit or crashed without recording - its kind may be silently stale.",
    "Look at the feed's last error; for Quo/cases a smaller window (incremental) usually fixes it.",
    stuck.slice(0, 20).map((r) => ({ id: `${r.kind}-${r.started_at}`, label: r.kind, detail: `started ${r.started_at.slice(0, 16).replace("T", " ")}` })), 1, 3);

  // UI usage table empty = the case_ui sync has never succeeded.
  if (!(uiRows ?? []).length) {
    mk("ui_usage_empty", "Case UI usage table is empty", "The old-vs-new UI page has nothing to show.", "Run the cases sync; if PostHog times out it logs and skips.", [{ id: "ui", label: "case_ui_usage", detail: "0 rows" }], 1);
  }

  const tokens = [token];
  const problems: SystemHealth["problems"] = [
    ...feeds.filter((f) => f.level === "bad" || f.level === "warn").map((f) => ({ level: f.level, text: `${f.label}: ${f.note ?? "stale"}${f.lastError ? ` - ${f.lastError.slice(0, 160)}` : ""}` })),
    ...watermarks.filter((w) => w.level === "bad").map((w) => ({ level: w.level, text: `${w.label}: ${w.latest ? fmtAge((w.ageHours ?? 0) * 60) : "never"}` })),
    ...checks.filter((c) => c.level !== "ok").map((c) => ({ level: c.level, text: `${c.label}: ${c.count}` })),
    ...tokens.filter((t) => t.level !== "ok").map((t) => ({ level: t.level, text: `${t.label}: ${t.note}` })),
  ];

  return {
    generatedAt: new Date(now).toISOString(),
    level: worst([...feeds.map((f) => f.level), ...checks.map((c) => c.level), ...tokens.map((t) => t.level), ...watermarks.map((w) => (w.level === "bad" ? "bad" : "ok"))]),
    feeds, watermarks, checks, tokens, problems,
  };
}

export { fmtAge };
