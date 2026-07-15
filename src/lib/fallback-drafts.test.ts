import { describe, expect, it } from "vitest";
import { buildFallbackMarketingCampaign, buildFallbackOutreachDraft, buildFallbackTrialTask } from "./fallback-drafts";

describe("fallback drafts", () => {
  it("creates a conservative trial task without pretending it came from AI", () => {
    const trial = buildFallbackTrialTask({
      project: { title: "Python 评审", domain: "Python 后端", taskType: "代码评审" },
      candidate: { expert: { name: "Ada", domainTags: ["FastAPI", "Django"] } },
    });

    expect(trial.instructions).toContain("Ada");
    expect(trial.rubric.criteria.length).toBeGreaterThanOrEqual(4);
    expect(trial.rubric.reviewNotes.join(" ")).toContain("系统模板生成");
    expect(trial.rubric.reviewNotes.join(" ")).toContain("不自动决定");
  });

  it("creates review-gated channel drafts for every requested channel", () => {
    const campaign = buildFallbackMarketingCampaign({
      project: {
        title: "Python 后端专家招募",
        domain: "Python 后端",
        taskType: "代码评审",
        quantity: 3,
        languages: ["中文", "英文"],
        regions: ["远程"],
      },
      channels: ["linkedin", "wechat", "community"],
      audience: ["Python 专家"],
    });

    expect(campaign.posts.map((post) => post.channel)).toEqual(["linkedin", "wechat", "community"]);
    expect(campaign.posts.every((post) => post.riskNotes.join(" ").includes("人工复核"))).toBe(true);
    expect(campaign.reviewChecklist.join(" ")).toContain("试标");
  });

  it("creates a complete outreach draft without internal operational metadata", () => {
    const draft = buildFallbackOutreachDraft({
      project: {
        title: "Python 后端代码评审专家招募",
        domain: "Python 后端",
        taskType: "代码评审",
        languages: ["中文", "英文"],
        regions: ["远程", "UTC+8"],
      },
      candidate: {
        expert: {
          name: "Ada",
          title: "资深 Python 后端工程师",
          domainTags: ["FastAPI", "Django", "SQLAlchemy"],
        },
      },
    });

    expect(draft.subject).toContain("Python 后端代码评审");
    expect(draft.subject).toContain("专家邀请");
    expect(draft.body).toContain("Ada");
    expect(draft.body).toContain("您作为资深 Python 后端工程师，在 FastAPI、Django、SQLAlchemy 方面的经历");
    expect(draft.body).toContain("如不希望继续联系");
    expect(draft.body).toMatch(/[。！？.!?]$/);
    expect(JSON.stringify(draft)).not.toMatch(/consented|direct_consent|\bE[0-4]\b|expert-ops\.local/i);
  });
});
