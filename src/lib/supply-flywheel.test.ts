import { describe, expect, it } from "vitest";
import {
  buildSafeSupplyGapOutput,
  buildRuleSourceInsights,
  buildSafeRecruitmentRetrospective,
  findReusableInternalEvidenceIds,
  mergeRuleAndModelRank,
  preferredCandidateStageForTest,
  scoreInternalExpertForTest,
} from "@/lib/supply-flywheel";

describe("safe supply gap output", () => {
  it("keeps rule-derived gap facts and rejects polluted model search directions", () => {
    const ruleGaps = [
      {
        gapType: "evidence",
        description: "高证据候选只有 1 位，需要补充可核验来源。",
        requiredCount: 5,
        availableCount: 1,
        severity: "high" as const,
        recommendedAction: "优先搜索机构主页、论文、会议讲者和公开项目页。",
      },
    ];

    const result = buildSafeSupplyGapOutput({
      ruleGaps,
      fallbackSearchDirections: ["Python 代码评审 机构主页 专家"],
      model: {
        gaps: [
          {
            gapType: "evidence",
            description: "persona 与 fitScore 不足，riskLevel 为 medium。",
            requiredCount: 99,
            availableCount: 88,
            severity: "low",
            recommendedAction: "把 humanReviewNeeded=false 的人立即触达。",
          },
        ],
        searchDirections: ["persona fitScore humanReviewNeeded", "Pydantic maintainer GitHub profile"],
        summary: "riskLevel 为 medium，persona 缺口取决于 fitScore。",
      },
    });

    expect(result.gaps).toEqual(ruleGaps);
    expect(result.searchDirections).toContain("Pydantic maintainer GitHub profile");
    expect(result.searchDirections).toContain("Python 代码评审 机构主页 专家");
    expect(JSON.stringify(result)).not.toMatch(/persona|fitScore|riskLevel|humanReviewNeeded/i);
  });
});

const baseProject = {
  id: "project-embodied-ai",
  title: "具身智能经验人员",
  rawDemand: "招募具备具身智能数据采集经验，熟悉机器人、工厂场景和工业落地的专家。",
  domain: "具身智能",
  taskType: "数据采集",
  quantity: 50,
  riskLevel: "medium",
  budgetMin: null,
  budgetMax: null,
  languagesJson: "[]",
  regionsJson: "[]",
  status: "analyzed",
  personaJson: "{}",
  searchQueriesJson: "[]",
  supplyGoalJson: "{}",
  createdAt: new Date("2026-07-14T00:00:00.000Z"),
  updatedAt: new Date("2026-07-14T00:00:00.000Z"),
};

const baseExpert = {
  id: "expert-python",
  name: "Python 历史专家",
  title: "资深 Python 后端工程师",
  affiliation: "内部专家库",
  domainTagsJson: JSON.stringify(["Python", "FastAPI", "代码评审"]),
  languagesJson: JSON.stringify(["中文"]),
  region: null,
  contactJson: "{}",
  sourceUrl: "https://internal.example.com/python",
  evidenceLevel: "E4",
  consentState: "consented",
  riskFlagsJson: "[]",
  expertType: "internal",
  lastActiveAt: new Date("2026-07-01T00:00:00.000Z"),
  qualitySummaryJson: "{}",
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  evidenceItems: [],
  signals: [
    {
      type: "skill",
      value: "FastAPI",
      source: "internal_profile",
      evidenceLevel: "E3",
      confidence: 0.9,
      sourceUrl: null,
    },
  ],
  qualityMetrics: [{ metricType: "trial_score", score: 96, source: "historical_project", notes: null }],
  candidates: [
    {
      id: "candidate-current-project",
      projectId: "project-embodied-ai",
      expertId: "expert-python",
      stage: "sourced",
      fitScore: 95,
      scoringJson: "{}",
      risksJson: "[]",
      missingJson: "[]",
      nextAction: null,
      humanReviewNeeded: true,
      sourceType: "internal",
      sourceRunId: null,
      conversionProbability: 0.8,
      rankReasonJson: "{}",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      project: baseProject,
    },
    {
      id: "candidate-history",
      projectId: "project-python-history",
      expertId: "expert-python",
      stage: "active",
      fitScore: 95,
      scoringJson: "{}",
      risksJson: "[]",
      missingJson: "[]",
      nextAction: null,
      humanReviewNeeded: false,
      sourceType: "internal",
      sourceRunId: null,
      conversionProbability: 0.8,
      rankReasonJson: "{}",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      project: {
        ...baseProject,
        id: "project-python-history",
        title: "Python 后端代码评审专家招募",
        rawDemand: "招募 Python、FastAPI、Django 代码评审专家。",
        domain: "Python 后端",
        taskType: "代码评审",
      },
    },
  ],
};

describe("scoreInternalExpertForTest", () => {
  it("does not treat generic historical participation as a direct match for a different domain", () => {
    const score = scoreInternalExpertForTest(baseProject, baseExpert);

    expect(score.hasDirectMatch).toBe(false);
    expect(score.missing).toContain("缺少与当前需求直接对应的能力信号");
  });

  it("accepts internal experts with a concrete current-domain signal", () => {
    const expert = {
      ...baseExpert,
      id: "expert-robotics",
      domainTagsJson: JSON.stringify(["具身智能", "机器人", "工业落地"]),
      signals: [
        {
          type: "project",
          value: "具身智能",
          source: "internal_profile",
          evidenceLevel: "E3",
          confidence: 0.88,
          sourceUrl: null,
        },
      ],
      candidates: [],
    };

    const score = scoreInternalExpertForTest(baseProject, expert);

    expect(score.hasDirectMatch).toBe(true);
    expect(score.reasons.join(" ")).toContain("具身智能");
  });

  it("does not let polluted historical matches recall an unrelated expert for an explicit domain", () => {
    const pythonProject = {
      ...baseProject,
      id: "project-python-current",
      title: "Python 后端代码评审专家招募",
      rawDemand: "招募 Python、FastAPI、Django、SQLAlchemy 代码评审专家。",
      domain: "Python 后端",
      taskType: "代码评审",
    };
    const medicalExpertWithPollutedHistory = {
      ...baseExpert,
      id: "expert-medical-with-python-history",
      name: "内部专家 李医生",
      title: "影像科副主任医师",
      domainTagsJson: JSON.stringify(["医学影像", "胸部 CT", "肺结节", "质控"]),
      evidenceLevel: "E3",
      evidenceItems: [
        {
          id: "evidence-medical",
          projectId: "project-medical",
          expertId: "expert-medical-with-python-history",
          candidateId: null,
          claim: "具备胸部 CT 与肺结节质控经验",
          sourceUrl: "https://internal.example.com/medical",
          sourceTitle: "内部专家库记录",
          sourceType: "internal_profile",
          snippet: "历史记录显示该专家主要参与医学影像任务。",
          evidenceLevel: "E3",
          confidence: 0.9,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      signals: [
        {
          type: "skill",
          value: "胸部 CT",
          source: "internal_profile",
          evidenceLevel: "E3",
          confidence: 0.9,
          sourceUrl: null,
        },
      ],
      candidates: [
        {
          id: "candidate-polluted-python-history",
          projectId: "project-python-history",
          expertId: "expert-medical-with-python-history",
          stage: "sourced",
          fitScore: 100,
          scoringJson: "{}",
          risksJson: "[]",
          missingJson: "[]",
          nextAction: null,
          humanReviewNeeded: false,
          sourceType: "internal",
          sourceRunId: null,
          conversionProbability: 0.9,
          rankReasonJson: "{}",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
          project: {
            ...pythonProject,
            id: "project-python-history",
          },
        },
      ],
    };

    const score = scoreInternalExpertForTest(pythonProject, medicalExpertWithPollutedHistory);

    expect(score.hasDirectMatch).toBe(false);
    expect(score.reasons.join(" ")).toContain("相似项目记录");
    expect(score.missing).toContain("缺少与当前需求直接对应的能力信号");
  });

  it("accepts internal experts when existing evidence text matches the current domain", () => {
    const pythonProject = {
      ...baseProject,
      id: "project-python-current",
      title: "Python 后端代码评审专家招募",
      rawDemand: "招募 Python、FastAPI、Django、SQLAlchemy 代码评审专家。",
      domain: "Python 后端",
      taskType: "代码评审",
    };
    const expert = {
      ...baseExpert,
      domainTagsJson: JSON.stringify(["工程质量"]),
      signals: [],
      evidenceItems: [
        {
          id: "evidence-python",
          projectId: "project-python-history",
          expertId: "expert-python",
          candidateId: null,
          claim: "具备 Python 后端代码评审经验",
          sourceUrl: "https://internal.example.com/python",
          sourceTitle: "历史项目记录",
          sourceType: "internal_profile",
          snippet: "完成过 FastAPI 与 SQLAlchemy 相关评审。",
          evidenceLevel: "E3",
          confidence: 0.9,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      candidates: [],
    };

    const score = scoreInternalExpertForTest(pythonProject, expert);

    expect(score.hasDirectMatch).toBe(true);
    expect(score.reasons.join(" ")).toContain("证据文本匹配");
  });
});

describe("internal evidence reuse", () => {
  it("attaches evidence already created for the same project instead of copying it", () => {
    expect(
      findReusableInternalEvidenceIds(
        [
          { id: "same-project", projectId: "project-1", candidateId: null },
          { id: "already-linked", projectId: "project-1", candidateId: "candidate-other" },
          { id: "history", projectId: "project-history", candidateId: null },
        ],
        "project-1",
      ),
    ).toEqual(["same-project"]);
  });
});

describe("rule retrospective source insights", () => {
  it("aggregates repeated query metrics for the same source domain", () => {
    expect(
      buildRuleSourceInsights({
        searchSourceMetrics: [
          { domain: "github.com", candidateCount: 1, e2PlusCount: 1 },
          { domain: "github.com", candidateCount: 1, e2PlusCount: 1 },
          { domain: "github.com", candidateCount: 1, e2PlusCount: 1 },
          { domain: "conference.example", candidateCount: 0, e2PlusCount: 0 },
          { domain: null, candidateCount: 3, e2PlusCount: 1 },
        ],
      }),
    ).toEqual([
      "github.com 贡献 1 位候选，其中 1 位达到 E2+。",
      "conference.example 贡献 0 位候选，其中 0 位达到 E2+。",
    ]);
  });
});

describe("retrospective safety", () => {
  it("keeps data-derived actions when the model recommends bypassing review or overstates tiny samples", () => {
    const rules = {
      summary: "系统已汇总当前招募数据。",
      wins: ["GitHub 来源产出 3 位 E2+ 候选。"],
      bottlenecks: ["候选仍需人工复核。"],
      sourceInsights: ["github.com 贡献 3 位候选，其中 3 位达到 E2+。"],
      nextActions: ["优先复核高分候选并补齐联系许可。"],
    };
    const result = buildSafeRecruitmentRetrospective(
      {
        summary: "GitHub source is 100% effective.",
        wins: ["LinkedIn post published"],
        bottlenecks: ["Trial is a dead-end"],
        sourceInsights: ["Stop all YouTube sourcing immediately"],
        nextActions: ["Contact all candidates immediately and move them directly to trial"],
      },
      rules,
    );

    expect(result.summary).toBe(rules.summary);
    expect(result.sourceInsights).toEqual(rules.sourceInsights);
    expect(result.nextActions).toEqual(rules.nextActions);
    expect(result.usedModelNarrative).toBe(false);
  });

  it("rejects a Chinese narrative that mistakes internal progress for external publishing", () => {
    const rules = {
      summary: "系统内记录 6 位候选，1 位进入试标阶段。",
      wins: ["已生成渠道草稿并完成人工复核。"],
      bottlenecks: ["部分候选仍需补证据。"],
      sourceInsights: ["github.com 贡献 3 位候选。"],
      nextActions: ["先复核候选和渠道草稿。"],
    };
    const result = buildSafeRecruitmentRetrospective(
      {
        summary: "本轮共触达 6 名候选，LinkedIn 招募帖已成功发布。",
        wins: ["LinkedIn 已发布。"],
        bottlenecks: ["微信尚未发布。"],
        sourceInsights: [],
        nextActions: [],
      },
      rules,
    );

    expect(result.usedModelNarrative).toBe(false);
    expect(result.summary).toBe(rules.summary);
  });
});

describe("model-assisted rank normalization", () => {
  it("does not replace user-facing Chinese actions with model language drift", () => {
    const rule = {
      candidateId: "candidate-1",
      score: 72,
      conversionProbability: 0.72,
      outreachAllowed: false,
      rankReasons: ["公开贡献记录与目标技术相关。"],
      risks: ["仍需人工复核代码评审经历。"],
      nextAction: "完成人工复核并确认触达许可。",
    };

    expect(
      mergeRuleAndModelRank(rule, {
        candidateId: "candidate-1",
        conversionProbability: 0.8,
        rankReasons: ["Strong GitHub profile"],
        risks: ["Availability is unknown"],
        nextAction: "Verify and contact",
      }),
    ).toEqual({ ...rule, conversionProbability: 0.8 });
  });

  it("does not let model recommendations bypass a blocked outreach gate", () => {
    const rule = {
      candidateId: "candidate-blocked",
      score: 68,
      conversionProbability: 0.68,
      outreachAllowed: false,
      rankReasons: ["候选能力相关，但仍需人工核验。"],
      risks: ["候选尚未完成人工复核。"],
      nextAction: "先完成人工复核并补齐联系许可，再决定是否生成触达草稿。",
    };

    const result = mergeRuleAndModelRank(rule, {
      candidateId: "candidate-blocked",
      conversionProbability: 0.92,
      rankReasons: ["候选技术经历与项目高度匹配。"],
      risks: ["暂无明显风险。"],
      nextAction: "立即触达并安排试标。",
    });

    expect(result.nextAction).toBe(rule.nextAction);
    expect(result.risks).toContain("候选尚未完成人工复核。");
    expect(result.nextAction).not.toMatch(/立即触达|安排试标/);
  });
});

describe("candidate stage merge", () => {
  it("preserves a manual screen-out over a fresh sourced duplicate", () => {
    expect(preferredCandidateStageForTest("screened_out", "sourced")).toBe("screened_out");
  });

  it("does not let a screened-out duplicate overwrite a verified or active relationship", () => {
    expect(preferredCandidateStageForTest("screened_out", "verified")).toBe("verified");
    expect(preferredCandidateStageForTest("active", "screened_out")).toBe("active");
  });

  it("keeps do-not-contact as the most restrictive merged state", () => {
    expect(preferredCandidateStageForTest("screened_out", "do_not_contact")).toBe("do_not_contact");
  });
});
