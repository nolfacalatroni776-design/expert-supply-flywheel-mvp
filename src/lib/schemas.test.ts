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

  it("normalizes a 0-10 dimension scale and rejects an inconsistent explicit total", () => {
    const parsed = scoreCandidateOutputSchema.parse({
      fitScore: 12,
      evidenceLevel: "E2",
      scoreBreakdown: [
        { dimension: "domain_fit", score: 10, weight: 40, evidence: "Direct maintainer evidence" },
        { dimension: "task_fit", score: 9, weight: 35, evidence: "Direct task match" },
        { dimension: "availability_signal", score: 4, weight: 25, evidence: "Availability unknown" },
      ],
      topReasons: [],
      risks: [],
      missingEvidence: [],
      humanReviewRequired: true,
    });

    expect(parsed.scoreBreakdown.map((item) => item.score)).toEqual([100, 90, 40]);
    expect(parsed.fitScore).toBe(82);
  });

  it("assigns deterministic weights totaling 100 when the model omits every weight", () => {
    const parsed = scoreCandidateOutputSchema.parse({
      evidenceLevel: "E2",
      scoreBreakdown: [
        { dimension: "领域匹配", score: 90, evidence: "公开能力与项目领域匹配。" },
        { dimension: "任务适配", score: 80, evidence: "历史经历与任务类型相关。" },
        { dimension: "合规风险", score: 60, evidence: "仍需人工复核联系许可。" },
      ],
    });

    expect(parsed.scoreBreakdown.map((item) => item.weight)).toEqual([34, 33, 33]);
    expect(parsed.scoreBreakdown.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
    expect(parsed.fitScore).toBe(77);
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

  it("normalizes GLM outreachDraft output and scenario reply templates", () => {
    const parsed = outreachOutputSchema.parse({
      outreachDraft: {
        subject: "Pydantic v2 代码评审项目邀请",
        body: "您好，我们希望邀请您参与 Pydantic v2 代码评审项目。正式推进前会先确认时间、试标和合作边界；如不希望继续联系，请直接告知。",
      },
      replyTemplates: [
        { scenario: "专家确认愿意参与", body: "感谢确认，我们会补充试标和排期说明。" },
        { scenario: "专家时间不确定", body: "理解，我们可以在合适时间再次确认。" },
        { scenario: "专家拒绝或要求不再联系", body: "已记录，我们不会继续跟进。" },
      ],
    });

    expect(parsed.subject).toContain("Pydantic v2");
    expect(parsed.body).toContain("代码评审");
    expect(parsed.replyTemplates.interested).toContain("试标");
    expect(parsed.replyTemplates.unavailable).toContain("合适时间");
    expect(parsed.replyTemplates.unsubscribe).toContain("不会继续");
  });

  it("rejects empty outreach output instead of writing a generic draft", () => {
    expect(() => outreachOutputSchema.parse({})).toThrow();
  });

  it("rejects a truncated outreach body", () => {
    expect(() =>
      outreachOutputSchema.parse({
        subject: "Python 代码评审项目邀请",
        body: "您好，我们希望邀请您参与 Python 代码评审项目。如不希望继续联系，请回复",
      }),
    ).toThrow(/complete sentence/i);
  });

  it("rejects internal consent codes, evidence grades, and private source URLs", () => {
    expect(() =>
      outreachOutputSchema.parse({
        subject: "Python 代码评审项目邀请",
        body:
          "您好，您的 consentState 为 consented，联系依据是 direct_consent，内部证据等级为 E4。详情见 https://expert-ops.local/internal/profile。",
      }),
    ).toThrow(/internal operational metadata/i);
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
    expect(parsed.usedDefaultRubric).toBe(true);
  });

  it("joins instruction arrays returned by GLM", () => {
    const parsed = trialTaskOutputSchema.parse({
      instructions: ["阅读脱敏代码", "指出安全风险", "给出修改建议"],
    });

    expect(parsed.instructions).toContain("阅读脱敏代码");
    expect(parsed.instructions).toContain("给出修改建议");
    expect(parsed.rubric.criteria.length).toBeGreaterThanOrEqual(3);
  });

  it("normalizes scoringRubric with an absolute threshold into a percentage rubric", () => {
    const parsed = trialTaskOutputSchema.parse({
      instructions: ["审核 3 个脱敏样例", "给出判断依据和不确定性"],
      scoringRubric: {
        totalMaxScore: 50,
        passThreshold: 40,
        perQuestionCriteria: {
          correctness: "判断结论与金标准一致。",
          rationaleQuality: "理由需包含可验证依据。",
          arbitrationSpecific: "仲裁需说明分歧原因。",
        },
        autoFailConditions: ["使用未获批准的外部工具", "泄露敏感数据"],
      },
    });

    expect(parsed.rubric.criteria.map((item) => item.name)).toEqual(["判断准确性", "证据化解释", "仲裁处理"]);
    expect(parsed.rubric.passThreshold).toBe(80);
    expect(parsed.rubric.reviewNotes).toContain("使用未获批准的外部工具");
    expect(parsed.usedDefaultRubric).toBe(false);
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

  it("normalizes the object-rich retrospective shape returned by the live model", () => {
    const parsed = recruitmentRetrospectiveOutputSchema.parse({
      summary: { overallHealth: "有风险", topFinding: "高证据候选仍停留在人工复核阶段。" },
      wins: [{ area: "候选质量", detail: "GitHub 来源产出了高证据候选。" }],
      bottlenecks: [{ area: "复核", detail: "候选尚未完成联系许可确认。", impact: "暂不可触达。" }],
      sourceInsights: [{ source: "github.com", assessment: "适合继续补充公开贡献证据。" }],
      nextActions: [{ priority: 1, action: "先完成人工复核", detail: "确认联系许可后再分批触达。" }],
    });

    expect(parsed.summary).toBe("高证据候选仍停留在人工复核阶段。");
    expect(parsed.wins).toEqual(["候选质量：GitHub 来源产出了高证据候选。"]);
    expect(parsed.bottlenecks).toEqual(["复核：候选尚未完成联系许可确认。 暂不可触达。"]);
    expect(parsed.sourceInsights).toEqual(["github.com：适合继续补充公开贡献证据。"]);
    expect(parsed.nextActions).toEqual(["先完成人工复核：确认联系许可后再分批触达。"]);
  });
});
