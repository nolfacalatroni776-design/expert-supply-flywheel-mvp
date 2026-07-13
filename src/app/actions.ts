"use server";

import { prisma } from "@/lib/prisma";
import { stringifyJson } from "@/lib/json";
import { createProjectSchema } from "@/lib/schemas";
import { redirect } from "next/navigation";
import { writeAuditEvent } from "@/lib/audit";

export async function createProjectAction(formData: FormData) {
  const languages = String(formData.get("languages") ?? "")
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const regions = String(formData.get("regions") ?? "")
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const payload = createProjectSchema.parse({
    title: formData.get("title"),
    rawDemand: formData.get("rawDemand"),
    domain: formData.get("domain") || undefined,
    taskType: formData.get("taskType") || undefined,
    quantity: formData.get("quantity") || undefined,
    budgetMin: formData.get("budgetMin") || undefined,
    budgetMax: formData.get("budgetMax") || undefined,
    languages,
    regions,
  });

  const project = await prisma.project.create({
    data: {
      title: payload.title,
      rawDemand: payload.rawDemand,
      domain: payload.domain,
      taskType: payload.taskType,
      quantity: payload.quantity,
      budgetMin: payload.budgetMin,
      budgetMax: payload.budgetMax,
      languagesJson: stringifyJson(payload.languages),
      regionsJson: stringifyJson(payload.regions),
    },
  });

  await writeAuditEvent({
    projectId: project.id,
    entityType: "project",
    entityId: project.id,
    action: "project.created",
    payload: { source: "form" },
  });

  redirect(`/?project=${project.id}&view=demand`);
}

export async function createProjectFromDemandAction(formData: FormData) {
  const rawDemand = String(formData.get("rawDemand") ?? "").trim();
  const explicitTitle = String(formData.get("title") ?? "").trim();
  const title = explicitTitle.length >= 3 ? explicitTitle : makeProjectTitle(rawDemand);

  const payload = createProjectSchema.parse({
    title,
    rawDemand,
    languages: [],
    regions: [],
  });

  const project = await prisma.project.create({
    data: {
      title: payload.title,
      rawDemand: payload.rawDemand,
      languagesJson: stringifyJson([]),
      regionsJson: stringifyJson([]),
    },
  });

  await writeAuditEvent({
    projectId: project.id,
    entityType: "project",
    entityId: project.id,
    action: "project.created",
    payload: { source: "agent_home" },
  });

  redirect(`/?project=${project.id}&view=agent`);
}

function makeProjectTitle(rawDemand: string) {
  const cleaned = rawDemand.replace(/\s+/g, " ").trim();
  if (!cleaned) return "专家招募项目";
  const short = cleaned.length > 22 ? `${cleaned.slice(0, 22)}...` : cleaned;
  return short.includes("招募") ? short : `${short}专家招募`;
}
