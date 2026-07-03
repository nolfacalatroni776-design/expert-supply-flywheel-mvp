import { prisma } from "@/lib/prisma";
import { stringifyJson } from "@/lib/json";
import { redactForAudit } from "@/lib/redaction";

export async function writeAuditEvent({
  projectId,
  entityType,
  entityId,
  action,
  payload,
}: {
  projectId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  payload?: unknown;
}) {
  await prisma.auditEvent.create({
    data: {
      projectId: projectId ?? null,
      entityType,
      entityId,
      action,
      payloadJson: stringifyJson(redactForAudit(payload ?? {})),
    },
  });
}
