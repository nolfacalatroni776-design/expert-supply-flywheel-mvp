import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { marketingPostStatusSchema } from "@/lib/schemas";
import { writeAuditEvent } from "@/lib/audit";
import { canTransitionMarketingPost } from "@/lib/state-machines";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { status } = (await request.json()) as { status?: string };
    const parsed = marketingPostStatusSchema.safeParse(status);
    if (!parsed.success) return apiError("Invalid marketing post status.", 422, parsed.error.flatten());

    const post = await prisma.marketingPost.findUnique({ where: { id } });
    if (!post) return apiError("Marketing post not found.", 404);

    const transition = canTransitionMarketingPost(post.status, parsed.data);
    if (!transition.ok) {
      await writeAuditEvent({
        projectId: post.projectId,
        entityType: "marketing_post",
        entityId: post.id,
        action: "marketing.post.status.rejected",
        payload: { from: post.status, to: parsed.data, reason: transition.reason, channel: post.channel },
      });
      return apiError(transition.reason, 409);
    }

    const updated = await prisma.marketingPost.update({
      where: { id },
      data: {
        status: parsed.data,
        publishedAt: parsed.data === "published" && post.status !== "published" ? new Date() : post.publishedAt,
      },
    });

    await writeAuditEvent({
      projectId: post.projectId,
      entityType: "marketing_post",
      entityId: post.id,
      action: "marketing.post.status.updated",
      payload: { from: post.status, to: parsed.data, channel: post.channel, internalMarkerOnly: parsed.data === "published" },
    });

    return apiOk({ post: updated });
  } catch (error) {
    return handleRouteError(error);
  }
}
