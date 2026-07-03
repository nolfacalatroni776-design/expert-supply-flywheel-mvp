import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { resolveExpertMergeCandidate } from "@/lib/supply-flywheel";
import { z } from "zod";

const resolveSchema = z.object({
  status: z.enum(["confirmed", "rejected"]),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const payload = resolveSchema.parse(await request.json().catch(() => ({})));
    const result = await resolveExpertMergeCandidate({ mergeId: id, status: payload.status });
    if (!result) return apiError("Merge suggestion not found.", 404);
    return apiOk({ mergeCandidate: result });
  } catch (error) {
    return handleRouteError(error);
  }
}
