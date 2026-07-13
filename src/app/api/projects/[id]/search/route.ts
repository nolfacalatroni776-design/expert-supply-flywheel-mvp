import { createAgentTaskRun } from "@/lib/agent-runtime";
import { apiError, apiOk, handleRouteError } from "@/lib/http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { queries?: string[] };
    const suppliedQueries = body.queries?.filter(Boolean).slice(0, 4) ?? [];
    const run = await createAgentTaskRun({
      projectId: id,
      intent: "search_candidates",
      instruction: suppliedQueries.length
        ? `按已确认的搜索方向发现候选：${suppliedQueries.join("；")}。调用外部搜索服务前等待确认。`
        : "按项目搜索式发现候选，并在调用外部搜索服务前等待确认。",
    });
    if (!run) return apiError("Project not found.", 404);
    return apiOk({ run }, 202);
  } catch (error) {
    return handleRouteError(error);
  }
}
