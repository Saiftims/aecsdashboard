/** Server-side env access. Never import from client components.
 * All values are trimmed: vars set via CLI pipes can carry trailing CR/LF
 * (Windows), which breaks strict comparisons and HTTP headers. */
function clean(name: string): string {
  return (process.env[name] ?? "").trim();
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
  /** HubSpot writes are gated: nothing is written unless explicitly enabled. */
  hubspotWritesEnabled: () => clean("HUBSPOT_APPLY") === "true",
};
