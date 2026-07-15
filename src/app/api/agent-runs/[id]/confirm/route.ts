import { resumeAgentTaskWorkflow } from "@/lib/agent-workflow-runtime";
import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { z } from "zod";

const confirmationSchema = z.object({
  stepId: z.string().trim().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = confirmationSchema.parse(await request.json().catch(() => ({})));
    const run = await resumeAgentTaskWorkflow(id, { action: "approve", ...body });
    if (!run) return apiError("任务不存在或已被删除。", 404);
    return apiOk({ run }, 202);
  } catch (error) {
    return handleRouteError(error);
  }
}
