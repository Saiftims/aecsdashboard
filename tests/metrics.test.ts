import { describe, expect, it } from "vitest";
import type { CaseRecord } from "@/lib/cases/provider";
import { computeFirmUsage, median, monthlyCaseCounts } from "@/lib/metrics";

const NOW = new Date("2026-07-06T12:00:00Z");

function mkCase(daysAgo: number, id = String(daysAgo)): CaseRecord {
  return {
    swId: `case_${id}`,
    swAccountId: "acc_1",
    swOrganizationId: null,
    name: null,
    caseStage: "completed",
    analysisType: "accident_only",
    submittedAt: new Date(NOW.getTime() - daysAgo * 86400000).toISOString(),
    deliveredAt: null,
    reportStatus: "completed",
    raw: {},
  };
}

describe("computeFirmUsage", () => {
  it("handles a firm with no cases", () => {
    const u = computeFirmUsage([], { now: NOW, pricePerCase: 250 });
    expect(u.casesLifetime).toBe(0);
    expect(u.daysSinceLastCase).toBeNull();
    expect(u.firstCaseAt).toBeNull();
    expect(u.estRevenue).toBe(0);
    expect(u.usageTrend).toBe("flat");
  });

  it("computes window counts, revenue and days-since correctly", () => {
    const cases = [mkCase(2), mkCase(10), mkCase(40), mkCase(80), mkCase(200)];
    const u = computeFirmUsage(cases, { now: NOW, pricePerCase: 250 });
    expect(u.casesLifetime).toBe(5);
    expect(u.cases7d).toBe(1);
    expect(u.cases30d).toBe(2);
    expect(u.cases60d).toBe(3);
    expect(u.cases90d).toBe(4);
    expect(u.casesPrev30d).toBe(1); // day 31-60 window
    expect(u.daysSinceLastCase).toBe(2);
    expect(u.estRevenue).toBe(1250);
    expect(u.usageTrend).toBe("up"); // 2 recent vs 1 previous
  });

  it("orders first/second/last case correctly", () => {
    const u = computeFirmUsage([mkCase(5, "b"), mkCase(50, "a"), mkCase(1, "c")], {
      now: NOW, pricePerCase: 100,
    });
    expect(u.firstCaseAt).toBe(mkCase(50).submittedAt);
    expect(u.secondCaseAt).toBe(mkCase(5).submittedAt);
    expect(u.lastCaseAt).toBe(mkCase(1).submittedAt);
  });

  it("reports a down trend when previous window beats current", () => {
    const u = computeFirmUsage([mkCase(45), mkCase(50)], { now: NOW, pricePerCase: 250 });
    expect(u.cases30d).toBe(0);
    expect(u.casesPrev30d).toBe(2);
    expect(u.usageTrend).toBe("down");
  });
});

describe("monthlyCaseCounts", () => {
  it("buckets cases into calendar months", () => {
    const buckets = monthlyCaseCounts([mkCase(0), mkCase(1), mkCase(35)], 3, NOW);
    expect(buckets).toHaveLength(3);
    expect(buckets[2].month).toBe("2026-07");
    expect(buckets[2].count).toBe(2);
    expect(buckets[1].month).toBe("2026-06");
    expect(buckets[1].count).toBe(1);
  });
});

describe("median", () => {
  it("handles empty, odd and even inputs", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});
