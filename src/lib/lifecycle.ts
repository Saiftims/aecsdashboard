/** Activation lifecycle automation: derives the next activation stage from
 * real case/usage data. Pure + unit-tested. Never auto-churns.
 *
 * Movement rules (per spec):
 * - first case detected            -> first_case_submitted
 * - first case delivered           -> first_case_delivered
 * - first-case journey complete    -> activated
 * - second case detected           -> repeat_user
 * - healthy usage threshold met    -> healthy_account
 * - inactivity beyond threshold    -> at_risk (flag; humans decide churn)
 * - usage resumes                  -> repeat_user / healthy_account
 * - never move backwards otherwise; manual stages (handoff/onboarding/
 *   reactivation) are set by humans or the handoff flow, not this function.
 */
import { ACTIVATION_RANK, type ActivationStage } from "@/lib/hubspot/stages";

export interface LifecycleInput {
  current: ActivationStage | null;
  casesLifetime: number;
  cases30d: number;
  firstCaseDelivered: boolean;
  daysSinceLastCase: number | null;
  atRiskInactivityDays: number;
  healthyCasesPer30d: number;
}

export function nextActivationStage(i: LifecycleInput): ActivationStage | null {
  const cur = i.current ?? "handoff_pending";

  // Churn is never automated.
  if (cur === "churned_or_inactive") return null;

  // 1) At-risk: inactivity beyond threshold (only for firms that have submitted
  //    at least one case; pre-first-case firms are tracked by risk flags).
  const inactive =
    i.casesLifetime > 0 &&
    i.daysSinceLastCase !== null &&
    i.daysSinceLastCase > i.atRiskInactivityDays;

  // 2) Usage-driven target stage.
  let target: ActivationStage | null = null;
  if (i.casesLifetime === 0) {
    target = null; // manual stages govern pre-first-case journey
  } else if (inactive) {
    // Preserve an in-progress reactivation lane.
    target = cur === "reactivation_in_progress" ? null : "at_risk";
  } else if (i.cases30d >= i.healthyCasesPer30d) {
    target = "healthy_account";
  } else if (i.casesLifetime >= 2) {
    target = "repeat_user";
  } else if (i.firstCaseDelivered) {
    // First case delivered; "activated" once journey complete = delivered + no
    // blocking issue. We treat delivery as completing the first-case journey.
    target = "activated";
  } else {
    target = "first_case_submitted";
  }

  if (!target || target === cur) return null;

  // 3) Recovery: usage resumed from at_risk / reactivation -> allowed even
  //    though rank goes "down" the parked lane.
  if (
    (cur === "at_risk" || cur === "reactivation_in_progress") &&
    target !== "at_risk"
  ) {
    return target;
  }

  // 4) At-risk is always allowed from active lanes.
  if (target === "at_risk") return target;

  // 5) Otherwise never downgrade.
  return ACTIVATION_RANK[target] > ACTIVATION_RANK[cur] ? target : null;
}
