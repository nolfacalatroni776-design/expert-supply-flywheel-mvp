import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { trialResultSchema } from "@/lib/schemas";
import { recordExpertQualityEvent } from "@/lib/supply-flywheel";
import { writeAuditEvent } from "@/lib/audit";
import { getTrialResultCandidateUpdate } from "@/lib/trial-approval";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const payload = trialResultSchema.parse(await request.json());
    const candidate = await prisma.projectCandidate.findUnique({
      where: { id },
      include: { trialTasks: { orderBy: { createdAt: "desc" }, take: 1 }, expert: true },
    });
    if (!candidate) return apiError("Candidate not found.", 404);
    if (candidate.stage !== "trial") {
      await writeAuditEvent({
        projectId: candidate.projectId,
        entityType: "candidate",
        entityId: candidate.id,
        action: "trial.result.rejected",
        payload: { stage: candidate.stage, outcome: payload.outcome, reason: "candidate_not_in_trial_stage" },
      });
      return apiError("Trial results can only be recorded for candidates in trial stage.", 409);
    }
    const latestTrial = candidate.trialTasks[0];
    if (!latestTrial) return apiError("No trial task exists for this candidate.", 409);

    const candidateUpdate = getTrialResultCandidateUpdate(payload.outcome);
    const [trial, updatedCandidate] = await prisma.$transaction([
      prisma.trialTask.update({
        where: { id: latestTrial.id },
        data: { score: payload.score, outcome: payload.outcome, notes: payload.notes },
      }),
      prisma.projectCandidate.update({
        where: { id: candidate.id },
        data: candidateUpdate,
      }),
    ]);

    await writeAuditEvent({
      projectId: updatedCandidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "trial.result.recorded",
      payload,
    });

    await recordExpertQualityEvent({
      expertId: candidate.expertId,
      projectId: updatedCandidate.projectId,
      candidateId: candidate.id,
      eventType: payload.outcome === "passed" ? "trial_passed" : payload.outcome === "failed" ? "trial_failed" : "trial_started",
      channel: "trial",
      score: payload.score,
      notes: payload.notes,
    });

    return apiOk({ trialTask: trial, candidate: updatedCandidate });
  } catch (error) {
    return handleRouteError(error);
  }
}
