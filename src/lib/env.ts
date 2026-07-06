/** Server-side env access. Never import from client components. */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  hubspotToken: () => required("HUBSPOT_TOKEN"),
  hubspotPortalId: () => process.env.HUBSPOT_PORTAL_ID ?? "148349267",
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  swApiBaseUrl: () => process.env.SW_API_BASE_URL ?? "",
  swApiKey: () => process.env.SILENT_WITNESS_API_KEY ?? "",
  posthogKey: () => process.env.POSTHOG_API_KEY ?? "",
  posthogHost: () => process.env.POSTHOG_HOST ?? "https://us.posthog.com",
  slackWebhookUrl: () => process.env.SLACK_WEBHOOK_URL ?? "",
  cronSecret: () => process.env.CRON_SECRET ?? "",
  /** HubSpot writes are gated: nothing is written unless explicitly enabled. */
  hubspotWritesEnabled: () => process.env.HUBSPOT_APPLY === "true",
};
