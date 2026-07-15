import { describe, expect, it } from "vitest";
import { buildCandidateReviewUpdate } from "@/lib/candidate-review";

describe("candidate review decisions", () => {
  it("screens a rejected candidate out of the current project without setting global DNC", () => {
    expect(
      buildCandidateReviewUpdate({
        decision: "rejected",
        note: "缺少企业级代码评审经历",
        currentStage: "verified",
        missingJson: "[]",
      }),
    ).toEqual({
      humanReviewNeeded: false,
      stage: "screened_out",
      nextAction: "本项目暂不推进：缺少企业级代码评审经历。如有新证据，可重新复核。",
    });
  });

  it("requires a concrete reason before screening a candidate out", () => {
    expect(() =>
      buildCandidateReviewUpdate({
        decision: "rejected",
        note: " ",
        currentStage: "sourced",
        missingJson: "[]",
      }),
    ).toThrow("请填写本项目暂不推进的原因。");
  });

  it("allows new evidence to reopen a screened-out candidate at verified", () => {
    expect(
      buildCandidateReviewUpdate({
        decision: "approved",
        note: "已补充企业代码评审案例",
        currentStage: "screened_out",
        missingJson: "[]",
      }),
    ).toEqual({
      humanReviewNeeded: false,
      stage: "verified",
      nextAction: "联系路径确认后生成触达草稿。",
    });
  });

  it("keeps evidence requests reviewable and deduplicates repeated notes", () => {
    expect(
      buildCandidateReviewUpdate({
        decision: "needs_more_evidence",
        note: "补充机构任职证明",
        currentStage: "sourced",
        missingJson: JSON.stringify(["补充机构任职证明"]),
      }),
    ).toEqual({
      humanReviewNeeded: true,
      missingJson: JSON.stringify(["补充机构任职证明"]),
      nextAction: "补证据：补充机构任职证明",
    });
  });
});
