import { describe, expect, it } from "vitest";
import { nextActivationStage } from "@/lib/lifecycle";

const base = {
  current: null,
  casesLifetime: 0,
  cases30d: 0,
  firstCaseDelivered: false,
  daysSinceLastCase: null,
  atRiskInactivityDays: 30,
  healthyCasesPer30d: 2,
};

describe("nextActivationStage", () => {
  it("does not move pre-first-case firms (manual stages govern)", () => {
    expect(nextActivationStage({ ...base, current: "onboarding_scheduled" })).toBeNull();
  });

  it("moves to first_case_submitted on first case", () => {
    expect(nextActivationStage({
      ...base, current: "onboarding_completed", casesLifetime: 1,
      cases30d: 1, daysSinceLastCase: 3,
    })).toBe("first_case_submitted");
  });

  it("moves to activated once the first case is delivered", () => {
    expect(nextActivationStage({
      ...base, current: "first_case_submitted", casesLifetime: 1,
      cases30d: 1, daysSinceLastCase: 5, firstCaseDelivered: true,
    })).toBe("activated");
  });

  it("moves to repeat_user on the second case", () => {
    expect(nextActivationStage({
      ...base, current: "activated", casesLifetime: 2, cases30d: 1,
      daysSinceLastCase: 2, firstCaseDelivered: true,
    })).toBe("repeat_user");
  });

  it("moves to healthy_account at the healthy threshold", () => {
    expect(nextActivationStage({
      ...base, current: "repeat_user", casesLifetime: 5, cases30d: 3,
      daysSinceLastCase: 1, firstCaseDelivered: true,
    })).toBe("healthy_account");
  });

  it("flags at_risk after inactivity but never churns automatically", () => {
    expect(nextActivationStage({
      ...base, current: "healthy_account", casesLifetime: 5, cases30d: 0,
      daysSinceLastCase: 45, firstCaseDelivered: true,
    })).toBe("at_risk");
    expect(nextActivationStage({
      ...base, current: "churned_or_inactive", casesLifetime: 5,
      daysSinceLastCase: 400,
    })).toBeNull();
  });

  it("recovers from at_risk when usage resumes", () => {
    expect(nextActivationStage({
      ...base, current: "at_risk", casesLifetime: 3, cases30d: 1,
      daysSinceLastCase: 2, firstCaseDelivered: true,
    })).toBe("repeat_user");
  });

  it("respects an in-progress reactivation during inactivity", () => {
    expect(nextActivationStage({
      ...base, current: "reactivation_in_progress", casesLifetime: 3,
      cases30d: 0, daysSinceLastCase: 60, firstCaseDelivered: true,
    })).toBeNull();
  });

  it("never downgrades an activated account to first_case_submitted", () => {
    expect(nextActivationStage({
      ...base, current: "healthy_account", casesLifetime: 4, cases30d: 2,
      daysSinceLastCase: 3, firstCaseDelivered: true,
    })).toBeNull();
  });
});
