import { z } from "zod";
import {
  CONSENT_STATES,
  EVIDENCE_LEVELS,
  MARKETING_CHANNELS,
  MARKETING_POST_STATUSES,
  PIPELINE_STAGES,
  RISK_LEVELS,
} from "./constants";

export const pipelineStageSchema = z.enum(PIPELINE_STAGES);
export const evidenceLevelSchema = z.enum(EVIDENCE_LEVELS);
export const riskLevelSchema = z.enum(RISK_LEVELS);
export const consentStateSchema = z.enum(CONSENT_STATES);
export const marketingChannelSchema = z.enum(MARKETING_CHANNELS);
export const marketingPostStatusSchema = z.enum(MARKETING_POST_STATUSES);

export const createProjectSchema = z.object({
  title: z.string().trim().min(3),
  rawDemand: z.string().trim().min(20),
  domain: z.string().trim().optional(),
  taskType: z.string().trim().optional(),
  quantity: z.coerce.number().int().positive().optional(),
  budgetMin: z.coerce.number().nonnegative().optional(),
  budgetMax: z.coerce.number().nonnegative().optional(),
  languages: z.array(z.string().trim().min(1)).default([]),
  regions: z.array(z.string().trim().min(1)).default([]),
});

const stringArraySchema = z
  .union([
    z.array(z.union([z.string(), z.number(), z.boolean()])),
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
  ])
  .optional()
  .transform((value) => {
    if (value === null || value === undefined) return [];
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => String(item).trim()).filter(Boolean);
  });

const nullablePositiveIntSchema = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  });

const nullableNonnegativeNumberSchema = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  });

const searchQueryItemSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .transform((value) => {
    if (typeof value === "string") return value.trim();
    const preferredKeys = ["query", "q", "searchQuery", "search_query", "keyword", "keywords"];
    for (const key of preferredKeys) {
      const item = value[key];
      if (typeof item === "string" && item.trim()) return item.trim();
    }
    const firstString = Object.values(value).find((item) => typeof item === "string" && item.trim().length > 0);
    return typeof firstString === "string" ? firstString.trim() : "";
  });

export const analyzeProjectOutputSchema = z.object({
  title: z.string().default(""),
  domain: z.string().default(""),
  taskType: z.string().default(""),
  quantity: nullablePositiveIntSchema.default(null),
  budgetMin: nullableNonnegativeNumberSchema.default(null),
  budgetMax: nullableNonnegativeNumberSchema.default(null),
  languages: stringArraySchema,
  regions: stringArraySchema,
  riskLevel: riskLevelSchema.catch("medium"),
  persona: z
    .object({
      summary: z.string().default(""),
      mustHave: stringArraySchema,
      niceToHave: stringArraySchema,
      exclude: stringArraySchema,
      taskFitSignals: stringArraySchema,
      evidenceRequirements: stringArraySchema,
      humanReviewPoints: stringArraySchema,
    })
    .default({
      summary: "",
      mustHave: [],
      niceToHave: [],
      exclude: [],
      taskFitSignals: [],
      evidenceRequirements: [],
      humanReviewPoints: [],
    }),
  searchQueries: z
    .array(searchQueryItemSchema)
    .default([])
    .transform((queries) => Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean))).slice(0, 8)),
});

export type AnalyzeProjectOutput = z.infer<typeof analyzeProjectOutputSchema>;

const publicUrlSchema = z
  .string()
  .url()
  .refine((url) => /^https?:\/\//i.test(url), "Only HTTP(S) URLs are supported.");

export const searchResultSchema = z.object({
  title: z.string(),
  url: publicUrlSchema,
  snippet: z.string().default(""),
  position: z.number().int().optional(),
});

const nullableStringSchema = z
  .union([z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))])
  .optional()
  .nullable()
  .transform((value) => {
    if (typeof value === "string") return value.trim() ? value.trim() : null;
    if (Array.isArray(value)) {
      const joined = value.map((item) => String(item).trim()).filter(Boolean).join(", ");
      return joined || null;
    }
    return null;
  });

const candidateEvidenceClaimSchema = z.object({
  claim: z.string().default("公开搜索结果显示该候选可能与项目需求相关"),
  sourceUrl: publicUrlSchema,
  sourceTitle: nullableStringSchema,
  sourceType: z.string().default("public_web"),
  snippet: z.string().default(""),
  evidenceLevel: evidenceLevelSchema.catch("E1"),
  confidence: z.number().min(0).max(1).catch(0.5),
});

export const extractedCandidateSchema = z.object({
  name: z.string().min(1),
  title: nullableStringSchema,
  affiliation: nullableStringSchema,
  sourceUrl: publicUrlSchema,
  domainTags: stringArraySchema,
  languages: stringArraySchema,
  region: nullableStringSchema,
  lastActiveAt: z.string().datetime({ offset: true }).optional().nullable(),
  evidenceLevel: evidenceLevelSchema.catch("E1"),
  claims: z.array(candidateEvidenceClaimSchema).default([]),
  risks: stringArraySchema,
}).transform((candidate) => ({
  ...candidate,
  claims: candidate.claims.length
    ? candidate.claims
    : [
        {
          claim: "公开搜索结果显示该候选可能与项目需求相关",
          sourceUrl: candidate.sourceUrl,
          sourceTitle: candidate.title ?? candidate.name,
          sourceType: "public_web",
          snippet: [candidate.title, candidate.affiliation, candidate.domainTags.join(", ")].filter(Boolean).join(" · "),
          evidenceLevel: "E1" as const,
          confidence: 0.45,
        },
      ],
}));

export const extractCandidatesOutputSchema = z
  .union([
    z.object({
      candidates: z.array(extractedCandidateSchema).max(20),
    }),
    z.array(extractedCandidateSchema).max(20),
  ])
  .transform((output) => (Array.isArray(output) ? { candidates: output } : output));

export type ExtractCandidatesOutput = z.infer<typeof extractCandidatesOutputSchema>;

const scoreBreakdownItemSchema = z.object({
  dimension: z.string().default("未命名维度"),
  score: z.coerce.number().min(0).max(100).catch(50),
  weight: z.coerce.number().min(0).max(100).catch(0),
  evidence: z.string().default("未提供证据"),
  reason: z.string().optional(),
  explanation: z.string().optional(),
  notes: z.string().optional(),
}).transform((item) => ({
  dimension: item.dimension,
  score: Math.round(item.score),
  weight: item.weight,
  evidence: item.evidence,
  reason: item.reason || item.explanation || item.notes || item.evidence || "模型未提供该维度解释。",
}));

export const scoreCandidateOutputSchema = z.object({
  fitScore: z.coerce.number().int().min(0).max(100).optional(),
  evidenceLevel: evidenceLevelSchema.catch("E1"),
  scoreBreakdown: z.array(scoreBreakdownItemSchema).min(3).max(6),
  topReasons: stringArraySchema,
  risks: stringArraySchema,
  missingEvidence: stringArraySchema,
  nextAction: z.string().default("人工复核证据后决定下一步。"),
  humanReviewRequired: z.boolean().default(true),
}).transform((score) => {
  const rawTotalWeight = score.scoreBreakdown.reduce((sum, item) => sum + item.weight, 0);
  const usesFractionalWeights = rawTotalWeight > 0 && score.scoreBreakdown.every((item) => item.weight <= 1);
  const maxDimensionScore = Math.max(...score.scoreBreakdown.map((item) => item.score));
  const usesTenPointScale = maxDimensionScore >= 8 && maxDimensionScore <= 10 && (score.fitScore === undefined || score.fitScore <= 20);
  const defaultWeight = Math.floor(100 / score.scoreBreakdown.length);
  const defaultWeightRemainder = 100 - defaultWeight * score.scoreBreakdown.length;
  const scoreBreakdown = score.scoreBreakdown.map((item) => ({
    ...item,
    score: usesTenPointScale ? item.score * 10 : item.score,
    weight:
      rawTotalWeight === 0
        ? defaultWeight + (score.scoreBreakdown.indexOf(item) < defaultWeightRemainder ? 1 : 0)
        : usesFractionalWeights
          ? Math.round(item.weight * 100)
          : item.weight,
  }));
  const totalWeight = scoreBreakdown.reduce((sum, item) => sum + item.weight, 0);
  const weightedScore =
    totalWeight > 0
      ? scoreBreakdown.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight
      : scoreBreakdown.reduce((sum, item) => sum + item.score, 0) / scoreBreakdown.length;
  const derivedRisks = scoreBreakdown
    .filter((item) => item.score < 40 || /risk|compliance|合规|风险/i.test(`${item.dimension} ${item.reason} ${item.evidence}`))
    .map((item) => `${item.dimension}: ${item.reason}`);
  const derivedFitScore = Math.round(weightedScore);
  const fitScore =
    score.fitScore !== undefined && Math.abs(score.fitScore - derivedFitScore) <= 15
      ? score.fitScore
      : derivedFitScore;
  return {
    ...score,
    scoreBreakdown,
    fitScore,
    topReasons: score.topReasons.length
      ? score.topReasons
      : scoreBreakdown
          .slice()
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((item) => `${item.dimension}: ${item.reason}`),
    risks: score.risks.length ? score.risks : derivedRisks,
    missingEvidence: score.missingEvidence.length
      ? score.missingEvidence
      : scoreBreakdown
          .filter((item) => item.evidence.includes("未") || item.score < 60)
          .map((item) => `${item.dimension}: ${item.evidence}`),
  };
});

export type ScoreCandidateOutput = z.infer<typeof scoreCandidateOutputSchema>;

const marketingChannelInputSchema = z
  .string()
  .transform((channel) => {
    const normalized = channel.trim().toLowerCase().replace(/\s+/g, "_");
    const aliases: Record<string, (typeof MARKETING_CHANNELS)[number]> = {
      "小红书": "xiaohongshu",
      rednote: "xiaohongshu",
      weixin: "wechat",
      "微信公众号": "wechat",
      "公众号": "wechat",
      zhihu: "zhihu",
      "知乎": "zhihu",
      linkedin: "linkedin",
      community: "community",
      "社群": "community",
      newsletter: "email_newsletter",
      email: "email_newsletter",
    };
    return aliases[normalized] ?? normalized;
  })
  .pipe(marketingChannelSchema.catch("community"));

const marketingPostSchema = z
  .record(z.string(), z.unknown())
  .transform((post) => {
    const nestedPost = typeof post.post === "object" && post.post !== null ? (post.post as Record<string, unknown>) : {};
    const content = typeof post.content === "object" && post.content !== null ? (post.content as Record<string, unknown>) : {};
    return { ...post, ...nestedPost, ...content };
  })
  .pipe(
    z.object({
      channel: marketingChannelInputSchema.default("community"),
      title: z.string().optional(),
      headline: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      content: z.string().optional(),
      copy: z.string().optional(),
      text: z.string().optional(),
      cta: z.string().optional(),
      callToAction: z.string().optional(),
      hashtags: stringArraySchema,
      riskNotes: stringArraySchema,
      reviewNotes: stringArraySchema,
    }),
  )
  .transform((post) => ({
    channel: post.channel,
    title: post.title || post.headline || post.subject || "专家项目招募",
    body: cleanMarketingBody(
      post.body || post.content || post.copy || post.text || "我们正在招募符合项目需求的专家参与标注/评审任务，欢迎回复或推荐合适人选。",
    ),
    cta: post.cta || post.callToAction || "如有相关经验，欢迎回复或推荐合适专家。",
    hashtags: post.hashtags,
    riskNotes: post.riskNotes.length ? post.riskNotes : post.reviewNotes,
  }));

function cleanMarketingBody(body: string) {
  return body
    .replace(/\n+\s*(CTA|Call to action|riskNotes?|Review notes?)\s*[:：][\s\S]*$/i, "")
    .trim();
}

function collectMarketingPosts(output: Record<string, unknown>): unknown[] {
  const direct =
    output.posts ??
    output.channelPosts ??
    output.channel_posts ??
    output.drafts ??
    output.marketingPosts ??
    output.marketing_posts ??
    output.socialPosts ??
    output.social_posts ??
    output.channels;
  if (Array.isArray(direct)) {
    return direct
      .map((item) =>
        item && typeof item === "object"
          ? { ...(output.channel ? { channel: output.channel } : {}), ...(item as Record<string, unknown>) }
          : item,
      )
      .slice(0, MARKETING_CHANNELS.length);
  }
  if (direct && typeof direct === "object") {
    return Object.entries(direct as Record<string, unknown>).map(([channel, value]) =>
      value && typeof value === "object" ? { channel, ...(value as Record<string, unknown>) } : { channel, body: String(value ?? "") },
    ).slice(0, MARKETING_CHANNELS.length);
  }

  const nestedKeys = ["campaign", "marketingPlan", "marketing_plan", "contentPlan", "content_plan", "plan", "result", "data"];
  for (const key of nestedKeys) {
    const nested = output[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const posts = collectMarketingPosts(nested as Record<string, unknown>);
      if (posts.length) return posts;
    }
  }

  if (typeof output.channel === "string") return [output].slice(0, MARKETING_CHANNELS.length);

  const channelKeyedPosts = Object.entries(output)
    .filter(([key, value]) => marketingChannelInputSchema.safeParse(key).success && value && typeof value === "object")
    .map(([channel, value]) => ({ channel, ...(value as Record<string, unknown>) }));
  if (channelKeyedPosts.length) return channelKeyedPosts.slice(0, MARKETING_CHANNELS.length);

  return [];
}

function readStringArray(output: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = output[key];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return [value];
  }
  for (const key of ["campaign", "marketingPlan", "marketing_plan", "contentPlan", "content_plan", "plan", "result", "data"]) {
    const nested = output[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedValue = readStringArray(nested as Record<string, unknown>, keys);
      if (nestedValue.length) return nestedValue;
    }
  }
  return [];
}

function readString(output: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = output[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const key of ["campaign", "marketingPlan", "marketing_plan", "contentPlan", "content_plan", "plan", "result", "data"]) {
    const nested = output[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedValue = readString(nested as Record<string, unknown>, keys);
      if (nestedValue) return nestedValue;
    }
  }
  return "";
}

export const marketingCampaignOutputSchema = z
  .record(z.string(), z.unknown())
  .transform((output, ctx) => {
    const rawPosts = collectMarketingPosts(output);
    const posts: Array<z.infer<typeof marketingPostSchema>> = [];
    for (const post of rawPosts) {
      const parsedPost = marketingPostSchema.safeParse(post);
      if (parsedPost.success) posts.push(parsedPost.data);
    }

    if (!posts.length) {
      ctx.addIssue({
        code: "custom",
        message: "Marketing campaign output did not contain any channel posts.",
        path: ["posts"],
      });
      return z.NEVER;
    }

    const audienceRaw = readStringArray(output, ["audience", "targetAudience", "target_audience"]);
    const reviewRaw = readStringArray(output, ["reviewChecklist", "review_checklist", "complianceChecklist", "compliance_checklist"]);

    const audience = audienceRaw.map((item) => String(item).trim()).filter(Boolean);
    const reviewChecklist = reviewRaw.map((item) => String(item).trim()).filter(Boolean);

    return {
      campaignSummary:
        readString(output, ["campaignSummary", "campaign_summary", "summary", "campaignGoal", "campaign_goal", "objective"]) ||
        "为项目需求生成多渠道专家招募文案。",
      audience,
      posts,
      reviewChecklist: reviewChecklist.length
        ? reviewChecklist
        : ["确认项目需求可公开发布。", "移除敏感客户、预算和未授权数据。", "发布前由运营人工审批。"],
    };
  });

export type MarketingCampaignOutput = z.infer<typeof marketingCampaignOutputSchema>;

const defaultReplyTemplates = {
  interested: "感谢回复。我们会补充项目范围、时间安排和试标说明，确认后再推进下一步。",
  unavailable: "感谢告知。如您愿意，也欢迎推荐更合适的专家。",
  referral: "感谢推荐。我们会仅基于公开信息和对方同意进行后续沟通。",
  priceQuestion: "预算会根据任务复杂度、投入时间和试标结果确认，正式合作前会明确报价和结算方式。",
  ndaQuestion: "正式接触任何敏感数据前会先签署 NDA，并优先使用脱敏样例进行试标。",
  noInterest: "感谢回复。我们会停止本次触达，不再继续跟进该项目。",
  unsubscribe: "已记录不再联系请求，后续不会再就此项目触达。",
  deletionRequest: "已记录删除请求，我们会按内部流程移除非必要联系记录。",
};

const replyTemplatesSchema = z
  .unknown()
  .optional()
  .transform((templates) => normalizeReplyTemplates(templates));

export const outreachOutputSchema = z
  .record(z.string(), z.unknown())
  .transform((output, ctx) => {
    const nested = ["outreachDraft", "outreach_draft", "email", "message", "outreach"]
      .map((key) => output[key])
      .find((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
    const draft = nested ? { ...output, ...nested } : output;
    const subject = readString(draft, ["subject", "title", "headline"]);
    const body = readString(draft, ["body", "draft", "content", "message", "text"]);

    if (subject.length < 4 || body.length < 12) {
      ctx.addIssue({
        code: "custom",
        message: "Outreach output must include a specific subject and body.",
        path: [subject.length < 4 ? "subject" : "body"],
      });
      return z.NEVER;
    }

    if (!/[。！？.!?][”"']?$/.test(body)) {
      ctx.addIssue({
        code: "custom",
        message: "Outreach body must end with a complete sentence.",
        path: ["body"],
      });
      return z.NEVER;
    }

    if (
      /consentState|contactPermissionBasis|profileAllowsOutreach|sourceAllowsOutreach|\bconsented\b|\bdirect_consent\b|\breferral_consent\b|\bE[0-4]\b|expert-ops\.local|内部证据等级|内部质量指标/i.test(
        body,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Outreach body must not expose internal operational metadata.",
        path: ["body"],
      });
      return z.NEVER;
    }

    return {
      subject,
      body,
      replyTemplates: replyTemplatesSchema.parse(output.replyTemplates ?? nested?.replyTemplates),
    };
  })
;

function normalizeReplyTemplates(value: unknown) {
  const overrides: Partial<typeof defaultReplyTemplates> = {};

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(defaultReplyTemplates) as Array<keyof typeof defaultReplyTemplates>) {
      const template = (value as Record<string, unknown>)[key];
      if (typeof template === "string" && template.trim()) overrides[key] = template.trim();
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const scenario = readString(record, ["scenario", "case", "intent", "label", "type"]);
      const body = readString(record, ["body", "reply", "response", "content", "text"]);
      if (!scenario || !body) continue;
      const key = replyTemplateKeyForScenario(scenario);
      if (key) overrides[key] = body;
    }
  }

  return { ...defaultReplyTemplates, ...overrides };
}

function replyTemplateKeyForScenario(scenario: string): keyof typeof defaultReplyTemplates | null {
  if (/删除|delete/i.test(scenario)) return "deletionRequest";
  if (/不再联系|退订|unsubscribe|opt.?out/i.test(scenario)) return "unsubscribe";
  if (/拒绝|不感兴趣|no.?interest|decline/i.test(scenario)) return "noInterest";
  if (/推荐|referr/i.test(scenario)) return "referral";
  if (/预算|价格|报价|price|budget/i.test(scenario)) return "priceQuestion";
  if (/保密|nda/i.test(scenario)) return "ndaQuestion";
  if (/时间|无法参与|没空|unavailable|later/i.test(scenario)) return "unavailable";
  if (/愿意|参与|有兴趣|确认|interested|accept/i.test(scenario)) return "interested";
  return null;
}

const defaultTrialCriteria = [
  {
    name: "领域判断准确性",
    weight: 35,
    description: "能否基于脱敏样例指出核心问题、边界条件和判断依据。",
  },
  {
    name: "证据化评审",
    weight: 30,
    description: "是否给出可复核的理由，而不是只给结论。",
  },
  {
    name: "沟通与合规",
    weight: 20,
    description: "是否避免不必要敏感信息，并能清楚说明不确定性。",
  },
  {
    name: "交付稳定性",
    weight: 15,
    description: "是否按要求格式提交，结论完整、可追踪。",
  },
];

const trialCriterionSchema = z
  .object({
    name: z.string().optional(),
    criterion: z.string().optional(),
    dimension: z.string().optional(),
    weight: z.coerce.number().min(0).max(100).catch(0),
    description: z.string().optional(),
    rubric: z.string().optional(),
    expectation: z.string().optional(),
  })
  .transform((criterion) => ({
    name: criterion.name || criterion.criterion || criterion.dimension || "试标维度",
    weight: criterion.weight,
    description: criterion.description || criterion.rubric || criterion.expectation || "按项目要求人工复核该维度。",
  }));

const trialRubricSchema = z
  .object({
    criteria: z.array(trialCriterionSchema).optional(),
    passThreshold: z.coerce.number().min(0).max(100).catch(75).optional(),
    totalMaxScore: z.coerce.number().positive().max(10_000).optional(),
    perQuestionCriteria: z.record(z.string(), z.unknown()).optional(),
    reviewNotes: stringArraySchema,
    autoFailConditions: stringArraySchema,
  })
  .transform((rubric) => {
    const derivedCriteria = rubric.perQuestionCriteria ? trialCriteriaFromRecord(rubric.perQuestionCriteria) : [];
    const criteria = rubric.criteria?.length ? rubric.criteria : derivedCriteria.length ? derivedCriteria : defaultTrialCriteria;
    const rawThreshold = rubric.passThreshold ?? 75;
    const passThreshold =
      rubric.totalMaxScore && rawThreshold <= rubric.totalMaxScore
        ? Math.round((rawThreshold / rubric.totalMaxScore) * 100)
        : Math.round(rawThreshold);
    const reviewNotes = Array.from(new Set([...rubric.reviewNotes, ...rubric.autoFailConditions]));
    return {
      criteria,
      passThreshold,
      reviewNotes: reviewNotes.length
        ? reviewNotes
        : ["使用脱敏样例。", "试标结果仅用于人工复核，不自动决定录用。", "记录不确定性和缺失证据。"],
    };
  });

function trialCriteriaFromRecord(criteria: Record<string, unknown>) {
  const entries = Object.entries(criteria).filter(([, description]) => typeof description === "string" && description.trim());
  const weights = entries.length === 3 ? [40, 35, 25] : entries.map(() => Math.floor(100 / Math.max(entries.length, 1)));
  return entries.map(([key, description], index) => ({
    name: trialCriterionLabel(key),
    weight: weights[index] ?? 0,
    description: String(description).trim(),
  }));
}

function trialCriterionLabel(key: string) {
  const labels: Record<string, string> = {
    correctness: "判断准确性",
    rationaleQuality: "证据化解释",
    arbitrationSpecific: "仲裁处理",
  };
  return labels[key] ?? key.replace(/[_-]+/g, " ");
}

const instructionSchema = z
  .union([z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))])
  .optional()
  .transform((value) => {
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).join("\n");
    return "";
  });

export const trialTaskOutputSchema = z
  .record(z.string(), z.unknown())
  .transform((output) => {
    const nested =
      (typeof output.trialTask === "object" && output.trialTask !== null ? output.trialTask : null) ??
      (typeof output.task === "object" && output.task !== null ? output.task : null) ??
      (typeof output.trial === "object" && output.trial !== null ? output.trial : null) ??
      output;
    return nested as Record<string, unknown>;
  })
  .pipe(
    z
      .object({
        instructions: instructionSchema,
        instruction: instructionSchema,
        taskDescription: instructionSchema,
        description: instructionSchema,
        prompt: instructionSchema,
        rubric: trialRubricSchema.optional(),
        scoringRubric: trialRubricSchema.optional(),
        scoring_rubric: trialRubricSchema.optional(),
      })
      .transform((output) => {
        const modelRubric = output.rubric ?? output.scoringRubric ?? output.scoring_rubric;
        return {
          instructions:
            output.instructions ||
            output.instruction ||
            output.taskDescription ||
            output.description ||
            output.prompt ||
            "请候选专家基于一段脱敏样例完成小规模评审，指出主要问题、判断依据、风险、不确定性和建议处理方式。",
          rubric: modelRubric ?? {
            criteria: defaultTrialCriteria,
            passThreshold: 75,
            reviewNotes: ["使用脱敏样例。", "试标结果仅用于人工复核，不自动决定录用。", "记录不确定性和缺失证据。"],
          },
          usedDefaultRubric: !modelRubric,
        };
      }),
  );

export const trialResultSchema = z.object({
  score: z.coerce.number().min(0).max(100),
  outcome: z.enum(["passed", "failed", "needs_review"]),
  notes: z.string().optional(),
});

export const qualityEventSchema = z.object({
  eventType: z.enum([
    "recalled",
    "contacted",
    "replied",
    "declined",
    "trial_started",
    "trial_passed",
    "trial_failed",
    "onboarded",
    "activated",
    "unsubscribed",
    "delete_requested",
  ]),
  projectId: z.string().optional(),
  candidateId: z.string().optional(),
  channel: z.string().trim().max(80).optional(),
  score: z.coerce.number().min(0).max(100).optional(),
  notes: z.string().trim().max(1200).optional().default(""),
});

export const supplyGapOutputSchema = z.object({
  gaps: z
    .array(
      z.object({
        gapType: z.string().default("capacity"),
        description: z.string(),
        requiredCount: z.coerce.number().int().min(0).default(0),
        availableCount: z.coerce.number().int().min(0).default(0),
        severity: z.enum(["low", "medium", "high", "critical"]).catch("medium"),
        recommendedAction: z.string().default("补充外部搜索并人工复核候选。"),
      }),
    )
    .default([]),
  searchDirections: stringArraySchema,
  summary: z.string().default("供给缺口已分析。"),
});

export const supplyRankOutputSchema = z.object({
  candidates: z
    .array(
      z.object({
        candidateId: z.string(),
        conversionProbability: z.coerce.number().min(0).max(1).catch(0.5),
        rankReasons: stringArraySchema,
        risks: stringArraySchema,
        nextAction: z.string().default("人工复核后决定下一步。"),
      }),
    )
    .default([]),
});

const retrospectiveSummarySchema = z.unknown().optional().transform((value) => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["topFinding", "top_finding", "summary", "finding", "detail"]) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
    }
  }
  return "招募复盘已生成。";
});

const retrospectiveItemsSchema = z.unknown().optional().transform((value) => {
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return items.map(formatRetrospectiveItem).filter(Boolean);
});

function formatRetrospectiveItem(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" ? record[key].trim() : "");
  const action = text("action");
  if (action) return [action, text("detail")].filter(Boolean).join("：");
  const lead = text("area") || text("source") || text("title");
  const detail = text("detail") || text("assessment") || text("summary") || text("topFinding") || text("finding");
  const impact = text("impact");
  const body = [detail, impact].filter(Boolean).join(" ");
  return lead && body ? `${lead}：${body}` : lead || body;
}

export const recruitmentRetrospectiveOutputSchema = z.object({
  summary: retrospectiveSummarySchema,
  wins: retrospectiveItemsSchema,
  bottlenecks: retrospectiveItemsSchema,
  sourceInsights: retrospectiveItemsSchema,
  nextActions: retrospectiveItemsSchema,
});
