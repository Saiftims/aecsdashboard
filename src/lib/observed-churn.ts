import type { CohortRow } from "@/lib/queries";

/** Retention the unit economics actually run on: the subscription cohorts
 * from the Activity page's logo-retention chart, averaged (owner, 2026-10-21:
 * "use these retention numbers ... remove the base case churn and different
 * scenarios, make the figure actual, just calculate what an average looks
 * like"). A cohort with no subscriber (June 2026) is skipped.
 *
 * `average[m]` is firm-weighted: of every subscriber whose cohort has reached
 * month m, the share still on a plan - so May's 5 firms count five times and
 * July's one firm once. Beyond the last observed month the curve LEVELS OFF
 * at the last observed value (owner, 2026-10-21: "lets not assume same churn
 * rate per month. lets assume it levels off at 83%") - May's cohort has held
 * 80% from month 1 to month 3, which is the evidence for a plateau. Lives in
 * lib because the server page computes it. */
export interface ObservedCohort {
  key: string;
  label: string;
  firms: number;
  /** % retained at month 0..N; null once the cohort has not reached that month. */
  retention: (number | null)[];
}

export interface ObservedRetention {
  cohorts: ObservedCohort[];
  /** % retained at month 0..N across all cohorts that reached each month. */
  average: number[];
  /** Firms standing behind each `average` entry. */
  elapsed: number[];
  /** Where the curve levels off: the last observed average, in %. */
  plateau: number;
  firms: number;
}

export function observedRetention(cohorts: CohortRow[]): ObservedRetention | null {
  const subs = cohorts
    .map((c) => ({ ...c, members: c.members.filter((m) => m.billing === "subscription") }))
    .filter((c) => c.members.length > 0);
  if (!subs.length) return null;
  const months = Math.max(...subs.flatMap((c) => c.members.map((m) => m.retained.length)));
  const average: number[] = [];
  const elapsed: number[] = [];
  for (let m = 0; m < months; m++) {
    const reached = subs.flatMap((c) => c.members.filter((x) => x.retained.length > m));
    if (!reached.length) break;
    elapsed.push(reached.length);
    average.push(Math.round((reached.filter((x) => x.retained[m]).length / reached.length) * 1000) / 10);
  }
  return {
    cohorts: subs.map((c) => ({
      key: c.key, label: c.label, firms: c.members.length,
      retention: Array.from({ length: average.length }, (_, m) => {
        const reached = c.members.filter((x) => x.retained.length > m);
        return reached.length ? Math.round((reached.filter((x) => x.retained[m]).length / reached.length) * 100) : null;
      }),
    })),
    average, elapsed,
    plateau: average[average.length - 1] ?? 100,
    firms: subs.reduce((a, c) => a + c.members.length, 0),
  };
}

/** Share of an acquired cohort still paying in month m+1 (m = 0..horizon-1):
 * the observed average while it lasts, then flat at the plateau. */
export function observedSurvival(obs: ObservedRetention, horizon: number): number[] {
  return Array.from({ length: horizon }, (_, m) =>
    (m < obs.average.length ? obs.average[m] : obs.plateau) / 100);
}
