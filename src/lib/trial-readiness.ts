export const TRIAL_REQUIRED_MATERIALS = ["已脱敏试标样本", "任务指引", "经内部校验的标准答案"] as const;

export function buildTrialPreparationStatus() {
  return {
    status: "preparing" as const,
    readyToStart: false,
    requiredMaterials: [...TRIAL_REQUIRED_MATERIALS],
    nextAction: "补齐并核验试标材料后，由运营确认开始试标。",
  };
}

export function validateTrialStartApproval(input: {
  samplesDeidentified: boolean;
  guidanceAttached: boolean;
  goldAnswersValidated: boolean;
  approvalNote: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.samplesDeidentified) return { ok: false, reason: "请先确认试标样本已完成脱敏。" };
  if (!input.guidanceAttached) return { ok: false, reason: "请先确认任务指引已附上。" };
  if (!input.goldAnswersValidated) return { ok: false, reason: "请先确认标准答案已经过内部校验。" };
  if (input.approvalNote.trim().length < 3) return { ok: false, reason: "请填写开始试标的人工审批说明。" };
  return { ok: true };
}
