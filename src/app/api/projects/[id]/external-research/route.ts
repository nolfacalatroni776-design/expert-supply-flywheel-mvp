import { createAgentTaskRun, startAgentTaskRun } from "@/lib/agent-runtime";
import { apiError, apiOk, handleRouteError } from "@/lib/http";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const created = await createAgentTaskRun({
      projectId: id,
      intent: "external_research",
      instruction: "补充公开候选，并在调用外部搜索服务前等待确认。",
    });
    if (!created) return apiError("Project not found.", 404);
    const run = await startAgentTaskRun(created.id);
    if (!run) return apiError("任务不存在或已被删除。", 404);
    return apiOk({ run }, 202);
  } catch (error) {
    return handleRouteError(error);
  }
}
