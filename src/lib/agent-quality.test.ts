import { describe, expect, it } from "vitest";
import { buildAgentRunReport, evaluateExternalResearchStepQuality, toActionableError } from "@/lib/agent-quality";

describe("agent quality report", () => {
  it("summarizes completed, skipped, failed, written, review, and next actions", () => {
    const report = buildAgentRunReport({
      status: "partially_succeeded",
      steps: [
        {
          stepKey: "internal_match",
          label: "召回内部专家",
          status: "succeeded",
          output: { candidates: 3, needsReview: ["医疗项目需复核"], nextActions: ["分析供给缺口"] },
        },
        {
          stepKey: "external_research",
          label: "补充公开候选",
          status: "failed",
          errorMessage: "SERPER_API_KEY is not configured.",
        },
        {
          stepKey: "rank_supply",
          label: "更新候选排序",
          status: "skipped",
          errorMessage: "前置步骤未完成",
        },
      ],
    });

    expect(report.summary).toBe("任务已完成一部分，部分步骤需要人工处理或重试。");
    expect(report.completed).toEqual(["召回内部专家"]);
    expect(report.written).toEqual(["召回内部专家：3 候选"]);
    expect(report.needsReview).toEqual(["医疗项目需复核"]);
    expect(report.nextActions).toEqual(["查看未完成步骤原因后重试，已完成结果会保留\u3002"]);
    expect(report.failed[0]).toContain("候选搜索服务暂不可用");
    expect(report.skipped[0]).toContain("前置步骤未完成");
  });

  it("turns technical model errors into actionable user-facing errors", () => {
    expect(toActionableError("Model response was not valid JSON")).toBe("智能处理服务暂不可用，请稍后重试或联系管理员检查服务连接。");
    expect(toActionableError("HTTP 429 quota exceeded")).toBe("服务繁忙或额度受限，请稍后重试。");
  });

  it("treats confirmation waits as pending user action, not skipped work", () => {
    const report = buildAgentRunReport({
      status: "waiting_for_confirmation",
      steps: [
        { stepKey: "analyze_project", label: "补齐需求画像", status: "succeeded", output: { nextActions: ["开始执行任务。"] } },
        { stepKey: "confirm_external_search", label: "确认调用外部搜索", status: "blocked", errorMessage: "需要确认后再调用外部搜索。" },
      ],
    });

    expect(report.skipped).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.nextActions).toEqual(["确认是否继续调用外部搜索。"]);
  });

  it("fails an external-research step when saved results do not pass candidate quality gates", () => {
    expect(
      evaluateExternalResearchStepQuality({
        candidateCount: 3,
        acceptance: { passed: false, blockers: ["高证据候选不足。", "查询方向覆盖不足。"] },
      }),
    ).toEqual({
      stepFailed: true,
      failureReason: "搜索结果已保存，但候选质量未通过：高证据候选不足；查询方向覆盖不足",
    });
  });

  it("keeps a quality-passing external candidate batch successful", () => {
    expect(
      evaluateExternalResearchStepQuality({
        candidateCount: 2,
        acceptance: { passed: true, blockers: [] },
      }),
    ).toEqual({ stepFailed: false, failureReason: undefined });
  });

  it("removes internal fields and unsafe outreach instructions from operator reports", () => {
    const report = buildAgentRunReport({
      status: "partially_succeeded",
      steps: [
        {
          stepKey: "analyze_supply_gap",
          label: "分析供给缺口",
          status: "succeeded",
          output: {
            needsReview: [
              "现有候选 fitScore 为 100，但数量不足。",
              "persona 要求 5 年以上经验。",
              "项目 riskLevel 为 medium，当前 humanReviewNeeded 为 false。",
            ],
          },
        },
        {
          stepKey: "rank_supply",
          label: "更新候选排序",
          status: "succeeded",
          output: {
            needsReview: ["立即生成触达草稿并安排试标。", "优先触达并确认中文能力。"],
            nextActions: ["触达并安排第一批试标。"],
          },
        },
      ],
    });

    const userFacingText = [...report.needsReview, ...report.nextActions].join(" ");
    expect(userFacingText).not.toMatch(/fitScore|persona|riskLevel|humanReviewNeeded|\bmedium\b/i);
    expect(userFacingText).not.toMatch(/立即生成触达|优先触达|触达并安排|安排试标/);
    expect(userFacingText).toContain("先完成人工复核");
  });

  it("keeps only unresolved and final-step actions in a partial sourcing report", () => {
    const report = buildAgentRunReport({
      status: "partially_succeeded",
      steps: [
        {
          stepKey: "internal_match",
          label: "召回内部专家",
          status: "succeeded",
          output: { nextActions: ["分析供给缺口。"] },
        },
        {
          stepKey: "analyze_supply_gap",
          label: "分析供给缺口",
          status: "succeeded",
          output: { nextActions: ["确认是否补充公开候选。"] },
        },
        {
          stepKey: "confirm_external_search",
          label: "确认公开搜索计划",
          status: "succeeded",
          output: {
            needsReview: ["确认后会调用外部搜索服务。"],
            nextActions: ["继续执行公开候选补充。"],
          },
        },
        {
          stepKey: "external_research",
          label: "补充公开候选",
          status: "failed",
          output: { nextActions: ["调整未产出候选的搜索方向后重试。"] },
        },
        {
          stepKey: "rank_supply",
          label: "更新候选排序",
          status: "succeeded",
          output: { nextActions: ["先完成人工复核并补齐联系许可。"] },
        },
      ],
    });

    expect(report.nextActions).toEqual([
      "调整未产出候选的搜索方向后重试。",
      "先完成人工复核并补齐联系许可。",
    ]);
    expect(report.needsReview).not.toContain("确认后会调用外部搜索服务。");
  });

  it("removes an early evidence-count warning after later search results resolve it", () => {
    const report = buildAgentRunReport({
      status: "succeeded",
      steps: [
        {
          stepKey: "analyze_supply_gap",
          label: "分析供给缺口",
          status: "succeeded",
          output: {
            needsReview: [
              "E2+ 证据候选只有 1 位，需要补充可核验来源。",
              "内部库当前召回 1 位，距离目标 3 位仍有缺口。",
            ],
          },
        },
        {
          stepKey: "external_research",
          label: "补充公开候选",
          status: "succeeded",
          output: {
            acceptance: {
              passed: true,
              e2PlusCandidates: 3,
              hardRequirementReadyCandidates: 2,
            },
            needsReview: ["3 位候选需要人工复核。"],
            nextActions: ["完成候选复核后再准备触达草稿。"],
          },
        },
      ],
    });

    expect(report.needsReview).not.toContain("E2+ 证据候选只有 1 位，需要补充可核验来源。");
    expect(report.needsReview).toContain("内部库当前召回 1 位，距离目标 3 位仍有缺口。");
    expect(report.needsReview).toContain("3 位候选需要人工复核。");
  });
});
