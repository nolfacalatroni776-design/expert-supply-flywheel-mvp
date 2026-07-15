import { describe, expect, it } from "vitest";
import { getTrialResultCandidateUpdate, validateOnboardingApproval } from "@/lib/trial-approval";

describe("trial approval", () => {
  it("records a passing result without automatically onboarding the candidate", () => {
    expect(getTrialResultCandidateUpdate("passed")).toEqual({
      stage: "trial",
      humanReviewNeeded: true,
      nextAction: "试标通过，等待人工确认入池。",
    });
  });

  it("requires both a passing trial and an approval reason before onboarding", () => {
    expect(validateOnboardingApproval({ latestTrialOutcome: null, reason: "人工确认入池" }).ok).toBe(false);
    expect(validateOnboardingApproval({ latestTrialOutcome: "passed", reason: "" }).ok).toBe(false);
    expect(validateOnboardingApproval({ latestTrialOutcome: "passed", reason: "医学负责人确认试标通过" })).toEqual({ ok: true });
  });
});
