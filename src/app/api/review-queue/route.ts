import { apiOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { serializeCandidate } from "@/lib/serializers";

export async function GET() {
  const candidates = await prisma.projectCandidate.findMany({
    where: {
      OR: [
        { humanReviewNeeded: true },
        { stage: "approved_for_outreach" },
        { stage: "do_not_contact" },
        { expert: { evidenceLevel: { in: ["E0", "E1"] } } },
      ],
    },
    include: { expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  return apiOk({ candidates: candidates.map(serializeCandidate) });
}
