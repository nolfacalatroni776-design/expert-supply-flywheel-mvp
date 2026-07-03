import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeCandidate, serializeProject } from "@/lib/serializers";
import { writeAuditEvent } from "@/lib/audit";
import { designTrialTask } from "@/lib/workflows";
import { canTransitionCandidateStage } from "@/lib/state-machines";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const candidate = await prisma.projectCandidate.findUnique({
      where: { id },
      include: { project: true, expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
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
      project: serializeProject(candidate.project),
      candidate: serializeCandidate(candidate),
    });

    if (!result.ok) {
      await writeAuditEvent({
        projectId: candidate.projectId,
        entityType: "candidate",
        entityId: candidate.id,
        action: "ai.trial.failed",
        payload: { error: result.error },
      });
      return apiError(result.error, result.error.includes("DASHSCOPE_API_KEY") ? 412 : 502);
    }

    const [trial, updatedCandidate] = await prisma.$transaction([
      prisma.trialTask.create({
        data: {
          candidateId: candidate.id,
          instructions: result.data.instructions,
          rubricJson: stringifyJson(result.data.rubric),
        },
      }),
      prisma.projectCandidate.update({
        where: { id: candidate.id },
        data: { stage: "trial", humanReviewNeeded: true },
      }),
    ]);

    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "candidate.stage.updated",
      payload: { from: candidate.stage, to: "trial", reason: "trial_task_created" },
    });

    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "ai.trial.completed",
      payload: { trialId: trial.id, usage: result.usage },
    });

    return apiOk({ trialTask: trial, candidate: updatedCandidate });
  } catch (error) {
    return handleRouteError(error);
  }
}
