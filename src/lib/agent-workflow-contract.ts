export type AgentApprovalDecision = {
  action: "approve" | "reject";
  stepId: string;
  reason?: string;
};

type AgentWorkflowStepLike = {
  id: string;
  status: string;
  requiresConfirmation: boolean;
  confirmedAt: Date | string | null;
};

type AgentWorkflowRunLike = {
  id: string;
  status: string;
  steps: AgentWorkflowStepLike[];
};

export type AgentWorkflowBoundary =
  | { runId: string; status: string; kind: "ready" }
  | { runId: string; status: string; kind: "busy" }
  | { runId: string; status: string; kind: "terminal" }
  | { runId: string; status: "waiting_for_confirmation"; kind: "waiting_for_confirmation"; stepId: string };

const terminalStatuses = new Set([
  "preflight_failed",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
]);

export function buildAgentWorkflowHookToken(runId: string) {
  const normalized = normalizeHookId(runId, "任务标识无效。");
  return `agent-task:${normalized}:commands`;
}

export function buildAgentApprovalHookToken(runId: string, stepId: string) {
  const normalizedRunId = normalizeHookId(runId, "任务标识无效。");
  const normalizedStepId = normalizeHookId(stepId, "步骤标识无效。");
  return `agent-task:${normalizedRunId}:approval:${normalizedStepId}`;
}

function normalizeHookId(value: string, errorMessage: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(normalized)) throw new Error(errorMessage);
  return normalized;
}

export function parseAgentApprovalDecision(value: unknown, expectedStepId: string): AgentApprovalDecision {
  if (!value || typeof value !== "object") {
    throw new Error("审批内容无法识别，请重新操作。");
  }
  const input = value as Record<string, unknown>;
  const action = input.action;
  const stepId = typeof input.stepId === "string" ? input.stepId.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";

  if (action !== "approve" && action !== "reject") {
    throw new Error("审批动作无法识别，请重新操作。");
  }
  if (!stepId || stepId !== expectedStepId) {
    throw new Error("审批对应的步骤已变化，请刷新后重新核对。");
  }
  if (action === "reject" && !reason) {
    throw new Error("请说明不继续执行的原因。");
  }

  return {
    action,
    stepId,
    ...(reason ? { reason } : {}),
  };
}

export function getAgentWorkflowBoundary(run: AgentWorkflowRunLike): AgentWorkflowBoundary {
  if (run.status === "waiting_for_confirmation") {
    const step = run.steps.find((item) => item.requiresConfirmation && !item.confirmedAt);
    if (!step) {
      throw new Error("任务正在等待确认，但没有找到待确认步骤。");
    }
    return {
      runId: run.id,
      status: "waiting_for_confirmation",
      kind: "waiting_for_confirmation",
      stepId: step.id,
    };
  }
  if (terminalStatuses.has(run.status)) {
    return { runId: run.id, status: run.status, kind: "terminal" };
  }
  if (run.status === "planned") {
    return { runId: run.id, status: run.status, kind: "ready" };
  }
  if (run.status === "running") {
    return { runId: run.id, status: run.status, kind: "busy" };
  }
  throw new Error("任务状态无法识别。");
}
