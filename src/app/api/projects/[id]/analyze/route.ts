import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { normalizeProjectAnalysis } from "@/lib/project-analysis";
import { serializeProject } from "@/lib/serializers";
import { writeAuditEvent } from "@/lib/audit";
import { analyzeProjectDemand } from "@/lib/workflows";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return apiError("Project not found.", 404);

    const result = await analyzeProjectDemand({
      rawDemand: project.rawDemand,
      existingFields: {
        title: project.title,
        domain: project.domain,
        taskType: project.taskType,
        quantity: project.quantity,
        budgetMin: project.budgetMin,
        budgetMax: project.budgetMax,
      },
    });

    if (!result.ok) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "ai.analyze.failed",
        payload: { error: result.error, status: result.status },
      });
      return apiError(result.error, result.error.includes("DASHSCOPE_API_KEY") ? 412 : 502);
    }

    const data = normalizeProjectAnalysis(project, result.data);
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: {
        title: data.title || project.title,
        domain: data.domain,
        taskType: data.taskType,
        quantity: data.quantity,
        budgetMin: data.budgetMin,
        budgetMax: data.budgetMax,
        languagesJson: stringifyJson(data.languages),
        regionsJson: stringifyJson(data.regions),
        riskLevel: data.riskLevel,
        personaJson: stringifyJson(data.persona),
        searchQueriesJson: stringifyJson(data.searchQueries),
        status: "analyzed",
      },
    });

    await writeAuditEvent({
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "ai.analyze.completed",
      payload: { usage: result.usage, searchQueries: data.searchQueries.length },
    });

    return apiOk({ project: serializeProject(updated) });
  } catch (error) {
    return handleRouteError(error);
  }
}
