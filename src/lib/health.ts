/** Transparent 7-factor customer health score (0-100) + explicit risk flags.
 * No ML - every point is attributable to a named factor. */

export interface HealthInput {
  caseInLast30d: boolean;
  twoPlusCasesInLast60d: boolean;
  onboardingCompleted: boolean;
  championIdentified: boolean;
  interactionInLast30d: boolean;
  futureTaskOrMeetingExists: boolean;
  noUnresolvedCriticalIssue: boolean;
}

export interface HealthFactor {
  key: keyof HealthInput;
  label: string;
  points: number;
  earned: number;
}

export interface HealthResult {
  score: number;
  category: "green" | "yellow" | "red";
  factors: HealthFactor[];
}

const RUBRIC: { key: keyof HealthInput; label: string; points: number }[] = [
  { key: "caseInLast30d", label: "Case submitted in last 30 days", points: 30 },
  { key: "twoPlusCasesInLast60d", label: "2+ cases in last 60 days", points: 20 },
  { key: "onboardingCompleted", label: "Onboarding completed", points: 10 },
  { key: "championIdentified", label: "Active champion identified", points: 10 },
  { key: "interactionInLast30d", label: "Meaningful interaction in last 30 days", points: 10 },
  { key: "futureTaskOrMeetingExists", label: "Future task or meeting exists", points: 10 },
  { key: "noUnresolvedCriticalIssue", label: "No unresolved critical issue", points: 10 },
];

export function computeHealth(input: HealthInput): HealthResult {
  const factors = RUBRIC.map((r) => ({
    ...r,
    earned: input[r.key] ? r.points : 0,
  }));
  const score = factors.reduce((s, f) => s + f.earned, 0);
  const category = score >= 70 ? "green" : score >= 40 ? "yellow" : "red";
  return { score, category, factors };
}

export interface RiskFlagInput {
  onboardingCompleted: boolean;
  daysSinceClosedWon: number | null;
  firstCaseAt: string | null;
  secondCaseAt: string | null;
  daysSinceLastCase: number | null;
  daysSinceLastInteraction: number | null;
  openProductIssue: boolean;
  negativeFeedback: boolean;
  paymentIssue: boolean;
  championIdentified: boolean;
  futureTaskExists: boolean;
  firstCaseTargetDays: number;
  secondCaseTargetDays: number;
  atRiskInactivityDays: number;
}

export function computeRiskFlags(i: RiskFlagInput): string[] {
  const flags: string[] = [];
  if (!i.onboardingCompleted) flags.push("No onboarding completed");
  if (
    !i.firstCaseAt &&
    i.daysSinceClosedWon !== null &&
    i.daysSinceClosedWon > i.firstCaseTargetDays
  )
    flags.push(`No first case within ${i.firstCaseTargetDays} days`);
  if (
    i.firstCaseAt &&
    !i.secondCaseAt &&
    i.daysSinceLastCase !== null &&
    i.daysSinceLastCase > i.secondCaseTargetDays
  )
    flags.push(`No second case within ${i.secondCaseTargetDays} days`);
  if (i.daysSinceLastCase !== null && i.daysSinceLastCase > i.atRiskInactivityDays)
    flags.push(`No case submitted in ${i.atRiskInactivityDays} days`);
  if (i.daysSinceLastInteraction !== null && i.daysSinceLastInteraction > 30)
    flags.push("No customer interaction in 30 days");
  if (i.openProductIssue) flags.push("Open product issue");
  if (i.negativeFeedback) flags.push("Negative customer feedback");
  if (i.paymentIssue) flags.push("Payment issue");
  if (!i.championIdentified) flags.push("No champion identified");
  if (!i.futureTaskExists) flags.push("No future task");
  return flags;
}
