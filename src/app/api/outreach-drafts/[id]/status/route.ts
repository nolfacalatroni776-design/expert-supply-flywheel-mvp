import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { canApproveForOutreach } from "@/lib/gates";
import { prisma } from "@/lib/prisma";
import { canTransitionCandidateStage } from "@/lib/state-machines";
import { recordExpertQualityEvent } from "@/lib/supply-flywheel";
import { writeAuditEvent } from "@/lib/audit";
import { z } from "zod";

const statusSchema = z.object({
  status: z.enum(["draft", "sent"]),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const payload = statusSchema.parse(await request.json().catch(() => ({})));
    const draft = await prisma.outreachDraft.findUnique({
      where: { id },
      include: {
        candidate: {
          include: { expert: true, project: true },
        },
      },
    });
    if (!draft) return apiError("Outreach draft not found.", 404);

    if (payload.status === "sent") {
      const gate = canApproveForOutreach({
        candidate: draft.candidate,
        expert: draft.candidate.expert,
        project: draft.candidate.project,
      });
      if (!gate.ok) return apiError(gate.reason, 409);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedDraft = await tx.outreachDraft.update({
        where: { id },
        data: { status: payload.status },
      });

      if (payload.status === "sent") {
        const stage = nextContactedStage(draft.candidate.stage);
        await tx.projectCandidate.update({
          where: { id: draft.candidateId },
          data: { stage, nextAction: "等待回复或进入筛选。" },
        });
      }

      return updatedDraft;
    });

    await writeAuditEvent({
      projectId: draft.candidate.projectId,
      entityType: "outreach_draft",
      entityId: draft.id,
      action: "outreach.status.updated",
      payload: {
        from: draft.status,
        to: payload.status,
        candidateId: draft.candidateId,
      },
    });

    if (payload.status === "sent") {
      await recordExpertQualityEvent({
        expertId: draft.candidate.expertId,
        projectId: draft.candidate.projectId,
        candidateId: draft.candidateId,
        eventType: "contacted",
        channel: draft.channel,
      });
    }

    return apiOk({ outreachDraft: updated });
  } catch (error) {
    return handleRouteError(error);
  }
}

function nextContactedStage(stage: string) {
  if (stage === "contacted" || stage === "replied" || stage === "screening") return stage;
  if (canTransitionCandidateStage(stage, "contacted").ok) return "contacted";
  if (canTransitionCandidateStage(stage, "approved_for_outreach").ok) return "approved_for_outreach";
  return stage;
}
