import type { AgentRunStatus, AgentStepStatus } from "@/lib/agent-tasks";
import { publicErrorMessage } from "@/lib/redaction";

export type AgentStepSnapshot = {
  stepKey: string;
  label: string;
  status: AgentStepStatus | string;
  output?: Record<string, unknown>;
  checks?: Record<string, unknown>;
  errorMessage?: string | null;
};

export type AgentRunReport = {
  status: AgentRunStatus | string;
  summary: string;
  completed: string[];
  skipped: string[];
  failed: string[];
  written: string[];
  needsReview: string[];
  nextActions: string[];
};

export function toActionableError(error: unknown) {
  return publicErrorMessage(error instanceof Error ? error.message : typeof error === "string" ? error : "操作未完成，请稍后重试。");
}

export function hasWrittenData(output?: Record<string, unknown>) {
  if (!output) return false;
  return [
    "projectUpdated",
    "candidates",
    "searchResults",
    "gaps",
    "ranked",
    "posts",
    "outcomeId",
    "campaignId",
  ].some((key) => {
    const value = output[key];
    return typeof value === "number" ? value > 0 : Boolean(value);
  });
}

export function buildAgentRunReport({
  status,
  steps,
}: {
  status: AgentRunStatus | string;
  steps: AgentStepSnapshot[];
}): AgentRunReport {
  const completed = steps.filter((step) => step.status === "succeeded").map((step) => step.label);
  const skipped = steps
    .filter((step) => step.status === "skipped")
    .map((step) => `${step.label}${step.errorMessage ? `：${toActionableError(step.errorMessage)}` : ""}`);
  const failed = steps
    .filter((step) => step.status === "failed")
    .map((step) => `${step.label}${step.errorMessage ? `：${toActionableError(step.errorMessage)}` : ""}`);
  const written = steps
    .filter((step) => hasWrittenData(step.output))
    .map((step) => summarizeWrittenData(step.label, step.output));
  const needsReview = steps.flatMap((step) => {
    const outputReview = readStringArray(step.output?.needsReview);
    const checkReview = readStringArray(step.checks?.needsReview);
    return [...outputReview, ...checkReview];
  });
  const nextActions =
    status === "waiting_for_confirmation"
      ? ["确认是否继续调用外部搜索。"]
      : steps
          .flatMap((step) => readStringArray(step.output?.nextActions))
          .filter((action) => shouldKeepNextAction(status, action));

  const summary =
    status === "succeeded"
      ? "任务已完成，结果已整理到工作台。"
      : status === "partially_succeeded"
        ? "任务已完成一部分，部分步骤需要人工处理或重试。"
        : status === "waiting_for_confirmation"
          ? "任务已准备好，需要确认后继续执行。"
          : status === "preflight_failed"
            ? "任务未开始，需先补齐前置条件。"
            : status === "failed"
              ? "任务未完成，未通过的步骤已保留原因。"
              : status === "cancelled"
                ? "任务已取消。"
                : "任务已生成执行计划。";

  return {
    status,
    summary,
    completed,
    skipped,
    failed,
    written,
    needsReview: Array.from(new Set(needsReview)),
    nextActions: nextActions.length ? Array.from(new Set(nextActions)) : defaultNextActions(status),
  };
}

function summarizeWrittenData(label: string, output?: Record<string, unknown>) {
  if (!output) return label;
  const parts: string[] = [];
  if (output.projectUpdated) parts.push("项目画像");
  appendCount(parts, output.candidates, "候选");
  appendCount(parts, output.searchResults, "搜索结果");
  appendCount(parts, output.gaps, "供给缺口");
  appendCount(parts, output.ranked, "排序候选");
  appendCount(parts, output.posts, "渠道内容");
  if (output.outcomeId) parts.push("复盘记录");
  if (output.campaignId) parts.push("渠道活动");
  return parts.length ? `${label}：${parts.join("、")}` : label;
}

function appendCount(parts: string[], value: unknown, label: string) {
  if (typeof value === "number" && value > 0) {
    parts.push(`${value} ${label}`);
  }
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function defaultNextActions(status: AgentRunStatus | string) {
  if (status === "waiting_for_confirmation") return ["确认是否继续调用外部搜索。"];
  if (status === "preflight_failed") return ["补齐提示中的前置条件后重新提交任务。"];
  if (status === "failed") return ["查看未完成步骤原因后重试任务。"];
  return ["查看候选和复核任务，决定下一步推进动作。"];
}

function shouldKeepNextAction(status: AgentRunStatus | string, action: string) {
  if (!action) return false;
  if (status !== "planned" && action === "开始执行任务。") {
    return false;
  }
  return true;
}
