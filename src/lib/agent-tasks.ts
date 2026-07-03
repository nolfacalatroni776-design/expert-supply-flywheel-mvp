export const AGENT_INTENTS = [
  "full_sourcing",
  "analyze_project",
  "search_candidates",
  "generate_marketing",
  "internal_match",
  "analyze_supply_gap",
  "external_research",
  "rank_supply",
  "recruitment_retrospective",
] as const;

export type AgentIntent = (typeof AGENT_INTENTS)[number];

export type AgentRunStatus =
  | "planned"
  | "preflight_failed"
  | "waiting_for_confirmation"
  | "running"
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "cancelled";

export type AgentStepStatus = "pending" | "running" | "succeeded" | "skipped" | "blocked" | "failed";

export type AgentStepKey =
  | "check_project"
  | "analyze_project"
  | "internal_match"
  | "analyze_supply_gap"
  | "confirm_external_search"
  | "external_research"
  | "search_candidates"
  | "rank_supply"
  | "generate_marketing"
  | "recruitment_retrospective"
  | "quality_report";

export type AgentTaskStepDefinition = {
  key: AgentStepKey;
  label: string;
  description: string;
  requiresConfirmation?: boolean;
};

export type AgentTaskTemplate = {
  intent: AgentIntent;
  label: string;
  objective: string;
  steps: AgentTaskStepDefinition[];
};

const stepDefinitions: Record<AgentStepKey, AgentTaskStepDefinition> = {
  check_project: {
    key: "check_project",
    label: "检查项目资料",
    description: "确认需求、目标数量、画像、候选和渠道准备是否足够支持本次任务。",
  },
  analyze_project: {
    key: "analyze_project",
    label: "补齐需求画像",
    description: "整理专家画像、硬性要求、证据要求和搜索方向。",
  },
  internal_match: {
    key: "internal_match",
    label: "召回内部专家",
    description: "优先从专家库和历史合作记录中找到可复用候选。",
  },
  analyze_supply_gap: {
    key: "analyze_supply_gap",
    label: "分析供给缺口",
    description: "判断还缺什么类型的专家、缺多少，以及下一步补给方向。",
  },
  confirm_external_search: {
    key: "confirm_external_search",
    label: "确认调用外部搜索",
    description: "外部搜索会优先复用已保存结果；未保存的查询需要确认后执行。",
    requiresConfirmation: true,
  },
  external_research: {
    key: "external_research",
    label: "补充公开候选",
    description: "按缺口从公开来源发现候选，并保存证据和来源记录。",
  },
  search_candidates: {
    key: "search_candidates",
    label: "搜索候选",
    description: "根据项目搜索式发现候选并整理证据。",
  },
  rank_supply: {
    key: "rank_supply",
    label: "更新候选排序",
    description: "统一排序内部召回和外部发现候选，给出下一步动作。",
  },
  generate_marketing: {
    key: "generate_marketing",
    label: "生成分发内容",
    description: "生成多渠道招募内容，进入复核队列后再确认发布进展。",
  },
  recruitment_retrospective: {
    key: "recruitment_retrospective",
    label: "生成项目复盘",
    description: "汇总漏斗、来源质量和下一轮供给策略。",
  },
  quality_report: {
    key: "quality_report",
    label: "整理执行结果",
    description: "汇总完成事项、跳过原因、失败原因、写入数据和下一步建议。",
  },
};

function steps(keys: AgentStepKey[]) {
  return keys.map((key) => stepDefinitions[key]);
}

export const agentTaskTemplates: Record<AgentIntent, AgentTaskTemplate> = {
  full_sourcing: {
    intent: "full_sourcing",
    label: "完整发现候选",
    objective: "从需求画像开始，先召回内部专家，再分析缺口，必要时补充公开候选并完成统一排序。",
    steps: steps([
      "check_project",
      "analyze_project",
      "internal_match",
      "analyze_supply_gap",
      "confirm_external_search",
      "external_research",
      "rank_supply",
      "quality_report",
    ]),
  },
  analyze_project: {
    intent: "analyze_project",
    label: "补齐需求画像",
    objective: "把项目需求整理成可执行的专家画像、约束、证据要求和搜索方向。",
    steps: steps(["check_project", "analyze_project", "quality_report"]),
  },
  search_candidates: {
    intent: "search_candidates",
    label: "搜索候选",
    objective: "按项目搜索式发现公开候选并整理证据。",
    steps: steps(["check_project", "confirm_external_search", "search_candidates", "quality_report"]),
  },
  generate_marketing: {
    intent: "generate_marketing",
    label: "生成分发内容",
    objective: "生成渠道招募内容并进入人工复核。",
    steps: steps(["check_project", "generate_marketing", "quality_report"]),
  },
  internal_match: {
    intent: "internal_match",
    label: "召回内部专家",
    objective: "优先从内部专家库召回可复用候选。",
    steps: steps(["check_project", "internal_match", "quality_report"]),
  },
  analyze_supply_gap: {
    intent: "analyze_supply_gap",
    label: "分析供给缺口",
    objective: "基于内部召回和当前候选，判断供给缺口和补给策略。",
    steps: steps(["check_project", "analyze_supply_gap", "quality_report"]),
  },
  external_research: {
    intent: "external_research",
    label: "补充公开候选",
    objective: "围绕供给缺口执行公开来源深搜，补充候选和证据。",
    steps: steps(["check_project", "confirm_external_search", "external_research", "quality_report"]),
  },
  rank_supply: {
    intent: "rank_supply",
    label: "更新候选排序",
    objective: "按证据、匹配度、可触达状态和转化概率整理候选优先级。",
    steps: steps(["check_project", "rank_supply", "quality_report"]),
  },
  recruitment_retrospective: {
    intent: "recruitment_retrospective",
    label: "生成项目复盘",
    objective: "汇总本项目招募漏斗、来源质量和下一轮策略建议。",
    steps: steps(["check_project", "recruitment_retrospective", "quality_report"]),
  },
};

export function isAgentIntent(value: unknown): value is AgentIntent {
  return typeof value === "string" && (AGENT_INTENTS as readonly string[]).includes(value);
}

export function getAgentTaskTemplate(intent: AgentIntent) {
  return agentTaskTemplates[intent];
}

export function getAgentIntentLabel(intent: AgentIntent | string) {
  return isAgentIntent(intent) ? agentTaskTemplates[intent].label : "招募任务";
}
