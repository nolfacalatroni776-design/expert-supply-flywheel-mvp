import { createAgentTaskRun, normalizeAgentIntent } from "@/lib/agent-runtime";
import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { z } from "zod";

const commandSchema = z.object({
  intent: z.string(),
  instruction: z.string().trim().min(8).max(1200),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = commandSchema.parse(await request.json().catch(() => ({})));
    const intent = normalizeAgentIntent(body.intent);
    if (!intent) return apiError("任务类型不可识别，请重新选择。", 422);

    const run = await createAgentTaskRun({
      projectId: id,
      intent,
      instruction: body.instruction,
    });
    if (!run) return apiError("项目不存在或已被删除。", 404);

    return apiOk({ run }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
