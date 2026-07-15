export function getTrialResultCandidateUpdate(outcome: "passed" | "failed" | "needs_review") {
  return {
    stage: "trial" as const,
    humanReviewNeeded: true,
    nextAction: outcome === "passed" ? "试标通过，等待人工确认入池。" : "试标结果需继续处理。",
  };
}

export function validateOnboardingApproval({
  latestTrialOutcome,
  reason,
}: {
  latestTrialOutcome?: string | null;
  reason: string;
}): { ok: true } | { ok: false; reason: string } {
  if (latestTrialOutcome !== "passed") {
    return { ok: false, reason: "候选人尚无通过的试标结果，不能确认入池。" };
  }
  if (reason.trim().length < 3) {
    return { ok: false, reason: "确认入池前请填写人工审批理由。" };
  }
  return { ok: true };
}
