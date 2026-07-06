import { describe, expect, it } from "vitest";
import { computeHealth, computeRiskFlags } from "@/lib/health";

const allGood = {
  caseInLast30d: true,
  twoPlusCasesInLast60d: true,
  onboardingCompleted: true,
  championIdentified: true,
  interactionInLast30d: true,
  futureTaskOrMeetingExists: true,
  noUnresolvedCriticalIssue: true,
};

describe("computeHealth", () => {
  it("scores 100 when every factor is met and category is green", () => {
    const r = computeHealth(allGood);
    expect(r.score).toBe(100);
    expect(r.category).toBe("green");
    expect(r.factors).toHaveLength(7);
  });

  it("scores 0 when nothing is met and category is red", () => {
    const r = computeHealth({
      caseInLast30d: false,
      twoPlusCasesInLast60d: false,
      onboardingCompleted: false,
      championIdentified: false,
      interactionInLast30d: false,
      futureTaskOrMeetingExists: false,
      noUnresolvedCriticalIssue: false,
    });
    expect(r.score).toBe(0);
    expect(r.category).toBe("red");
  });

  it("weights recent cases at 30 points and applies category bounds", () => {
    const r = computeHealth({ ...allGood, caseInLast30d: false });
    expect(r.score).toBe(70);
    expect(r.category).toBe("green"); // 70 is the green boundary

    const y = computeHealth({
      ...allGood, caseInLast30d: false, twoPlusCasesInLast60d: false,
      onboardingCompleted: false,
    });
    expect(y.score).toBe(40);
    expect(y.category).toBe("yellow"); // 40 is the yellow boundary
  });

  it("keeps the rubric transparent: earned points sum to score", () => {
    const r = computeHealth({ ...allGood, championIdentified: false });
    expect(r.factors.reduce((s, f) => s + f.earned, 0)).toBe(r.score);
  });
});

describe("computeRiskFlags", () => {
  const base = {
    onboardingCompleted: true,
    daysSinceClosedWon: 10,
    firstCaseAt: "2026-06-01T00:00:00Z",
    secondCaseAt: "2026-06-20T00:00:00Z",
    daysSinceLastCase: 5,
    daysSinceLastInteraction: 5,
    openProductIssue: false,
    negativeFeedback: false,
    paymentIssue: false,
    championIdentified: true,
    futureTaskExists: true,
    firstCaseTargetDays: 14,
    secondCaseTargetDays: 45,
    atRiskInactivityDays: 30,
  };

  it("returns no flags for a healthy account", () => {
    expect(computeRiskFlags(base)).toEqual([]);
  });

  it("flags a missing first case only after the target window", () => {
    expect(
      computeRiskFlags({ ...base, firstCaseAt: null, secondCaseAt: null, daysSinceClosedWon: 10, daysSinceLastCase: null }),
    ).toEqual([]);
    expect(
      computeRiskFlags({ ...base, firstCaseAt: null, secondCaseAt: null, daysSinceClosedWon: 20, daysSinceLastCase: null }),
    ).toContain("No first case within 14 days");
  });

  it("flags inactivity and missing second case", () => {
    const flags = computeRiskFlags({
      ...base, secondCaseAt: null, daysSinceLastCase: 50,
    });
    expect(flags).toContain("No second case within 45 days");
    expect(flags).toContain("No case submitted in 30 days");
  });

  it("flags discipline gaps", () => {
    const flags = computeRiskFlags({
      ...base, championIdentified: false, futureTaskExists: false,
      daysSinceLastInteraction: 40,
    });
    expect(flags).toEqual(
      expect.arrayContaining([
        "No champion identified", "No future task", "No customer interaction in 30 days",
      ]),
    );
  });
});
