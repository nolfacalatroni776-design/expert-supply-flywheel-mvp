import type { Project } from "@prisma/client";
import type { AnalyzeProjectOutput } from "@/lib/schemas";

export function normalizeProjectAnalysis(project: Project, data: AnalyzeProjectOutput): AnalyzeProjectOutput {
  const domain = data.domain || project.domain || "未分类领域";
  const taskType = data.taskType || project.taskType || "专家标注 / 复核";
  const searchQueries = data.searchQueries.length
    ? data.searchQueries
    : buildFallbackSearchQueries({
        rawDemand: project.rawDemand,
        domain,
        taskType,
      });

  return {
    ...data,
    title: data.title || project.title,
    domain,
    taskType,
    quantity: data.quantity ?? project.quantity,
    budgetMin: data.budgetMin ?? project.budgetMin,
    budgetMax: data.budgetMax ?? project.budgetMax,
    languages: data.languages.length ? data.languages : readJsonArray(project.languagesJson),
    regions: data.regions.length ? data.regions : readJsonArray(project.regionsJson),
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
