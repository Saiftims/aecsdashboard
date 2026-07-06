import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.vercel", "utf8").split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const [k, ...r] = l.split("=");
      return [k.trim(), r.join("=").trim().replace(/^"|"$/g, "")];
    }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: deals } = await sb.from("deals")
  .select("hubspot_id, name, stage, stage_label, primary_contact_id");
const { data: contacts } = await sb.from("contacts")
  .select("hubspot_id, email");
const { data: acts } = await sb.from("activities")
  .select("kind, activity_type, subject, outcome, deal_hubspot_id, contact_hubspot_id, occurred_at");

const emailById = new Map((contacts ?? []).map((c) => [c.hubspot_id, c.email]));
const meaningful = (a) =>
  a.kind !== "task" && (a.kind !== "note" || Boolean(a.activity_type));

function touchesFor(d) {
  return (acts ?? []).filter((a) =>
    meaningful(a) &&
    (a.deal_hubspot_id === d.hubspot_id ||
     (d.primary_contact_id && a.contact_hubspot_id === d.primary_contact_id)),
  );
}

console.log("=== ALL 20 MQL DEALS + TOUCH EVIDENCE ===");
for (const d of (deals ?? []).filter((x) => x.stage === "5242041534")) {
  const t = touchesFor(d);
  const email = emailById.get(d.primary_contact_id) ?? "no-contact";
  console.log(`\n${t.length ? "TOUCHED " : "WAITING "} ${d.name}  <${email}>`);
  for (const a of t.slice(0, 4)) {
    console.log(`    ${a.kind}${a.activity_type ? `/${a.activity_type}` : ""} ` +
      `${(a.occurred_at ?? "").slice(0, 10)} :: ${(a.subject ?? a.outcome ?? "").slice(0, 70)}`);
  }
}

console.log("\n=== ATTEMPTING-CONTACT STAGE WITH ZERO TOUCHES ===");
for (const d of (deals ?? []).filter((x) => x.stage === "5242041535")) {
  const t = touchesFor(d);
  if (!t.length) console.log(`  ${d.name}  <${emailById.get(d.primary_contact_id) ?? "?"}>`);
}
