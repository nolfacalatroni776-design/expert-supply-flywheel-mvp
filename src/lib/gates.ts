import type { ProjectCandidate, Expert, Project } from "@prisma/client";
import { parseJson } from "./json";

const evidenceRank: Record<string, number> = {
  E0: 0,
  E1: 1,
  E2: 2,
  E3: 3,
  E4: 4,
};

const humanVerifiedStages = new Set([
  "verified",
  "approved_for_outreach",
  "contacted",
  "replied",
  "screening",
  "trial",
  "contracting",
  "onboarded",
  "active",
]);

export function canApproveForOutreach({
  candidate,
  expert,
  project,
}: {
  candidate: Pick<ProjectCandidate, "risksJson" | "humanReviewNeeded" | "fitScore" | "stage">;
  expert: Pick<Expert, "evidenceLevel" | "consentState" | "contactJson" | "sourceUrl">;
  project?: ProjectRiskContext | null;
}): { ok: true } | { ok: false; reason: string } {
  if (candidate.stage === "do_not_contact") {
    return { ok: false, reason: "该候选在当前项目中已标记为不再联系。" };
  }

  if (candidate.stage === "screened_out") {
    return { ok: false, reason: "该候选在当前项目中暂不推进。" };
  }

  if (candidate.humanReviewNeeded) {
    return {
      ok: false,
      reason: requiresProjectReview(project)
        ? "高风险或受监管项目需完成人工复核后才能生成触达草稿。"
        : "该候选需完成人工复核后才能生成触达草稿。",
    };
  }

  if (candidate.fitScore === null) {
    return { ok: false, reason: "请先完成匹配评分，再生成触达草稿。" };
  }

  if (candidate.fitScore < 75 && !humanVerifiedStages.has(candidate.stage)) {
    return { ok: false, reason: "匹配评分低于 75 分，需人工复核通过后才能生成触达草稿。" };
  }

  if ((evidenceRank[expert.evidenceLevel] ?? 0) < 2) {
    return { ok: false, reason: "证据等级需达到 E2 后才能生成触达草稿。" };
  }

  if (["unsubscribed", "do_not_contact", "delete_requested"].includes(expert.consentState)) {
    return { ok: false, reason: "候选已退订、不再联系或请求删除资料，不能触达。" };
  }

  const contact = parseJson<Record<string, unknown>>(expert.contactJson, {});
  const hasContactPermission =
    contact.contactPermissionBasis === "public_outreach_allowed" ||
    contact.contactPermissionBasis === "direct_consent" ||
    contact.contactPermissionBasis === "referral_consent";
  if (contact.email && !hasContactPermission) {
    return { ok: false, reason: "缺少合规联系路径或明确联系许可；公开主页不等于可触达许可。" };
  }
  const hasApprovedProfilePath =
    Boolean(contact.profileUrl || expert.sourceUrl) &&
    (contact.allowOutreach === true ||
      contact.profileAllowsOutreach === true ||
      contact.sourceAllowsOutreach === true ||
      hasContactPermission);
  if (!contact.email && !hasApprovedProfilePath) {
    return { ok: false, reason: "缺少合规联系路径或明确联系许可；公开主页不等于可触达许可。" };
  }

  const risks = parseJson<string[]>(candidate.risksJson, []);
  if (risks.some((risk) => risk.toLowerCase().includes("protected attribute"))) {
    return { ok: false, reason: "候选风险记录涉及受保护或敏感属性，需人工处理。" };
  }

  return { ok: true };
}

type ProjectRiskContext = Pick<Project, "riskLevel" | "domain"> &
  Partial<Pick<Project, "rawDemand" | "taskType">>;

const REGULATED_PROJECT_PATTERN =
  /medical|medicine|healthcare|clinical|hospital|patient|oncology|cancer|tumou?r|pathology|radiology|pharma|drug|legal|finance|insurance|biometric|defense|minors|safety[-\s]?critical|医学|医疗|临床|医院|患者|医生|肿瘤|癌症|病理|放射|药物|制药|法律|金融|保险|未成年人|生物识别|国防|安全关键|安全攸关/i;

export function isRegulatedProjectText(...values: Array<string | null | undefined>) {
  return REGULATED_PROJECT_PATTERN.test(values.filter(Boolean).join(" "));
}

export function getInitialProjectRiskLevel({
  rawDemand,
  domain,
  taskType,
}: {
  rawDemand: string;
  domain?: string | null;
  taskType?: string | null;
}) {
  return isRegulatedProjectText(rawDemand, domain, taskType) ? "regulated" : "medium";
}

export function requiresProjectReview(project?: ProjectRiskContext | null) {
  if (!project) return false;
  if (project.riskLevel === "regulated" || project.riskLevel === "high") return true;
  return isRegulatedProjectText(project.domain, project.taskType, project.rawDemand);
}
