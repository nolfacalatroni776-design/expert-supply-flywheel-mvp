import { describe, expect, it } from "vitest";
import { buildAgentRunReport, toActionableError } from "@/lib/agent-quality";

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
    expect(report.nextActions).toEqual(["分析供给缺口"]);
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
});
