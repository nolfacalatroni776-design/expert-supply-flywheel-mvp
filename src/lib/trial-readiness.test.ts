import { describe, expect, it } from "vitest";
import { buildTrialPreparationStatus, validateTrialStartApproval } from "@/lib/trial-readiness";

describe("trial preparation", () => {
  it("keeps a generated trial in preparation until required materials are confirmed", () => {
    expect(buildTrialPreparationStatus()).toEqual({
      status: "preparing",
      readyToStart: false,
      requiredMaterials: ["已脱敏试标样本", "任务指引", "经内部校验的标准答案"],
      nextAction: "补齐并核验试标材料后，由运营确认开始试标。",
    });
  });

  it("requires every material and an approval note before trial starts", () => {
    expect(
      validateTrialStartApproval({
        samplesDeidentified: true,
        guidanceAttached: false,
        goldAnswersValidated: true,
        approvalNote: "材料已复核",
      }),
    ).toEqual({ ok: false, reason: "请先确认任务指引已附上。" });

    expect(
      validateTrialStartApproval({
        samplesDeidentified: true,
        guidanceAttached: true,
        goldAnswersValidated: true,
        approvalNote: "材料已复核，可以开始试标。",
      }),
    ).toEqual({ ok: true });
  });
});
