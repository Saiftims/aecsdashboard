import { describe, expect, it } from "vitest";
import {
  computeAccountHealth, DEFAULT_SEGMENT_RULES, type AccountHealthInput,
} from "@/lib/health";

const NOW = new Date("2026-07-09T12:00:00Z");
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString();

function base(over: Partial<AccountHealthInput> = {}): AccountHealthInput {
  return {
    segment: "small",
    monthlyTarget: 2,
    rule: DEFAULT_SEGMENT_RULES.small,
    handoffExists: true,
    handoffAccepted: true,
    firstCaseCommitmentDate: null,
    firstCaseSubmittedDate: null,
    firstCaseCompletedDate: null,
    secondCaseDate: null,
    casesLifetime: 0,
    casesThisMonth: 0,
    cases30d: 0,
    daysSinceLastCase: null,
    openIssueCount: 0,
    hasDeliveredCaseWithoutExpertReviewOffered: false,
    hasActiveOpp: false,
    now: NOW,
    ...over,
  };
}

describe("computeAccountHealth priority order", () => {
  it("new_handoff when nothing has happened", () => {
    expect(computeAccountHealth(base()).status).toBe("new_handoff");
  });

  it("awaiting_first_case after commitment, no case", () => {
    expect(computeAccountHealth(base({ firstCaseCommitmentDate: iso(3) })).status)
      .toBe("awaiting_first_case");
  });

  it("activated: first case completed, met 30d floor, none yet this month", () => {
    // cases30d meets the floor (not at-risk) and casesThisMonth = 0 (not
    // healthy/below-target) -> activated.
    expect(computeAccountHealth(base({
      firstCaseCommitmentDate: iso(20), firstCaseSubmittedDate: iso(15),
      firstCaseCompletedDate: iso(10), secondCaseDate: iso(8),
      casesLifetime: 2, cases30d: 1, casesThisMonth: 0, daysSinceLastCase: 8,
    })).status).toBe("activated");
  });

  it("healthy when month target met", () => {
    expect(computeAccountHealth(base({
      firstCaseCompletedDate: iso(20), casesLifetime: 3, casesThisMonth: 2,
      cases30d: 3, daysSinceLastCase: 2, secondCaseDate: iso(15),
    })).status).toBe("healthy");
  });

  it("active_below_target when some but under target", () => {
    expect(computeAccountHealth(base({
      firstCaseCompletedDate: iso(20), casesLifetime: 2, casesThisMonth: 1,
      cases30d: 1, daysSinceLastCase: 5, secondCaseDate: iso(15), monthlyTarget: 2,
      rule: { ...DEFAULT_SEGMENT_RULES.small, atRiskFloor30d: 1 },
    })).status).toBe("active_below_target");
  });

  it("at_risk: no first case within 14 days of commitment", () => {
    expect(computeAccountHealth(base({ firstCaseCommitmentDate: iso(20) })).status)
      .toBe("at_risk");
  });

  it("at_risk: first completed but no second case in 45 days", () => {
    expect(computeAccountHealth(base({
      firstCaseCommitmentDate: iso(60), firstCaseSubmittedDate: iso(55),
      firstCaseCompletedDate: iso(50), casesLifetime: 1, daysSinceLastCase: 50,
    })).status).toBe("at_risk");
  });

  it("at_risk: open issue overrides healthy", () => {
    expect(computeAccountHealth(base({
      firstCaseCompletedDate: iso(20), casesLifetime: 3, casesThisMonth: 5,
      cases30d: 5, daysSinceLastCase: 1, secondCaseDate: iso(15), openIssueCount: 1,
    })).status).toBe("at_risk");
  });

  it("at_risk: delivered case without expert review offered", () => {
    expect(computeAccountHealth(base({
      firstCaseCompletedDate: iso(10), casesLifetime: 2, casesThisMonth: 2,
      cases30d: 2, daysSinceLastCase: 2, secondCaseDate: iso(5),
      hasDeliveredCaseWithoutExpertReviewOffered: true,
    })).status).toBe("at_risk");
  });

  it("churned by segment threshold, overrides at_risk", () => {
    const small = computeAccountHealth(base({
      casesLifetime: 4, daysSinceLastCase: 95, firstCaseCompletedDate: iso(120),
    }));
    expect(small.status).toBe("churned");
    // large firm churns sooner (60d)
    const large = computeAccountHealth(base({
      segment: "large", rule: DEFAULT_SEGMENT_RULES.large,
      casesLifetime: 4, daysSinceLastCase: 65, firstCaseCompletedDate: iso(120),
    }));
    expect(large.status).toBe("churned");
  });

  it("active opportunity prevents churn", () => {
    expect(computeAccountHealth(base({
      casesLifetime: 4, daysSinceLastCase: 95, hasActiveOpp: true,
      firstCaseCompletedDate: iso(120),
    })).status).not.toBe("churned");
  });
});
