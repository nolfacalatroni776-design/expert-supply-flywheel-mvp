import { describe, expect, it } from "vitest";
import {
  assessInternalSupplyAvailability,
  buildRankSupplyStepOutput,
  buildSearchQueryBase,
  getApprovedExternalSearchQueries,
  getDependentStepsToSkip,
  getStepsToResetForRetry,
  isAgentExecutionLeaseActive,
  normalizeAgentIntent,
  shouldContinueAfterStepFailure,
  validateAgentRunStatusTransition,
} from "@/lib/agent-runtime";

describe("rank supply step output", () => {
  it("keeps review risks separate from safe candidate actions", () => {
    expect(
      buildRankSupplyStepOutput({
        usedFallback: false,
        candidates: [
          {
            risks: ["候选尚未完成人工复核。", "缺少可验证的联系许可。"],
            nextAction: "先完成人工复核并补齐必要证据或联系许可，再决定是否生成触达草稿。",
          },
          {
            risks: ["候选尚未完成人工复核。"],
            nextAction: "继续当前试标，记录提交结果并完成人工复核。",
          },
        ],
      }),
    ).toEqual({
      ranked: 2,
      usedFallback: false,
      needsReview: ["候选尚未完成人工复核。", "缺少可验证的联系许可。"],
      nextActions: [
        "先完成人工复核并补齐必要证据或联系许可，再决定是否生成触达草稿。",
        "继续当前试标，记录提交结果并完成人工复核。",
      ],
    });
  });

  it("uses a conservative action when ranking has no candidate actions", () => {
    expect(buildRankSupplyStepOutput({ usedFallback: true, candidates: [] })).toEqual({
      ranked: 0,
      usedFallback: true,
      needsReview: [],
      nextActions: ["先补充或召回候选，再更新候选排序。"],
    });
  });
});

describe("external search base", () => {
  it("prefers specific technologies from the demand over a broad project domain", () => {
    expect(
      buildSearchQueryBase({
        title: "Python 开源后端代码审查专家招募",
        rawDemand: "招募熟悉 FastAPI、Django、异步服务和代码审查的 Python 开源维护者。",
        domain: "Python 开源后端",
        taskType: "代码审查",
      }),
    ).toBe("Python FastAPI Django 代码评审");
  });

  it("keeps concrete software technologies when the demand also mentions a trial task", () => {
    const base = buildSearchQueryBase({
      title: "Pydantic v2 数据验证代码评审专家招募",
      rawDemand:
        "招募熟悉 Pydantic v2、pydantic-core、TypeAdapter、JSON Schema 或 SQLModel 的 Python 专家，完成代码评审和小规模试标。",
      domain: "Python 数据验证与类型系统",
      taskType: "代码评审 / 试标",
    });

    expect(base).toContain("Pydantic v2");
    expect(base).toContain("pydantic-core");
    expect(base).toContain("SQLModel");
    expect(base).not.toMatch(/中文文本|数据标注|FastAPI|Django/);
  });
});

describe("agent runtime state guards", () => {
  it("keeps full sourcing available when the internal expert library is empty", () => {
    expect(assessInternalSupplyAvailability("full_sourcing", 0)).toEqual({
      missing: [],
      warnings: ["专家库暂无可召回的内部或推荐专家，将继续分析缺口并在确认后补充公开候选。"],
    });
    expect(assessInternalSupplyAvailability("internal_match", 0)).toEqual({
      missing: ["专家库暂无可召回的内部或推荐专家。"],
      warnings: [],
    });
  });

  it("allows only known task intents", () => {
    expect(normalizeAgentIntent("generate_marketing")).toBe("generate_marketing");
    expect(normalizeAgentIntent("unknown")).toBeNull();
  });

  it("blocks unsafe run status transitions", () => {
    expect(validateAgentRunStatusTransition("planned", "running")).toEqual({ ok: true });
    expect(validateAgentRunStatusTransition("waiting_for_confirmation", "running")).toEqual({ ok: true });
    expect(validateAgentRunStatusTransition("succeeded", "running")).toEqual({
      ok: false,
      reason: "当前任务状态不能执行该动作。",
    });
    expect(validateAgentRunStatusTransition("planned", "succeeded")).toEqual({
      ok: false,
      reason: "当前任务状态不能执行该动作。",
    });
  });

  it("treats only an unexpired owned running lease as active", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");

    expect(
      isAgentExecutionLeaseActive(
        {
          status: "running",
          executionToken: "owner-1",
          leaseExpiresAt: new Date("2026-07-16T00:01:00.000Z"),
        },
        now,
      ),
    ).toBe(true);
    expect(
      isAgentExecutionLeaseActive(
        {
          status: "running",
          executionToken: "owner-1",
          leaseExpiresAt: new Date("2026-07-15T23:59:59.000Z"),
        },
        now,
      ),
    ).toBe(false);
    expect(isAgentExecutionLeaseActive({ status: "planned", executionToken: null, leaseExpiresAt: null }, now)).toBe(false);
  });

  it("marks only pending dependent steps after a failure as skipped", () => {
    expect(
      getDependentStepsToSkip([
        { id: "check", order: 0, stepKey: "check_project", status: "succeeded" },
        { id: "search", order: 1, stepKey: "external_research", status: "failed" },
        { id: "rank", order: 2, stepKey: "rank_supply", status: "pending" },
        { id: "report", order: 3, stepKey: "quality_report", status: "pending" },
      ]),
    ).toEqual(["rank"]);
  });

  it("continues unified ranking when full sourcing saved only a partial external result", () => {
    expect(shouldContinueAfterStepFailure("full_sourcing", "external_research")).toBe(true);
    expect(shouldContinueAfterStepFailure("external_research", "external_research")).toBe(false);
    expect(shouldContinueAfterStepFailure("full_sourcing", "internal_match")).toBe(false);
  });

  it("reruns every downstream data step after the earliest technical failure", () => {
    expect(
      getStepsToResetForRetry([
        { id: "check", order: 1, status: "succeeded", requiresConfirmation: false, confirmedAt: null, errorMessage: null },
        { id: "approval", order: 2, status: "succeeded", requiresConfirmation: true, confirmedAt: new Date(), errorMessage: null },
        { id: "search", order: 3, status: "failed", requiresConfirmation: false, confirmedAt: null, errorMessage: "搜索失败" },
        { id: "rank", order: 4, status: "succeeded", requiresConfirmation: false, confirmedAt: null, errorMessage: null },
        { id: "report", order: 5, status: "succeeded", requiresConfirmation: false, confirmedAt: null, errorMessage: null },
      ]),
    ).toEqual(["search", "rank", "report"]);
  });

  it("reopens an unconfirmed approval downstream of a failed prerequisite", () => {
    expect(
      getStepsToResetForRetry([
        { id: "analysis", order: 1, status: "failed", requiresConfirmation: false, confirmedAt: null, errorMessage: "画像失败" },
        { id: "approval", order: 2, status: "skipped", requiresConfirmation: true, confirmedAt: null, errorMessage: "前置步骤未达到执行条件，本步未执行。" },
        { id: "search", order: 3, status: "skipped", requiresConfirmation: false, confirmedAt: null, errorMessage: "前置步骤未达到执行条件，本步未执行。" },
      ]),
    ).toEqual(["analysis", "approval", "search"]);
  });
});

describe("approved external search plan", () => {
  it("uses only the exact queries saved at confirmation time", () => {
    const queries = getApprovedExternalSearchQueries([
      {
        stepKey: "confirm_external_search",
        confirmedAt: new Date("2026-07-15T00:00:00.000Z"),
        outputJson: JSON.stringify({
          approvedQueries: ["中文 NLP 讲者", "中文 NLP 作者"],
        }),
        checksJson: JSON.stringify({
          queryPreview: ["旧的预检查查询不应覆盖批准快照"],
        }),
      },
    ]);

    expect(queries).toEqual(["中文 NLP 讲者", "中文 NLP 作者"]);
  });

  it("does not expose unconfirmed queries to an external-search tool", () => {
    const queries = getApprovedExternalSearchQueries([
      {
        stepKey: "confirm_external_search",
        confirmedAt: null,
        outputJson: "{}",
        checksJson: JSON.stringify({ queryPreview: ["尚未批准的查询"] }),
      },
    ]);

    expect(queries).toEqual([]);
  });
});
