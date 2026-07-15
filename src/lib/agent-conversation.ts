import { normalizeAgentUserFacingText } from "@/lib/agent-quality";

export type AgentConversationStep = {
  id?: string;
  stepKey: string;
  label?: string;
  status: string;
  requiresConfirmation?: boolean;
  confirmedAt?: string | Date | null;
  confirmationDecision?: string | null;
  confirmationReason?: string | null;
  errorMessage?: string | null;
  output?: Record<string, unknown>;
  checks?: Record<string, unknown>;
  toolReceipts?: AgentToolReceiptView[];
};

export type AgentToolReceiptView = {
  toolName: string;
  status: string;
  provider?: string | null;
  attempt?: number;
  durationMs?: number | null;
  errorCategory?: string | null;
  resultSummary?: Record<string, unknown>;
};

export type AgentConversationRun = {
  id: string;
  label?: string;
  status: string;
  plan?: {
    objective?: string;
  };
  report?: {
    summary?: string;
    completed?: string[];
    skipped?: string[];
    failed?: string[];
    written?: string[];
    needsReview?: string[];
    nextActions?: string[];
  };
  steps: AgentConversationStep[];
};

export type AgentConversationAction =
  | { kind: "start"; label: "开始执行" }
  | { kind: "confirm"; label: "确认并开始公开搜索" | "确认并继续" }
  | { kind: "retry"; label: "重试未完成" }
  | { kind: "enrich"; label: "补齐候选证据" | "调整补证方向" }
  | { kind: "revise"; label: "调整搜索方向" }
  | { kind: "none"; label: "" };

export type AgentConversationMessage = {
  role: "assistant";
  tone: "info" | "success" | "warning" | "danger";
  title: string;
  items: string[];
};

export type AgentConfirmationBrief = {
  title: string;
  items: string[];
  queries: string[];
};

export type AgentStepConfirmationBadge = {
  label: "需确认" | "已确认" | "已拒绝";
  tone: "warning" | "success" | "danger";
};

export type AgentCandidatePreview = {
  candidateId: string;
  name: string;
  title?: string | null;
  affiliation?: string | null;
  evidenceLevel?: string | null;
  sourceType?: string | null;
  humanReviewNeeded?: boolean;
  sourceUrl?: string | null;
  nextAction?: string | null;
};

export type AgentSearchResultPreview = {
  searchResultId: string;
  title: string;
  url: string;
  domain?: string | null;
  query?: string | null;
  snippet?: string | null;
};

export function shouldRefreshWorkspaceData(status: string) {
  return ["succeeded", "partially_succeeded", "failed"].includes(status);
}

export function getAgentStepConfirmationBadge(
  step: Pick<
    AgentConversationStep,
    "requiresConfirmation" | "confirmedAt" | "confirmationDecision" | "status"
  >,
): AgentStepConfirmationBadge | null {
  if (!step.requiresConfirmation) return null;
  if (step.confirmationDecision === "rejected") return { label: "已拒绝", tone: "danger" };
  if (step.confirmedAt) return { label: "已确认", tone: "success" };
  if (step.status === "blocked") return { label: "需确认", tone: "warning" };
  return null;
}

export function shouldContinuePollingAgentRun(
  action: "start" | "confirm" | "reject" | "retry",
  run: AgentConversationRun,
  previousApprovalStepId?: string,
) {
  if (["preflight_failed", "succeeded", "partially_succeeded", "failed", "cancelled"].includes(run.status)) {
    return false;
  }
  if (run.status !== "waiting_for_confirmation") return true;

  const waitingStep = run.steps.find(
    (step) => step.requiresConfirmation && !step.confirmedAt && step.status === "blocked",
  );
  if (action === "start" || action === "retry") return false;
  return Boolean(previousApprovalStepId && waitingStep?.id === previousApprovalStepId);
}

export function describeAgentToolReceipts(receipts: AgentToolReceiptView[]) {
  return receipts.map((receipt) => {
    const query =
      typeof receipt.resultSummary?.query === "string" && receipt.resultSummary.query.trim()
        ? `“${receipt.resultSummary.query.trim().slice(0, 80)}”`
        : "";
    const tool = receipt.toolName === "public_search" ? `公开搜索${query}` : "任务调用";
    const attempt = (receipt.attempt ?? 0) > 1 ? `第 ${receipt.attempt} 次执行` : "执行";
    if (receipt.status === "approved") return `${tool}：搜索方向已确认，等待执行。`;
    if (receipt.status === "running") return `${tool}：正在${attempt}。`;
    if (receipt.status === "interrupted") return `${tool}：任务已停止，本次调用未继续。`;
    if (receipt.status === "failed") {
      return `${tool}：${attempt}未完成，${toolErrorMessage(receipt.errorCategory)}。`;
    }
    if (receipt.status !== "succeeded") return `${tool}：等待执行。`;

    const provider = formatToolProvider(receipt.provider);
    const resultCount = receipt.resultSummary?.resultCount;
    const countText = typeof resultCount === "number" ? `，返回 ${resultCount} 条` : "";
    const durationText = typeof receipt.durationMs === "number" ? `，用时 ${formatDuration(receipt.durationMs)}` : "";
    return `${tool}：${provider}${countText}${durationText}。`;
  });
}

function formatToolProvider(provider?: string | null) {
  const labels: Record<string, string> = {
    cache: "使用已保存结果",
    serper: "完成公开网页搜索",
    github: "完成 GitHub 公开资料检索",
    openalex: "完成公开论文检索",
  };
  return labels[provider ?? ""] ?? "完成公开资料检索";
}

function toolErrorMessage(category?: string | null) {
  const labels: Record<string, string> = {
    configuration: "搜索服务尚未配置",
    unauthorized: "搜索服务授权失效，请联系管理员",
    rate_limited: "外部服务请求过于频繁，请稍后重试",
    timeout: "外部服务响应超时，请稍后重试",
    network: "网络连接异常，请稍后重试",
    invalid_output: "返回内容无法识别，未写入候选",
    cancelled: "任务已停止",
  };
  return labels[category ?? ""] ?? "外部服务暂时不可用，请稍后重试";
}

function formatDuration(durationMs: number) {
  return `${Math.max(0.1, Math.round(durationMs / 100) / 10).toFixed(1)} 秒`;
}

export function getAgentConversationAction(run: AgentConversationRun): AgentConversationAction {
  if (run.status === "planned") return { kind: "start", label: "开始执行" };
  if (run.status === "waiting_for_confirmation") {
    const needsExternalSearch = run.steps.some((step) => step.stepKey === "confirm_external_search" && step.status === "blocked");
    return { kind: "confirm", label: needsExternalSearch ? "确认并开始公开搜索" : "确认并继续" };
  }
  if (run.status === "failed" || run.status === "partially_succeeded") {
    if (run.steps.some((step) => step.confirmationDecision === "rejected" || step.output?.rejected === true)) {
      return run.steps.some((step) => step.stepKey === "enrich_candidate_evidence")
        ? { kind: "enrich", label: "调整补证方向" }
        : { kind: "revise", label: "调整搜索方向" };
    }
    if (run.steps.some((step) => step.stepKey === "enrich_candidate_evidence")) {
      return { kind: "enrich", label: "调整补证方向" };
    }
    if (hasCandidateInstitutionEvidenceGap(run)) return { kind: "enrich", label: "补齐候选证据" };
    if (hasSavedSearchResultsWithoutPeople(run) || hasExternalSearchQualityFailure(run)) {
      return { kind: "revise", label: "调整搜索方向" };
    }
    return { kind: "retry", label: "重试未完成" };
  }
  return { kind: "none", label: "" };
}

function hasCandidateInstitutionEvidenceGap(run: AgentConversationRun) {
  return run.steps.some((step) => {
    if (!["external_research", "search_candidates"].includes(step.stepKey)) return false;
    const acceptance = step.output?.acceptance;
    if (!acceptance || typeof acceptance !== "object" || Array.isArray(acceptance)) return false;
    const report = acceptance as Record<string, unknown>;
    const requirements = readStringArray(report.candidateHardRequirements);
    return (
      requirements.includes("机构公开主页") &&
      numberValue(report.e2PlusCandidates) > 0 &&
      numberValue(report.hardRequirementReadyCandidates) === 0
    );
  });
}

function hasExternalSearchQualityFailure(run: AgentConversationRun) {
  return run.steps.some((step) => {
    if (!["external_research", "search_candidates"].includes(step.stepKey) || step.status !== "failed") return false;
    const acceptance = step.output?.acceptance;
    return Boolean(acceptance && typeof acceptance === "object" && (acceptance as Record<string, unknown>).passed === false);
  });
}

export function getAgentConfirmationBrief(run: AgentConversationRun): AgentConfirmationBrief | null {
  if (run.status !== "waiting_for_confirmation") return null;
  const confirmationStep = run.steps.find((step) => step.stepKey === "confirm_external_search" && step.status === "blocked");
  if (!confirmationStep) return null;

  const checks = confirmationStep.checks ?? {};
  const queries = numberValue(checks.queries);
  const cached = numberValue(checks.cached);
  const uncached = numberValue(checks.uncached);
  const queryPreview = readStringArray(checks.queryPreview).slice(0, 4);
  const evidenceEnrichment = run.steps.some((step) => step.stepKey === "enrich_candidate_evidence");

  return {
    title: "确认后会做什么",
    items: evidenceEnrichment
      ? [
          `按 ${queries} 个搜索方向补查候选机构主页，其中 ${cached} 个使用已保存结果，${uncached} 个会调用外部搜索服务。`,
          "只会处理计划中列出的候选姓名；不会发送邮件、不会发布渠道内容。",
          "只有姓名匹配且来自机构人员页的结果才能生成补证线索。",
          "同人关系只生成建议，核对姓名、机构和来源后再由你确认合并。",
        ]
      : [
          `按 ${queries} 个搜索方向查找公开来源候选，其中 ${cached} 个使用已保存结果，${uncached} 个会调用外部搜索服务。`,
          "只会写入搜索结果、候选线索和证据项；不会发送邮件、不会发布渠道内容。",
          "低证据或高风险候选会留在复核中，不会直接进入触达。",
          "完成后会在这里展示“外部搜索到的人力”，并可进入候选管道继续复核。",
        ],
    queries: queryPreview,
  };
}

export function getAgentCandidatePreview(run: AgentConversationRun): AgentCandidatePreview[] {
  const candidates: AgentCandidatePreview[] = [];
  const seen = new Set<string>();
  for (const step of run.steps) {
    const preview = readCandidatePreview(step.output?.candidatePreview);
    for (const candidate of preview) {
      if (seen.has(candidate.candidateId)) continue;
      seen.add(candidate.candidateId);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function getAgentSourceRunId(run: AgentConversationRun) {
  const sourceStep = [...run.steps]
    .reverse()
    .find(
      (step) =>
        ["external_research", "search_candidates"].includes(step.stepKey) &&
        ["succeeded", "failed"].includes(step.status),
    );
  const runId = sourceStep?.output?.runId;
  return typeof runId === "string" && runId.trim() ? runId.trim() : null;
}

export function getAgentSearchResultPreview(run: AgentConversationRun): AgentSearchResultPreview[] {
  for (const step of run.steps) {
    const preview = readSearchResultPreview(step.output?.searchResultPreview);
    if (preview.length) return preview;
  }
  return [];
}

export function getAgentConversationMessages(run: AgentConversationRun): AgentConversationMessage[] {
  const report = run.report ?? {};
  const messages: AgentConversationMessage[] = [];

  const emptyPeopleStep = hasSavedSearchResultsWithoutPeople(run);
  if (emptyPeopleStep) {
    messages.push({
      role: "assistant",
      tone: "warning",
      title: "找到搜索结果，但没有可复核人力",
      items: [
        "已保留本次网页结果，未创建空候选或把资料页误当成专家。",
        "可以先查看搜索结果，再用面向个人主页、作者、讲者或团队成员的方向重新生成计划。",
      ],
    });
  }

  addMessage(messages, "success", "已完成", report.completed);
  addMessage(messages, "info", "写入结果", report.written);
  addMessage(messages, "warning", "需要人工处理", report.needsReview);
  addMessage(messages, "danger", "未完成", [...(report.failed ?? []), ...(report.skipped ?? [])]);
  addMessage(messages, "info", "建议下一步", normalizeNextActions(run, report.nextActions));

  if (!messages.length && report.summary) {
    messages.push({ role: "assistant", tone: "info", title: "任务进展", items: [report.summary] });
  }

  return messages;
}

function normalizeNextActions(run: AgentConversationRun, values?: string[]) {
  const candidates = getAgentCandidatePreview(run).filter((candidate) => candidate.sourceType === "external");
  const reviewOnlyBatch = candidates.length > 0 && candidates.every((candidate) => candidate.humanReviewNeeded !== false);
  if (!reviewOnlyBatch) return values;

  const nextActions = (values ?? []).filter(
    (item) =>
      !(["succeeded", "partially_succeeded", "failed"].includes(run.status) && /继续执行公开候选补充/.test(item)) &&
      !/把可触达候选推进到触达草稿或试标准备/.test(item),
  );
  nextActions.push("完成候选复核和联系许可确认后，再准备触达草稿。");
  return Array.from(new Set(nextActions));
}

function hasSavedSearchResultsWithoutPeople(run: AgentConversationRun) {
  return run.steps.some((step) => numberValue(step.output?.searchResults) > 0 && numberValue(step.output?.candidates) === 0);
}

function readSearchResultPreview(value: unknown): AgentSearchResultPreview[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): AgentSearchResultPreview | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const searchResultId = stringValue(record.searchResultId);
      const title = stringValue(record.title);
      const url = stringValue(record.url);
      if (!searchResultId || !title || !url) return null;
      return {
        searchResultId,
        title,
        url,
        domain: nullableStringValue(record.domain),
        query: nullableStringValue(record.query),
        snippet: nullableStringValue(record.snippet),
      };
    })
    .filter((item): item is AgentSearchResultPreview => Boolean(item));
}

function addMessage(
  messages: AgentConversationMessage[],
  tone: AgentConversationMessage["tone"],
  title: string,
  values?: string[],
) {
  const items = Array.from(new Set((values ?? []).map(normalizeAgentUserFacingText).filter(Boolean)));
  if (items.length) messages.push({ role: "assistant", tone, title, items });
}

function readCandidatePreview(value: unknown): AgentCandidatePreview[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): AgentCandidatePreview | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const candidateId = stringValue(record.candidateId);
      const name = stringValue(record.name);
      if (!candidateId || !name) return null;
      return {
        candidateId,
        name,
        title: nullableStringValue(record.title),
        affiliation: nullableStringValue(record.affiliation),
        evidenceLevel: nullableStringValue(record.evidenceLevel),
        sourceType: nullableStringValue(record.sourceType),
        humanReviewNeeded: typeof record.humanReviewNeeded === "boolean" ? record.humanReviewNeeded : undefined,
        sourceUrl: nullableStringValue(record.sourceUrl),
        nextAction: nullableStringValue(record.nextAction),
      };
    })
    .filter((item): item is AgentCandidatePreview => Boolean(item));
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableStringValue(value: unknown) {
  const text = stringValue(value);
  return text || null;
}
