import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeProject } from "@/lib/serializers";
import { writeAuditEvent } from "@/lib/audit";
import { draftMarketingCampaign } from "@/lib/workflows";
import { MARKETING_CHANNELS } from "@/lib/constants";
import type { MarketingCampaignOutput } from "@/lib/schemas";

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

    const result = await draftMarketingCampaign({
      project: serializeProject(project),
      channels,
      audience: body.audience ?? ["领域专家", "专家推荐人", "技术社区成员"],
      messageBrief:
        body.messageBrief ??
        "生成公开渠道可发布的专家招募项目需求文案，强调任务类型、专家要求、合规试标和人工审核，不承诺虚假收益。",
      existingCandidateSignals: project.candidates.slice(0, 5).map((candidate) => ({
        name: candidate.expert.name,
        title: candidate.expert.title,
        evidenceLevel: candidate.expert.evidenceLevel,
      })),
    });

    if (!result.ok) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "ai.marketing.failed",
        payload: { error: result.error, rawTextPreviewLength: result.rawText?.length ?? 0, usage: result.usage },
      });
      return apiError(result.error, result.error.includes("DASHSCOPE_API_KEY") ? 412 : 502);
    }

    const generatedChannels = new Set(result.data.posts.map((post) => post.channel));
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
          usage: result.usage,
        },
      });
      return apiError(`Marketing output missed requested channels: ${missingChannels.join(", ")}`, 502);
    }

    const campaign = await prisma.marketingCampaign.create({
      data: {
        projectId: project.id,
        objective: "recruit_experts",
        audienceJson: stringifyJson(result.data.audience),
        channelsJson: stringifyJson(channels),
        messageBrief: result.data.campaignSummary,
        status: "draft",
      },
    });

    const posts = await prisma.$transaction(
      result.data.posts.map((post: MarketingCampaignOutput["posts"][number]) =>
        prisma.marketingPost.create({
          data: {
            campaignId: campaign.id,
            projectId: project.id,
            channel: post.channel,
            title: post.title,
            body: post.body,
            cta: post.cta,
            hashtagsJson: stringifyJson(post.hashtags),
            riskNotesJson: stringifyJson([...post.riskNotes, ...result.data.reviewChecklist]),
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
        usage: result.usage,
      },
    });

    return apiOk({ campaign, posts });
  } catch (error) {
    return handleRouteError(error);
  }
}
