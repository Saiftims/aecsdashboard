/** Canonical HubSpot stage ids/labels (EU portal 148349267, pipeline `default`).
 * IDs verified by the Phase-1 migration; labels are display-only and may be
 * re-fetched live, but ids are stable. */

export const SALES_PIPELINE_ID = "default";

export const SALES_STAGES = {
  mql: "5242041534",
  attemptingContact: "5242041535",
  connected: "5656197328",
  qualified: "5656197329",
  demoScheduled: "5242041536",
  demoCompleted: "5603791089",
  firstCaseIdentified: "5242041537",
  firstCaseCommitted: "5656264907",
  closedWon: "closedwon",
  closedLost: "closedlost",
  nurture: "5243024611",
} as const;

export const SALES_STAGE_ORDER: string[] = [
  SALES_STAGES.mql,
  SALES_STAGES.attemptingContact,
  SALES_STAGES.connected,
  SALES_STAGES.qualified,
  SALES_STAGES.demoScheduled,
  SALES_STAGES.demoCompleted,
  SALES_STAGES.firstCaseIdentified,
  SALES_STAGES.firstCaseCommitted,
  SALES_STAGES.closedWon,
  SALES_STAGES.closedLost,
  SALES_STAGES.nurture,
];

export const SALES_STAGE_LABELS: Record<string, string> = {
  [SALES_STAGES.mql]: "New MQL",
  [SALES_STAGES.attemptingContact]: "Attempting Contact",
  [SALES_STAGES.connected]: "Connected",
  [SALES_STAGES.qualified]: "Qualified",
  [SALES_STAGES.demoScheduled]: "Demo Scheduled",
  [SALES_STAGES.demoCompleted]: "Demo Completed",
  [SALES_STAGES.firstCaseIdentified]: "First Case Identified",
  [SALES_STAGES.firstCaseCommitted]: "First Case Committed",
  [SALES_STAGES.closedWon]: "Closed Won",
  [SALES_STAGES.closedLost]: "Closed Lost",
  [SALES_STAGES.nurture]: "Nurture",
};

/** Virtual activation pipeline: stored in the `sw_activation_stage` deal
 * property because the current HubSpot tier allows only one deal pipeline. */
export const ACTIVATION_STAGES = [
  "handoff_pending",
  "onboarding_scheduled",
  "onboarding_completed",
  "first_case_identified",
  "first_case_submitted",
  "first_case_delivered",
  "activated",
  "repeat_user",
  "healthy_account",
  "at_risk",
  "reactivation_in_progress",
  "churned_or_inactive",
] as const;

export type ActivationStage = (typeof ACTIVATION_STAGES)[number];

export const ACTIVATION_STAGE_LABELS: Record<ActivationStage, string> = {
  handoff_pending: "Handoff Pending",
  onboarding_scheduled: "Onboarding Scheduled",
  onboarding_completed: "Onboarding Completed",
  first_case_identified: "First Case Identified",
  first_case_submitted: "First Case Submitted",
  first_case_delivered: "First Case Delivered",
  activated: "Activated",
  repeat_user: "Repeat User",
  healthy_account: "Healthy Account",
  at_risk: "At Risk",
  reactivation_in_progress: "Reactivation in Progress",
  churned_or_inactive: "Churned or Inactive",
};

/** Rank for "never downgrade" automation decisions. */
export const ACTIVATION_RANK: Record<ActivationStage, number> = {
  handoff_pending: 1,
  onboarding_scheduled: 2,
  onboarding_completed: 3,
  first_case_identified: 4,
  first_case_submitted: 5,
  first_case_delivered: 6,
  activated: 7,
  repeat_user: 8,
  healthy_account: 9,
  at_risk: 4.5, // parked lane; movement handled by explicit rules, not rank
  reactivation_in_progress: 4.6,
  churned_or_inactive: 0,
};

export function hubspotDealUrl(portalId: string, dealId: string): string {
  return `https://app-eu1.hubspot.com/contacts/${portalId}/record/0-3/${dealId}`;
}

export function hubspotCompanyUrl(portalId: string, companyId: string): string {
  return `https://app-eu1.hubspot.com/contacts/${portalId}/record/0-2/${companyId}`;
}
