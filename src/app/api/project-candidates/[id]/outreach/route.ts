import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeCandidate, serializeProject } from "@/lib/serializers";
import { canApproveForOutreach } from "@/lib/gates";
import { writeAuditEvent } from "@/lib/audit";
import { draftOutreach } from "@/lib/workflows";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const candidate = await prisma.projectCandidate.findUnique({
      where: { id },
      include: { project: true, expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
    });
    if (!candidate) return apiError("Candidate not found.", 404);

    const gate = canApproveForOutreach({ candidate, expert: candidate.expert, project: candidate.project });
    if (!gate.ok) return apiError(gate.reason, 409);

    const result = await draftOutreach({
      project: serializeProject(candidate.project),
      candidate: serializeCandidate(candidate),
    });

    if (!result.ok) {
      await writeAuditEvent({
        projectId: candidate.projectId,
        entityType: "candidate",
        entityId: candidate.id,
        action: "ai.outreach.failed",
        payload: { error: result.error },
      });
      return apiError(result.error, result.error.includes("DASHSCOPE_API_KEY") ? 412 : 502);
    }

    const draft = await prisma.outreachDraft.create({
      data: {
        candidateId: candidate.id,
        channel: "email",
        subject: result.data.subject,
        body: result.data.body,
        replyTemplatesJson: stringifyJson(result.data.replyTemplates),
        status: "draft",
      },
    });

    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "ai.outreach.completed",
      payload: { draftId: draft.id, usage: result.usage },
    });

    return apiOk({ outreachDraft: draft });
  } catch (error) {
    return handleRouteError(error);
  }
}
