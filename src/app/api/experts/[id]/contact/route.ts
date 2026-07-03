import { apiError, apiOk, handleRouteError } from "@/lib/http";
import { parseJson, stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeExpert } from "@/lib/serializers";
import { consentStateSchema } from "@/lib/schemas";
import { writeAuditEvent } from "@/lib/audit";
import { z } from "zod";

const contactSchema = z.object({
  email: z.union([z.string().email(), z.literal(""), z.null()]).optional(),
  profileUrl: z.union([z.string().url(), z.literal(""), z.null()]).optional(),
  consentState: consentStateSchema,
  contactPermissionBasis: z
    .enum(["public_outreach_allowed", "direct_consent", "referral_consent", "manual_review_required", ""])
    .optional()
    .default(""),
  notes: z.string().trim().max(1000).optional().default(""),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const payload = contactSchema.parse(await request.json().catch(() => ({})));
    const expert = await prisma.expert.findUnique({ where: { id } });
    if (!expert) return apiError("Expert not found.", 404);

    const contact = parseJson<Record<string, unknown>>(expert.contactJson, {});
    const updatedContact = {
      ...contact,
      email: normalizeBlank(payload.email),
      profileUrl: normalizeBlank(payload.profileUrl) ?? contact.profileUrl,
      contactPermissionBasis: payload.contactPermissionBasis || undefined,
      notes: payload.notes || undefined,
      updatedAt: new Date().toISOString(),
    };

    const updated = await prisma.expert.update({
      where: { id },
      data: {
        consentState: payload.consentState,
        contactJson: stringifyJson(updatedContact),
      },
    });

    await writeAuditEvent({
      entityType: "expert",
      entityId: expert.id,
      action: "expert.contact.updated",
      payload: {
        consentState: payload.consentState,
        hasEmail: Boolean(normalizeBlank(payload.email)),
        hasProfileUrl: Boolean(normalizeBlank(payload.profileUrl) ?? contact.profileUrl),
        contactPermissionBasis: payload.contactPermissionBasis || null,
      },
    });

    return apiOk({ expert: serializeExpert(updated) });
  } catch (error) {
    return handleRouteError(error);
  }
}

function normalizeBlank(value: string | null | undefined) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}
