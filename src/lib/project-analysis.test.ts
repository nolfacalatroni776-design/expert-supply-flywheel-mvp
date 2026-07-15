import type { Project } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { AnalyzeProjectOutput } from "./schemas";
import { assessProjectAnalysisQuality, normalizeProjectAnalysis } from "./project-analysis";

const project = {
  title: "单细胞肿瘤免疫专家招募",
  rawDemand: "为医院肿瘤免疫单细胞数据评审招募专家，所有候选需人工复核。",
  domain: "肿瘤免疫与单细胞组学",
  taskType: "数据评审",
  quantity: 5,
  budgetMin: 300,
  budgetMax: 600,
  languagesJson: JSON.stringify(["中文", "英文"]),
  regionsJson: JSON.stringify(["中国", "新加坡"]),
} as Project;

function analysis(overrides: Partial<AnalyzeProjectOutput> = {}): AnalyzeProjectOutput {
  return {
    title: project.title,
    domain: project.domain ?? "",
    taskType: project.taskType ?? "",
    quantity: 5,
    budgetMin: 300,
    budgetMax: 600,
    languages: ["中文", "英文"],
    regions: ["中国", "新加坡"],
    riskLevel: "medium",
    persona: {
      summary: "招募有肿瘤免疫单细胞研究经历、可进行数据评审的专家。",
      mustHave: ["肿瘤免疫单细胞研究经历", "能够评审单细胞数据"],
      niceToHave: ["AACR 或 ASCO 会议经历"],
      exclude: ["无公开研究证据"],
      taskFitSignals: ["近五年相关论文"],
      evidenceRequirements: ["机构主页", "论文作者页", "会议讲者页"],
      humanReviewPoints: ["身份与机构归属", "研究方向与任务匹配"],
    },
    searchQueries: ["single cell tumor immunology paper author China", "AACR single cell speaker Singapore"],
    ...overrides,
  };
}

describe("project analysis quality", () => {
  it("raises oncology projects to the regulated risk floor", () => {
    expect(normalizeProjectAnalysis(project, analysis()).riskLevel).toBe("regulated");
  });

  it("rejects schema-valid but operationally empty personas", () => {
    const result = assessProjectAnalysisQuality(
      analysis({
        persona: {
          summary: "",
          mustHave: [],
          niceToHave: [],
          exclude: [],
          taskFitSignals: [],
          evidenceRequirements: [],
          humanReviewPoints: [],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("专家画像摘要");
    expect(result.missing).toContain("硬性要求");
    expect(result.missing).toContain("证据要求");
  });

  it("accepts a specific, actionable recruiting persona", () => {
    expect(assessProjectAnalysisQuality(analysis())).toEqual({ ok: true, missing: [] });
  });

  it("keeps explicit project fields and search directions as the source of truth", () => {
    const explicitProject = {
      ...project,
      title: "Python 后端代码评审专家招募",
      rawDemand: "招募 3 位 Python 后端代码评审专家，远程协作，中英文均可。",
      domain: "Python 后端",
      taskType: "代码评审",
      quantity: 3,
      budgetMin: 120,
      budgetMax: 260,
      languagesJson: JSON.stringify(["中文", "英文"]),
      regionsJson: JSON.stringify(["远程", "UTC+8"]),
      riskLevel: "medium",
      searchQueriesJson: JSON.stringify(["Python FastAPI GitHub maintainer"]),
    } as Project;

    const normalized = normalizeProjectAnalysis(
      explicitProject,
      analysis({
        title: "模型改写标题",
        domain: "软件工程",
        taskType: "人才搜索",
        quantity: 30,
        budgetMin: 1,
        budgetMax: 2,
        languages: ["英文"],
        regions: ["中国"],
        riskLevel: "regulated",
        searchQueries: ["Python generic expert"],
      }),
    );

    expect(normalized).toMatchObject({
      title: explicitProject.title,
      domain: explicitProject.domain,
      taskType: explicitProject.taskType,
      quantity: 3,
      budgetMin: 120,
      budgetMax: 260,
      languages: ["中文", "英文"],
      regions: ["远程", "UTC+8"],
      riskLevel: "medium",
    });
    expect(normalized.searchQueries[0]).toBe("Python FastAPI GitHub maintainer");
    expect(normalized.searchQueries).toContain("Python generic expert");
  });
});
