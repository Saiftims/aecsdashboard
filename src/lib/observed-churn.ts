import type { CohortRow } from "@/lib/queries";

export type ChurnBands = [number, number, number, number];

/** Churn measured from the subscription cohorts on the Activity page's
 * logo-retention chart (owner, 2026-10-21: "change unit economics based on
 * these retention numbers"). Each band is a pooled monthly hazard: of every
 * subscriber still on a plan at month m-1 across all cohorts, the share gone
 * by month m. The tail (M4+) is the pooled hazard over every observed
 * firm-month, because no cohort is older than three months yet. `exposure` is
 * how many firm-months stand behind each band - the figure is only as good as
 * that count. Lives in lib (not the client component) because the server page
 * computes it. */
export interface ObservedChurn {
  bands: ChurnBands;
  exposure: [number, number, number, number];
  churned: [number, number, number, number];
  firms: number;
}

export function observedChurn(cohorts: CohortRow[]): ObservedChurn {
  const exposure = [0, 0, 0, 0];
  const churned = [0, 0, 0, 0];
  let firms = 0;
  for (const c of cohorts) {
    for (const m of c.members) {
      if (m.billing !== "subscription") continue;
      firms += 1;
      for (let k = 1; k < m.retained.length && k <= 3; k++) {
        if (!m.retained[k - 1]) break; // already churned - no longer exposed
        exposure[k - 1] += 1;
        if (!m.retained[k]) churned[k - 1] += 1;
      }
    }
  }
  const allExp = exposure[0] + exposure[1] + exposure[2];
  const allChurn = churned[0] + churned[1] + churned[2];
  exposure[3] = allExp;
  churned[3] = allChurn;
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    bands: [pct(churned[0], exposure[0]), pct(churned[1], exposure[1]), pct(churned[2], exposure[2]), pct(allChurn, allExp)],
    exposure: exposure as ObservedChurn["exposure"],
    churned: churned as ObservedChurn["churned"],
    firms,
  };
}
