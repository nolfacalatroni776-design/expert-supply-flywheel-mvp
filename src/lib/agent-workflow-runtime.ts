import { getRun, resumeHook, start } from "workflow/api";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";
import {
  getAgentTaskRun,
  getAgentTaskWorkflowRunId,
  releaseAgentTaskWorkflowRun,
} from "@/lib/agent-runtime";
import {
  buildAgentApprovalHookToken,
  parseAgentApprovalDecision,
  type AgentApprovalDecision,
} from "@/lib/agent-workflow-contract";
import { executeAgentTaskWorkflow } from "@/workflows/agent-task";

const activeWorkflowStatuses = new Set(["pending", "running"]);

export async function startDurableAgentTaskWorkflow(runId: string) {
  const run = await getAgentTaskRun(runId);
  if (!run) return null;

  const existingWorkflowRunId = await getAgentTaskWorkflowRunId(runId);
  if (existingWorkflowRunId) {
    try {
      const status = await getRun(existingWorkflowRunId).status;
      if (activeWorkflowStatuses.has(status) || isTerminalAgentStatus(run.status)) {
        return run;
      }
      await releaseAgentTaskWorkflowRun(runId, existingWorkflowRunId);
    } catch (error) {
      if (!WorkflowRunNotFoundError.is(error)) throw error;
      await releaseAgentTaskWorkflowRun(runId, existingWorkflowRunId);
    }
  }

  await start(executeAgentTaskWorkflow, [runId]);
  return getAgentTaskRun(runId);
}

export async function resumeAgentTaskWorkflow(runId: string, value: unknown) {
  const run = await getAgentTaskRun(runId);
  if (!run) return null;
  const waitingStep = run.steps.find((step) => step.requiresConfirmation && !step.confirmedAt);
  if (!waitingStep || run.status !== "waiting_for_confirmation") {
    const submittedStepId = readSubmittedStepId(value);
    const decidedStep = run.steps.find((step) => step.id === submittedStepId && step.confirmationDecision);
    if (decidedStep) return run;
    throw new Error("当前任务不在等待确认状态，请刷新后重试。");
  }

  const decision = parseAgentApprovalDecision(value, waitingStep.id);
  const token = buildAgentApprovalHookToken(runId, waitingStep.id);
  await resumeHookWhenReady(token, decision);
  return getAgentTaskRun(runId);
}

export async function cancelDurableAgentTaskWorkflow(runId: string) {
  const workflowRunId = await getAgentTaskWorkflowRunId(runId);
  if (!workflowRunId) return false;
  try {
    await getRun(workflowRunId).cancel();
    return true;
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) return false;
    throw error;
  }
}

async function resumeHookWhenReady(token: string, decision: AgentApprovalDecision) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await resumeHook(token, decision);
      return;
    } catch (error) {
      if (!HookNotFoundError.is(error) || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function readSubmittedStepId(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const stepId = (value as Record<string, unknown>).stepId;
  return typeof stepId === "string" ? stepId : "";
}

function isTerminalAgentStatus(status: string) {
  return ["preflight_failed", "succeeded", "partially_succeeded", "failed", "cancelled"].includes(status);
}
