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

const SAFE_REVIEW_ACTION = "先完成人工复核并确认必要证据和联系许可，再决定是否生成触达草稿或准备试标材料。";

export function normalizeAgentUserFacingText(value: string) {
  const input = value.trim();
  if (!input) return "";
  if (/立即(?:生成)?触达|优先触达|直接触达|触达并.{0,12}(?:安排|进入|启动)试标|安排(?:第一批|小规模)?试标|直接进入试标|发送(?:邮件|邀请)|无需复核/i.test(input)) {
    return SAFE_REVIEW_ACTION;
  }

  return input
    .replace(/humanReviewNeeded\s*(?:为|是|=|:)?\s*false/gi, "尚未标记为待人工复核")
    .replace(/humanReviewNeeded\s*(?:为|是|=|:)?\s*true/gi, "已标记为待人工复核")
    .replace(/fitScore/gi, "匹配评分")
    .replace(/\bpersona\b/gi, "专家画像")
    .replace(/riskLevel/gi, "风险等级")
    .replace(/evidenceItems?/gi, "证据记录")
    .replace(/domainTags?/gi, "能力标签")
    .replace(/contactPermissionBasis/gi, "联系许可依据")
    .replace(/profileAllowsOutreach|sourceAllowsOutreach/gi, "公开联系许可")
    .replace(/\bsourceType\b/gi, "候选来源")
    .replace(/\b(?:live[_-]?smoke|fixture)\b/gi, "测试记录")
    .replace(/(风险等级\s*(?:为|是|[:：])?\s*)medium\b/gi, "$1中等")
    .replace(/(风险等级\s*(?:为|是|[:：])?\s*)regulated\b/gi, "$1受监管")
    .replace(/(风险等级\s*(?:为|是|[:：])?\s*)critical\b/gi, "$1极高")
    .replace(/(风险等级\s*(?:为|是|[:：])?\s*)high\b/gi, "$1高")
    .replace(/(风险等级\s*(?:为|是|[:：])?\s*)low\b/gi, "$1低")
    .replace(/\s+/g, " ")
    .trim();
}

export function toActionableError(error: unknown) {
  return publicErrorMessage(error instanceof Error ? error.message : typeof error === "string" ? error : "操作未完成，请稍后重试。");
}

export function evaluateExternalResearchStepQuality({
  candidateCount,
  acceptance,
}: {
  candidateCount: number;
  acceptance?: { passed?: boolean; blockers?: string[] } | null;
}) {
  if (candidateCount === 0) {
    return {
      stepFailed: true,
      failureReason: "已保存搜索结果，但未抽取到与项目要求相关的可复核候选。",
    };
  }
  if (acceptance?.passed === false) {
    const blockers = (acceptance.blockers ?? [])
      .map((item) => item.trim().replace(/[。；;]+$/g, ""))
      .filter(Boolean);
    return {
      stepFailed: true,
      failureReason: blockers.length
        ? `搜索结果已保存，但候选质量未通过：${blockers.join("；")}`
        : "搜索结果已保存，但候选质量未通过。",
    };
  }
  return { stepFailed: false, failureReason: undefined };
}

export function hasWrittenData(output?: Record<string, unknown>) {
  if (!output) return false;
  return [
    "projectUpdated",
    "candidates",
    "searchResults",
    "autoScreenedOut",
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
  const needsReview = steps
    .filter((step) => status === "waiting_for_confirmation" || step.stepKey !== "confirm_external_search")
    .flatMap((step) => {
    const outputReview = readStringArray(step.output?.needsReview);
    const checkReview = readStringArray(step.checks?.needsReview);
    return [...outputReview, ...checkReview];
  }).map(normalizeAgentUserFacingText).filter(Boolean);
  const nextActions =
    status === "waiting_for_confirmation"
      ? ["确认是否继续调用外部搜索。"]
      : selectCurrentActionSteps(status, steps)
          .flatMap((step) => readStringArray(step.output?.nextActions))
          .map(normalizeAgentUserFacingText)
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
  appendCount(parts, output.autoScreenedOut, "暂不推进候选");
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
  if (status === "partially_succeeded") return ["查看未完成步骤原因后重试，已完成结果会保留。"];
  if (status === "cancelled") return ["如需继续，请重新提交任务。"];
  return ["查看候选和复核任务，决定下一步推进动作。"];
}

function selectCurrentActionSteps(status: AgentRunStatus | string, steps: AgentStepSnapshot[]) {
  if (status === "partially_succeeded" || status === "failed") {
    const firstFailureIndex = steps.findIndex((step) => step.status === "failed");
    if (firstFailureIndex >= 0) {
      return steps
        .slice(firstFailureIndex)
        .filter((step) => step.status === "failed" || step.status === "succeeded");
    }
  }

  if (status === "succeeded") {
    const finalActionStep = [...steps]
      .reverse()
      .find(
        (step) =>
          step.status === "succeeded" &&
          step.stepKey !== "quality_report" &&
          readStringArray(step.output?.nextActions).length > 0,
      );
    return finalActionStep ? [finalActionStep] : [];
  }

  return steps.filter(
    (step) =>
      (step.status === "failed" || step.status === "blocked") &&
      readStringArray(step.output?.nextActions).length > 0,
  );
}

function shouldKeepNextAction(status: AgentRunStatus | string, action: string) {
  if (!action) return false;
  if (status !== "planned" && action === "开始执行任务。") {
    return false;
  }
  return true;
}
