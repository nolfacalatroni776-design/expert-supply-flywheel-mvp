import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeCandidate, serializeCandidateForScoring, serializeProjectForGeneration } from "@/lib/serializers";
import { writeAuditEvent } from "@/lib/audit";
import { scoreCandidateFit } from "@/lib/workflows";
import { requiresProjectReview } from "@/lib/gates";
import { normalizeCandidateScore } from "@/lib/candidate-scoring";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const candidate = await prisma.projectCandidate.findUnique({
      where: { id },
      include: { project: true, expert: { include: { signals: true, qualityMetrics: true, evidenceItems: true } }, evidenceItems: true },
    });
    if (!candidate) return apiError("未找到该候选。", 404);
    if (candidate.stage === "screened_out") {
      return apiError("该候选在当前项目中暂不推进。如有新证据，请先重新通过人工复核。", 409);
    }

    const result = await scoreCandidateFit({
      project: serializeProjectForGeneration(candidate.project),
      candidate: serializeCandidateForScoring(candidate),
    });

    if (!result.ok) {
      await writeAuditEvent({
        projectId: candidate.projectId,
        entityType: "candidate",
        entityId: candidate.id,
        action: "ai.score.failed",
        payload: { error: result.error },
      });
      return apiError(result.error, result.error.includes("DASHSCOPE_API_KEY") ? 412 : 502);
    }

    const projectReviewRequired = requiresProjectReview(candidate.project);
    const humanReviewNeeded = candidate.humanReviewNeeded || result.data.humanReviewRequired || projectReviewRequired;
    const score = normalizeCandidateScore({
      project: serializeProjectForGeneration(candidate.project),
      candidate: {
        languages: serializeCandidate(candidate).expert?.languages ?? [],
        evidenceLevel: candidate.expert.evidenceLevel,
        evidenceItemCount: candidate.evidenceItems.length,
        stage: candidate.stage,
        humanReviewNeeded,
      },
      score: result.data,
    });
    const updated = await prisma.projectCandidate.update({
      where: { id: candidate.id },
      data: {
        fitScore: score.fitScore,
        scoringJson: stringifyJson({
          evidenceLevel: score.evidenceLevel,
          scoreBreakdown: score.scoreBreakdown,
          topReasons: score.topReasons,
        }),
        risksJson: stringifyJson(score.risks),
        missingJson: stringifyJson(score.missingEvidence),
        nextAction: score.nextAction,
        humanReviewNeeded,
      },
      include: {
        expert: { include: { signals: true, qualityMetrics: true, evidenceItems: true } },
        evidenceItems: true,
        outreachDrafts: true,
        trialTasks: true,
      },
    });

    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "ai.score.completed",
      payload: {
        fitScore: score.fitScore,
        usage: result.usage,
        humanReviewSuggested: score.humanReviewRequired,
        projectReviewRequired,
      },
    });

    return apiOk({ candidate: serializeCandidate(updated) });
  } catch (error) {
    return handleRouteError(error);
  }
}
