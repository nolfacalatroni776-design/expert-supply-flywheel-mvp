import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeProjectForGeneration } from "@/lib/serializers";
import { writeAuditEvent } from "@/lib/audit";
import { draftMarketingCampaign } from "@/lib/workflows";
import { MARKETING_CHANNELS } from "@/lib/constants";
import type { MarketingCampaignOutput } from "@/lib/schemas";
import { evaluateMarketingAttractionReadiness } from "@/lib/marketing-attraction";
import { buildFallbackMarketingCampaign } from "@/lib/fallback-drafts";
import {
  buildMarketingChannelBrief,
  generateMarketingByChannel,
  mergeMarketingReviewNotes,
  sanitizeMarketingPostClaims,
} from "@/lib/marketing-generation";

export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      channels?: string[];
      audience?: string[];
      messageBrief?: string;
    };

    const project = await prisma.project.findUnique({
      where: { id },
      include: { candidates: { include: { expert: true } } },
    });
    if (!project) return apiError("Project not found.", 404);

    const channels = (body.channels?.length ? body.channels : ["linkedin", "wechat", "xiaohongshu", "community"])
      .filter((channel): channel is (typeof MARKETING_CHANNELS)[number] =>
        (MARKETING_CHANNELS as readonly string[]).includes(channel),
      )
      .slice(0, 6);

    const projectBrief = serializeProjectForGeneration(project);
    const audience = body.audience ?? ["领域专家", "专家推荐人", "技术社区成员"];
    const messageBrief =
      body.messageBrief ??
      "生成公开渠道可发布的专家招募项目需求文案，强调任务类型、专家要求、合规试标和人工审核，不承诺虚假收益。";
    const existingCandidateSignals = project.candidates.slice(0, 5).map((candidate) => ({
      name: candidate.expert.name,
      title: candidate.expert.title,
      evidenceLevel: candidate.expert.evidenceLevel,
    }));
    const generation = await generateMarketingByChannel({
      channels,
      audience,
      generate: (channel) =>
        draftMarketingCampaign({
          project: projectBrief,
          channels: [channel],
          audience,
          messageBrief: buildMarketingChannelBrief(messageBrief, channel),
          existingCandidateSignals,
        }, { timeoutMs: 40_000, maxAttempts: 1 }),
      fallback: (fallbackChannels) =>
        buildFallbackMarketingCampaign({
          project: projectBrief,
          channels: fallbackChannels,
          audience,
        }),
    });
    const marketingSourceText = `${project.rawDemand} ${messageBrief}`;
    const campaignDraft = {
      ...generation.campaign,
      posts: generation.campaign.posts.map((post) => sanitizeMarketingPostClaims(post, marketingSourceText)),
    };

    if (generation.fallbackChannels.length) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "ai.marketing.fallback",
        payload: {
          fallbackChannels: generation.fallbackChannels,
          failures: generation.failures,
          usage: generation.usage,
          fallback: "system_template",
        },
      });
    }

    const generatedChannels = new Set(campaignDraft.posts.map((post) => post.channel));
    const missingChannels = channels.filter((channel) => !generatedChannels.has(channel));
    if (missingChannels.length) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "ai.marketing.failed",
        payload: {
          error: "Marketing output missed requested channels.",
          requestedChannels: channels,
          generatedChannels: Array.from(generatedChannels),
          missingChannels,
          usage: generation.usage,
        },
      });
      return apiError(`Marketing output missed requested channels: ${missingChannels.join(", ")}`, 502);
    }

    const attractionReadiness = evaluateMarketingAttractionReadiness({
      posts: campaignDraft.posts,
      sourceText: marketingSourceText,
    });

    const campaign = await prisma.marketingCampaign.create({
      data: {
        projectId: project.id,
        objective: "recruit_experts",
        audienceJson: stringifyJson(campaignDraft.audience),
        channelsJson: stringifyJson(channels),
        messageBrief: campaignDraft.campaignSummary,
        status: "draft",
      },
    });

    const posts = await prisma.$transaction(
      campaignDraft.posts.map((post: MarketingCampaignOutput["posts"][number]) =>
        prisma.marketingPost.create({
          data: {
            campaignId: campaign.id,
            projectId: project.id,
            channel: post.channel,
            title: post.title,
            body: post.body,
            cta: post.cta,
            hashtagsJson: stringifyJson(post.hashtags),
            riskNotesJson: stringifyJson(
              mergeMarketingReviewNotes(post.riskNotes, campaignDraft.reviewChecklist, attractionReadiness.needsReview),
            ),
            status: "needs_review",
          },
        }),
      ),
    );

    await writeAuditEvent({
      projectId: project.id,
      entityType: "marketing_campaign",
      entityId: campaign.id,
      action: "ai.marketing.completed",
      payload: {
        channels,
        posts: posts.length,
        usage: generation.usage,
        attractionReadiness,
        successfulChannels: generation.successfulChannels,
        fallbackChannels: generation.fallbackChannels,
        fallback: generation.fallbackChannels.length > 0,
      },
    });

    return apiOk({
      campaign,
      posts,
      attractionReadiness,
      successfulChannels: generation.successfulChannels,
      fallbackChannels: generation.fallbackChannels,
      fallback: generation.fallbackChannels.length > 0,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
