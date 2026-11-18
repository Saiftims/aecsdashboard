/** Path-to-$2M model. Pure functions and constants shared by the shareable
 * plan page; no server dependencies so it can run in the browser for the
 * custom-scenario controls. Inputs snapshot HubSpot / Stripe / Meta / app
 * actuals as of 2026-11-17. */

export const MONTHS_ACTUAL = ["Jul", "Aug", "Sep", "Oct", "Nov*"];
export const ACT = {
  metaSpend: [5856, 7718, 7225, 14996, 9676],
  metaLeads: [83, 94, 62, 185, 143],
  dealsCreated: [130, 102, 72, 277, 186],
  demos: [38, 50, 38, 70, 71],
  closedWon: [16, 19, 28, 28, 15],
  payingFirms: [9, 18, 30, 45, 32],
  cases: [32, 45, 60, 89, 53],
  revenue: [6700, 6772, 12468, 17132, 16148],
};
export const NOV_PROJECTED_REVENUE = 26500;
export const ACTIVE_SUBS = 62;
export const MRR = 23045;

export const UNIT = {
  baseMetaSpend: 15000,
  cpl: 75,
  organicMqls: 60,
  mqlToDemo: 0.32,
  demoToWon: 0.3,
  demosPerAe: 80,
  demosPerBdr: 35,
  arpa: 410,
  casesPerFirm: 2.0,
  churn: 0.01,
  churnWithCs: 0.0075,
  payingFirmsNow: 64,
};

export const TARGET_ARR = 2_000_000;
export const TARGET_MRR = TARGET_ARR / 12;
export const PLAN_MONTHS = ["Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"];

export interface Scenario {
  name: string;
  aeStarts: number[];
  bdrStarts: number[];
  metaSpend: number;
  csManagerStart: number | null;
  arpaGrowth: number;
  churn: number;
}

export interface MonthResult {
  month: string;
  mqls: number;
  demos: number;
  wins: number;
  firms: number;
  arpa: number;
  cases: number;
  revenue: number;
  arr: number;
  demoCapacity: number;
}

export function simulate(s: Scenario): MonthResult[] {
  let firms = UNIT.payingFirmsNow;
  let arpa = UNIT.arpa;
  let casesPerFirm = UNIT.casesPerFirm;
  const out: MonthResult[] = [];
  for (let t = 0; t < PLAN_MONTHS.length; t++) {
    const cpl = UNIT.cpl + Math.max(0, (s.metaSpend - 15000) / 10000) * 8;
    const mqls = s.metaSpend / cpl + UNIT.organicMqls;
    let demoCapacity = UNIT.demosPerAe;
    for (const start of s.aeStarts) {
      const k = t - start;
      if (k < 0) continue;
      demoCapacity += UNIT.demosPerAe * (k === 0 ? 0.3 : k === 1 ? 0.6 : 1);
    }
    let bdrDemos = 0;
    for (const start of s.bdrStarts) {
      const k = t - start;
      if (k < 0) continue;
      bdrDemos += UNIT.demosPerBdr * (k === 0 ? 0.5 : 1);
    }
    const demos = Math.min(mqls * UNIT.mqlToDemo + bdrDemos, demoCapacity, mqls * 0.6);
    const wins = demos * UNIT.demoToWon;
    const csActive = s.csManagerStart !== null && t >= s.csManagerStart;
    const churn = csActive ? Math.min(s.churn, UNIT.churnWithCs) : s.churn;
    firms = firms * (1 - churn) + wins;
    arpa *= 1 + s.arpaGrowth + (csActive ? 0.015 : 0);
    if (csActive) casesPerFirm = Math.min(2.6, casesPerFirm + 0.1);
    const revenue = firms * arpa;
    out.push({ month: PLAN_MONTHS[t], mqls, demos, wins, firms, arpa, cases: firms * casesPerFirm, revenue, arr: revenue * 12, demoCapacity });
  }
  return out;
}

export const SCENARIOS: Scenario[] = [
  { name: "A · Current momentum", aeStarts: [], bdrStarts: [], metaSpend: UNIT.baseMetaSpend, csManagerStart: null, arpaGrowth: 0.01, churn: UNIT.churn },
  { name: "B · Lean hires", aeStarts: [1], bdrStarts: [0], metaSpend: 20000, csManagerStart: 0, arpaGrowth: 0.01, churn: UNIT.churn },
  { name: "C · Full push", aeStarts: [1, 2], bdrStarts: [0, 1], metaSpend: 35000, csManagerStart: 0, arpaGrowth: 0.025, churn: UNIT.churn },
];

export const HIRES = [
  { role: "CS Manager", start: "Dec", ote: 110000, why: "Lift cases/firm 2.0 → 2.6, move Solo firms to Boutique/Growth, reactivate paused accounts, keep churn at ~1%. Already in process." },
  { role: "BDR #1", start: "Dec", ote: 65000, why: "Work the 300+ MQLs/mo Meta already produces: Oct created 277 deals but only 65 reached a demo. Target 35 booked demos/mo by Jan." },
  { role: "AE #2 (Chris profile)", start: "Jan", ote: 120000, why: "Chris is at capacity (70+ demos/mo, 67 of 71 wins since Sep). Second closer doubles demo capacity; ramped by March." },
  { role: "BDR #2", start: "Jan", ote: 65000, why: "Feeds AE #2 and the Meta scale-up to $35k/mo. Also owns outbound to Filevine/Needles firms (CRM shows 28 on those systems)." },
  { role: "AE #3", start: "Feb", ote: 120000, why: "Needed to hold 200+ demos/mo in Q2 without win rate collapsing from rushed calls." },
];

export const money = (n: number, digits = 0) => `$${n.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
export const kfmt = (n: number) => `$${(n / 1000).toFixed(0)}k`;
export const mfmt = (n: number) => `$${(n / 1_000_000).toFixed(2)}M`;
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const r0 = (n: number) => Math.round(n).toLocaleString("en-US");
export const hitMonth = (r: MonthResult[]) => r.find((x) => x.arr >= TARGET_ARR)?.month ?? "not by June";
