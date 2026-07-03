import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { runExternalResearch } from "@/lib/supply-flywheel";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await runExternalResearch(id);
    if (!result) return apiError("Project not found.", 404);
    if (!result.ok) return apiError(result.error, result.status);
    return apiOk({
      runId: result.runId,
      searchResults: result.searchResults.length,
      candidates: result.candidates.length,
      providerStats: result.providerStats,
      cacheHits: result.cacheHits,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
