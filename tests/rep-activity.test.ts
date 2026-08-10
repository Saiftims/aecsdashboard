import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { activityTodayFor, buildRoleActivity, textsComeFromQuo } from "@/lib/rep-activity";

const NOW = new Date("2026-08-10T18:00:00Z"); // 11:00 in America/Los_Angeles
const ALEX = "77777777";                      // unlisted owner => AE
const iso = (hoursAgo: number) =>
  new Date(NOW.getTime() - hoursAgo * 3600000).toISOString();

const settings = { ...DEFAULT_SETTINGS, dashboardTimezone: "America/Los_Angeles" };

const build = (
  touches: { owner_id: string | null; occurred_at: string; type: string; kind?: string }[],
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
               key: "calls" | "emails" | "sms" | "other" | "total") =>
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
  it("buckets DMs and meetings together, apart from calls/emails/texts", () => {
    // One band: split out, each of these was a sliver too thin to read.
    const r = build([
      { owner_id: ALEX, occurred_at: iso(2), type: "linkedin" },
      { owner_id: ALEX, occurred_at: iso(3), type: "instagram" },
      { owner_id: ALEX, occurred_at: iso(4), type: "facebook" },
      { owner_id: ALEX, occurred_at: iso(5), type: "whatsapp" },
      { owner_id: ALEX, occurred_at: iso(6), type: "other" },
      { owner_id: ALEX, occurred_at: iso(7), type: "meeting", kind: "meeting" },
      { owner_id: ALEX, occurred_at: iso(8), type: "in_person_visit", kind: "meeting" },
    ]);
    expect(total(r, "ae", "other")).toBe(7);
    expect(total(r, "ae", "calls")).toBe(0);
    expect(total(r, "ae", "emails")).toBe(0);
    expect(total(r, "ae", "sms")).toBe(0);
  });

  it("still excludes a task the quick logger stamped with a type", () => {
    // A walk_in task is a plan to visit an office, not a visit.
    const r = build([
      { owner_id: ALEX, occurred_at: iso(2), type: "walk_in", kind: "task" },
      { owner_id: ALEX, occurred_at: iso(3), type: "linkedin", kind: "note" },
    ]);
    expect(total(r, "ae", "other")).toBe(1);
    expect(total(r, "ae", "total")).toBe(1);
  });
});

describe("activity target", () => {
  it("stacks every channel into the day total", () => {
    const r = build(
      [{ owner_id: ALEX, occurred_at: iso(2), type: "email" },
       { owner_id: ALEX, occurred_at: iso(2), type: "linkedin" },
       { owner_id: ALEX, occurred_at: iso(2), type: "meeting" }],
      [{ call_id: "c1", hubspot_owner_id: ALEX, created_at: iso(2) }],
      [{ message_id: "m1", hubspot_owner_id: ALEX, created_at: iso(2) }],
    );
    const day = r.find((s) => s.role === "ae")!.data.find((d) => d.total > 0)!;
    expect(day).toMatchObject({ calls: 1, emails: 1, sms: 1, other: 2 });
    expect(day.total).toBe(5);
    expect(total(r, "ae", "total")).toBe(5);
  });

  it("carries one total target per role, not per channel", () => {
    const r = build([]);
    expect(r.find((s) => s.role === "ae")!.activityTarget).toBe(75);
    expect(r.find((s) => s.role === "cs")!.activityTarget).toBe(40);
  });

  it("excludes unmarked notes, which are the agent's own context notes", () => {
    // These outnumber real touches on some days; counting them would show a rep
    // hitting the target without contacting anyone.
    const r = build([
      { owner_id: ALEX, occurred_at: iso(2), type: "note" },
      { owner_id: ALEX, occurred_at: iso(3), type: "task" },
      { owner_id: ALEX, occurred_at: iso(4), type: "call" },
    ]);
    expect(total(r, "ae", "total")).toBe(1);
    expect(total(r, "ae", "other")).toBe(0);
  });

  it("averages the total over the window for the caption", () => {
    const call = (hoursAgo: number) =>
      ({ owner_id: ALEX, occurred_at: iso(hoursAgo), type: "call" });
    const touches = [
      ...Array.from({ length: 14 }, () => call(2)),
      ...Array.from({ length: 7 }, () => call(26)),
    ];
    const r = build(touches);
    // 21 calls over a 7-day window.
    expect(r.find((s) => s.role === "ae")!.dailyAverage).toBe(3);
  });
});

describe("activityTodayFor", () => {
  const today = (
    touches: { owner_id: string | null; occurred_at: string; type: string }[],
    quoCalls: { call_id: string; hubspot_owner_id: string | null; created_at: string }[] = [],
    quoMessages: { message_id: string; hubspot_owner_id: string | null; created_at: string }[] = [],
  ) =>
    activityTodayFor({
      ownerId: ALEX,
      touches,
      quoCalls: quoCalls.map((c) => ({ ...c, direction: "outgoing" })),
      quoMessages: quoMessages.map((m) => ({ ...m, direction: "outgoing" })),
      settings, now: NOW,
    });

  it("totals every channel touched today", () => {
    const r = today(
      [{ owner_id: ALEX, occurred_at: iso(1), type: "email" },
       { owner_id: ALEX, occurred_at: iso(2), type: "linkedin" }],
      [{ call_id: "c1", hubspot_owner_id: ALEX, created_at: iso(1) }],
      [{ message_id: "m1", hubspot_owner_id: ALEX, created_at: iso(3) }],
    );
    expect(r).toMatchObject({ calls: 1, emails: 1, sms: 1, other: 1, total: 4 });
  });

  it("ignores yesterday, other reps and unmarked notes", () => {
    const r = today([
      { owner_id: ALEX, occurred_at: iso(30), type: "call" },   // yesterday
      { owner_id: "other", occurred_at: iso(1), type: "call" }, // not this rep
      { owner_id: ALEX, occurred_at: iso(1), type: "note" },    // agent note
      { owner_id: ALEX, occurred_at: iso(1), type: "call" },
    ]);
    expect(r.total).toBe(1);
  });

  it("does not count a text twice when HubSpot mirrored it", () => {
    const r = today(
      [{ owner_id: ALEX, occurred_at: iso(1), type: "sms" }],
      [],
      [{ message_id: "m1", hubspot_owner_id: ALEX, created_at: iso(1) }],
    );
    expect(r.sms).toBe(1);
    expect(r.total).toBe(1);
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
