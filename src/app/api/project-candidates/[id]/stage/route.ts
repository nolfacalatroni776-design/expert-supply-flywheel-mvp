import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { canApproveForOutreach } from "@/lib/gates";
import { prisma } from "@/lib/prisma";
import { pipelineStageSchema } from "@/lib/schemas";
import { serializeCandidate } from "@/lib/serializers";
import { writeAuditEvent } from "@/lib/audit";
import { canTransitionCandidateStage } from "@/lib/state-machines";
import { recordExpertQualityEvent } from "@/lib/supply-flywheel";
import { z } from "zod";
import { validateOnboardingApproval } from "@/lib/trial-approval";

const stageUpdateSchema = z.object({
  stage: pipelineStageSchema,
  scope: z.enum(["project", "global"]).optional().default("project"),
  reason: z.string().trim().max(1000).optional().default(""),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = stageUpdateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError("Invalid pipeline stage.", 422, parsed.error.flatten());

    const candidate = await prisma.projectCandidate.findUnique({
      where: { id },
      include: { expert: true, project: true, trialTasks: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!candidate) return apiError("Candidate not found.", 404);

    const transition = canTransitionCandidateStage(candidate.stage, parsed.data.stage);
    if (!transition.ok) {
      await writeAuditEvent({
        projectId: candidate.projectId,
        entityType: "candidate",
        entityId: candidate.id,
        action: "candidate.stage.rejected",
        payload: { from: candidate.stage, to: parsed.data.stage, reason: transition.reason },
      });
      return apiError(transition.reason, 409);
    }

    if (parsed.data.stage === "approved_for_outreach") {
      const gate = canApproveForOutreach({ candidate, expert: candidate.expert, project: candidate.project });
      if (!gate.ok) return apiError(gate.reason, 409);
    }

    if (parsed.data.stage === "onboarded") {
      const approval = validateOnboardingApproval({
        latestTrialOutcome: candidate.trialTasks[0]?.outcome,
        reason: parsed.data.reason,
      });
      if (!approval.ok) {
        await writeAuditEvent({
          projectId: candidate.projectId,
          entityType: "candidate",
          entityId: candidate.id,
          action: "candidate.stage.rejected",
          payload: { from: candidate.stage, to: parsed.data.stage, reason: approval.reason },
        });
        return apiError(approval.reason, 409);
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (parsed.data.stage === "do_not_contact" && parsed.data.scope === "global") {
        await tx.expert.update({
          where: { id: candidate.expertId },
          data: { consentState: "do_not_contact" },
        });
      }

      return tx.projectCandidate.update({
        where: { id },
        data: {
          stage: parsed.data.stage,
          nextAction: parsed.data.reason || candidate.nextAction,
          humanReviewNeeded: parsed.data.stage === "onboarded" ? false : candidate.humanReviewNeeded,
        },
        include: { expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
      });
    });

    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "candidate.stage.updated",
      payload: {
        from: candidate.stage,
        to: parsed.data.stage,
        scope: parsed.data.stage === "do_not_contact" ? parsed.data.scope : undefined,
        reason: parsed.data.reason,
        expertConsentState:
          parsed.data.stage === "do_not_contact" && parsed.data.scope === "global"
            ? "do_not_contact"
            : candidate.expert.consentState,
      },
    });

    await recordExpertQualityEvent({
      expertId: candidate.expertId,
      projectId: candidate.projectId,
      candidateId: candidate.id,
      eventType: eventTypeForStage(parsed.data.stage),
      channel: "pipeline",
      notes: parsed.data.reason,
    });

    return apiOk({ candidate: serializeCandidate(updated) });
  } catch (error) {
    return handleRouteError(error);
  }
}

function eventTypeForStage(stage: string) {
  if (stage === "contacted") return "contacted";
  if (stage === "replied") return "replied";
  if (stage === "trial") return "trial_started";
  if (stage === "onboarded" || stage === "active") return "onboarded";
  if (stage === "do_not_contact") return "unsubscribed";
  return "activated";
}
