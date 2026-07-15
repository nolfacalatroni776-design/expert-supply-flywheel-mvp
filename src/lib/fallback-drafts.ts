import type { MARKETING_CHANNELS } from "@/lib/constants";
import type { MarketingCampaignOutput } from "@/lib/schemas";

type ProjectBrief = {
  title?: string | null;
  rawDemand?: string | null;
  domain?: string | null;
  taskType?: string | null;
  quantity?: number | null;
  languages?: string[];
  regions?: string[];
};

type CandidateBrief = {
  expert?: {
    name?: string | null;
    title?: string | null;
    domainTags?: string[];
  };
};

type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

export function buildFallbackOutreachDraft({
  project,
  candidate,
}: {
  project: ProjectBrief;
  candidate: CandidateBrief;
}) {
  const title = project.title || `${project.domain || "专业领域"}专家项目`;
  const taskType = project.taskType || "专家评审任务";
  const expertName = candidate.expert?.name || "老师";
  const expertTitle = candidate.expert?.title?.trim();
  const tags = candidate.expert?.domainTags?.slice(0, 4).filter(Boolean) ?? [];
  const expertiseText = tags.length ? tags.join("、") : project.domain || "相关领域";
  const languageText = project.languages?.length ? `工作语言为${project.languages.join("、")}` : "工作语言将在沟通时确认";
  const regionText = project.regions?.length ? `协作方式或地区为${project.regions.join("、")}` : "协作方式将在沟通时确认";

  return {
    subject: `${title} | 专家邀请`,
    body: [
      `${expertName}您好，`,
      `我们正在为「${title}」邀请专家参与${taskType}。${expertTitle ? `您作为${expertTitle}，在 ${expertiseText} 方面的经历与当前任务方向相关。` : `您在 ${expertiseText} 方面的经历与当前任务方向相关。`}`,
      `项目会先提供清晰的任务说明和小规模脱敏试标，${languageText}，${regionText}。试标结果只用于人工复核，不会自动决定录用或正式合作。`,
      "如您有兴趣，我们会进一步说明任务范围、投入时间、报酬与保密边界，待双方确认后再推进。",
      "如您暂时无法参与，也欢迎推荐合适的同行。如不希望继续联系或希望删除相关联系记录，请直接告知，我们会停止后续联系并按流程处理。",
    ].join("\n\n"),
    replyTemplates: {
      interested: "我有兴趣参与，请提供详细任务说明、试标材料和时间安排。",
      unavailable: "感谢邀请，我目前无法参与此次任务。",
      referral: "我暂时无法参与，但可以推荐一位合适的同行，请提供推荐方式。",
      priceQuestion: "请提供任务报酬、投入时间和结算方式。",
      ndaQuestion: "请提供保密范围和 NDA 文本供我了解。",
      noInterest: "感谢邀请，我对此项目不感兴趣，请停止后续跟进。",
      unsubscribe: "请停止后续联系，并将我标记为不再联系。",
      deletionRequest: "请删除非必要的个人联系记录，并确认处理结果。",
    },
  };
}

export function buildFallbackTrialTask({
  project,
  candidate,
}: {
  project: ProjectBrief;
  candidate: CandidateBrief;
}) {
  const taskType = project.taskType || "专家评审";
  const domain = project.domain || "项目相关领域";
  const expertName = candidate.expert?.name || "候选专家";
  const tags = candidate.expert?.domainTags?.slice(0, 4).join("、") || domain;

  return {
    instructions: [
      `请 ${expertName} 完成一轮小规模试标，用于验证其在「${domain} / ${taskType}」中的真实判断质量。`,
      `试标材料应使用脱敏样例，覆盖 ${tags} 相关能力点。`,
      "提交内容需包含：主要判断、证据依据、不确定性、风险提示、建议处理方式。",
      "试标结果只进入人工复核，不自动决定录用或入池。",
    ].join("\n"),
    rubric: {
      criteria: [
        {
          name: "领域判断准确性",
          weight: 35,
          description: "是否能识别关键问题、边界条件和任务相关风险。",
        },
        {
          name: "证据化解释",
          weight: 30,
          description: "是否给出可复核的理由、引用依据和不确定性说明。",
        },
        {
          name: "交付规范",
          weight: 20,
          description: "是否按要求格式提交，结论完整、结构清楚、可追踪。",
        },
        {
          name: "合规与沟通",
          weight: 15,
          description: "是否避免敏感信息扩散，并清楚说明需人工确认的事项。",
        },
      ],
      passThreshold: 75,
      reviewNotes: [
        "系统模板生成，需人工复核后使用。",
        "使用脱敏样例，不提供客户敏感数据。",
        "试标结果不自动决定录用、入池或正式合作。",
      ],
    },
  };
}

export function buildFallbackMarketingCampaign({
  project,
  channels,
  audience,
}: {
  project: ProjectBrief;
  channels: MarketingChannel[];
  audience: string[];
}): MarketingCampaignOutput {
  const title = project.title || `${project.domain || "专业领域"}专家招募`;
  const domain = project.domain || "相关领域";
  const taskType = project.taskType || "专家评审/标注";
  const quantityText = project.quantity ? `计划邀请约 ${project.quantity} 位专家。` : "名额将根据项目节奏确认。";
  const languageText = project.languages?.length ? `工作语言：${project.languages.join("、")}。` : "";
  const regionText = project.regions?.length ? `地区/协作方式：${project.regions.join("、")}。` : "";
  const coreBody = [
    `我们正在招募具备 ${domain} 经验的专家参与 ${taskType} 项目。`,
    quantityText,
    languageText,
    regionText,
    "正式合作前会先完成资料复核、任务说明确认和小规模试标。",
    "项目不会承诺自动录用或固定收益，合作范围和结算方式将在人工确认后明确。",
  ].filter(Boolean);

  return {
    campaignSummary: `系统模板生成的 ${title} 多渠道招募草稿。`,
    audience: audience.length ? audience : ["领域专家", "专家推荐人", "专业社区成员"],
    posts: channels.map((channel) => ({
      channel,
      title: channelTitle(channel, title),
      body: channelBody(channel, coreBody),
      cta: channelCta(channel),
      hashtags: channelHashtags(channel, domain),
      riskNotes: [
        "系统模板生成，发布前需人工复核。",
        "确认报名动作、试标流程和人工审核边界清晰。",
        "不得承诺录用、收益或自动入池。",
      ],
    })),
    reviewChecklist: [
      "确认不包含客户敏感信息。",
      "确认专家要求与项目实际需求一致。",
      "确认报名或推荐路径可用。",
      "确认试标与人工复核边界清楚。",
    ],
  };
}

function channelTitle(channel: MarketingChannel, title: string) {
  const prefix: Record<MarketingChannel, string> = {
    linkedin: "Expert Opportunity",
    xiaohongshu: "专家招募",
    wechat: "专家招募",
    zhihu: "项目招募",
    community: "社区招募",
    email_newsletter: "专家项目推荐",
  };
  return `${prefix[channel]}：${title}`;
}

function channelBody(channel: MarketingChannel, lines: string[]) {
  if (channel === "linkedin") return lines.join(" ");
  if (channel === "xiaohongshu") return lines.join("\n");
  return lines.join("\n");
}

function channelCta(channel: MarketingChannel) {
  if (channel === "linkedin") return "If you are interested or can recommend a suitable expert, please contact the operations team for manual review.";
  if (channel === "email_newsletter") return "如你符合条件或愿意推荐专家，请回复运营团队，我们会人工确认后推进。";
  return "如你符合条件或愿意推荐专家，请联系运营团队进行人工复核。";
}

function channelHashtags(channel: MarketingChannel, domain: string) {
  if (channel === "linkedin") return ["ExpertNetwork", "DataAnnotation", domain.replace(/\s+/g, "")].filter(Boolean);
  return ["专家招募", "数据标注", domain.replace(/\s+/g, "")].filter(Boolean);
}
