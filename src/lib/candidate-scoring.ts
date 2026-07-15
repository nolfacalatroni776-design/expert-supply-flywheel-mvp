import type { ScoreCandidateOutput } from "@/lib/schemas";
import { hasQualifiedBudget } from "@/lib/serializers";

type LanguageCompatibilityInput = {
  project: {
    rawDemand?: string | null;
    languages?: string[];
  };
  candidate: {
    languages?: string[];
    evidenceLevel?: string | null;
    evidenceItemCount?: number;
    stage?: string | null;
    humanReviewNeeded?: boolean;
  };
  score: ScoreCandidateOutput;
};

export function normalizeCandidateScore(input: LanguageCompatibilityInput): ScoreCandidateOutput {
  const languageNormalized = normalizeLanguageCompatibility(input);
  const budgetNormalized = normalizeUnqualifiedBudget(input.project.rawDemand ?? "", languageNormalized);
  const evidenceLevel = strongerEvidenceLevel(budgetNormalized.evidenceLevel, input.candidate.evidenceLevel);
  const risks = budgetNormalized.risks.filter((item) => !isPositiveFitStatement(item));
  const factNormalized = normalizeCurrentCandidateFacts(
    { ...budgetNormalized, evidenceLevel, risks },
    input.candidate,
  );
  return normalizeUserFacingScoreText(factNormalized, input.candidate);
}

function normalizeCurrentCandidateFacts(
  score: ScoreCandidateOutput,
  candidate: LanguageCompatibilityInput["candidate"],
): ScoreCandidateOutput {
  const hasEvidenceItems = (candidate.evidenceItemCount ?? 0) > 0;
  const risks = (hasEvidenceItems ? score.risks.filter((item) => !claimsEvidenceItemsAreEmpty(item)) : score.risks)
    .filter((item) => !candidate.humanReviewNeeded || !contradictsRequiredReview(item));
  const missingEvidence = hasEvidenceItems
    ? score.missingEvidence.filter((item) => !claimsEvidenceItemsAreEmpty(item))
    : score.missingEvidence;
  const topReasons = candidate.humanReviewNeeded
    ? score.topReasons.filter(
        (item) => !proposesPrematureCandidateAction(item) && !contradictsRequiredReview(item),
      )
    : score.topReasons;
  const nextAction =
    candidate.stage === "trial" && (proposesStartingTrial(score.nextAction) || isGenericNextAction(score.nextAction))
      ? "继续当前试标，记录提交结果并完成人工复核。"
      : candidate.humanReviewNeeded && !["trial", "onboarded", "active"].includes(candidate.stage ?? "")
        ? "先完成人工复核并补齐必要证据和联系许可，再决定是否生成触达草稿或准备试标材料。"
      : score.nextAction;

  return { ...score, topReasons, risks, missingEvidence, nextAction };
}

function claimsEvidenceItemsAreEmpty(value: string) {
  return /(?:evidence\s*items?|evidenceitems?|证据项).{0,16}(?:为空|空白|不存在|缺失|没有|empty|missing|none|zero)|(?:无|没有|缺少|不存在).{0,8}(?:evidence\s*items?|evidenceitems?|证据项)/i.test(
    value,
  );
}

function proposesStartingTrial(value: string) {
  return /(?:安排|进入|启动|开始|创建|发起).{0,12}(?:小规模)?试标|(?:schedule|start|initiate|begin|move).{0,16}\btrial\b/i.test(
    value,
  );
}

function proposesPrematureCandidateAction(value: string) {
  return /(?:立即|优先|直接|可以).{0,10}触达|触达.{0,12}(?:安排|进入|启动)试标|(?:发送|发出).{0,8}(?:试标)?邀请|(?:立即|直接).{0,8}(?:安排|进入|启动|开始)试标/i.test(
    value,
  );
}

function contradictsRequiredReview(value: string) {
  return /无需(?:人工)?复核|不需(?:要)?(?:人工)?复核|无需额外合规审查|未标记为待人工复核|humanReviewNeeded.{0,8}false/i.test(
    value,
  );
}

function isGenericNextAction(value: string) {
  return /(?:人工复核|补齐证据).{0,16}(?:决定下一步|再决定|决定是否推进)|review.{0,16}(?:next step|proceed)/i.test(
    value,
  );
}

function normalizeUserFacingScoreText(
  score: ScoreCandidateOutput,
  candidate: LanguageCompatibilityInput["candidate"],
): ScoreCandidateOutput {
  const scoreBreakdown = score.scoreBreakdown.map((item) => {
    const dimension = normalizeScoreDimension(item.dimension);
    const fallback = scoreDimensionExplanation(dimension);
    const evidence = cleanModelText(item.evidence);
    const reason = cleanModelText(item.reason);
    return {
      ...item,
      dimension,
      evidence:
        hasInternalScoreMetadata(evidence) || !hasChineseText(evidence)
          ? internalScoreEvidence(dimension, evidence, fallback.evidence, candidate)
          : evidence,
      reason:
        candidate.humanReviewNeeded && contradictsRequiredReview(reason)
          ? "该候选仍需完成人工复核，并确认必要证据和联系许可。"
          : hasInternalScoreMetadata(reason) || !hasChineseText(reason)
            ? internalScoreReason(dimension, reason, fallback.reason, candidate)
            : reason,
    };
  });
  const normalizedReasons = score.topReasons.map(normalizeScoreReason).filter(Boolean);
  const normalizedRisks = Array.from(new Set(score.risks.map(normalizeScoreRisk).filter(Boolean)));
  const normalizedMissingEvidence = Array.from(
    new Set(score.missingEvidence.map(normalizeMissingEvidence).filter(Boolean)),
  );
  const missingEvidence = normalizedMissingEvidence.length
    ? normalizedMissingEvidence
    : deriveMissingEvidenceFromRisks(normalizedRisks);
  return {
    ...score,
    scoreBreakdown,
    topReasons: normalizedReasons.length
      ? Array.from(new Set(normalizedReasons))
      : Array.from(new Set(scoreBreakdown.filter((item) => item.score >= 70).map((item) => item.reason))).slice(0, 4),
    risks: normalizedRisks,
    missingEvidence,
    nextAction:
      hasChineseText(cleanModelText(score.nextAction)) && !hasInternalScoreMetadata(cleanModelText(score.nextAction))
        ? cleanModelText(score.nextAction)
        : "完成人工复核并补齐必要证据后，再决定是否推进。",
  };
}

const INTERNAL_SCORE_METADATA =
  /evidenceLevel|confidence|live[_-]?smoke|fixture|evidenceItems?|evidenceRequirements|\bsignals?\b|domainTags?|qualityMetrics|qualitySummaryJson|humanReviewNeeded|consentState|contactPermissionBasis|direct_consent|profileAllowsOutreach|sourceAllowsOutreach|riskLevel|mustHave|niceToHave|\bpersona\b|taskFitSignals|humanReviewPoints|searchQueries|sourceType|sourceRunId|conversionProbability|expertType|lastActiveAt|fitScore|rawDemand|supplyGoalJson|\bstage\b|\blanguages\b|\bregions\b/i;

function hasInternalScoreMetadata(value: string) {
  return INTERNAL_SCORE_METADATA.test(value);
}

function internalScoreEvidence(
  dimension: string,
  original: string,
  fallback: string,
  candidate: LanguageCompatibilityInput["candidate"],
) {
  if (/live[_-]?smoke|fixture/i.test(original)) return "该记录尚未核验为真实业务数据。";
  const descriptions: Record<string, string> = {
    领域匹配: "基于候选能力标签、历史记录和当前项目要求评估。",
    证据可信度: "现有记录提供了能力证据，仍需补充可公开核验的项目案例。",
    任务适配: "基于候选历史任务表现和当前任务要求评估。",
    可参与性:
      candidate.stage === "trial"
        ? "候选当前处于试标流程，具体可用时间和持续投入能力仍需确认。"
        : "当前没有可验证的可用时间或参与意愿信息。",
    沟通协作: "已记录的工作语言与项目要求匹配，具体协作表现仍需人工确认。",
    合规风险: "联系许可、触达路径和项目风险仍需人工确认。",
  };
  return descriptions[dimension] ?? fallback;
}

function internalScoreReason(
  dimension: string,
  original: string,
  fallback: string,
  candidate: LanguageCompatibilityInput["candidate"],
) {
  if (/live[_-]?smoke|fixture/i.test(original)) return "测试来源不能作为正式决策依据。";
  const descriptions: Record<string, string> = {
    领域匹配: "候选能力与项目领域存在匹配，仍需结合原始证据确认。",
    证据可信度: "当前证据可用于初步判断，但仍需补充外部可核验材料。",
    任务适配: "候选历史经历与任务要求相关，具体能力需通过试标验证。",
    可参与性:
      candidate.stage === "trial"
        ? "候选已进入试标流程，当前可用时间和投入能力仍需确认。"
        : "需要人工确认候选当前可参与时间和合作意愿。",
    沟通协作: "工作语言满足项目要求，协作效率仍需在试标中观察。",
    合规风险: "触达或试标前需确认联系许可并完成人工复核。",
  };
  return descriptions[dimension] ?? fallback;
}

function normalizeScoreDimension(value: string) {
  const cleaned = cleanModelText(value);
  const mappings: Array<[RegExp, string]> = [
    [/domain|领域/i, "领域匹配"],
    [/credential|evidence|资历|证据/i, "证据可信度"],
    [/task|任务/i, "任务适配"],
    [/availability|可用|意愿/i, "可参与性"],
    [/communication|language|沟通|语言/i, "沟通协作"],
    [/compliance|risk|合规|风险/i, "合规风险"],
  ];
  return mappings.find(([pattern]) => pattern.test(cleaned))?.[1] ?? (hasChineseText(cleaned) ? cleaned : "综合评估");
}

function scoreDimensionExplanation(dimension: string) {
  const explanations: Record<string, { evidence: string; reason: string }> = {
    领域匹配: { evidence: "基于候选能力标签、历史记录和当前项目要求评估。", reason: "候选能力与项目领域的匹配程度需结合证据判断。" },
    证据可信度: { evidence: "基于现有内部记录或公开来源评估。", reason: "证据强度决定该项结论的可信程度。" },
    任务适配: { evidence: "基于候选历史任务与当前任务类型评估。", reason: "需确认候选能完成当前任务要求的具体产出。" },
    可参与性: { evidence: "当前没有完整的可用时间或合作意愿信息。", reason: "需人工确认当前可参与时间和合作意愿。" },
    沟通协作: { evidence: "基于已记录语言与协作信息评估。", reason: "需确认候选是否满足项目沟通和协作要求。" },
    合规风险: { evidence: "基于触达许可、复核状态和项目风险评估。", reason: "触达或试标前必须满足人工复核与合规门禁。" },
    综合评估: { evidence: "基于当前候选资料评估。", reason: "该评分项仍需结合原始证据人工复核。" },
  };
  return explanations[dimension] ?? explanations.综合评估;
}

function normalizeScoreRisk(value: string) {
  const risk = normalizeRiskLevelEnums(cleanModelText(value));
  if (!risk) return "";
  if (/live[_-]?smoke|fixture/i.test(risk)) return "该历史试标记录尚未核验为真实项目表现，不能作为正式决策依据。";
  if (hasInternalScoreMetadata(risk)) {
    if (/evidenceItems?/i.test(risk)) return "现有证据仍需补充外部可核验的项目案例。";
    return "当前项目仍需完成人工复核。";
  }
  if (hasChineseText(risk)) return risk;
  if (/conflict[- ]of[- ]interest|\bnda\b|confidential/i.test(risk)) return "利益冲突与保密要求尚未确认。";
  if (/internal[- ]only|external verification/i.test(risk)) return "现有证据主要来自内部记录，必要时补充外部交叉验证。";
  if (/repository|review sample|evidenceitems.*empty|code review case/i.test(risk)) return "缺少公开项目仓库或脱敏代码评审案例。";
  if (/humanreviewneeded|human review|trial-stage review/i.test(risk)) return "试标和正式任务前仍需完成人工复核。";
  if (/availability|available|participation/i.test(risk)) return "当前可用时间和参与意愿尚未确认。";
  if (/contact|consent|permission/i.test(risk)) return "触达许可尚未确认。";
  return "该风险项需人工复核。";
}

function normalizeRiskLevelEnums(value: string) {
  const levelLabels: Record<string, string> = {
    low: "低",
    medium: "中等",
    high: "高",
    regulated: "受监管",
    critical: "极高",
  };
  return value.replace(/((?:项目)?风险等级(?:为|是|[:：])?\s*)(low|medium|high|regulated|critical)\b/gi, (_, prefix, level) => {
    return `${prefix}${levelLabels[String(level).toLowerCase()] ?? level}`;
  });
}

function normalizeMissingEvidence(value: string) {
  const item = cleanModelText(value);
  if (!item) return "";
  if (hasInternalScoreMetadata(item)) return "仍需补充可公开核验的项目案例。";
  if (hasChineseText(item)) return item;
  if (/repository|code review|review sample|redacted/i.test(item)) return "缺少公开项目仓库或脱敏代码评审案例。";
  if (/availability|participation/i.test(item)) return "缺少当前可用时间和参与意愿确认。";
  if (/contact|consent|permission/i.test(item)) return "缺少可核验的触达许可。";
  if (/language|chinese|english/i.test(item)) return "缺少项目所需语言能力的核验证据。";
  return "该证据项仍需补充和人工核验。";
}

function deriveMissingEvidenceFromRisks(risks: string[]) {
  return Array.from(
    new Set(
      risks
        .map((risk) => risk.match(/缺少[^。；;]+[。]?/)?.[0] ?? "")
        .filter(Boolean)
        .map((item) => (/[。！？]$/.test(item) ? item : `${item}。`)),
    ),
  );
}

function normalizeScoreReason(value: string) {
  const reason = cleanModelText(value);
  if (hasInternalScoreMetadata(reason)) return "该结论基于现有业务记录，仍需结合原始证据人工确认。";
  if (hasChineseText(reason)) return reason;
  if (/domain|creator|maintainer|framework|direct match/i.test(reason)) return "候选公开能力与项目领域存在直接匹配。";
  if (/github|contribution|credential|evidence/i.test(reason)) return "候选具备可追溯的能力证据。";
  if (/task|review experience/i.test(reason)) return "候选历史经历与任务要求相关。";
  return "";
}

function cleanModelText(value: string) {
  return value
    .trim()
    .replace(/\s*(?:\}\s*\]\s*,?\s*["']?|\]\s*,\s*["'])\s*$/g, "")
    .trim();
}

function hasChineseText(value: string) {
  return /[\u3400-\u9fff]/.test(value);
}

export function normalizeLanguageCompatibility({ project, candidate, score }: LanguageCompatibilityInput): ScoreCandidateOutput {
  const demand = project.rawDemand ?? "";
  if (!allowsAnyListedLanguage(demand) || requiresAllListedLanguages(demand)) return score;

  const accepted = new Set((project.languages ?? []).map(normalizeLanguage).filter(Boolean));
  const candidateLanguages = (candidate.languages ?? []).map(normalizeLanguage).filter(Boolean);
  if (!candidateLanguages.some((language) => accepted.has(language))) return score;

  let changed = false;
  const scoreBreakdown = score.scoreBreakdown.map((item) => {
    if (!/communication|language|沟通|语言/i.test(item.dimension) || item.score >= 80) return item;
    changed = true;
    const matched = candidate.languages?.join("、") || "已记录语言";
    return {
      ...item,
      score: 80,
      evidence: `${matched} 属于项目可接受的工作语言。`,
      reason: "项目允许使用任一已列语言，不要求候选人同时具备全部语言。",
    };
  });

  const risks = score.risks.filter((item) => !isLanguageBlocker(item));
  const missingEvidence = score.missingEvidence.filter((item) => !isLanguageBlocker(item));
  changed ||= risks.length !== score.risks.length || missingEvidence.length !== score.missingEvidence.length;
  if (!changed) return score;

  return {
    ...score,
    scoreBreakdown,
    fitScore: weightedScore(scoreBreakdown),
    risks,
    missingEvidence,
  };
}

function allowsAnyListedLanguage(demand: string) {
  return /中英文均可|中英文皆可|中文或英文|任一(?:语言)?(?:均)?可|任意一种|either\s+(?:Chinese|English)|Chinese\s+or\s+English|one\s+of\s+the\s+languages/i.test(demand);
}

function requiresAllListedLanguages(demand: string) {
  return /必须同时|均需具备|都需具备|中英文双语|双语能力|both\s+Chinese\s+and\s+English|bilingual/i.test(demand);
}

function normalizeLanguage(value: string) {
  const language = value.trim().toLowerCase();
  if (/^(中文|汉语|普通话|chinese|mandarin)$/.test(language)) return "zh";
  if (/^(英文|英语|english)$/.test(language)) return "en";
  return language;
}

function isLanguageBlocker(value: string) {
  return /language|Chinese|English|bilingual|语言|中文|英文|英语|汉语/i.test(value);
}

function weightedScore(items: ScoreCandidateOutput["scoreBreakdown"]) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return Math.round(items.reduce((sum, item) => sum + item.score, 0) / Math.max(items.length, 1));
  return Math.round(items.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight);
}

function normalizeUnqualifiedBudget(rawDemand: string, score: ScoreCandidateOutput): ScoreCandidateOutput {
  if (hasQualifiedBudget(rawDemand)) return score;

  let changed = false;
  const scoreBreakdown = score.scoreBreakdown.map((item) => {
    if (!containsBudgetConclusion(`${item.reason} ${item.evidence}`)) return item;
    changed = true;
    const availabilityDimension = /availability|可用|意愿/i.test(item.dimension);
    return {
      ...item,
      score: availabilityDimension ? Math.max(30, item.score) : item.score,
      evidence: availabilityDimension
        ? "当前没有可验证的可用时间或参与意愿信息。"
        : "项目未提供带币种和计价单位的有效预算信息。",
      reason: availabilityDimension
        ? "需要人工确认候选人的当前可用时间和合作意愿。"
        : "该维度不使用未注明币种和计价单位的预算数字。",
    };
  });
  const risks = score.risks.filter((item) => !containsBudgetConclusion(item));
  const missingEvidence = score.missingEvidence.filter((item) => !containsBudgetConclusion(item));
  const topReasons = score.topReasons.filter((item) => !containsBudgetConclusion(item));
  changed ||=
    risks.length !== score.risks.length ||
    missingEvidence.length !== score.missingEvidence.length ||
    topReasons.length !== score.topReasons.length ||
    containsBudgetConclusion(score.nextAction);
  if (!changed) return score;

  return {
    ...score,
    fitScore: weightedScore(scoreBreakdown),
    scoreBreakdown,
    topReasons,
    risks,
    missingEvidence,
    nextAction: containsBudgetConclusion(score.nextAction)
      ? "人工复核可用时间、合作意愿和联系许可后决定下一步。"
      : score.nextAction,
  };
}

function containsBudgetConclusion(value: string) {
  return /(?:\$\s*\d|USD|CNY|RMB|budget|预算|计价|报价|market\s+rate|市场价|\b\d{2,}\s*[-–]\s*\d{2,}\b)/i.test(value);
}

function isPositiveFitStatement(value: string) {
  if (!/^(?:domain_fit|credential_evidence|task_fit|领域匹配(?:度)?|资历证据|凭证证据|任务匹配(?:度)?)\s*:/i.test(value)) return false;
  return !/(?:no\s+evidence|missing|unknown|lack|weak|insufficient|needs?\s+review|unverified|unavailable|conflict|cannot|high[-\s]?risk|risk\s+(?:concern|issue|flag)|缺少|不足|未知|较弱|需要?复核|未验证|无法|冲突|存在风险|风险(?:较高|高|隐患|问题)|高风险)/i.test(value);
}

function strongerEvidenceLevel(modelLevel: ScoreCandidateOutput["evidenceLevel"], candidateLevel?: string | null) {
  const levels = ["E0", "E1", "E2", "E3", "E4"] as const;
  const modelIndex = levels.indexOf(modelLevel);
  const candidateIndex = levels.indexOf(candidateLevel?.toUpperCase() as (typeof levels)[number]);
  return levels[Math.max(modelIndex, candidateIndex >= 0 ? candidateIndex : 0)];
}
