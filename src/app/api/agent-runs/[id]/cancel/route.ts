import { cancelAgentTaskRun } from "@/lib/agent-runtime";
import { apiError, apiOk, handleRouteError } from "@/lib/http";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const run = await cancelAgentTaskRun(id);
    if (!run) return apiError("任务不存在或已被删除。", 404);
    return apiOk({ run });
  } catch (error) {
    return handleRouteError(error);
  }
}
