/** Server-side env access. Never import from client components.
 * All values are trimmed: vars set via CLI pipes can carry trailing CR/LF
 * (Windows), which breaks strict comparisons and HTTP headers. */
function clean(name: string): string {
  // `echo $x | vercel env add` on Windows stores the line ending as the
  // LITERAL four characters \r\n, which trim() does not touch.
  return (process.env[name] ?? "").replace(/(\\r)?\\n$/, "").trim();
}

function required(name: string): string {
  const v = clean(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  hubspotToken: () => required("HUBSPOT_TOKEN"),
  hubspotPortalId: () => clean("HUBSPOT_PORTAL_ID") || "148349267",
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  swApiBaseUrl: () => clean("SW_API_BASE_URL"),
  swApiKey: () => clean("SILENT_WITNESS_API_KEY"),
  posthogKey: () => clean("POSTHOG_API_KEY"),
  posthogProjectId: () => clean("POSTHOG_PROJECT_ID"),
  posthogHost: () => clean("POSTHOG_HOST") || "https://us.posthog.com",
  slackWebhookUrl: () => clean("SLACK_WEBHOOK_URL"),
  cronSecret: () => clean("CRON_SECRET"),
  /** Bearer token the investor data room presents to GET /api/investor. */
  investorFeedToken: () => clean("INVESTOR_FEED_TOKEN"),
  /** Meta Graph token with leads_retrieval + pages_show_list + pages_read_engagement. */
  metaAccessToken: () => required("META_ACCESS_TOKEN"),
  metaPageId: () => clean("META_PAGE_ID") || "852956741232072",
  /** Token for the ad account's Insights (spend). Only needs `ads_read`, so a
   * never-expiring system-user token can go here even while the leads token
   * above has to be re-minted. Falls back to META_ACCESS_TOKEN. */
  metaAdsToken: () => clean("META_ADS_TOKEN") || required("META_ACCESS_TOKEN"),
  metaAdAccountId: () => clean("META_AD_ACCOUNT_ID") || "act_993053423296349",
  /** HubSpot writes are gated: nothing is written unless explicitly enabled. */
  hubspotWritesEnabled: () => clean("HUBSPOT_APPLY") === "true",
  /** True on Vercel (build and runtime, every environment). */
  isVercel: () => Boolean(clean("VERCEL")),
};

/** Gate for every `/api/cron/*` route. Vercel calls them with
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * - Secret set: the header must match.
 * - Secret unset ON VERCEL: refuse everything. An unconfigured production
 *   deployment must fail closed, not run full syncs for anyone who finds the
 *   URL.
 * - Secret unset locally: allow, so `curl localhost:3000/api/cron/...` works
 *   in dev without configuration.
 *
 * Returns the 401 response to send, or null when the request may proceed. */
export function cronUnauthorized(req: { headers: { get(name: string): string | null } }): Response | null {
  const secret = env.cronSecret();
  const ok = secret
    ? req.headers.get("authorization") === `Bearer ${secret}`
    : !env.isVercel();
  if (ok) return null;
  const body = secret ? { error: "unauthorized" } : { error: "unauthorized: CRON_SECRET is not set" };
  return Response.json(body, { status: 401 });
}
