import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { parseJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeSearchResult } from "@/lib/serializers";
import { writeAuditEvent } from "@/lib/audit";
import { sourceProjectCandidates } from "@/lib/sourcing";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { queries?: string[] };
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return apiError("Project not found.", 404);

    const projectQueries = parseJson<string[]>(project.searchQueriesJson, []);
    const queries = (body.queries?.length ? body.queries : projectQueries).slice(0, 4);
    if (!queries.length) {
      return apiError("No search queries found. Run project analysis first or provide queries.", 422);
    }

    const sourcing = await sourceProjectCandidates({ project, queries });
    if (!sourcing.ok) return apiError(sourcing.error, sourcing.status);

    await writeAuditEvent({
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "search.completed",
      payload: {
        queries: sourcing.queries,
        searchResults: sourcing.searchResults.length,
        candidates: sourcing.candidates.length,
        providerStats: sourcing.providerStats,
        cacheHits: sourcing.cacheHits.length,
      },
    });

    return apiOk({
      searchResults: sourcing.searchResults.map(serializeSearchResult),
      candidates: sourcing.candidates,
      providerStats: sourcing.providerStats,
      cacheHits: sourcing.cacheHits,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
