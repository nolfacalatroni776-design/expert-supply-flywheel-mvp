import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { buildCandidateReviewUpdate } from "@/lib/candidate-review";
import { prisma } from "@/lib/prisma";
import { serializeCandidate } from "@/lib/serializers";
import { writeAuditEvent } from "@/lib/audit";
import { z } from "zod";

const reviewSchema = z
  .object({
    decision: z.enum(["approved", "needs_more_evidence", "rejected"]),
    note: z.string().trim().max(1000).optional().default(""),
  })
  .superRefine((payload, context) => {
    if (payload.decision === "rejected" && payload.note.length < 3) {
      context.addIssue({ code: "custom", path: ["note"], message: "请填写本项目暂不推进的原因。" });
    }
    if (payload.decision === "needs_more_evidence" && payload.note.length < 3) {
      context.addIssue({ code: "custom", path: ["note"], message: "请说明需要补充哪些证据。" });
    }
  });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = reviewSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return apiError(parsed.error.issues[0]?.message ?? "请选择有效的复核结论。", 422);
    }
    const payload = parsed.data;
    const candidate = await prisma.projectCandidate.findUnique({
      where: { id },
      include: { expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
    });
    if (!candidate) return apiError("未找到该候选。", 404);

    if (candidate.stage === "do_not_contact") {
      return apiError("该候选已标记为不再联系，不能修改复核结论。", 409);
    }

    const update = buildCandidateReviewUpdate({
      decision: payload.decision,
      note: payload.note,
      currentStage: candidate.stage,
      missingJson: candidate.missingJson,
    });
    const updated = await prisma.projectCandidate.update({
      where: { id },
      data: update,
      include: { expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
    });

    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "candidate.review.updated",
      payload: {
        decision: payload.decision,
        fromStage: candidate.stage,
        toStage: updated.stage,
        note: payload.note,
      },
    });

    return apiOk({ candidate: serializeCandidate(updated) });
  } catch (error) {
    return handleRouteError(error);
  }
}
