import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { buildRoleActivity, textsComeFromQuo } from "@/lib/rep-activity";

const NOW = new Date("2026-08-10T18:00:00Z"); // 11:00 in America/Los_Angeles
const ALEX = "77777777";                      // unlisted owner => AE
const iso = (hoursAgo: number) =>
  new Date(NOW.getTime() - hoursAgo * 3600000).toISOString();

const settings = { ...DEFAULT_SETTINGS, dashboardTimezone: "America/Los_Angeles" };

const build = (
  touches: { owner_id: string | null; occurred_at: string; type: string }[],
  quoCalls: { call_id: string; hubspot_owner_id: string | null; created_at: string }[] = [],
  quoMessages: { message_id: string; hubspot_owner_id: string | null; created_at: string }[] = [],
) =>
  buildRoleActivity({
    touches,
    quoCalls: quoCalls.map((c) => ({ ...c, direction: "outgoing" })),
    quoMessages: quoMessages.map((m) => ({ ...m, direction: "outgoing" })),
    owners: [], settings, now: NOW,
  });

const total = (r: ReturnType<typeof build>, role: "ae" | "cs",
               key: "calls" | "emails" | "sms" | "social" | "other") =>
  r.find((s) => s.role === role)!.data.reduce((n, d) => n + d[key], 0);

describe("texts", () => {
  it("counts Quo texts and ignores HubSpot's mirror of them", () => {
    // HubSpot's SMS rows are mirrored from Quo, so adding both double counts.
    const r = build(
      [{ owner_id: ALEX, occurred_at: iso(2), type: "sms" }],
      [],
      [{ message_id: "m1", hubspot_owner_id: ALEX, created_at: iso(2) }],
    );
    expect(total(r, "ae", "sms")).toBe(1);
    expect(r.find((s) => s.role === "ae")!.smsSource).toBe("quo");
  });

  it("drops HubSpot SMS rows even when HubSpot left them unowned", () => {
    // An unowned row cannot be matched to a rep, so a per-owner rule would let
    // it through and it would land in the AE series by default.
    const r = build(
      [{ owner_id: null, occurred_at: iso(2), type: "sms" }],
      [],
      [{ message_id: "m1", hubspot_owner_id: ALEX, created_at: iso(2) }],
    );
    expect(total(r, "ae", "sms")).toBe(1);
  });

  it("falls back to HubSpot SMS rows when Quo has none", () => {
    const r = build([{ owner_id: ALEX, occurred_at: iso(2), type: "sms" }]);
    expect(total(r, "ae", "sms")).toBe(1);
    expect(r.find((s) => s.role === "ae")!.smsSource).toBe("hubspot");
  });

  it("keeps texts out of the calls and emails series", () => {
    const r = build([], [], [{ message_id: "m1", hubspot_owner_id: ALEX, created_at: iso(2) }]);
    expect(total(r, "ae", "calls")).toBe(0);
    expect(total(r, "ae", "emails")).toBe(0);
    expect(total(r, "ae", "sms")).toBe(1);
  });

  it("textsComeFromQuo only when Quo actually returned something", () => {
    expect(textsComeFromQuo([])).toBe(false);
    expect(textsComeFromQuo([{}])).toBe(true);
  });
});

describe("other channels", () => {
  it("buckets social DMs together, apart from calls/emails/texts", () => {
    const r = build([
      { owner_id: ALEX, occurred_at: iso(2), type: "linkedin" },
      { owner_id: ALEX, occurred_at: iso(3), type: "instagram" },
      { owner_id: ALEX, occurred_at: iso(4), type: "facebook" },
      { owner_id: ALEX, occurred_at: iso(5), type: "whatsapp" },
      { owner_id: ALEX, occurred_at: iso(6), type: "other" },
    ]);
    expect(total(r, "ae", "social")).toBe(5);
    expect(total(r, "ae", "other")).toBe(0);
    expect(total(r, "ae", "calls")).toBe(0);
  });

  it("leaves an untyped note in the leftover bucket, not in social", () => {
    const r = build([{ owner_id: ALEX, occurred_at: iso(2), type: "note" }]);
    expect(total(r, "ae", "social")).toBe(0);
    expect(total(r, "ae", "other")).toBe(1);
  });
});

describe("calls still behave as before", () => {
  it("prefers Quo per rep and drops that rep's HubSpot calls", () => {
    const r = build(
      [{ owner_id: ALEX, occurred_at: iso(2), type: "call" }],
      [{ call_id: "c1", hubspot_owner_id: ALEX, created_at: iso(2) },
       { call_id: "c2", hubspot_owner_id: ALEX, created_at: iso(3) }],
    );
    expect(total(r, "ae", "calls")).toBe(2);
    expect(r.find((s) => s.role === "ae")!.callSource).toBe("quo");
  });

  it("keeps HubSpot calls for a rep Quo knows nothing about", () => {
    const r = build([{ owner_id: "99999", occurred_at: iso(2), type: "call" }]);
    expect(total(r, "ae", "calls")).toBe(1);
  });
});
