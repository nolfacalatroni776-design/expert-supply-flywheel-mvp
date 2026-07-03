import { describe, expect, it } from "vitest";
import { normalizeAgentIntent, validateAgentRunStatusTransition } from "@/lib/agent-runtime";

describe("agent runtime state guards", () => {
  it("allows only known task intents", () => {
    expect(normalizeAgentIntent("generate_marketing")).toBe("generate_marketing");
    expect(normalizeAgentIntent("unknown")).toBeNull();
  });

  it("blocks unsafe run status transitions", () => {
    expect(validateAgentRunStatusTransition("planned", "running")).toEqual({ ok: true });
    expect(validateAgentRunStatusTransition("waiting_for_confirmation", "running")).toEqual({ ok: true });
    expect(validateAgentRunStatusTransition("succeeded", "running")).toEqual({
      ok: false,
      reason: "当前任务状态不能执行该动作。",
    });
    expect(validateAgentRunStatusTransition("planned", "succeeded")).toEqual({
      ok: false,
      reason: "当前任务状态不能执行该动作。",
    });
  });
});
