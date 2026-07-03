import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { qualityEventSchema } from "@/lib/schemas";
import { recordExpertQualityEvent } from "@/lib/supply-flywheel";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const payload = qualityEventSchema.parse(await request.json().catch(() => ({})));
    const event = await recordExpertQualityEvent({
      expertId: id,
      projectId: payload.projectId,
      candidateId: payload.candidateId,
      eventType: payload.eventType,
      channel: payload.channel,
      score: payload.score,
      notes: payload.notes,
    });
    if (!event) return apiError("Expert not found.", 404);
    return apiOk({ event });
  } catch (error) {
    return handleRouteError(error);
  }
}
