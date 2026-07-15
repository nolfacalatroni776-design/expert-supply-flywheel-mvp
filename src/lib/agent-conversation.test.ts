import { describe, expect, it } from "vitest";
import {
  describeAgentToolReceipts,
  getAgentCandidatePreview,
  getAgentConfirmationBrief,
  getAgentConversationAction,
  getAgentConversationMessages,
  getAgentSourceRunId,
  getAgentSearchResultPreview,
  getAgentStepConfirmationBadge,
  shouldContinuePollingAgentRun,
  shouldRefreshWorkspaceData,
} from "@/lib/agent-conversation";

describe("agent conversation helpers", () => {
  it("shows the current approval decision instead of a permanent needs-confirmation badge", () => {
    expect(
      getAgentStepConfirmationBadge({
        status: "blocked",
        requiresConfirmation: true,
        confirmedAt: null,
      }),
    ).toEqual({ label: "需确认", tone: "warning" });
    expect(
      getAgentStepConfirmationBadge({
        status: "succeeded",
        requiresConfirmation: true,
        confirmedAt: "2026-07-16T00:00:00.000Z",
        confirmationDecision: "approved",
      }),
    ).toEqual({ label: "已确认", tone: "success" });
    expect(
      getAgentStepConfirmationBadge({
        status: "blocked",
        requiresConfirmation: true,
        confirmedAt: "2026-07-16T00:00:00.000Z",
        confirmationDecision: "rejected",
      }),
    ).toEqual({ label: "已拒绝", tone: "danger" });
    expect(
      getAgentStepConfirmationBadge({
        status: "skipped",
        requiresConfirmation: true,
        confirmedAt: null,
      }),
    ).toBeNull();
  });

  it("turns durable tool receipts into user-facing execution evidence", () => {
    expect(
      describeAgentToolReceipts([
        {
          toolName: "public_search",
          status: "succeeded",
          provider: "cache",
          attempt: 1,
          durationMs: 180,
          errorCategory: null,
          resultSummary: { query: "Python maintainer", resultCount: 8, cacheHit: true },
        },
        {
          toolName: "public_search",
          status: "failed",
          provider: "serper",
          attempt: 2,
          durationMs: 1200,
          errorCategory: "rate_limited",
          resultSummary: {},
        },
      ]),
    ).toEqual([
      "公开搜索“Python maintainer”：使用已保存结果，返回 8 条，用时 0.2 秒。",
      "公开搜索：第 2 次执行未完成，外部服务请求过于频繁，请稍后重试。",
    ]);
  });
  it("refreshes workspace data after terminal runs but not while a task is still executing", () => {
    expect(shouldRefreshWorkspaceData("succeeded")).toBe(true);
    expect(shouldRefreshWorkspaceData("partially_succeeded")).toBe(true);
    expect(shouldRefreshWorkspaceData("failed")).toBe(true);
    expect(shouldRefreshWorkspaceData("running")).toBe(false);
    expect(shouldRefreshWorkspaceData("waiting_for_confirmation")).toBe(false);
  });

  it("keeps polling a queued durable task until it reaches the next user boundary", () => {
    const planned = { id: "run-queued", status: "planned", steps: [] };
    const waiting = {
      id: "run-queued",
      status: "waiting_for_confirmation",
      steps: [
        {
          id: "approval-1",
          stepKey: "confirm_external_search",
          status: "blocked",
          requiresConfirmation: true,
        },
      ],
    };
    const completed = { id: "run-queued", status: "succeeded", steps: [] };

    expect(shouldContinuePollingAgentRun("start", planned)).toBe(true);
    expect(shouldContinuePollingAgentRun("start", waiting)).toBe(false);
    expect(shouldContinuePollingAgentRun("confirm", waiting, "approval-1")).toBe(true);
    expect(shouldContinuePollingAgentRun("confirm", completed, "approval-1")).toBe(false);
    expect(
      shouldContinuePollingAgentRun(
        "confirm",
        {
          ...waiting,
          steps: [{ ...waiting.steps[0], id: "approval-2" }],
        },
        "approval-1",
      ),
    ).toBe(false);
  });

  it("keeps the next executable action visible after a plan is generated", () => {
    expect(
      getAgentConversationAction({
        id: "run-1",
        status: "planned",
        steps: [],
      }),
    ).toEqual({ kind: "start", label: "开始执行" });

    expect(
      getAgentConversationAction({
        id: "run-2",
        status: "waiting_for_confirmation",
        steps: [{ stepKey: "confirm_external_search", status: "blocked" }],
      }),
    ).toEqual({ kind: "confirm", label: "确认并开始公开搜索" });
  });

  it("asks for a revised search plan when a candidate batch failed source-yield quality checks", () => {
    const run = {
        id: "run-source-gap",
        status: "partially_succeeded",
        report: {
          nextActions: [
            "继续执行公开候选补充。",
            "调整未产出候选的来源搜索词，优先定位个人主页、讲者页或作者页。",
          ],
        },
        steps: [
          {
            stepKey: "external_research",
            status: "failed",
            output: {
              runId: "search-run-source-gap",
              candidates: 9,
              searchResults: 25,
              candidatePreview: [
                {
                  candidateId: "candidate-source-gap",
                  name: "Thomas Graf",
                  sourceType: "external",
                  humanReviewNeeded: true,
                },
              ],
              acceptance: {
                passed: false,
                blockers: ["会议/论文方向未产出可复核候选。"],
              },
            },
          },
        ],
      };

    expect(getAgentConversationAction(run)).toEqual({ kind: "revise", label: "调整搜索方向" });
    expect(getAgentSourceRunId(run)).toBe("search-run-source-gap");
    expect(getAgentConversationMessages(run).find((message) => message.title === "建议下一步")?.items).toEqual([
      "调整未产出候选的来源搜索词，优先定位个人主页、讲者页或作者页。",
      "完成候选复核和联系许可确认后，再准备触达草稿。",
    ]);
  });

  it("offers candidate-specific evidence enrichment when E2+ people lack institution profiles", () => {
    expect(
      getAgentConversationAction({
        id: "run-institution-gap",
        status: "partially_succeeded",
        steps: [
          {
            stepKey: "external_research",
            status: "failed",
            output: {
              acceptance: {
                passed: false,
                e2PlusCandidates: 8,
                hardRequirementReadyCandidates: 0,
                candidateHardRequirements: ["机构公开主页"],
              },
            },
          },
        ],
      }),
    ).toEqual({ kind: "enrich", label: "补齐候选证据" });
  });

  it("keeps a failed evidence-enrichment run in the enrichment workflow", () => {
    expect(
      getAgentConversationAction({
        id: "run-enrichment-empty",
        status: "partially_succeeded",
        steps: [
          {
            stepKey: "enrich_candidate_evidence",
            status: "failed",
            output: { searchResults: 17, candidates: 0 },
          },
        ],
      }),
    ).toEqual({ kind: "enrich", label: "调整补证方向" });
  });

  it("returns to planning after an operator rejects the current search scope", () => {
    expect(
      getAgentConversationAction({
        id: "run-rejected-search",
        status: "partially_succeeded",
        steps: [
          {
            id: "approval-1",
            stepKey: "confirm_external_search",
            status: "blocked",
            confirmationDecision: "rejected",
            confirmationReason: "机构范围太宽",
            output: { rejected: true },
          },
          { stepKey: "external_research", status: "pending" },
        ],
      }),
    ).toEqual({ kind: "revise", label: "调整搜索方向" });
  });

  it("explains what external search confirmation will do before the user continues", () => {
    const brief = getAgentConfirmationBrief({
      id: "run-confirm",
      status: "waiting_for_confirmation",
      steps: [
        {
          stepKey: "confirm_external_search",
          label: "确认公开搜索",
          status: "blocked",
          checks: {
            queries: 4,
            cached: 1,
            uncached: 3,
            queryPreview: ["生物信息学 专家 机构主页", "bioinformatics expert conference speaker"],
          },
        },
      ],
    });

    expect(brief).toEqual({
      title: "确认后会做什么",
      items: [
        "按 4 个搜索方向查找公开来源候选，其中 1 个使用已保存结果，3 个会调用外部搜索服务。",
        "只会写入搜索结果、候选线索和证据项；不会发送邮件、不会发布渠道内容。",
        "低证据或高风险候选会留在复核中，不会直接进入触达。",
        "完成后会在这里展示“外部搜索到的人力”，并可进入候选管道继续复核。",
      ],
      queries: ["生物信息学 专家 机构主页", "bioinformatics expert conference speaker"],
    });
  });

  it("explains evidence enrichment without calling the results a new candidate batch", () => {
    const brief = getAgentConfirmationBrief({
      id: "run-enrichment-confirm",
      status: "waiting_for_confirmation",
      steps: [
        {
          stepKey: "confirm_external_search",
          status: "blocked",
          checks: {
            queries: 2,
            cached: 0,
            uncached: 2,
            queryPreview: ['"Junjie Hu" "Tongji University" institution profile'],
          },
        },
        { stepKey: "enrich_candidate_evidence", status: "pending" },
      ],
    });

    expect(brief?.items).toEqual([
      "按 2 个搜索方向补查候选机构主页，其中 0 个使用已保存结果，2 个会调用外部搜索服务。",
      "只会处理计划中列出的候选姓名；不会发送邮件、不会发布渠道内容。",
      "只有姓名匹配且来自机构人员页的结果才能生成补证线索。",
      "同人关系只生成建议，核对姓名、机构和来源后再由你确认合并。",
    ]);
  });

  it("extracts the first candidate batch from completed search steps for inline review", () => {
    const preview = getAgentCandidatePreview({
      id: "run-candidates",
      status: "succeeded",
      steps: [
        {
          stepKey: "external_research",
          label: "补充公开候选",
          status: "succeeded",
          output: {
            candidatePreview: [
              {
                candidateId: "candidate-1",
                name: "张三",
                title: "生物信息学研究员",
                affiliation: "某研究院",
                evidenceLevel: "E2",
                sourceType: "external",
                humanReviewNeeded: true,
                sourceUrl: "https://example.com/profile",
                nextAction: "核验证据后决定是否触达。",
              },
            ],
          },
        },
      ],
    });

    expect(preview).toEqual([
      {
        candidateId: "candidate-1",
        name: "张三",
        title: "生物信息学研究员",
        affiliation: "某研究院",
        evidenceLevel: "E2",
        sourceType: "external",
        humanReviewNeeded: true,
        sourceUrl: "https://example.com/profile",
        nextAction: "核验证据后决定是否触达。",
      },
    ]);
  });

  it("turns run reports into concrete user-facing result messages", () => {
    const messages = getAgentConversationMessages({
      id: "run-3",
      status: "partially_succeeded",
      label: "完整发现候选",
      plan: { objective: "按标准流程推进候选发现。" },
      steps: [
        { stepKey: "check_project", label: "检查项目资料", status: "succeeded" },
        { stepKey: "internal_match", label: "召回内部专家", status: "succeeded" },
        { stepKey: "external_research", label: "补充公开候选", status: "failed", errorMessage: "外部搜索服务暂时不可用。" },
      ],
      report: {
        summary: "已完成内部召回，公开搜索未完成。",
        completed: ["召回内部专家"],
        skipped: ["统一排序：候选证据不足"],
        failed: ["补充公开候选：外部搜索服务暂时不可用。"],
        written: ["新增 3 个内部候选", "写入 3 条行为记录"],
        needsReview: ["2 个候选需要人工核验证据"],
        nextActions: ["先复核内部候选", "稍后重试公开搜索"],
      },
    });

    expect(messages).toContainEqual({
      role: "assistant",
      tone: "success",
      title: "已完成",
      items: ["召回内部专家"],
    });
    expect(messages).toContainEqual({
      role: "assistant",
      tone: "info",
      title: "写入结果",
      items: ["新增 3 个内部候选", "写入 3 条行为记录"],
    });
    expect(messages).toContainEqual({
      role: "assistant",
      tone: "warning",
      title: "需要人工处理",
      items: ["2 个候选需要人工核验证据"],
    });
    expect(messages).toContainEqual({
      role: "assistant",
      tone: "danger",
      title: "未完成",
      items: ["补充公开候选：外部搜索服务暂时不可用。", "统一排序：候选证据不足"],
    });
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      tone: "info",
      title: "建议下一步",
      items: ["先复核内部候选", "稍后重试公开搜索"],
    });
  });

  it("does not tell users to advance outreach when the visible external batch all needs review", () => {
    const messages = getAgentConversationMessages({
      id: "run-review-only",
      status: "succeeded",
      steps: [
        {
          stepKey: "external_research",
          status: "succeeded",
          output: {
            candidatePreview: [
              { candidateId: "candidate-1", name: "候选人", sourceType: "external", evidenceLevel: "E2", humanReviewNeeded: true },
            ],
          },
        },
      ],
      report: {
        nextActions: ["继续执行公开候选补充。", "把可触达候选推进到触达草稿或试标准备。"],
      },
    });

    const nextAction = messages.find((message) => message.title === "建议下一步");
    expect(nextAction?.items).toEqual(["完成候选复核和联系许可确认后，再准备触达草稿。"]);
  });

  it("normalizes unsafe text in persisted historical task reports", () => {
    const messages = getAgentConversationMessages({
      id: "run-historical-unsafe",
      status: "partially_succeeded",
      steps: [],
      report: {
        needsReview: ["persona 要求未满足，humanReviewNeeded 为 false。"],
        nextActions: ["立即生成触达草稿并安排试标。"],
      },
    });
    const visibleText = messages.flatMap((message) => message.items).join(" ");

    expect(visibleText).not.toMatch(/persona|humanReviewNeeded|立即生成触达|安排试标/i);
    expect(visibleText).toContain("专家画像");
    expect(visibleText).toContain("先完成人工复核");
  });
});

describe("external search diagnostics", () => {
  const zeroCandidateRun = {
    id: "run-zero-candidates",
    status: "partially_succeeded",
    report: {
      summary: "任务已完成一部分。",
      completed: ["检查项目资料"],
      failed: ["补充公开候选：已保存搜索结果，但未抽取到可复核候选。"],
      nextActions: ["调整为面向个人主页、作者和讲者的搜索方向后重新生成计划。"],
    },
    steps: [
      {
        stepKey: "external_research",
        status: "failed",
        errorMessage: "已保存搜索结果，但未抽取到可复核候选。",
        output: {
          searchResults: 8,
          candidates: 0,
          searchResultPreview: [
            {
              searchResultId: "result-1",
              title: "中文 NLP 标注质量论坛讲者",
              url: "https://conference.example/speakers/zhang",
              domain: "conference.example",
              query: "中文 NLP 标注质量 会议 讲者",
              snippet: "张敏分享标注一致性审核方法。",
            },
          ],
        },
      },
    ],
  };

  it("shows the saved search results even when no candidate was extracted", () => {
    expect(getAgentSearchResultPreview(zeroCandidateRun)).toEqual([
      expect.objectContaining({
        searchResultId: "result-1",
        title: "中文 NLP 标注质量论坛讲者",
      }),
    ]);
  });

  it("explains that web results were found but no reviewable people were produced", () => {
    const messages = getAgentConversationMessages(zeroCandidateRun);
    expect(messages).toContainEqual(
      expect.objectContaining({
        tone: "warning",
        title: "找到搜索结果，但没有可复核人力",
      }),
    );
  });

  it("asks the user to revise search directions instead of retrying the same approved queries", () => {
    expect(getAgentConversationAction(zeroCandidateRun)).toEqual({
      kind: "revise",
      label: "调整搜索方向",
    });
  });
});

describe("candidate result aggregation", () => {
  it("returns the search run that produced the visible external candidate batch", () => {
    expect(
      getAgentSourceRunId({
        id: "agent-run",
        status: "succeeded",
        steps: [
          {
            stepKey: "external_research",
            status: "succeeded",
            output: { runId: "search-run-5", candidatePreview: [] },
          },
        ],
      }),
    ).toBe("search-run-5");
  });

  it("keeps both internal and external people visible across a full sourcing run", () => {
    const preview = getAgentCandidatePreview({
      id: "run-full-sourcing",
      status: "succeeded",
      steps: [
        {
          stepKey: "internal_match",
          status: "succeeded",
          output: {
            candidatePreview: [
              {
                candidateId: "internal-1",
                name: "内部专家",
                sourceType: "internal",
                evidenceLevel: "E3",
              },
            ],
          },
        },
        {
          stepKey: "external_research",
          status: "succeeded",
          output: {
            candidatePreview: [
              {
                candidateId: "external-1",
                name: "外部候选",
                sourceType: "external",
                evidenceLevel: "E1",
              },
              {
                candidateId: "internal-1",
                name: "内部专家重复项",
                sourceType: "internal",
              },
            ],
          },
        },
      ],
    });

    expect(preview.map((candidate) => candidate.candidateId)).toEqual(["internal-1", "external-1"]);
  });
});
