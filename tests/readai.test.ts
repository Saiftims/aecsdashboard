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
