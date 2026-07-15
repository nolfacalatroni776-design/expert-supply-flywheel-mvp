import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { canTransitionCandidateStage } from "@/lib/state-machines";
import { recordExpertQualityEvent } from "@/lib/supply-flywheel";
import { validateTrialStartApproval } from "@/lib/trial-readiness";
import { writeAuditEvent } from "@/lib/audit";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const candidate = await prisma.projectCandidate.findUnique({
      where: { id },
      include: { trialTasks: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!candidate) return apiError("Candidate not found.", 404);
    if (!candidate.trialTasks[0]) return apiError("请先生成试标方案。", 409);
    if (candidate.stage === "trial") {
      return apiOk({ candidate, trialTask: candidate.trialTasks[0], alreadyStarted: true });
    }

    const transition = canTransitionCandidateStage(candidate.stage, "trial");
    if (!transition.ok) return apiError(transition.reason, 409);
    const approval = {
      samplesDeidentified: body.samplesDeidentified === true,
      guidanceAttached: body.guidanceAttached === true,
      goldAnswersValidated: body.goldAnswersValidated === true,
      approvalNote: typeof body.approvalNote === "string" ? body.approvalNote.trim() : "",
    };
    const validation = validateTrialStartApproval(approval);
    if (!validation.ok) return apiError(validation.reason, 422);

    const updatedCandidate = await prisma.projectCandidate.update({
      where: { id: candidate.id },
      data: {
        stage: "trial",
        humanReviewNeeded: true,
        nextAction: "试标已开始，等待提交结果和人工评分。",
      },
    });
    await recordExpertQualityEvent({
      expertId: candidate.expertId,
      projectId: candidate.projectId,
      candidateId: candidate.id,
      eventType: "trial_started",
      channel: "trial",
      notes: approval.approvalNote,
    });
    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "trial.started",
      payload: {
        from: candidate.stage,
        to: "trial",
        materialsConfirmed: true,
        approvalNote: approval.approvalNote,
      },
    });

    return apiOk({ candidate: updatedCandidate, trialTask: candidate.trialTasks[0], alreadyStarted: false });
  } catch (error) {
    return handleRouteError(error);
  }
}
