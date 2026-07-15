import type { Project } from "@prisma/client";
import type { AnalyzeProjectOutput } from "@/lib/schemas";
import { isRegulatedProjectText } from "@/lib/gates";

export function assessProjectAnalysisQuality(data: AnalyzeProjectOutput): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (data.persona.summary.trim().length < 12) missing.push("专家画像摘要");
  if (data.persona.mustHave.filter((item) => item.trim().length >= 4).length < 2) missing.push("硬性要求");
  if (data.persona.taskFitSignals.filter((item) => item.trim().length >= 4).length < 1) missing.push("任务匹配信号");
  if (data.persona.evidenceRequirements.filter((item) => item.trim().length >= 3).length < 2) missing.push("证据要求");
  if (data.persona.humanReviewPoints.filter((item) => item.trim().length >= 3).length < 1) missing.push("人工复核点");
  if (data.searchQueries.filter((item) => item.trim().length >= 8).length < 2) missing.push("搜索方向");
  return { ok: missing.length === 0, missing };
}

export function normalizeProjectAnalysis(project: Project, data: AnalyzeProjectOutput): AnalyzeProjectOutput {
  const domain = project.domain?.trim() || data.domain || "未分类领域";
  const taskType = project.taskType?.trim() || data.taskType || "专家标注 / 复核";
  const storedRiskLevel = isProjectRiskLevel(project.riskLevel) ? project.riskLevel : data.riskLevel;
  const riskLevel: AnalyzeProjectOutput["riskLevel"] = isRegulatedProjectText(
    project.rawDemand,
    project.domain,
    domain,
    taskType,
  )
    ? "regulated"
    : storedRiskLevel;
  const existingSearchQueries = readJsonArray(project.searchQueriesJson);
  const generatedSearchQueries = data.searchQueries.length
    ? data.searchQueries
    : buildFallbackSearchQueries({
        rawDemand: project.rawDemand,
        domain,
        taskType,
      });
  const searchQueries = Array.from(new Set([...existingSearchQueries, ...generatedSearchQueries])).slice(0, 8);
  const existingLanguages = readJsonArray(project.languagesJson);
  const existingRegions = readJsonArray(project.regionsJson);

  return {
    ...data,
    title: project.title || data.title,
    domain,
    taskType,
    quantity: project.quantity ?? data.quantity,
    budgetMin: project.budgetMin ?? data.budgetMin,
    budgetMax: project.budgetMax ?? data.budgetMax,
    languages: existingLanguages.length ? existingLanguages : data.languages,
    regions: existingRegions.length ? existingRegions : data.regions,
    riskLevel,
    persona: {
      summary:
        data.persona.summary ||
        `为 ${domain} / ${taskType} 招募可人工复核的专家候选，优先保留公开证据和合规触达路径。`,
      mustHave: data.persona.mustHave.length ? data.persona.mustHave : [domain, taskType],
      niceToHave: data.persona.niceToHave,
      exclude: data.persona.exclude,
      taskFitSignals: data.persona.taskFitSignals,
      evidenceRequirements: data.persona.evidenceRequirements.length
        ? data.persona.evidenceRequirements
        : ["公开主页", "作品/论文/项目证据", "机构或职业背景证明"],
      humanReviewPoints: data.persona.humanReviewPoints.length
        ? data.persona.humanReviewPoints
        : ["证据真实性", "合规联系路径", "试标表现"],
    },
    searchQueries,
  };
}

function buildFallbackSearchQueries({
  rawDemand,
  domain,
  taskType,
}: {
  rawDemand: string;
  domain: string;
  taskType: string;
}) {
  const shortDemand = rawDemand
    .replace(/[，。；、]/g, " ")
    .split(/\s+/)
    .filter((part) => part.length >= 2)
    .slice(0, 8)
    .join(" ");
  return Array.from(
    new Set([
      `${domain} ${taskType} expert profile`,
      `${domain} ${taskType} 公开主页 专家`,
      `${shortDemand} 专家 公开资料`,
    ]),
  ).slice(0, 4);
}

function readJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function isProjectRiskLevel(value: string): value is AnalyzeProjectOutput["riskLevel"] {
  return value === "low" || value === "medium" || value === "high" || value === "regulated";
}
