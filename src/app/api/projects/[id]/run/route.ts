import { createAgentTaskRun } from "@/lib/agent-runtime";
import { apiError, apiOk, handleRouteError } from "@/lib/http";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const run = await createAgentTaskRun({
      projectId: id,
      intent: "full_sourcing",
      instruction: "完整发现候选，并在调用外部搜索服务前等待确认。",
    });
    if (!run) return apiError("Project not found.", 404);
    return apiOk({ run }, 202);
  } catch (error) {
    return handleRouteError(error);
  }
}
