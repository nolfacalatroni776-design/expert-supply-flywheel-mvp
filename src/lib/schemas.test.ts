import { describe, expect, it } from "vitest";
import {
  analyzeProjectOutputSchema,
  extractCandidatesOutputSchema,
  marketingCampaignOutputSchema,
  outreachOutputSchema,
  qualityEventSchema,
  recruitmentRetrospectiveOutputSchema,
  scoreCandidateOutputSchema,
  supplyGapOutputSchema,
  supplyRankOutputSchema,
  trialTaskOutputSchema,
} from "./schemas";

const baseScorePayload = {
  fitScore: 82,
  evidenceLevel: "E2",
  scoreBreakdown: [
    {
      dimension: "领域匹配",
      score: 88,
      weight: 35,
      evidence: "公开主页显示医学影像背景",
      reason: "候选人的公开经历与任务领域一致。",
    },
    {
      dimension: "证据强度",
      score: 70,
      weight: 30,
      evidence: "机构主页和项目相关页面",
      reason: "证据可追溯，但缺少资质原件。",
    },
    {
      dimension: "合规风险",
      score: 65,
      weight: 35,
      evidence: "医疗任务需要人工复核",
      reason: "属于高风险领域，不能自动批准触达。",
    },
  ],
  topReasons: ["领域匹配度较高"],
  risks: ["资质未人工核验"],
  missingEvidence: ["执业资质原件"],
  nextAction: "人工复核证据后再触达",
  humanReviewRequired: true,
};

describe("scoreCandidateOutputSchema", () => {
  it("requires explainable score breakdown dimensions", () => {
    expect(scoreCandidateOutputSchema.parse(baseScorePayload).scoreBreakdown).toHaveLength(3);
  });

  it("rejects black-box scores without breakdown", () => {
    const withoutBreakdown: Record<string, unknown> = { ...baseScorePayload };
    delete withoutBreakdown.scoreBreakdown;
    expect(scoreCandidateOutputSchema.safeParse(withoutBreakdown).success).toBe(false);
  });

  it("rejects invalid dimension scores", () => {
    const result = scoreCandidateOutputSchema.safeParse({
      ...baseScorePayload,
      scoreBreakdown: [{ ...baseScorePayload.scoreBreakdown[0], score: 101 }],
    });
    expect(result.success).toBe(false);
  });

  it("derives conservative defaults from breakdown-only GLM scoring", () => {
    const parsed = scoreCandidateOutputSchema.parse({
      scoreBreakdown: [
        { dimension: "领域匹配", score: 80, weight: 40, evidence: "GitHub profile", explanation: "Python repos" },
        { dimension: "证据强度", score: 55, weight: 35, evidence: "未提供机构证明" },
        { dimension: "合规风险", score: 50, weight: 25, evidence: "未验证联系路径" },
      ],
    });

    expect(parsed.fitScore).toBe(64);
    expect(parsed.scoreBreakdown[0].weight).toBe(40);
    expect(parsed.evidenceLevel).toBe("E1");
    expect(parsed.humanReviewRequired).toBe(true);
    expect(parsed.topReasons.length).toBeGreaterThan(0);
    expect(parsed.missingEvidence.length).toBeGreaterThan(0);
  });
});

describe("analyzeProjectOutputSchema", () => {
  it("accepts GLM query objects and missing top-level fields", () => {
    const parsed = analyzeProjectOutputSchema.parse({
      persona: {
        summary: "Python backend reviewers",
        mustHave: ["Python"],
      },
      searchQueries: [
        { query: "Python backend code reviewer GitHub" },
        { search_query: "FastAPI maintainer profile" },
        "Django reviewer expert",
      ],
    });

    expect(parsed.title).toBe("");
    expect(parsed.domain).toBe("");
    expect(parsed.riskLevel).toBe("medium");
    expect(parsed.persona.mustHave).toEqual(["Python"]);
    expect(parsed.persona.evidenceRequirements).toEqual([]);
    expect(parsed.searchQueries).toEqual([
      "Python backend code reviewer GitHub",
      "FastAPI maintainer profile",
      "Django reviewer expert",
    ]);
  });
});

describe("extractCandidatesOutputSchema", () => {
  it("accepts a top-level candidate array from GLM", () => {
    const parsed = extractCandidatesOutputSchema.parse([
      {
        name: "Ada Python",
        sourceUrl: "https://github.com/ada-python",
        domainTags: ["Python"],
      },
    ]);

    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]).toMatchObject({
      name: "Ada Python",
      sourceUrl: "https://github.com/ada-python",
      evidenceLevel: "E1",
    });
  });

  it("normalizes sparse GLM candidate output into reviewable low-evidence candidates", () => {
    const parsed = extractCandidatesOutputSchema.parse({
      candidates: [
        {
          name: "Ada Python",
          sourceUrl: "https://github.com/ada-python",
          domainTags: ["Python", "FastAPI"],
          region: ["China", "Remote"],
        },
      ],
    });

    expect(parsed.candidates[0]).toMatchObject({
      name: "Ada Python",
      title: null,
      affiliation: null,
      region: "China, Remote",
      evidenceLevel: "E1",
    });
    expect(parsed.candidates[0].claims).toHaveLength(1);
    expect(parsed.candidates[0].claims[0]).toMatchObject({
      sourceUrl: "https://github.com/ada-python",
      evidenceLevel: "E1",
    });
  });
});

describe("outreachOutputSchema", () => {
  it("accepts nested email drafts and fills reply templates", () => {
    const parsed = outreachOutputSchema.parse({
      email: {
        subject: "项目邀请",
        body: "您好，想邀请您了解一个代码评审项目。",
      },
    });

    expect(parsed.subject).toBe("项目邀请");
    expect(parsed.body).toContain("代码评审");
    expect(parsed.replyTemplates.unsubscribe).toContain("不再联系");
  });
});

describe("trialTaskOutputSchema", () => {
  it("accepts nested trial task drafts and normalizes rubric fields", () => {
    const parsed = trialTaskOutputSchema.parse({
      trialTask: {
        taskDescription: "请审查一段脱敏 Python API 代码并标注安全风险。",
        rubric: {
          criteria: [
            {
              criterion: "安全风险识别",
              weight: "45",
              expectation: "指出输入校验、鉴权和异常处理问题。",
            },
          ],
          passThreshold: "80",
        },
      },
    });

    expect(parsed.instructions).toContain("Python API");
    expect(parsed.rubric.criteria[0]).toMatchObject({
      name: "安全风险识别",
      weight: 45,
      description: "指出输入校验、鉴权和异常处理问题。",
    });
    expect(parsed.rubric.passThreshold).toBe(80);
    expect(parsed.rubric.reviewNotes.length).toBeGreaterThan(0);
  });

  it("fills a conservative default rubric when GLM omits one", () => {
    const parsed = trialTaskOutputSchema.parse({
      description: "请完成一个小规模代码评审试标。",
    });

    expect(parsed.instructions).toContain("代码评审");
    expect(parsed.rubric.criteria.length).toBeGreaterThanOrEqual(3);
    expect(parsed.rubric.passThreshold).toBe(75);
  });

  it("joins instruction arrays returned by GLM", () => {
    const parsed = trialTaskOutputSchema.parse({
      instructions: ["阅读脱敏代码", "指出安全风险", "给出修改建议"],
    });

    expect(parsed.instructions).toContain("阅读脱敏代码");
    expect(parsed.instructions).toContain("给出修改建议");
    expect(parsed.rubric.criteria.length).toBeGreaterThanOrEqual(3);
  });
});

describe("marketingCampaignOutputSchema", () => {
  it("accepts channel keyed drafts from GLM", () => {
    const parsed = marketingCampaignOutputSchema.parse({
      summary: "多渠道招募 Python 专家",
      targetAudience: ["Python 后端专家", "技术社区维护者"],
      channelPosts: {
        "公众号": {
          headline: "招募 Python 后端代码评审专家",
          copy: "我们正在寻找有 FastAPI/Django 经验的专家参与脱敏代码评审试标。",
          callToAction: "欢迎回复推荐。",
          hashtags: ["Python", "代码评审"],
          reviewNotes: ["发布前确认需求可公开。"],
        },
      },
    });

    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0]).toMatchObject({
      channel: "wechat",
      title: "招募 Python 后端代码评审专家",
      cta: "欢迎回复推荐。",
    });
    expect(parsed.audience).toEqual(["Python 后端专家", "技术社区维护者"]);
  });

  it("accepts GLM channel arrays with nested post objects and string risk notes", () => {
    const parsed = marketingCampaignOutputSchema.parse({
      campaignGoal: "招募 Python 后端代码评审专家",
      targetAudience: ["Python 后端专家", "专家推荐人"],
      channels: [
        {
          channel: "linkedin",
          post: {
            headline: "Expert Call: Python Backend Reviewers",
            body: "We are assembling a panel of Python backend experts for code review and model evaluation.\n\nCTA: Submit your profile.\n\nriskNotes: Human review.",
            cta: "Submit your public profile or refer a qualified expert.",
            hashtags: ["#PythonBackend", "#CodeReview"],
            riskNotes: "Confirm the application link is live before publishing.",
          },
        },
      ],
      complianceChecklist: ["发布前人工审批。"],
    });

    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0]).toMatchObject({
      channel: "linkedin",
      title: "Expert Call: Python Backend Reviewers",
      body: "We are assembling a panel of Python backend experts for code review and model evaluation.",
      cta: "Submit your public profile or refer a qualified expert.",
      riskNotes: ["Confirm the application link is live before publishing."],
    });
    expect(parsed.campaignSummary).toBe("招募 Python 后端代码评审专家");
    expect(parsed.reviewChecklist).toEqual(["发布前人工审批。"]);
  });

  it("accepts nested marketing plan wrappers", () => {
    const parsed = marketingCampaignOutputSchema.parse({
      marketingPlan: {
        campaign_summary: "社群渠道招募代码评审专家",
        target_audience: ["社区维护者"],
        social_posts: {
          community: {
            title: "招募 Python 代码评审专家",
            body: "我们正在招募 Python 后端专家参与试标。",
            cta: "回复公开主页链接。",
            hashtags: ["Python"],
            reviewNotes: ["确认社区版规。"],
          },
        },
        compliance_checklist: ["发布前人工复核。"],
      },
    });

    expect(parsed.campaignSummary).toBe("社群渠道招募代码评审专家");
    expect(parsed.audience).toEqual(["社区维护者"]);
    expect(parsed.posts[0]).toMatchObject({
      channel: "community",
      title: "招募 Python 代码评审专家",
    });
  });
});

describe("supply flywheel schemas", () => {
  it("validates quality event feedback for the expert flywheel", () => {
    const parsed = qualityEventSchema.parse({
      eventType: "trial_passed",
      score: "92",
      notes: "试标质量稳定",
    });
    expect(parsed).toMatchObject({ eventType: "trial_passed", score: 92 });
  });

  it("normalizes supply gap output", () => {
    const parsed = supplyGapOutputSchema.parse({
      gaps: [
        {
          gapType: "evidence",
          description: "缺少 E2+ 候选",
          requiredCount: "20",
          availableCount: "4",
          severity: "critical",
        },
      ],
      searchDirections: "医院 影像科 专家",
    });
    expect(parsed.gaps[0]).toMatchObject({
      requiredCount: 20,
      availableCount: 4,
      recommendedAction: "补充外部搜索并人工复核候选。",
    });
    expect(parsed.searchDirections).toEqual(["医院 影像科 专家"]);
  });

  it("accepts conservative rank output with candidate IDs only", () => {
    const parsed = supplyRankOutputSchema.parse({
      candidates: [
        {
          candidateId: "cand_1",
          conversionProbability: "0.73",
          rankReasons: "内部专家库命中",
          risks: ["待复核"],
        },
      ],
    });
    expect(parsed.candidates[0]).toMatchObject({
      candidateId: "cand_1",
      conversionProbability: 0.73,
      rankReasons: ["内部专家库命中"],
      nextAction: "人工复核后决定下一步。",
    });
  });

  it("fills retrospective arrays when GLM omits them", () => {
    const parsed = recruitmentRetrospectiveOutputSchema.parse({ summary: "内部供给不足，需要补外部深搜。" });
    expect(parsed.summary).toContain("内部供给不足");
    expect(parsed.wins).toEqual([]);
    expect(parsed.nextActions).toEqual([]);
  });
});
