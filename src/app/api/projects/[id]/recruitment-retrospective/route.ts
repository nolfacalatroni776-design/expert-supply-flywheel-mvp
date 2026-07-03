import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { createRecruitmentRetrospective } from "@/lib/supply-flywheel";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await createRecruitmentRetrospective(id);
    if (!result) return apiError("Project not found.", 404);
    return apiOk({ outcome: result });
  } catch (error) {
    return handleRouteError(error);
  }
}
