import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Extraction, noteBody, parseModelJson, splitParticipants, tokensMatch, transcriptText, verifyReadAiSignature,
  type ReadAiPayload,
} from "@/lib/sync/readai";

const key = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const sign = (body: string) => createHmac("sha256", Buffer.from(key, "base64")).update(body).digest("hex");

describe("webhook auth", () => {
  it("accepts Read.ai's hex HMAC over the raw body, keyed by the decoded base64 secret", () => {
    const body = '{"session_id":"s1"}';
    expect(verifyReadAiSignature(body, sign(body), key)).toBe(true);
    expect(verifyReadAiSignature(body, "sha256=" + sign(body).toUpperCase(), key)).toBe(true);
  });
  it("rejects a tampered body, a wrong key, and a missing header", () => {
    const body = '{"session_id":"s1"}';
    expect(verifyReadAiSignature(body + " ", sign(body), key)).toBe(false);
    expect(verifyReadAiSignature(body, sign(body), Buffer.from("other-key-other-key-other-key-00").toString("base64"))).toBe(false);
    expect(verifyReadAiSignature(body, null, key)).toBe(false);
    expect(verifyReadAiSignature(body, sign(body), "")).toBe(false);
  });
  it("compares URL tokens in constant time without throwing on length mismatch", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("ab", "abc")).toBe(false);
    expect(tokensMatch(null, "abc")).toBe(false);
    expect(tokensMatch("abc", "")).toBe(false);
  });
});

describe("participants", () => {
  it("puts silentwitness.ai, known owners and note-taker bots on our side", () => {
    const { internal, external } = splitParticipants([
      { name: "Chris Sanz", email: "chris@silentwitness.ai" },
      { name: "Alex Q", email: "alex@silentwitness.ai" },
      { name: "Read.ai Notetaker", email: null },
      { name: "Jane Partner", email: "jane@acmelaw.com" },
      { name: "Guest", email: null },
    ], new Set(["alex@silentwitness.ai"]));
    expect(internal.map((p) => p.name)).toEqual(["Chris Sanz", "Alex Q"]);
    expect(external.map((p) => p.name)).toEqual(["Jane Partner", "Guest"]);
  });
});

describe("transcript", () => {
  it("renders speaker lines and keeps head and tail when over the cap", () => {
    const p: ReadAiPayload = {
      session_id: "s", transcript: { speaker_blocks: [
        { speaker: { name: "A" }, words: "hello" }, { speaker: { name: "B" }, words: "" }, { speaker: { name: "B" }, words: "hi" },
      ] },
    };
    expect(transcriptText(p)).toBe("A: hello\nB: hi");
    const long: ReadAiPayload = { session_id: "s", transcript: { speaker_blocks: Array.from({ length: 2000 }, (_, i) => ({ speaker: { name: "A" }, words: `line ${i} ` + "x".repeat(50) })) } };
    const t = transcriptText(long, 10_000);
    expect(t.length).toBeLessThan(10_200);
    expect(t.startsWith("A: line 0 ")).toBe(true);
    expect(t.includes("line 1999")).toBe(true);
    expect(t).toContain("characters omitted");
  });
});

describe("extraction parsing", () => {
  const sample = {
    is_sales_or_cs_call: true, not_a_call_reason: null, firm_name: "Acme Injury Law",
    primary_contact: { name: "Jane Partner", role: "managing partner", email: "jane@acmelaw.com" },
    primary_contact_role_category: "decision_maker",
    other_firm_attendees: [{ name: "Bob Intake", role: "intake manager" }], silent_witness_attendees: ["Chris Sanz"],
    case_management_system: "filevine", case_management_system_detail: null,
    mva_cases_per_month: 40, total_caseload: 600, caseload_notes: "about 40 new MVA a month",
    plan_discussed: "boutique", plan_chosen: null, price_concerns: "wants per-case pricing instead of a monthly plan",
    next_step: "Chris sends Boutique proposal; firm submits 2 test cases", next_step_due: "2026-11-14",
    summary: "Demo with Acme; they run Filevine and take ~40 MVA cases a month.",
    evidence: { case_management_system: "we're on Filevine", case_volume: "forty-ish auto cases a month", plan: null },
  };
  it("accepts a well-formed reply, including fenced JSON", () => {
    const x = Extraction.parse(parseModelJson("Here you go:\n```json\n" + JSON.stringify(sample) + "\n```"));
    expect(x.firm_name).toBe("Acme Injury Law");
    expect(x.mva_cases_per_month).toBe(40);
  });
  it("rejects values outside the vocab so a hallucinated system never reaches HubSpot", () => {
    expect(() => Extraction.parse({ ...sample, case_management_system: "Salesforce" })).toThrow();
    expect(() => Extraction.parse({ ...sample, plan_discussed: "enterprise" })).toThrow();
    expect(() => Extraction.parse({ ...sample, next_step_due: "next Friday" })).toThrow();
  });
  it("writes every requested field into the note", () => {
    const x = Extraction.parse(sample);
    const body = noteBody({ session_id: "s", start_time: "2026-11-12T15:00:00Z", title: "Acme demo", report_url: "https://app.read.ai/analytics/meetings/s" }, x);
    for (const needle of ["2026-11-12", "Firm: Acme Injury Law", "Spoke with: Jane Partner (managing partner)", "Also from the firm: Bob Intake (intake manager)",
      "Silent Witness: Chris Sanz", "Case management system: Filevine", "MVA cases / month: 40 - total caseload 600", "discussed Boutique",
      "Price concerns: wants per-case pricing", "Next step: Chris sends Boutique proposal; firm submits 2 test cases (by 2026-11-14)", "Report: https://app.read.ai"]) {
      expect(body).toContain(needle);
    }
  });
});

describe("history import", async () => {
  const { EXCLUDED_TITLE_RE, internalOnly, planProps } = await import("@/lib/sync/readai");
  const { identityFromIdToken, meetingToPayload, pkcePair } = await import("@/lib/sync/readai-backfill");

  it("filters standups, interviews and growth syncs by title, keeps customer calls", () => {
    for (const t of ["Daily Standup", "Growth stand-up", "Interview - CS Manager", "Growth Sync", "Team sync"]) expect(EXCLUDED_TITLE_RE.test(t), t).toBe(true);
    for (const t of ["Omega Law x Silent Witness", "Demo - Smith & Jones", "Growth plan review with Acme Injury", "Onboarding call"]) expect(EXCLUDED_TITLE_RE.test(t), t).toBe(false);
  });

  it("skips a meeting only when every attendee is provably ours", () => {
    const ours = new Set(["chris@silentwitness.ai"]);
    expect(internalOnly([{ email: "saif@silentwitness.ai" }, { email: "chris@silentwitness.ai" }, { name: "Read.ai Notetaker" }], ours)).toBe(true);
    expect(internalOnly([{ email: "saif@silentwitness.ai" }, { name: "Dial-in caller" }], ours)).toBe(false);
    expect(internalOnly([{ email: "saif@silentwitness.ai" }, { email: "jane@omegalaw.com" }], ours)).toBe(false);
    expect(internalOnly([], ours)).toBe(false);
  });

  it("maps an API meeting onto the webhook payload shape", () => {
    const p = meetingToPayload({
      id: "01ABC", title: "Demo", start_time_ms: 1_762_000_000_000, end_time_ms: 1_762_003_600_000, platform: "zoom", report_url: "https://app.read.ai/x",
      participants: [{ name: "Jane", email: "jane@omegalaw.com", attended: true }, { name: "Ghost", email: "g@x.com", attended: false }],
      owner: { name: "Chris", email: "chris@silentwitness.ai" }, summary: "We talked.",
      action_items: ["Send proposal", { text: "Book follow-up" }],
      transcript: { turns: [{ speaker: { name: "Jane" }, text: "We use Filevine.", start_time_ms: 1_762_000_001_000 }] },
    });
    expect(p.session_id).toBe("01ABC");
    expect(p.request_id).toBe("backfill:01ABC");
    expect(p.start_time).toBe("2025-11-01T12:26:40.000Z");
    expect(p.participants).toEqual([{ name: "Jane", email: "jane@omegalaw.com" }]);
    expect(p.action_items).toEqual([{ text: "Send proposal" }, { text: "Book follow-up" }]);
    expect(p.transcript?.speaker_blocks?.[0]).toMatchObject({ speaker: { name: "Jane" }, words: "We use Filevine." });
  });

  it("lets a newer call overwrite, an older call only fill blanks and never touch last-call fields", () => {
    const current = { sw_case_management_system: "clio", sw_total_caseload: null, sw_last_call_date: "2026-10-01", sw_last_call_summary: "Oct call" };
    const desired = { sw_case_management_system: "filevine", sw_total_caseload: 400, sw_last_call_date: "2026-03-01", sw_last_call_summary: "March call", sw_estimated_monthly_case_volume: undefined };
    const older = planProps(current, desired, true, ["sw_last_call_date", "sw_last_call_summary"]);
    expect(older.props).toEqual({ sw_total_caseload: 400 });
    expect(older.fresh).toEqual(["sw_total_caseload"]);
    const newer = planProps(current, desired, false, ["sw_last_call_date", "sw_last_call_summary"]);
    expect(newer.set).toEqual(["sw_case_management_system", "sw_total_caseload", "sw_last_call_date", "sw_last_call_summary"]);
    expect(newer.fresh).toEqual(["sw_total_caseload"]);
  });

  it("reads the account email out of the id_token and builds a valid PKCE pair", () => {
    const payload = Buffer.from(JSON.stringify({ email: "Chris@SilentWitness.ai", name: "Chris" })).toString("base64url");
    expect(identityFromIdToken(`h.${payload}.s`)).toEqual({ email: "chris@silentwitness.ai", name: "Chris" });
    expect(identityFromIdToken(undefined)).toEqual({ email: null, name: null });
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("extraction normalisation", async () => {
  const { Extraction, normalizeExtraction } = await import("@/lib/sync/readai");
  const base = { is_sales_or_cs_call: false, not_a_call_reason: "internal", firm_name: null, primary_contact: null, mva_cases_per_month: null, total_caseload: null, plan_discussed: null, plan_chosen: null, price_concerns: null, next_step: null, summary: "Internal sync." };
  it("accepts null / off-list enum values instead of failing the call", () => {
    const x = Extraction.parse(normalizeExtraction({ ...base, case_management_system: null, plan_discussed: "Boutique plan", primary_contact_role_category: "paralegal" }));
    expect(x.case_management_system).toBe("unknown");
    expect(x.plan_discussed).toBeNull();
    expect(x.primary_contact_role_category).toBeNull();
    const y = Extraction.parse(normalizeExtraction({ ...base, case_management_system: "Smart Advocate", mva_cases_per_month: "40", next_step_due: "next Friday" }));
    expect(y.case_management_system).toBe("smartadvocate");
    expect(y.mva_cases_per_month).toBe(40);
    expect(y.next_step_due).toBeNull();
    const z = Extraction.parse(normalizeExtraction({ ...base, case_management_system: "Salesforce" }));
    expect(z.case_management_system).toBe("other");
    expect(z.case_management_system_detail).toBe("Salesforce");
    const w = Extraction.parse(normalizeExtraction({ ...base, case_management_system: "unknown", other_firm_attendees: [{ name: "Nate James" }, { name: "Speaker 2" }, { name: "UNKNOWN_SPEAKER" }] }));
    expect(w.other_firm_attendees.map((a) => a.name)).toEqual(["Nate James"]);
  });
});
