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

// ---------------------------------------------------------------------------
// Account health (CS model) — segment-aware, transparent, priority-ordered.
// Priority: churned > at_risk > healthy > active_below_target > activated
//           > awaiting_first_case > new_handoff
// ---------------------------------------------------------------------------

export type FirmSegment = "small" | "mid_size" | "large" | "strategic";

export type AccountHealthStatus =
  | "churned" | "at_risk" | "healthy" | "active_below_target"
  | "activated" | "awaiting_first_case" | "new_handoff";

export interface SegmentRule {
  monthlyTarget: number | null; // strategic may be null (custom required)
  atRiskFloor30d: number; // min cases in 30d after activation before at-risk
  churnDays: number; // days since last case -> churned
}

export interface AccountHealthInput {
  segment: FirmSegment | null;
  monthlyTarget: number | null; // effective (override or segment default)
  rule: SegmentRule;
  // lifecycle dates
  handoffExists: boolean;
  handoffAccepted: boolean;
  firstCaseCommitmentDate: string | null;
  firstCaseSubmittedDate: string | null;
  firstCaseCompletedDate: string | null;
  secondCaseDate: string | null;
  // usage
  casesLifetime: number;
  casesThisMonth: number;
  cases30d: number;
  daysSinceLastCase: number | null;
  // signals
  openIssueCount: number;
  hasDeliveredCaseWithoutExpertReviewOffered: boolean;
  hasActiveOpp: boolean;
  /** Created an app account (PostHog signup) - used to surface the
   * "signed up but no case yet" activation cohort. */
  signedUp?: boolean;
  now?: Date;
}

export interface AccountHealthResult {
  status: AccountHealthStatus;
  category: "green" | "yellow" | "red" | "neutral";
  reasons: string[]; // why (transparent)
}

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000);
}

export function computeAccountHealth(i: AccountHealthInput): AccountHealthResult {
  const now = i.now ?? new Date();
  const activated = Boolean(i.firstCaseCompletedDate);
  const commitSince = daysSince(i.firstCaseCommitmentDate, now);
  const firstCompletedSince = daysSince(i.firstCaseCompletedDate, now);
  const reasons: string[] = [];

  // 1) Churned (segment-specific inactivity, and no active opportunity)
  if (
    i.casesLifetime > 0 &&
    i.daysSinceLastCase !== null &&
    i.daysSinceLastCase >= i.rule.churnDays &&
    !i.hasActiveOpp
  ) {
    return { status: "churned", category: "red",
      reasons: [`No case in ${i.daysSinceLastCase}d (churn threshold ${i.rule.churnDays}d for ${i.segment})`] };
  }

  // 2) At Risk (any trigger)
  if (i.firstCaseCommitmentDate && !i.firstCaseSubmittedDate && commitSince !== null && commitSince > 14)
    reasons.push("No first case within 14 days of commitment");
  if (i.firstCaseCompletedDate && !i.secondCaseDate && firstCompletedSince !== null && firstCompletedSince > 45)
    reasons.push("First case completed but no second case within 45 days");
  if (activated && i.cases30d < i.rule.atRiskFloor30d)
    reasons.push(`Only ${i.cases30d} case(s) in 30d (floor ${i.rule.atRiskFloor30d} for ${i.segment})`);
  if (i.openIssueCount > 0) reasons.push(`${i.openIssueCount} open issue(s)`);
  if (i.hasDeliveredCaseWithoutExpertReviewOffered)
    reasons.push("Delivered case without expert review offered");
  if (reasons.length) return { status: "at_risk", category: "red", reasons };

  // 3) Healthy
  if (activated && i.monthlyTarget !== null && i.casesThisMonth >= i.monthlyTarget)
    return { status: "healthy", category: "green",
      reasons: [`${i.casesThisMonth}/${i.monthlyTarget} cases this month`] };

  // 4) Active below target
  if (activated && i.casesThisMonth > 0)
    return { status: "active_below_target", category: "yellow",
      reasons: [`${i.casesThisMonth}/${i.monthlyTarget ?? "?"} cases this month`] };

  // 5) Activated (first case completed, none this month yet)
  if (activated)
    return { status: "activated", category: "green", reasons: ["First case completed"] };

  // 6) Awaiting first case (committed in sales, OR signed up in-app) with none yet
  if (i.firstCaseCommitmentDate && !i.firstCaseSubmittedDate)
    return { status: "awaiting_first_case", category: "yellow",
      reasons: ["Committed, no case submitted yet"] };
  if (i.signedUp && !i.firstCaseSubmittedDate)
    return { status: "awaiting_first_case", category: "yellow",
      reasons: ["Signed up, no case submitted yet"] };

  // 7) New handoff
  return { status: "new_handoff", category: "neutral",
    reasons: [i.handoffAccepted ? "Handoff accepted, pre-first-case" : "Handoff not yet accepted"] };
}

/** Segment default rules; overridden by settings.segment_config at runtime. */
export const DEFAULT_SEGMENT_RULES: Record<FirmSegment, SegmentRule> = {
  small: { monthlyTarget: 2, atRiskFloor30d: 1, churnDays: 90 },
  mid_size: { monthlyTarget: 5, atRiskFloor30d: 2, churnDays: 75 },
  large: { monthlyTarget: 10, atRiskFloor30d: 4, churnDays: 60 },
  strategic: { monthlyTarget: null, atRiskFloor30d: 4, churnDays: 45 },
};

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
