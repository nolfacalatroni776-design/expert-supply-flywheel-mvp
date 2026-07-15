import { createHook, getWorkflowMetadata, sleep } from "workflow";
import {
  buildAgentApprovalHookToken,
  buildAgentWorkflowHookToken,
  parseAgentApprovalDecision,
  type AgentApprovalDecision,
  type AgentWorkflowBoundary,
} from "@/lib/agent-workflow-contract";
import {
  advanceAgentTaskWorkflowStep,
  applyAgentApprovalDecisionStep,
  attachAgentTaskWorkflowStep,
} from "@/workflows/agent-task-steps";

export type DurableAgentTaskResult =
  | AgentWorkflowBoundary
  | { runId: string; status: "deduplicated"; ownerWorkflowRunId?: string };

export async function executeAgentTaskWorkflow(runId: string): Promise<DurableAgentTaskResult> {
  "use workflow";

  using ownership = createHook({ token: buildAgentWorkflowHookToken(runId) });
  const conflict = await ownership.getConflict();
  if (conflict) {
    return { runId, status: "deduplicated", ownerWorkflowRunId: conflict.runId };
  }

  const workflowRunId = getWorkflowMetadata().workflowRunId;
  if (!(await attachAgentTaskWorkflowStep(runId, workflowRunId))) {
    return { runId, status: "deduplicated" };
  }

  for (;;) {
    const boundary = await advanceAgentTaskWorkflowStep(runId);
    if (boundary.kind === "terminal") return boundary;
    if (boundary.kind === "ready" || boundary.kind === "busy") {
      await sleep("2s");
      continue;
    }

    using approval = createHook<AgentApprovalDecision>({
      token: buildAgentApprovalHookToken(runId, boundary.stepId),
      metadata: { runId, stepId: boundary.stepId },
    });
    const value = await approval;
    const decision = parseAgentApprovalDecision(value, boundary.stepId);
    const nextBoundary = await applyAgentApprovalDecisionStep(runId, boundary.stepId, decision);
    if (nextBoundary.kind === "terminal") return nextBoundary;
  }
}
