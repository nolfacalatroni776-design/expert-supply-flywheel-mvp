import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { runInternalMatch } from "@/lib/supply-flywheel";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await runInternalMatch(id);
    if (!result) return apiError("Project not found.", 404);
    return apiOk({ runId: result.runId, candidates: result.candidates.length });
  } catch (error) {
    return handleRouteError(error);
  }
}
