import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { parseJson, stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { normalizeProjectAnalysis } from "@/lib/project-analysis";
import { serializeCandidate, serializeProject } from "@/lib/serializers";
import { sourceProjectCandidates } from "@/lib/sourcing";
import { writeAuditEvent } from "@/lib/audit";
import { analyzeProjectDemand, scoreCandidateFit } from "@/lib/workflows";
import { requiresProjectReview } from "@/lib/gates";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    let project = await prisma.project.findUnique({ where: { id } });
    if (!project) return apiError("Project not found.", 404);

    await writeAuditEvent({
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "agent.run.started",
      payload: { mode: "full_sourcing" },
    });

    const analyze = await analyzeProjectDemand({
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

    if (!analyze.ok) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "agent.run.failed",
        payload: { step: "analyze_project_demand", error: analyze.error, status: analyze.status },
      });
      return apiError(analyze.error, analyze.error.includes("DASHSCOPE_API_KEY") ? 412 : 502);
    }

    const analyzedData = normalizeProjectAnalysis(project, analyze.data);
    project = await prisma.project.update({
      where: { id: project.id },
      data: {
        title: analyzedData.title || project.title,
        domain: analyzedData.domain,
        taskType: analyzedData.taskType,
        quantity: analyzedData.quantity,
        budgetMin: analyzedData.budgetMin,
        budgetMax: analyzedData.budgetMax,
        languagesJson: stringifyJson(analyzedData.languages),
        regionsJson: stringifyJson(analyzedData.regions),
        riskLevel: analyzedData.riskLevel,
        personaJson: stringifyJson(analyzedData.persona),
        searchQueriesJson: stringifyJson(analyzedData.searchQueries),
        status: "analyzed",
      },
    });

    await writeAuditEvent({
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "agent.step.completed",
      payload: {
        step: "analyze_project_demand",
        searchQueries: analyzedData.searchQueries.length,
        usage: analyze.usage,
      },
    });

    const queries = parseJson<string[]>(project.searchQueriesJson, []);
    const sourcing = await sourceProjectCandidates({ project, queries });
    if (!sourcing.ok) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "agent.run.failed",
        payload: { step: "source_candidates", error: sourcing.error, storedResults: sourcing.storedResults ?? 0 },
      });
      return apiError(sourcing.error, sourcing.status);
    }

    await writeAuditEvent({
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "agent.step.completed",
      payload: {
        step: "source_candidates",
        queries: sourcing.queries,
        searchResults: sourcing.searchResults.length,
        candidates: sourcing.candidates.length,
        providerStats: sourcing.providerStats,
        cacheHits: sourcing.cacheHits.length,
      },
    });

    const candidates = await prisma.projectCandidate.findMany({
      where: { projectId: project.id },
      include: { project: true, expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
      orderBy: { updatedAt: "desc" },
      take: 12,
    });

    let scored = 0;
    const scoreFailures: Array<{ candidateId: string; error: string }> = [];

    for (const candidate of candidates) {
      const result = await scoreCandidateFit({
        project: serializeProject(candidate.project),
        candidate: serializeCandidate(candidate),
      });

      if (!result.ok) {
        scoreFailures.push({ candidateId: candidate.id, error: result.error });
        await writeAuditEvent({
          projectId: candidate.projectId,
          entityType: "candidate",
          entityId: candidate.id,
          action: "ai.score.failed",
          payload: { error: result.error },
        });
        continue;
      }

      const humanReviewNeeded = candidate.humanReviewNeeded || result.data.humanReviewRequired || requiresProjectReview(project);
      await prisma.projectCandidate.update({
        where: { id: candidate.id },
        data: {
          fitScore: result.data.fitScore,
          scoringJson: stringifyJson({
            evidenceLevel: result.data.evidenceLevel,
            scoreBreakdown: result.data.scoreBreakdown,
            topReasons: result.data.topReasons,
          }),
          risksJson: stringifyJson(result.data.risks),
          missingJson: stringifyJson(result.data.missingEvidence),
          nextAction: result.data.nextAction,
          humanReviewNeeded,
        },
      });
      scored += 1;
    }

    await writeAuditEvent({
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "agent.step.completed",
      payload: {
        step: "score_candidate_fit",
        attempted: candidates.length,
        scored,
        failures: scoreFailures.length,
      },
    });

    await writeAuditEvent({
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "agent.run.completed",
      payload: {
        searchResults: sourcing.searchResults.length,
        sourcedCandidates: sourcing.candidates.length,
        providerStats: sourcing.providerStats,
        cacheHits: sourcing.cacheHits.length,
        scored,
        scoreFailures,
        nextSuggestions: [
          "复核低证据候选并补充来源",
          "对高分候选生成触达草稿",
          "为通过复核的候选创建试标任务",
        ],
      },
    });

    return apiOk({
      projectId: project.id,
      searchResults: sourcing.searchResults.length,
      sourcedCandidates: sourcing.candidates.length,
      providerStats: sourcing.providerStats,
      cacheHits: sourcing.cacheHits,
      scored,
      scoreFailures,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
