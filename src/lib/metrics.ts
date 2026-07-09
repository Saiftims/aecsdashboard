/** Pure per-firm usage metric computation (unit-tested). */
import type { CaseRecord } from "@/lib/cases/provider";

export interface FirmUsage {
  casesLifetime: number;
  cases7d: number;
  cases30d: number;
  cases45d: number;
  cases60d: number;
  cases90d: number;
  casesThisMonth: number; // calendar month-to-date
  casesPrev30d: number; // days 31-60 window, for trend
  firstCaseAt: string | null;
  lastCaseAt: string | null;
  daysSinceLastCase: number | null;
  avgCasesPerMonth: number;
  secondCaseAt: string | null;
  usageTrend: "up" | "flat" | "down";
  estRevenue: number;
}

const DAY = 24 * 60 * 60 * 1000;

export function computeFirmUsage(
  cases: CaseRecord[],
  opts: { now?: Date; pricePerCase: number },
): FirmUsage {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const sorted = [...cases].sort(
    (a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime(),
  );

  const within = (days: number) =>
    sorted.filter((c) => nowMs - new Date(c.submittedAt).getTime() <= days * DAY).length;

  const cases30d = within(30);
  const cases60d = within(60);
  const casesPrev30d = cases60d - cases30d;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const casesThisMonth = sorted.filter(
    (c) => new Date(c.submittedAt).getTime() >= monthStart,
  ).length;

  const first = sorted[0] ?? null;
  const last = sorted[sorted.length - 1] ?? null;

  let avgCasesPerMonth = 0;
  if (first) {
    const monthsActive = Math.max(
      (nowMs - new Date(first.submittedAt).getTime()) / (30 * DAY),
      1,
    );
    avgCasesPerMonth = Math.round((sorted.length / monthsActive) * 100) / 100;
  }

  let usageTrend: FirmUsage["usageTrend"] = "flat";
  if (cases30d > casesPrev30d) usageTrend = "up";
  else if (cases30d < casesPrev30d) usageTrend = "down";

  return {
    casesLifetime: sorted.length,
    cases7d: within(7),
    cases30d,
    cases45d: within(45),
    cases60d,
    cases90d: within(90),
    casesThisMonth,
    casesPrev30d,
    firstCaseAt: first?.submittedAt ?? null,
    lastCaseAt: last?.submittedAt ?? null,
    daysSinceLastCase: last
      ? Math.floor((nowMs - new Date(last.submittedAt).getTime()) / DAY)
      : null,
    avgCasesPerMonth,
    secondCaseAt: sorted[1]?.submittedAt ?? null,
    usageTrend,
    estRevenue: sorted.length * opts.pricePerCase,
  };
}

/** Monthly case counts for the firm usage chart: [{ month: "2026-03", count }]. */
export function monthlyCaseCounts(cases: CaseRecord[], months = 12, now = new Date()) {
  const buckets: { month: string; count: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    buckets.push({ month: key, count: 0 });
  }
  const index = new Map(buckets.map((b, i) => [b.month, i]));
  for (const c of cases) {
    const d = new Date(c.submittedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const i = index.get(key);
    if (i !== undefined) buckets[i].count += 1;
  }
  return buckets;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
