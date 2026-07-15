import type { MARKETING_CHANNELS } from "@/lib/constants";
import type { MarketingCampaignOutput } from "@/lib/schemas";

type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

type ChannelGenerationResult =
  | { ok: true; data: MarketingCampaignOutput; usage: unknown }
  | { ok: false; error: string; usage?: unknown };

type ChannelOutcome =
  | {
      channel: MarketingChannel;
      ok: true;
      post: MarketingCampaignOutput["posts"][number];
      campaign: MarketingCampaignOutput;
      usage: unknown;
    }
  | { channel: MarketingChannel; ok: false; reason: string; usage: unknown };

const channelLengthGuidance: Record<MarketingChannel, string> = {
  linkedin: "正文控制在 500-900 个字符，专业、直接，适合职业网络阅读。",
  wechat: "正文控制在 400-700 个中文字符，信息完整但避免长篇铺陈。",
  xiaohongshu: "正文控制在 250-450 个中文字符，标题和要点便于移动端扫读。",
  zhihu: "正文控制在 500-900 个中文字符，突出专业问题与参与要求。",
  community: "正文控制在 250-500 个字符，适合技术社区直接转发。",
  email_newsletter: "正文控制在 400-700 个字符，主题和报名动作清楚。",
};

const channelNativeCta: Record<MarketingChannel, string> = {
  linkedin: "请私信发布账号并附上公开主页或作品链接；运营团队会人工复核后回复。",
  wechat: "请在公众号后台留言并附上公开主页或作品链接；运营团队会人工复核后回复。",
  xiaohongshu: "请私信发布账号并附上公开主页或作品链接；运营团队会人工复核后回复。",
  zhihu: "请私信发布账号或在评论区留言，并附上公开主页或作品链接；运营团队会人工复核后回复。",
  community: "请按社区规则私信发布者或回复帖子，并附上公开主页或作品链接；运营团队会人工复核后回复。",
  email_newsletter: "请回复本邮件并附上公开主页或作品链接；运营团队会人工复核后回复。",
};

export function buildMarketingChannelBrief(messageBrief: string, channel: MarketingChannel) {
  return [
    messageBrief.trim(),
    `本次仅为 ${channel} 渠道生成内容，只生成这一条渠道草稿。`,
    channelLengthGuidance[channel],
  ]
    .filter(Boolean)
    .join("\n");
}

export function mergeMarketingReviewNotes(postNotes: string[], campaignNotes: string[], requiredNotes: string[]) {
  return uniqueStrings(
    [...postNotes, ...requiredNotes, ...campaignNotes]
      .map(normalizeMarketingReviewNote)
      .filter((note): note is string => Boolean(note)),
  ).slice(0, 6);
}

export function sanitizeMarketingPostClaims(
  post: MarketingCampaignOutput["posts"][number],
  sourceText: string,
): MarketingCampaignOutput["posts"][number] {
  const paidTrialIsExplicit = /有偿试标|付费试标|带薪试标|试标.{0,8}(?:报酬|费用|结算)|\bpaid\s+trial\b/i.test(sourceText);
  if (paidTrialIsExplicit) return post;
  const sanitize = (value: string) =>
    value
      .replace(/\bpaid\s+trial\b/gi, "trial")
      .replace(/(?:有偿|付费|带薪)试标/g, "试标")
      .replace(/试标(?:任务)?(?:将|会)?(?:提供|支付)(?:报酬|费用)/g, "试标任务");
  return {
    ...post,
    title: sanitize(post.title),
    body: sanitize(post.body),
    cta: sanitize(post.cta),
  };
}

export function hasExecutableMarketingCta(cta: string) {
  return /https?:\/\//i.test(cta) ||
    /(私信|评论区|留言|公众号后台|回复(?:本邮件|帖子|消息)?|direct message|\bdm\b|comment|reply to|message the (?:poster|account))/i.test(cta);
}

export function ensureExecutableMarketingCta(channel: MarketingChannel, cta: string) {
  const value = cta.trim();
  return value && hasExecutableMarketingCta(value) ? value : channelNativeCta[channel];
}

export async function generateMarketingByChannel({
  channels,
  audience,
  generate,
  fallback,
}: {
  channels: MarketingChannel[];
  audience: string[];
  generate: (channel: MarketingChannel) => Promise<ChannelGenerationResult>;
  fallback: (channels: MarketingChannel[]) => MarketingCampaignOutput;
}) {
  const fallbackCampaign = fallback(channels);
  const fallbackByChannel = new Map(fallbackCampaign.posts.map((post) => [post.channel, post]));
  const outcomes: ChannelOutcome[] = [];
  for (const channel of channels) {
    try {
      const result = await generate(channel);
      if (!result.ok) {
        outcomes.push({ channel, ok: false, reason: result.error, usage: result.usage ?? null });
        continue;
      }
      const post = result.data.posts.find((item) => item.channel === channel);
      if (!post) {
        outcomes.push({
          channel,
          ok: false,
          reason: "Model output did not contain the requested channel.",
          usage: result.usage,
        });
        continue;
      }
      outcomes.push({ channel, ok: true, post, campaign: result.data, usage: result.usage });
    } catch (error) {
      outcomes.push({
        channel,
        ok: false,
        reason: error instanceof Error ? error.message : "Channel generation failed.",
        usage: null,
      });
    }
  }

  const successfulChannels = outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.channel);
  const fallbackChannels = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.channel);
  const failures = outcomes
    .filter((outcome): outcome is Extract<(typeof outcomes)[number], { ok: false }> => !outcome.ok)
    .map((outcome) => ({ channel: outcome.channel, reason: outcome.reason }));
  const posts = outcomes.map((outcome) => {
    if (outcome.ok) return { ...outcome.post, cta: ensureExecutableMarketingCta(outcome.channel, outcome.post.cta) };
    const fallbackPost = fallbackByChannel.get(outcome.channel);
    if (!fallbackPost) throw new Error(`Fallback output did not contain channel ${outcome.channel}.`);
    return { ...fallbackPost, cta: ensureExecutableMarketingCta(outcome.channel, fallbackPost.cta) };
  });
  const successfulCampaigns = outcomes.filter(
    (outcome): outcome is Extract<(typeof outcomes)[number], { ok: true }> => outcome.ok,
  );

  return {
    campaign: {
      campaignSummary:
        uniqueStrings(successfulCampaigns.map((outcome) => outcome.campaign.campaignSummary)).join("；") ||
        fallbackCampaign.campaignSummary,
      audience:
        audience.length > 0
          ? audience
          : uniqueStrings([
              ...successfulCampaigns.flatMap((outcome) => outcome.campaign.audience),
              ...fallbackCampaign.audience,
            ]),
      posts,
      reviewChecklist: uniqueStrings([
        ...successfulCampaigns.flatMap((outcome) => outcome.campaign.reviewChecklist),
        ...(fallbackChannels.length ? fallbackCampaign.reviewChecklist : []),
      ]),
    } satisfies MarketingCampaignOutput,
    successfulChannels,
    fallbackChannels,
    failures,
    usage: outcomes.map((outcome) => ({ channel: outcome.channel, usage: outcome.usage ?? null })),
  };
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeMarketingReviewNote(value: string) {
  const note = value.replace(/\s+/g, " ").trim();
  if (!note) return null;
  if (/[\u3400-\u9fff]/.test(note)) return note;
  if (/private|customer|internal id|sensitive|commercial data|client name/i.test(note)) {
    return "确认文案不包含候选隐私、客户名称或内部标识。";
  }
  if (/evidence|credential|repository link|review sample/i.test(note)) {
    return "确认证据要求可公开核验，且不涉及敏感或未脱敏数据。";
  }
  if (/exaggerated|earnings|guaranteed|unverifiable/i.test(note)) {
    return "不得承诺录用、收益或未经核验的资质。";
  }
  if (/trial|human review|screening|onboarding/i.test(note)) {
    return "确认试标、人工复核和正式任务边界与实际流程一致。";
  }
  if (/draft|publish|schedule|auto-publish|auto-scheduled/i.test(note)) {
    return "发布前须完成人工审批，不得自动外发。";
  }
  if (/cta|signup|application|reply|direct message/i.test(note)) {
    return "确认报名动作使用真实可执行的渠道入口。";
  }
  if (/protected attribute|gender|race|age/i.test(note)) {
    return "不得使用受保护属性筛选或推荐候选。";
  }
  return null;
}
