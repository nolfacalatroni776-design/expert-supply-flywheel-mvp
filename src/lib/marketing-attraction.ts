import { hasExecutableMarketingCta } from "@/lib/marketing-generation";

type MarketingPostLike = {
  channel?: string | null;
  title?: string | null;
  body?: string | null;
  cta?: string | null;
  riskNotes?: string[] | null;
};

export type MarketingAttractionReport = {
  passed: boolean;
  channels: string[];
  totalPosts: number;
  readyPosts: number;
  blockers: string[];
  needsReview: string[];
  nextActions: string[];
};

export function evaluateMarketingAttractionReadiness({
  posts,
  sourceText = "",
}: {
  posts: MarketingPostLike[];
  sourceText?: string;
}): MarketingAttractionReport {
  const channels = unique(posts.map((post) => post.channel?.trim()).filter((channel): channel is string => Boolean(channel)));
  const blockers: string[] = [];
  let readyPosts = 0;

  for (const post of posts) {
    const text = `${post.title ?? ""} ${post.body ?? ""} ${post.cta ?? ""}`;
    const postBlockers = evaluatePost(post, text, sourceText);
    if (postBlockers.length) blockers.push(...postBlockers);
    else readyPosts += 1;
  }

  if (!posts.length) blockers.push("没有可复核的渠道内容。");
  if (channels.length < Math.min(2, posts.length || 2)) blockers.push("渠道覆盖不足。");

  return {
    passed: blockers.length === 0,
    channels,
    totalPosts: posts.length,
    readyPosts,
    blockers: unique(blockers),
    needsReview: unique([
      "发布前确认不包含客户敏感信息。",
      "确认报名动作、试标流程和人工审核边界清晰。",
      "不得承诺录用、收益或自动入池。",
    ]),
    nextActions: blockers.length ? ["修正文案后重新进入复核。"] : ["进入渠道中心逐条复核后再发布。"],
  };
}

function evaluatePost(post: MarketingPostLike, text: string, sourceText: string) {
  const blockers: string[] = [];
  const body = post.body?.trim() ?? "";
  const cta = post.cta?.trim() ?? "";
  const riskNotes = post.riskNotes ?? [];

  if (!body || body.length < 30) blockers.push("招募内容不完整。");
  if (!/(专家|医生|工程师|开发者|研究员|顾问|reviewer|expert|developer|radiologist)/i.test(text)) blockers.push("目标专家不清晰。");
  if (!/(任务|项目|标注|评审|审核|review|labeling|annotation|project)/i.test(text)) blockers.push("任务价值不清晰。");
  const rejectsScreening = /(无需筛选|无须筛选|no screening)/i.test(text);
  if (rejectsScreening || !/(试标|筛选|审核|流程|确认|trial|screening|review process|qualification)/i.test(text)) {
    blockers.push("缺少试标或筛选流程说明。");
  }
  if (!/(报名|申请|回复|推荐|填写|联系|入口|表单|apply|reply|refer|contact|sign up)/i.test(cta)) blockers.push("报名动作不清晰。");
  if (cta && !hasExecutableMarketingCta(cta)) blockers.push("报名动作缺少可执行路径。");
  if (/(保证录用|无需筛选|无须筛选|轻松赚钱|躺赚|稳赚|guaranteed|no screening|easy money)/i.test(text)) blockers.push("存在过度承诺表达。");
  const claimsPaidTrial = /有偿试标|付费试标|带薪试标|\bpaid\s+trial\b/i.test(text);
  const paidTrialIsExplicit = /有偿试标|付费试标|带薪试标|试标.{0,8}(?:报酬|费用|结算)|\bpaid\s+trial\b/i.test(sourceText);
  if (claimsPaidTrial && !paidTrialIsExplicit) blockers.push("试标报酬表述缺少项目依据。");
  if (!riskNotes.length) blockers.push("缺少发布前复核项。");

  return blockers;
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}
