import { describe, expect, it } from "vitest";
import {
  buildAgentToolCallIdentity,
  classifyToolError,
  digestToolArguments,
} from "@/lib/agent-tools";

describe("agent tool call identity", () => {
  it("keeps a stable call id across retries of the same approved query", () => {
    const first = buildAgentToolCallIdentity({
      runId: "run-1",
      stepId: "step-search",
      toolName: "public_search",
      arguments: { query: "  Python maintainer  ", apiKey: "secret-value" },
    });
    const retry = buildAgentToolCallIdentity({
      runId: "run-1",
      stepId: "step-search",
      toolName: "public_search",
      arguments: { apiKey: "different-secret", query: "Python maintainer" },
    });

    expect(retry.toolCallId).toBe(first.toolCallId);
    expect(retry.argumentDigest).toBe(first.argumentDigest);
    expect(first.toolCallId).toMatch(/^tool_[a-f0-9]{24}$/);
    expect(first.argumentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("secret-value");
  });

  it("does not reuse an identity across queries or task runs", () => {
    const base = {
      stepId: "step-search",
      toolName: "public_search",
    };
    const first = buildAgentToolCallIdentity({
      ...base,
      runId: "run-1",
      arguments: { query: "Python maintainer" },
    });
    const differentQuery = buildAgentToolCallIdentity({
      ...base,
      runId: "run-1",
      arguments: { query: "Rust maintainer" },
    });
    const differentRun = buildAgentToolCallIdentity({
      ...base,
      runId: "run-2",
      arguments: { query: "Python maintainer" },
    });

    expect(differentQuery.toolCallId).not.toBe(first.toolCallId);
    expect(differentRun.toolCallId).not.toBe(first.toolCallId);
  });

  it("redacts secret-like fields before producing a deterministic digest", () => {
    expect(
      digestToolArguments({
        query: "tumor immunology author",
        authorization: "Bearer private-token",
        nested: { DASHSCOPE_API_KEY: "private-key" },
      }),
    ).toBe(
      digestToolArguments({
        nested: { DASHSCOPE_API_KEY: "another-key" },
        authorization: "another-token",
        query: "tumor immunology author",
      }),
    );
  });
});

describe("tool error classification", () => {
  it.each([
    ["HTTP 401", "unauthorized"],
    ["HTTP 429", "rate_limited"],
    ["request timed out", "timeout"],
    ["fetch failed", "network"],
    ["SERPER_API_KEY is not configured", "configuration"],
  ])("classifies %s as %s", (message, category) => {
    expect(classifyToolError(new Error(message))).toBe(category);
  });
});
