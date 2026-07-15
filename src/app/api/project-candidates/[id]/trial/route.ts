import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeCandidateForGeneration, serializeProjectForGeneration } from "@/lib/serializers";
import { writeAuditEvent } from "@/lib/audit";
import { designTrialTask } from "@/lib/workflows";
import { canTransitionCandidateStage } from "@/lib/state-machines";
import { buildFallbackTrialTask } from "@/lib/fallback-drafts";
import { buildTrialPreparationStatus } from "@/lib/trial-readiness";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const candidate = await prisma.projectCandidate.findUnique({
      where: { id },
      include: {
        project: true,
        expert: { include: { signals: true, qualityMetrics: true, evidenceItems: true } },
        evidenceItems: true,
        outreachDrafts: true,
        trialTasks: true,
      },
    });
    if (!candidate) return apiError("Candidate not found.", 404);

    const transition = canTransitionCandidateStage(candidate.stage, "trial");
    if (!transition.ok) {
      await writeAuditEvent({
        projectId: candidate.projectId,
        entityType: "candidate",
        entityId: candidate.id,
        action: "trial.stage.rejected",
        payload: { from: candidate.stage, to: "trial", reason: transition.reason },
      });
      return apiError(transition.reason, 409);
    }

    const result = await designTrialTask({
      project: serializeProjectForGeneration(candidate.project),
      candidate: serializeCandidateForGeneration(candidate),
    });

    const trialDraft = result.ok
      ? result.data
      : buildFallbackTrialTask({
          project: serializeProjectForGeneration(candidate.project),
          candidate: serializeCandidateForGeneration(candidate),
        });

    if (!result.ok) {
      await writeAuditEvent({
        projectId: candidate.projectId,
        entityType: "candidate",
        entityId: candidate.id,
        action: "ai.trial.fallback",
        payload: { error: result.error, fallback: "system_template" },
      });
    }

    const existingTrial = candidate.trialTasks.find((trial) => trial.score === null && trial.outcome === null);
    const readiness = buildTrialPreparationStatus();
    const trialData = {
      instructions: trialDraft.instructions,
      rubricJson: stringifyJson({ ...trialDraft.rubric, preparation: readiness }),
    };
    const [trial, updatedCandidate] = await prisma.$transaction([
      existingTrial
        ? prisma.trialTask.update({ where: { id: existingTrial.id }, data: trialData })
        : prisma.trialTask.create({ data: { candidateId: candidate.id, ...trialData } }),
      prisma.projectCandidate.update({
        where: { id: candidate.id },
        data: { humanReviewNeeded: true, nextAction: readiness.nextAction },
      }),
    ]);

    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "trial.draft.created",
      payload: { stage: candidate.stage, trialId: trial.id, readiness },
    });

    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "ai.trial.completed",
      payload: {
        trialId: trial.id,
        usage: result.ok ? result.usage : null,
        fallback: !result.ok,
        usedDefaultRubric: result.ok ? result.data.usedDefaultRubric : true,
        reusedTrial: Boolean(existingTrial),
      },
    });

    return apiOk({
      trialTask: trial,
      candidate: updatedCandidate,
      fallback: !result.ok,
      usedDefaultRubric: result.ok ? result.data.usedDefaultRubric : true,
      readiness,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
