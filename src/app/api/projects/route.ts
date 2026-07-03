import { apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeCandidate, serializeProject } from "@/lib/serializers";
import { createProjectSchema } from "@/lib/schemas";
import { writeAuditEvent } from "@/lib/audit";

export async function GET() {
  const projects = await prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      candidates: {
        include: { expert: true },
        orderBy: { updatedAt: "desc" },
      },
    },
  });

  return apiOk({
    projects: projects.map((project) => ({
      ...serializeProject(project),
      candidates: project.candidates.map((candidate) => serializeCandidate(candidate)),
    })),
  });
}

export async function POST(request: Request) {
  try {
    const payload = createProjectSchema.parse(await request.json());
    const project = await prisma.project.create({
      data: {
        title: payload.title,
        rawDemand: payload.rawDemand,
        domain: payload.domain,
        taskType: payload.taskType,
        quantity: payload.quantity,
        budgetMin: payload.budgetMin,
        budgetMax: payload.budgetMax,
        languagesJson: stringifyJson(payload.languages),
        regionsJson: stringifyJson(payload.regions),
      },
    });

    await writeAuditEvent({
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "project.created",
      payload: { title: project.title },
    });

    return apiOk({ project: serializeProject(project) }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
