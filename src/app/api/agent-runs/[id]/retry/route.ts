import { prepareAgentTaskRunRetry } from "@/lib/agent-runtime";
import {
  cancelDurableAgentTaskWorkflow,
  startDurableAgentTaskWorkflow,
} from "@/lib/agent-workflow-runtime";
import { apiError, apiOk, handleRouteError } from "@/lib/http";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await cancelDurableAgentTaskWorkflow(id);
    const prepared = await prepareAgentTaskRunRetry(id);
    if (!prepared) return apiError("任务不存在或已被删除。", 404);
    const run = ["succeeded", "cancelled"].includes(prepared.status)
      ? prepared
      : await startDurableAgentTaskWorkflow(id);
    if (!run) return apiError("任务不存在或已被删除。", 404);
    return apiOk({ run }, 202);
  } catch (error) {
    return handleRouteError(error);
  }
}
