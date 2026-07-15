import { describe, expect, it } from "vitest";
import {
  buildAgentApprovalHookToken,
  buildAgentWorkflowHookToken,
  getAgentWorkflowBoundary,
  parseAgentApprovalDecision,
} from "@/lib/agent-workflow-contract";

describe("durable Agent workflow contract", () => {
  it("uses one deterministic private hook token per business task", () => {
    expect(buildAgentWorkflowHookToken("run-123")).toBe("agent-task:run-123:commands");
    expect(buildAgentApprovalHookToken("run-123", "step-search")).toBe(
      "agent-task:run-123:approval:step-search",
    );
    expect(() => buildAgentWorkflowHookToken(" ")).toThrow("任务标识无效");
    expect(() => buildAgentApprovalHookToken("run-123", " ")).toThrow("步骤标识无效");
  });

  it("only accepts an approval for the step currently waiting", () => {
    expect(
      parseAgentApprovalDecision(
        { action: "approve", stepId: "step-search", reason: "查询范围已核对" },
        "step-search",
      ),
    ).toEqual({ action: "approve", stepId: "step-search", reason: "查询范围已核对" });

    expect(() =>
      parseAgentApprovalDecision({ action: "approve", stepId: "stale-step" }, "step-search"),
    ).toThrow("审批对应的步骤已变化");
  });

  it("requires a reason when rejecting a sensitive action", () => {
    expect(() =>
      parseAgentApprovalDecision({ action: "reject", stepId: "step-search", reason: "" }, "step-search"),
    ).toThrow("请说明不继续执行的原因");

    expect(
      parseAgentApprovalDecision(
        { action: "reject", stepId: "step-search", reason: "机构范围需要调整" },
        "step-search",
      ),
    ).toEqual({ action: "reject", stepId: "step-search", reason: "机构范围需要调整" });
  });

  it("returns only a compact serializable workflow boundary", () => {
    expect(
      getAgentWorkflowBoundary({
        id: "run-123",
        status: "waiting_for_confirmation",
        steps: [
          { id: "done", requiresConfirmation: false, confirmedAt: null, status: "succeeded" },
          { id: "step-search", requiresConfirmation: true, confirmedAt: null, status: "blocked" },
        ],
      }),
    ).toEqual({
      runId: "run-123",
      status: "waiting_for_confirmation",
      kind: "waiting_for_confirmation",
      stepId: "step-search",
    });

    expect(
      getAgentWorkflowBoundary({
        id: "run-123",
        status: "partially_succeeded",
        steps: [],
      }),
    ).toEqual({
      runId: "run-123",
      status: "partially_succeeded",
      kind: "terminal",
    });
  });
});
