type LiveAgentRunAssessmentInput = {
  status: string;
  failed?: string[];
};

type LiveExternalAcceptance = {
  passed?: boolean;
  uncached?: number;
  hardRequirementReadyCandidates?: number;
  blockers?: string[];
};

type LiveExternalSearchAssessmentInput = {
  externalRuns: number;
  searchResults: number;
  externalCandidates: number;
  requireNetworkCall: boolean;
  acceptance?: LiveExternalAcceptance | null;
  providerStats?: Record<string, number> | null;
};

export type LiveAcceptanceAssessment = {
  ok: boolean;
  reasons: string[];
};

export type LiveExternalSearchAssessment = LiveAcceptanceAssessment & {
  networkCallVerified: boolean;
  providers: string[];
};

export function assessLiveAgentRun(input: LiveAgentRunAssessmentInput): LiveAcceptanceAssessment {
  const failed = (input.failed ?? []).map((item) => item.trim()).filter(Boolean);
  if (input.status === "succeeded" && failed.length === 0) return { ok: true, reasons: [] };

  if (input.status === "partially_succeeded") {
    return {
      ok: false,
      reasons: [`任务仅部分完成。${failed.join("；")}`],
    };
  }

  if (failed.length) {
    return { ok: false, reasons: failed.map((item) => `任务步骤未完成：${item}`) };
  }

  return { ok: false, reasons: [`任务状态为 ${input.status}，未达到完整成功。`] };
}

export function assessLiveExternalSearch(
  input: LiveExternalSearchAssessmentInput,
): LiveExternalSearchAssessment {
  const reasons: string[] = [];
  const providerStats = input.providerStats ?? {};
  const providers = Object.entries(providerStats)
    .filter(([provider, count]) => provider !== "cache" && Number.isFinite(count) && count > 0)
    .map(([provider]) => provider);
  const networkCallVerified = (input.acceptance?.uncached ?? 0) > 0 && providers.length > 0;

  if (input.externalRuns < 1) reasons.push("没有创建公开搜索运行记录。");
  if (input.searchResults < 1) reasons.push("公开搜索没有保存任何来源结果。");
  if (input.externalCandidates < 1) reasons.push("公开搜索没有形成可复核候选。");

  if (input.acceptance?.passed !== true) {
    const blockers = (input.acceptance?.blockers ?? []).map((item) => item.trim()).filter(Boolean);
    reasons.push(`公开候选未通过项目质量门禁。${blockers.join("；")}`);
  } else if ((input.acceptance.hardRequirementReadyCandidates ?? 0) < 1) {
    reasons.push("没有候选同时满足高证据和项目硬条件。");
  }

  if (input.requireNetworkCall && !networkCallVerified) {
    reasons.push("本次仅复用了缓存，没有验证真实公开搜索服务。");
  }

  return {
    ok: reasons.length === 0,
    networkCallVerified,
    providers,
    reasons,
  };
}
