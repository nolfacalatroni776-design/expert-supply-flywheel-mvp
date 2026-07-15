import { FatalError } from "workflow";
import {
  attachAgentTaskWorkflowRun,
  confirmAgentTaskRun,
  rejectAgentTaskRunConfirmation,
  startAgentTaskRun,
} from "@/lib/agent-runtime";
import {
  getAgentWorkflowBoundary,
  parseAgentApprovalDecision,
  type AgentApprovalDecision,
} from "@/lib/agent-workflow-contract";

export async function attachAgentTaskWorkflowStep(runId: string, workflowRunId: string) {
  "use step";

  return attachAgentTaskWorkflowRun(runId, workflowRunId);
}

export async function advanceAgentTaskWorkflowStep(runId: string) {
  "use step";

  const run = await startAgentTaskRun(runId);
  if (!run) throw new FatalError("任务不存在或已被删除。");
  return getAgentWorkflowBoundary(run);
}

export async function applyAgentApprovalDecisionStep(
  runId: string,
  expectedStepId: string,
  value: AgentApprovalDecision,
) {
  "use step";

  const decision = parseAgentApprovalDecision(value, expectedStepId);
  const run =
    decision.action === "approve"
      ? await confirmAgentTaskRun(runId, {
          resume: false,
          stepId: decision.stepId,
          reason: decision.reason,
        })
      : await rejectAgentTaskRunConfirmation(runId, {
          stepId: decision.stepId,
          reason: decision.reason ?? "未批准当前步骤。",
        });
  if (!run) throw new FatalError("任务不存在或已被删除。");
  return getAgentWorkflowBoundary(run);
}
