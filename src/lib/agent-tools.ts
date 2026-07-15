import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { stringifyJson } from "@/lib/json";

export type AgentToolErrorCategory =
  | "configuration"
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  | "network"
  | "invalid_output"
  | "provider_error";

export type AgentToolExecutionContext = {
  runId: string;
  stepId: string;
  approvalId: string;
};

export function buildAgentToolCallIdentity(input: {
  runId: string;
  stepId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}) {
  const argumentDigest = digestToolArguments(input.arguments);
  const callDigest = sha256([input.runId, input.stepId, input.toolName, argumentDigest].join("\n"));
  return { toolCallId: `tool_${callDigest.slice(0, 24)}`, argumentDigest };
}

export function digestToolArguments(value: unknown) {
  return sha256(JSON.stringify(normalizeToolArguments(value)));
}

export function classifyToolError(error: unknown): AgentToolErrorCategory {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/not configured|missing.*(?:key|token)|configuration/i.test(message)) return "configuration";
  if (/\b401\b|unauthori[sz]ed|invalid.*(?:key|token)/i.test(message)) return "unauthorized";
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(message)) return "rate_limited";
  if (/timed?\s*out|aborterror|deadline/i.test(message)) return "timeout";
  if (/fetch failed|network|econn|enotfound|socket|dns/i.test(message)) return "network";
  if (/invalid.*(?:json|output)|schema|cannot parse|无法识别/i.test(message)) return "invalid_output";
  return "provider_error";
}

export async function beginApprovedAgentToolCall({
  context,
  toolName,
  arguments: toolArguments,
}: {
  context: AgentToolExecutionContext;
  toolName: string;
  arguments: Record<string, unknown>;
}) {
  const identity = buildAgentToolCallIdentity({
    runId: context.runId,
    stepId: context.stepId,
    toolName,
    arguments: toolArguments,
  });
  const receipt = await prisma.agentToolReceipt.findUnique({ where: { toolCallId: identity.toolCallId } });
  if (
    !receipt ||
    receipt.runId !== context.runId ||
    receipt.stepId !== context.stepId ||
    receipt.approvalId !== context.approvalId ||
    receipt.argumentDigest !== identity.argumentDigest
  ) {
    throw new Error("公开搜索参数与已确认计划不一致，未调用外部搜索服务。请重新确认搜索计划。");
  }
  if (receipt.idempotencyClass !== "read_only") {
    throw new Error("当前工具不允许按公开搜索方式重试，请重新发起任务。");
  }

  const startedAt = new Date();
  const updated = await prisma.agentToolReceipt.updateMany({
    where: {
      id: receipt.id,
      status: { in: ["approved", "failed", "succeeded", "interrupted"] },
    },
    data: {
      status: "running",
      attempt: { increment: 1 },
      startedAt,
      completedAt: null,
      durationMs: null,
      errorCategory: null,
    },
  });
  if (updated.count !== 1) {
    throw new Error("该搜索调用正在执行，请稍后查看任务进度。");
  }
  return { ...identity, startedAt };
}

export async function completeAgentToolCall({
  toolCallId,
  startedAt,
  provider,
  resultSummary,
}: {
  toolCallId: string;
  startedAt: Date;
  provider: string;
  resultSummary: Record<string, unknown>;
}) {
  const completedAt = new Date();
  await prisma.agentToolReceipt.updateMany({
    where: { toolCallId, status: "running" },
    data: {
      status: "succeeded",
      provider,
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      resultSummaryJson: stringifyJson(resultSummary),
      errorCategory: null,
      completedAt,
    },
  });
}

export async function failAgentToolCall({
  toolCallId,
  startedAt,
  provider,
  error,
  resultSummary = {},
}: {
  toolCallId: string;
  startedAt: Date;
  provider?: string;
  error: unknown;
  resultSummary?: Record<string, unknown>;
}) {
  const completedAt = new Date();
  await prisma.agentToolReceipt.updateMany({
    where: { toolCallId, status: "running" },
    data: {
      status: "failed",
      provider: provider ?? null,
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      resultSummaryJson: stringifyJson(resultSummary),
      errorCategory: classifyToolError(error),
      completedAt,
    },
  });
}

function normalizeToolArguments(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  if (Array.isArray(value)) return value.map((item) => normalizeToolArguments(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entryValue]) => [entryKey, normalizeToolArguments(entryValue, entryKey)]),
    );
  }
  return value;
}

function isSensitiveKey(key: string) {
  return /(?:api[-_]?key|authorization|cookie|password|secret|token|credential)/i.test(key);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
