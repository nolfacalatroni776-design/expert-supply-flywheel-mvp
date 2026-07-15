import { describe, expect, it } from "vitest";
import {
  serializeCandidate,
  serializeCandidateForGeneration,
  serializeCandidateForOutreach,
  serializeCandidateForScoring,
  serializeProjectForGeneration,
} from "./serializers";

describe("serializeProjectForGeneration", () => {
  it("removes internal record identifiers from model-facing project context", () => {
    const createdAt = new Date("2026-07-14T00:00:00.000Z");
    const serialized = serializeProjectForGeneration({
      id: "internal-project-id",
      title: "Pydantic v2 代码评审专家招募",
      rawDemand: "招募 Pydantic v2 代码评审专家。",
      domain: "Python",
      taskType: "代码评审",
      quantity: 3,
      budgetMin: null,
      budgetMax: null,
      languagesJson: "[]",
      regionsJson: "[]",
      riskLevel: "medium",
      status: "draft",
      personaJson: "{}",
      searchQueriesJson: "[]",
      supplyGoalJson: "{}",
      createdAt,
      updatedAt: createdAt,
    });

    expect(serialized).not.toHaveProperty("id");
    expect(serialized.title).toContain("Pydantic v2");
  });

  it("omits an unqualified numeric budget so the model cannot invent currency or billing units", () => {
    const createdAt = new Date("2026-07-14T00:00:00.000Z");
    const baseProject = {
      id: "project-budget",
      title: "代码评审专家招募",
      rawDemand: "招募 Python 代码评审专家。",
      domain: "Python",
      taskType: "代码评审",
      quantity: 3,
      budgetMin: 150,
      budgetMax: 300,
      languagesJson: "[]",
      regionsJson: "[]",
      riskLevel: "medium",
      status: "draft",
      personaJson: "{}",
      searchQueriesJson: "[]",
      supplyGoalJson: "{}",
      createdAt,
      updatedAt: createdAt,
    };

    expect(serializeProjectForGeneration(baseProject)).not.toHaveProperty("budgetMin");
    expect(serializeProjectForGeneration(baseProject)).not.toHaveProperty("budgetMax");
    expect(
      serializeProjectForGeneration({
        ...baseProject,
        rawDemand: "招募 Python 代码评审专家，预算 150-300 元/小时。",
      }),
    ).toMatchObject({ budgetMin: 150, budgetMax: 300 });
  });
});

describe("serializeCandidate", () => {
  it("keeps internal expert signals, quality metrics, and profile evidence for downstream AI actions", () => {
    const createdAt = new Date("2026-07-14T00:00:00.000Z");
    const serialized = serializeCandidate({
      id: "candidate-1",
      projectId: "project-1",
      expertId: "expert-1",
      stage: "verified",
      fitScore: 88,
      scoringJson: "{}",
      risksJson: "[]",
      missingJson: "[]",
      nextAction: "生成触达草稿。",
      humanReviewNeeded: false,
      sourceType: "internal",
      sourceRunId: "run-1",
      conversionProbability: 0.86,
      rankReasonJson: "{}",
      createdAt,
      updatedAt: createdAt,
      evidenceItems: [],
      outreachDrafts: [],
      trialTasks: [],
      expert: {
        id: "expert-1",
        identityKey: "internal-identity-key-must-not-leave-the-server",
        name: "内部 Python 专家",
        title: "资深 Python 后端工程师",
        affiliation: "内部专家库",
        domainTagsJson: JSON.stringify(["Python", "FastAPI"]),
        languagesJson: JSON.stringify(["中文"]),
        region: "远程",
        contactJson: JSON.stringify({ contactPermissionBasis: "direct_consent", profileAllowsOutreach: true }),
        sourceUrl: "https://expert.example/profile/python",
        evidenceLevel: "E4",
        consentState: "consented",
        riskFlagsJson: "[]",
        expertType: "internal",
        lastActiveAt: createdAt,
        qualitySummaryJson: JSON.stringify({ averageScore: 96, metricCount: 2 }),
        createdAt,
        updatedAt: createdAt,
        signals: [
          {
            id: "signal-1",
            expertId: "expert-1",
            type: "skill",
            value: "FastAPI",
            source: "live_smoke_internal_profile",
            evidenceLevel: "E4",
            confidence: 0.96,
            sourceUrl: "https://expert.example/profile/python",
            createdAt,
          },
        ],
        qualityMetrics: [
          {
            id: "metric-1",
            expertId: "expert-1",
            projectId: "project-old",
            metricType: "trial_passed",
            score: 96,
            source: "live_smoke_fixture",
            notes: "Live smoke fixture for production-flow validation.",
            createdAt,
          },
        ],
        evidenceItems: [
          {
            id: "evidence-1",
            projectId: null,
            expertId: "expert-1",
            candidateId: null,
            claim: "具备 FastAPI 代码评审经验",
            sourceUrl: "https://expert.example/profile/python",
            sourceTitle: "Expert profile",
            sourceType: "internal_profile",
            snippet: "历史项目记录显示该专家完成过 FastAPI 代码评审。",
            evidenceLevel: "E4",
            confidence: 0.94,
            createdAt,
          },
        ],
      },
    });

    expect(serialized.expert?.signals).toEqual([
      expect.objectContaining({ value: "FastAPI", evidenceLevel: "E4", confidence: 0.96 }),
    ]);
    expect(serialized.expert?.qualityMetrics).toEqual([
      expect.objectContaining({ metricType: "trial_passed", score: 96 }),
    ]);
    expect(serialized.expert?.evidenceItems).toEqual([
      expect.objectContaining({ claim: "具备 FastAPI 代码评审经验", evidenceLevel: "E4" }),
    ]);
    expect(serialized.expert).not.toHaveProperty("identityKey");
    expect(serialized.expert).not.toHaveProperty("domainTagsJson");
    expect(serialized.expert).not.toHaveProperty("languagesJson");
    expect(serialized.expert).not.toHaveProperty("contactJson");
    expect(serialized.expert).not.toHaveProperty("riskFlagsJson");
    expect(serialized.expert).not.toHaveProperty("qualitySummaryJson");
    expect(JSON.stringify(serialized.expert)).not.toMatch(/live[_-]?smoke|fixture/i);
    expect(serialized).not.toHaveProperty("project");
    expect(serialized).not.toHaveProperty("scoringJson");
    expect(serialized).not.toHaveProperty("risksJson");
  });

  it("builds compact candidate context for draft and trial generation", () => {
    const createdAt = new Date("2026-07-14T00:00:00.000Z");
    const candidate = {
      id: "candidate-compact",
      projectId: "project-1",
      expertId: "expert-1",
      stage: "verified",
      fitScore: 86,
      scoringJson: JSON.stringify({
        evidenceLevel: "E4",
        topReasons: ["领域匹配", "历史试标通过"],
        scoreBreakdown: Array.from({ length: 20 }, (_, index) => ({ dimension: `d${index}`, reason: "long" })),
      }),
      risksJson: JSON.stringify(["需人工复核"]),
      missingJson: JSON.stringify(["公开主页"]),
      nextAction: "生成触达草稿。",
      humanReviewNeeded: false,
      sourceType: "internal",
      sourceRunId: null,
      conversionProbability: 0.8,
      rankReasonJson: "{}",
      createdAt,
      updatedAt: createdAt,
      evidenceItems: [],
      outreachDrafts: [],
      trialTasks: [],
      expert: {
        id: "expert-1",
        name: "内部 Python 专家",
        title: "资深 Python 后端工程师",
        affiliation: "内部专家库",
        domainTagsJson: JSON.stringify(["Python", "FastAPI"]),
        languagesJson: JSON.stringify(["中文"]),
        region: "远程",
        contactJson: JSON.stringify({ contactPermissionBasis: "direct_consent", profileAllowsOutreach: true }),
        sourceUrl: "https://expert.example/profile/python",
        evidenceLevel: "E4",
        consentState: "consented",
        riskFlagsJson: "[]",
        expertType: "internal",
        lastActiveAt: createdAt,
        qualitySummaryJson: "{}",
        createdAt,
        updatedAt: createdAt,
      },
    };

    const compact = serializeCandidateForGeneration(candidate);
    const outreach = serializeCandidateForOutreach(candidate);

    expect(compact.scoring.topReasons).toEqual(["领域匹配", "历史试标通过"]);
    expect(compact.scoring).not.toHaveProperty("scoreBreakdown");
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(serializeCandidate(candidate)).length);
    expect(outreach.expert).toMatchObject({ name: "内部 Python 专家", domainTags: ["Python", "FastAPI"] });
    expect(JSON.stringify(outreach)).not.toMatch(/consented|direct_consent|\bE[0-4]\b|https?:\/\//i);
  });

  it("keeps previous model conclusions out of a fresh scoring request", () => {
    const createdAt = new Date("2026-07-14T00:00:00.000Z");
    const candidate = {
      id: "candidate-rescore",
      projectId: "project-1",
      expertId: "expert-1",
      stage: "verified",
      fitScore: 30,
      scoringJson: JSON.stringify({ topReasons: ["previous model conclusion"] }),
      risksJson: JSON.stringify(["invented budget mismatch"]),
      missingJson: JSON.stringify(["previous missing evidence"]),
      nextAction: "previous next action",
      humanReviewNeeded: true,
      sourceType: "external",
      sourceRunId: "run-1",
      conversionProbability: null,
      rankReasonJson: "{}",
      createdAt,
      updatedAt: createdAt,
      evidenceItems: [],
      outreachDrafts: [],
      trialTasks: [],
      expert: {
        id: "expert-1",
        name: "候选专家",
        title: "Pydantic maintainer",
        affiliation: null,
        domainTagsJson: JSON.stringify(["Pydantic"]),
        languagesJson: JSON.stringify(["English"]),
        region: "Remote",
        contactJson: JSON.stringify({ profileUrl: "https://github.com/example" }),
        sourceUrl: "https://github.com/example",
        evidenceLevel: "E2",
        consentState: "unknown",
        riskFlagsJson: JSON.stringify(["previous extraction risk"]),
        expertType: "external",
        lastActiveAt: null,
        qualitySummaryJson: "{}",
        createdAt,
        updatedAt: createdAt,
      },
    };

    const scoringInput = serializeCandidateForScoring(candidate);
    expect(scoringInput).not.toHaveProperty("fitScore");
    expect(scoringInput).not.toHaveProperty("scoring");
    expect(scoringInput).not.toHaveProperty("risks");
    expect(scoringInput).not.toHaveProperty("missing");
    expect(scoringInput).not.toHaveProperty("nextAction");
    expect(scoringInput.expert).not.toHaveProperty("riskFlags");
  });
});
