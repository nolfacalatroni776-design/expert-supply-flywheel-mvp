import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeCandidateForOutreach, serializeProjectForGeneration } from "@/lib/serializers";
import { canApproveForOutreach } from "@/lib/gates";
import { writeAuditEvent } from "@/lib/audit";
import { draftOutreach } from "@/lib/workflows";
import { buildFallbackOutreachDraft } from "@/lib/fallback-drafts";
import { generateOutreachDraftWithRecovery } from "@/lib/outreach-generation";

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

    const gate = canApproveForOutreach({ candidate, expert: candidate.expert, project: candidate.project });
    if (!gate.ok) return apiError(gate.reason, 409);

    const projectBrief = serializeProjectForGeneration(candidate.project);
    const candidateBrief = serializeCandidateForOutreach(candidate);
    const generation = await generateOutreachDraftWithRecovery({
      generate: () => draftOutreach({ project: projectBrief, candidate: candidateBrief }),
      fallback: () => buildFallbackOutreachDraft({ project: projectBrief, candidate: candidateBrief }),
    });
    const outreachDraft = generation.draft;

    if (generation.fallback) {
      await writeAuditEvent({
        projectId: candidate.projectId,
        entityType: "candidate",
        entityId: candidate.id,
        action: "ai.outreach.fallback",
        payload: {
          errors: generation.failures,
          attempts: generation.attempts,
          fallback: "system_template",
        },
      });
    }

    const existingDraft = candidate.outreachDrafts.find((draft) => draft.status === "draft");
    const draftData = {
      channel: "email",
      subject: outreachDraft.subject,
      body: outreachDraft.body,
      replyTemplatesJson: stringifyJson(outreachDraft.replyTemplates),
      status: "draft",
    };
    const draft = existingDraft
      ? await prisma.outreachDraft.update({ where: { id: existingDraft.id }, data: draftData })
      : await prisma.outreachDraft.create({ data: { candidateId: candidate.id, ...draftData } });

    await writeAuditEvent({
      projectId: candidate.projectId,
      entityType: "candidate",
      entityId: candidate.id,
      action: "ai.outreach.completed",
      payload: {
        draftId: draft.id,
        usage: generation.usage,
        fallback: generation.fallback,
        attempts: generation.attempts,
        recovered: !generation.fallback && generation.attempts > 1,
        reusedDraft: Boolean(existingDraft),
      },
    });

    return apiOk({ outreachDraft: draft, fallback: generation.fallback, attempts: generation.attempts });
  } catch (error) {
    return handleRouteError(error);
  }
}
