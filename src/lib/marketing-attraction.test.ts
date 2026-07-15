import { describe, expect, it } from "vitest";
import { evaluateMarketingAttractionReadiness } from "@/lib/marketing-attraction";

describe("evaluateMarketingAttractionReadiness", () => {
  it("passes channel drafts that make the expert value, process, and CTA clear", () => {
    const report = evaluateMarketingAttractionReadiness({
      posts: [
        {
          channel: "linkedin",
          title: "Python 后端代码评审专家招募",
          body: "我们正在邀请有 FastAPI、Django、工程质量经验的后端专家参与代码评审标注。任务包含小规模试标、人工审核和正式合作确认，适合愿意贡献工程判断的专家。",
          cta: "如你有相关经验，欢迎填写 https://apply.example/python-review 或推荐合适专家。",
          riskNotes: ["发布前确认不包含客户敏感信息。"],
        },
        {
          channel: "community",
          title: "寻找 Python 代码评审伙伴",
          body: "项目需要熟悉后端架构、测试质量和代码规范的专家。我们会先提供试标说明，再根据结果确认是否进入正式任务。",
          cta: "感兴趣请回复背景方向，我们会发送报名入口。",
          riskNotes: ["不得承诺录用或收益。"],
        },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.channels).toEqual(["linkedin", "community"]);
    expect(report.readyPosts).toBe(2);
    expect(report.nextActions).toContain("进入渠道中心逐条复核后再发布。");
  });

  it("flags drafts without CTA, process clarity, review notes, or with overpromising language", () => {
    const report = evaluateMarketingAttractionReadiness({
      posts: [
        {
          channel: "xiaohongshu",
          title: "高薪专家任务",
          body: "无需筛选，保证录用，轻松赚钱。快来。",
          cta: "",
          riskNotes: [],
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.blockers).toContain("报名动作不清晰。");
    expect(report.blockers).toContain("缺少试标或筛选流程说明。");
    expect(report.blockers).toContain("存在过度承诺表达。");
    expect(report.blockers).toContain("缺少发布前复核项。");
  });

  it("blocks a CTA that refers to a project page without a real path", () => {
    const report = evaluateMarketingAttractionReadiness({
      posts: [
        {
          channel: "linkedin",
          title: "Python 专家招募",
          body: "我们邀请 Python 专家参与代码评审项目，申请后会经过人工审核和小规模试标。",
          cta: "Apply through the project page.",
          riskNotes: ["发布前人工复核。"],
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.blockers).toContain("报名动作缺少可执行路径。");
  });

  it("blocks trial compensation language that is not present in the project demand", () => {
    const report = evaluateMarketingAttractionReadiness({
      sourceText: "项目包含小规模试标和人工复核。",
      posts: [
        {
          channel: "linkedin",
          title: "Python reviewer recruitment",
          body: "Python experts will complete a small paid trial task before the formal code review project.",
          cta: "Reply to this post to apply.",
          riskNotes: ["发布前人工复核。"],
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.blockers).toContain("试标报酬表述缺少项目依据。");
  });
});
