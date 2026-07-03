import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeCandidate } from "@/lib/serializers";
import { canTransitionCandidateStage } from "@/lib/state-machines";
import { writeAuditEvent } from "@/lib/audit";
import { z } from "zod";

const reviewSchema = z.object({
  decision: z.enum(["approved", "needs_more_evidence"]),
  note: z.string().trim().max(1000).optional().default(""),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const payload = reviewSchema.parse(await request.json().catch(() => ({})));
    const candidate = await prisma.projectCandidate.findUnique({
      where: { id },
      include: { expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
    });
    if (!candidate) return apiError("Candidate not found.", 404);

    if (candidate.stage === "do_not_contact") {
      return apiError("Candidate is marked do not contact.", 409);
    }

    const nextStage = nextReviewedStage(candidate.stage);
    const updated = await prisma.projectCandidate.update({
      where: { id },
      data:
        payload.decision === "approved"
          ? {
              humanReviewNeeded: false,
              stage: nextStage,
              nextAction: "联系路径确认后生成触达草稿。",
            }
          : {
              humanReviewNeeded: true,
              missingJson: stringifyJson(appendMissingEvidence(candidate.missingJson, payload.note)),
              nextAction: payload.note ? `补证据：${payload.note}` : "补充证据后再次复核。",
            },
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

function nextReviewedStage(stage: string) {
  if (stage === "verified" || stage === "approved_for_outreach" || stage === "contacted") return stage;
  if (canTransitionCandidateStage(stage, "verified").ok) return "verified";
  return stage;
}

function appendMissingEvidence(existingJson: string, note: string) {
  const existing = safeStringArray(existingJson);
  if (!note) return existing;
  return Array.from(new Set([...existing, note]));
}

function safeStringArray(json: string) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}
