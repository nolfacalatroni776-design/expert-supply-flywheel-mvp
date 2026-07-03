import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeCandidate, serializeProject } from "@/lib/serializers";
import { writeAuditEvent } from "@/lib/audit";
import { scoreCandidateFit } from "@/lib/workflows";
import { requiresProjectReview } from "@/lib/gates";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const candidate = await prisma.projectCandidate.findUnique({
      where: { id },
      include: { project: true, expert: true, evidenceItems: true },
    });
    if (!candidate) return apiError("Candidate not found.", 404);

    const result = await scoreCandidateFit({
      project: serializeProject(candidate.project),
      candidate: serializeCandidate(candidate),
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

    const humanReviewNeeded = candidate.humanReviewNeeded || result.data.humanReviewRequired || requiresProjectReview(candidate.project);
    const updated = await prisma.projectCandidate.update({
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
      include: { expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
    });

    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "ai.score.completed",
      payload: {
        fitScore: result.data.fitScore,
        usage: result.usage,
        humanReviewSuggested: result.data.humanReviewRequired,
        projectReviewRequired: requiresProjectReview(candidate.project),
      },
    });

    return apiOk({ candidate: serializeCandidate(updated) });
  } catch (error) {
    return handleRouteError(error);
  }
}
