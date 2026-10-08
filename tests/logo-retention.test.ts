import { describe, expect, it } from "vitest";
import {
  lastOnOrBefore, logoRetainedAt, utcMonthAsOf, TX_RETENTION_DAYS,
} from "@/lib/queries";

const MAY = new Date("2026-05-15T12:00:00Z");
const MAY_END = utcMonthAsOf(2026 * 12 + 4, new Date("2026-10-08T12:00:00Z"));
const JUN_END = utcMonthAsOf(2026 * 12 + 5, new Date("2026-10-08T12:00:00Z"));
const AUG_END = utcMonthAsOf(2026 * 12 + 7, new Date("2026-10-08T12:00:00Z"));
const NOW = new Date("2026-10-08T12:00:00Z");

describe("logoRetainedAt", () => {
  it("month 0 is always retained", () => {
    expect(logoRetainedAt({
      billing: "subscription", monthOffset: 0, asOf: MAY,
      planEnd: new Date("2026-05-28T00:00:00Z"), lastCaseAt: null,
    })).toBe(true);
    expect(logoRetainedAt({
      billing: "transactional", monthOffset: 0, asOf: MAY,
      planEnd: null, lastCaseAt: null,
    })).toBe(true);
  });

  it("a subscriber is retained until they cancel, then churned", () => {
    const end = new Date("2026-06-15T00:00:00Z");
    expect(logoRetainedAt({
      billing: "subscription", monthOffset: 1, asOf: MAY_END,
      planEnd: end, lastCaseAt: null,
    })).toBe(true);
    expect(logoRetainedAt({
      billing: "subscription", monthOffset: 1, asOf: JUN_END,
      planEnd: end, lastCaseAt: null,
    })).toBe(false);
    expect(logoRetainedAt({
      billing: "subscription", monthOffset: 2, asOf: AUG_END,
      planEnd: null, lastCaseAt: null,
    })).toBe(true);
  });

  it("a live subscriber is retained even with no cases", () => {
    expect(logoRetainedAt({
      billing: "subscription", monthOffset: 3, asOf: NOW,
      planEnd: null, lastCaseAt: null,
    })).toBe(true);
  });

  it(`a transactional firm is retained for ${TX_RETENTION_DAYS} days after the last case, not 30`, () => {
    const first = new Date("2026-05-08T00:00:00Z");
    // 53 days after first case, still inside 90.
    expect(logoRetainedAt({
      billing: "transactional", monthOffset: 1, asOf: JUN_END,
      planEnd: null, lastCaseAt: first,
    })).toBe(true);
    // ~115 days after first case, past 90.
    expect(logoRetainedAt({
      billing: "transactional", monthOffset: 3, asOf: AUG_END,
      planEnd: null, lastCaseAt: first,
    })).toBe(false);
  });
});

describe("utcMonthAsOf / lastOnOrBefore", () => {
  it("uses now for the current month and month-end for past months", () => {
    const octIdx = 2026 * 12 + 9;
    expect(utcMonthAsOf(octIdx, NOW).toISOString()).toBe(NOW.toISOString());
    expect(utcMonthAsOf(2026 * 12 + 4, NOW).toISOString()).toBe("2026-05-31T23:59:59.999Z");
  });

  it("ignores cases after the as-of date", () => {
    const may = Date.parse("2026-05-08T00:00:00Z");
    const aug = Date.parse("2026-08-20T00:00:00Z");
    expect(lastOnOrBefore([may, aug], Date.parse("2026-06-30T23:59:59Z"))).toBe(may);
  });
});
