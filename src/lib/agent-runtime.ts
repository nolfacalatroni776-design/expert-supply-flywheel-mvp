import type { AgentTaskRun, AgentTaskStep, AgentToolReceipt, Project } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import {
  type AgentIntent,
  type AgentRunStatus,
  type AgentStepKey,
  getAgentIntentLabel,
  getAgentTaskTemplate,
  isAgentIntent,
} from "@/lib/agent-tasks";
import {
  buildAgentRunReport,
  evaluateExternalResearchStepQuality,
  normalizeAgentUserFacingText,
  toActionableError,
  type AgentRunReport,
} from "@/lib/agent-quality";
import { MARKETING_CHANNELS } from "@/lib/constants";
import {
  buildInstructionSourceQueries,
  buildPersonaSourceQueries,
  buildExternalResearchAcceptancePreview,
  evaluateExternalResearchAcceptance,
  selectExternalResearchQueries,
} from "@/lib/external-research-acceptance";
import { requiresProjectReview } from "@/lib/gates";
import { parseJson, stringifyJson } from "@/lib/json";
import { buildFallbackMarketingCampaign } from "@/lib/fallback-drafts";
import { evaluateMarketingAttractionReadiness } from "@/lib/marketing-attraction";
import {
  buildMarketingChannelBrief,
  generateMarketingByChannel,
  mergeMarketingReviewNotes,
  sanitizeMarketingPostClaims,
} from "@/lib/marketing-generation";
import { prisma } from "@/lib/prisma";
import { assessProjectAnalysisQuality, normalizeProjectAnalysis } from "@/lib/project-analysis";
import { redactSensitiveText } from "@/lib/redaction";
import { serializeProjectForGeneration, serializeSearchResult } from "@/lib/serializers";
import {
  getCompatibleCachedQueries,
  shouldBypassSearchCache,
  sourceProjectCandidates,
} from "@/lib/sourcing";
import {
  getCandidateEvidenceEnrichmentQueries,
  runCandidateEvidenceEnrichment,
} from "@/lib/candidate-evidence-enrichment";
import {
  analyzeProjectSupplyGap,
  createRecruitmentRetrospective,
  rankUnifiedSupply,
  runExternalResearch,
  runInternalMatch,
} from "@/lib/supply-flywheel";
import { analyzeProjectDemand, draftMarketingCampaign } from "@/lib/workflows";
import { buildAgentToolCallIdentity, type AgentToolExecutionContext } from "@/lib/agent-tools";

export type SerializedAgentStep = Omit<AgentTaskStep, "inputJson" | "outputJson" | "checksJson"> & {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  checks: Record<string, unknown>;
  toolReceipts: SerializedAgentToolReceipt[];
};

export type SerializedAgentToolReceipt = Omit<
  AgentToolReceipt,
  "argumentDigest" | "toolCallId" | "resultSummaryJson"
> & {
  resultSummary: Record<string, unknown>;
};

export type SerializedAgentRun = Omit<
  AgentTaskRun,
  | "planJson"
  | "contextSnapshotJson"
  | "reportJson"
  | "workflowRunId"
  | "executionToken"
  | "leaseExpiresAt"
  | "heartbeatAt"
> & {
  label: string;
  plan: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
  report: AgentRunReport | Record<string, unknown>;
  steps: SerializedAgentStep[];
};

type StepWithToolReceipts = AgentTaskStep & { toolReceipts?: AgentToolReceipt[] };
type RunWithSteps = AgentTaskRun & { steps: StepWithToolReceipts[] };

const terminalRunStatuses = ["succeeded", "partially_succeeded", "failed", "cancelled"];
const DEPENDENCY_SKIP_REASON = "前置步骤未达到执行条件，本步未执行。";

export function getDependentStepsToSkip(
  steps: Array<{ id: string; order: number; stepKey: string; status: string }>,
) {
  const firstFailureOrder = steps
    .filter((step) => step.status === "failed")
    .map((step) => step.order)
    .sort((a, b) => a - b)[0];
  if (firstFailureOrder === undefined) return [];
  return steps
    .filter(
      (step) =>
        step.order > firstFailureOrder &&
        step.status === "pending" &&
        step.stepKey !== "quality_report",
    )
    .map((step) => step.id);
}

export function getStepsToResetForRetry(
  steps: Array<{
    id: string;
    order: number;
    status: string;
    requiresConfirmation: boolean;
    confirmedAt: Date | null;
    errorMessage: string | null;
  }>,
) {
  const firstRetryOrder = steps
    .filter(
      (step) =>
        ["failed", "blocked", "running"].includes(step.status) ||
        (step.status === "skipped" && step.errorMessage === DEPENDENCY_SKIP_REASON),
    )
    .map((step) => step.order)
    .sort((left, right) => left - right)[0];
  if (firstRetryOrder === undefined) return [];

  return steps
    .filter(
      (step) =>
        step.order >= firstRetryOrder &&
        !(step.requiresConfirmation && Boolean(step.confirmedAt)),
    )
    .map((step) => step.id);
}

export function shouldContinueAfterStepFailure(intent: string, stepKey: string) {
  return intent === "full_sourcing" && stepKey === "external_research";
}

function agentExecutionLeaseMs() {
  const configured = Number(process.env.AGENT_EXECUTION_LEASE_MS ?? 360_000);
  return Number.isFinite(configured) ? Math.max(60_000, Math.min(configured, 900_000)) : 360_000;
}

export function isAgentExecutionLeaseActive(
  run: Pick<AgentTaskRun, "status" | "executionToken" | "leaseExpiresAt">,
  now = new Date(),
) {
  return Boolean(
    run.status === "running" &&
      run.executionToken &&
      run.leaseExpiresAt &&
      run.leaseExpiresAt.getTime() > now.getTime(),
  );
}

export async function claimAgentTaskRunExecution(
  runId: string,
  executionToken: string = randomUUID(),
  now = new Date(),
) {
  const leaseExpiresAt = new Date(now.getTime() + agentExecutionLeaseMs());
  const claimed = await prisma.agentTaskRun.updateMany({
    where: {
      id: runId,
      OR: [
        { status: "planned" },
        {
          status: "running",
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
      ],
    },
    data: {
      status: "running",
      executionToken,
      leaseExpiresAt,
      heartbeatAt: now,
      errorMessage: null,
      attempt: { increment: 1 },
    },
  });
  if (claimed.count === 1) {
    await prisma.agentTaskRun.updateMany({
      where: { id: runId, executionToken, startedAt: null },
      data: { startedAt: now },
    });
  }
  return { claimed: claimed.count === 1, executionToken, leaseExpiresAt };
}

export type CreateAgentRunInput = {
  projectId: string;
  intent: AgentIntent;
  instruction: string;
};

export async function createAgentTaskRun({ projectId, intent, instruction }: CreateAgentRunInput) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { candidates: true, marketingPosts: true, supplyGaps: true },
  });
  if (!project) return null;

  const template = getAgentTaskTemplate(intent);
  const contextSnapshot = await buildContextSnapshot(project);
  const run = await prisma.agentTaskRun.create({
    data: {
      projectId,
      intent,
      instruction: redactSensitiveText(instruction),
      status: "planned",
      planJson: stringifyJson({
        label: template.label,
        objective: template.objective,
        steps: template.steps.map((step) => ({
          key: step.key,
          label: step.label,
          description: step.description,
          requiresConfirmation: Boolean(step.requiresConfirmation),
        })),
      }),
      contextSnapshotJson: stringifyJson(contextSnapshot),
      reportJson: stringifyJson({
        status: "planned",
        summary: "任务计划已生成。",
        completed: [],
        skipped: [],
        failed: [],
        written: [],
        needsReview: [],
        nextActions: ["确认计划后开始执行。"],
      }),
      steps: {
        create: template.steps.map((step, index) => ({
          stepKey: step.key,
          label: step.label,
          order: index + 1,
          requiresConfirmation: Boolean(step.requiresConfirmation),
          inputJson: stringifyJson({ description: step.description }),
        })),
      },
    },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });

  const checked = await runPreflight(run.id);
  await writeAuditEvent({
    projectId,
    entityType: "agent_task_run",
    entityId: run.id,
    action: "agent.task.planned",
    payload: {
      intent,
      status: checked.status,
      steps: checked.steps.length,
    },
  });
  return serializeAgentRun(checked);
}

export async function getAgentTaskRun(runId: string) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });
  return run ? serializeAgentRun(run) : null;
}

export async function getAgentTaskWorkflowRunId(runId: string) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    select: { workflowRunId: true },
  });
  return run?.workflowRunId ?? null;
}

export async function attachAgentTaskWorkflowRun(runId: string, workflowRunId: string) {
  const normalized = workflowRunId.trim();
  if (!normalized) return false;

  const existing = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    select: { workflowRunId: true },
  });
  if (!existing) return false;
  if (existing.workflowRunId === normalized) return true;
  if (existing.workflowRunId) return false;

  const attached = await prisma.agentTaskRun.updateMany({
    where: { id: runId, workflowRunId: null },
    data: { workflowRunId: normalized },
  });
  return attached.count === 1;
}

export async function releaseAgentTaskWorkflowRun(runId: string, workflowRunId: string) {
  const released = await prisma.agentTaskRun.updateMany({
    where: { id: runId, workflowRunId },
    data: { workflowRunId: null },
  });
  return released.count === 1;
}

export async function cancelAgentTaskRun(runId: string) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });
  if (!run) return null;
  if (terminalRunStatuses.includes(run.status)) {
    return serializeAgentRun(run);
  }

  const completedAt = new Date();
  await prisma.$transaction([
    prisma.agentTaskStep.updateMany({
      where: { runId, status: "running" },
      data: {
        status: "blocked",
        completedAt,
        errorMessage: "任务已停止，未继续执行后续步骤。",
      },
    }),
    prisma.agentTaskRun.update({
      where: { id: runId },
      data: {
        status: "cancelled",
        completedAt,
        executionToken: null,
        leaseExpiresAt: null,
        reportJson: stringifyJson(buildReportFromSteps("cancelled", run.steps)),
      },
    }),
    prisma.agentToolReceipt.updateMany({
      where: { runId, status: "running" },
      data: {
        status: "interrupted",
        completedAt,
        errorCategory: "cancelled",
      },
    }),
  ]);
  const updated = await prisma.agentTaskRun.findUniqueOrThrow({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });
  await writeAuditEvent({
    projectId: updated.projectId,
    entityType: "agent_task_run",
    entityId: updated.id,
    action: "agent.task.cancelled",
    payload: { intent: updated.intent },
  });
  return serializeAgentRun(updated);
}

export async function confirmAgentTaskRun(
  runId: string,
  options?: { resume?: boolean; stepId?: string; reason?: string },
) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });
  if (!run) return null;
  if (run.status !== "waiting_for_confirmation") return serializeAgentRun(run);

  const confirmationSteps = run.steps.filter(
    (step) => step.requiresConfirmation && !step.confirmedAt && (!options?.stepId || step.id === options.stepId),
  );
  if (options?.stepId && !confirmationSteps.length) {
    throw new Error("审批对应的步骤已变化，请刷新后重新核对。");
  }
  if (!confirmationSteps.length) return options?.resume === false ? serializeAgentRun(run) : startAgentTaskRun(run.id);

  const searchExecutionStep = run.steps.find((step) =>
    ["external_research", "search_candidates", "enrich_candidate_evidence"].includes(step.stepKey),
  );
  const receiptOperations = confirmationSteps.flatMap((confirmationStep) => {
    if (!searchExecutionStep) return [];
    const checks = parseJson<{ queryPreview?: unknown }>(confirmationStep.checksJson, {});
    return readStringList(checks.queryPreview).map((query) => {
      const identity = buildAgentToolCallIdentity({
        runId: run.id,
        stepId: searchExecutionStep.id,
        toolName: "public_search",
        arguments: { query },
      });
      return prisma.agentToolReceipt.upsert({
        where: { toolCallId: identity.toolCallId },
        update: {
          approvalId: confirmationStep.id,
          argumentDigest: identity.argumentDigest,
          status: "approved",
          errorCategory: null,
        },
        create: {
          runId: run.id,
          stepId: searchExecutionStep.id,
          toolCallId: identity.toolCallId,
          toolName: "public_search",
          argumentDigest: identity.argumentDigest,
          approvalId: confirmationStep.id,
          idempotencyClass: "read_only",
          status: "approved",
        },
      });
    });
  });

  await prisma.$transaction([
    ...confirmationSteps.map((step) => {
      const checks = parseJson<{ queryPreview?: unknown }>(step.checksJson, {});
      const approvedQueries = readStringList(checks.queryPreview);
      return prisma.agentTaskStep.updateMany({
        where: { id: step.id, status: "blocked", confirmedAt: null },
        data: {
          status: "succeeded",
          confirmedAt: new Date(),
          confirmationDecision: "approved",
          confirmationReason: options?.reason?.trim().slice(0, 500) || null,
          decidedAt: new Date(),
          completedAt: new Date(),
          outputJson: stringifyJson({
            confirmed: true,
            approvedQueries,
            nextActions: ["继续执行公开候选补充。"],
          }),
          errorMessage: null,
        },
      });
    }),
    prisma.agentTaskRun.updateMany({
      where: { id: run.id, status: "waiting_for_confirmation" },
      data: {
        status: "planned",
        executionToken: null,
        leaseExpiresAt: null,
        errorMessage: null,
      },
    }),
    ...receiptOperations,
  ]);
  await writeAuditEvent({
    projectId: run.projectId,
    entityType: "agent_task_run",
    entityId: run.id,
    action: "agent.task.confirmed",
    payload: {
      intent: run.intent,
      steps: confirmationSteps.map((step) => step.stepKey),
      decision: "approved",
    },
  });

  return options?.resume === false ? getAgentTaskRun(runId) : startAgentTaskRun(runId);
}

export async function rejectAgentTaskRunConfirmation(
  runId: string,
  decision: { stepId: string; reason: string },
) {
  const reason = redactSensitiveText(decision.reason).trim().slice(0, 500);
  if (!reason) throw new Error("请说明不继续执行的原因。");

  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });
  if (!run) return null;
  if (run.status !== "waiting_for_confirmation") {
    throw new Error("当前任务不在等待确认状态，请刷新后重试。");
  }
  const confirmationStep = run.steps.find(
    (step) => step.id === decision.stepId && step.requiresConfirmation && !step.confirmedAt,
  );
  if (!confirmationStep) {
    throw new Error("审批对应的步骤已变化，请刷新后重新核对。");
  }

  const completedAt = new Date();
  const outputJson = stringifyJson({
    confirmed: false,
    rejected: true,
    reason,
    written: [],
    needsReview: ["公开搜索计划未获批准，未调用外部搜索服务。"],
    nextActions: ["调整搜索方向后生成新计划。"],
  });
  const reportSteps = run.steps.map((step) =>
    step.id === confirmationStep.id
      ? {
          ...step,
          status: "blocked",
          outputJson,
          errorMessage: "公开搜索计划未获批准，未执行。",
          confirmationDecision: "rejected",
          confirmationReason: reason,
          decidedAt: completedAt,
          completedAt,
        }
      : step,
  );

  await prisma.$transaction([
    prisma.agentTaskStep.update({
      where: { id: confirmationStep.id },
      data: {
        status: "blocked",
        confirmationDecision: "rejected",
        confirmationReason: reason,
        decidedAt: completedAt,
        completedAt,
        outputJson,
        errorMessage: "公开搜索计划未获批准，未执行。",
      },
    }),
    prisma.agentTaskRun.update({
      where: { id: run.id },
      data: {
        status: "partially_succeeded",
        completedAt,
        executionToken: null,
        leaseExpiresAt: null,
        heartbeatAt: completedAt,
        errorMessage: null,
        reportJson: stringifyJson(buildReportFromSteps("partially_succeeded", reportSteps)),
      },
    }),
  ]);
  await writeAuditEvent({
    projectId: run.projectId,
    entityType: "agent_task_run",
    entityId: run.id,
    action: "agent.task.confirmation_rejected",
    payload: {
      intent: run.intent,
      step: confirmationStep.stepKey,
      decision: "rejected",
      reason,
    },
  });
  return getAgentTaskRun(run.id);
}

export async function prepareAgentTaskRunRetry(runId: string) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });
  if (!run) return null;
  if (["succeeded", "cancelled", "waiting_for_confirmation"].includes(run.status)) return serializeAgentRun(run);
  if (run.steps.some((step) => step.confirmationDecision === "rejected")) return serializeAgentRun(run);
  if (isAgentExecutionLeaseActive(run)) return serializeAgentRun(run);

  const resetStepIds = getStepsToResetForRetry(run.steps);
  if (!resetStepIds.length) return serializeAgentRun(run);

  await prisma.$transaction(
    run.steps
      .filter((step) => resetStepIds.includes(step.id))
      .map((step) =>
        prisma.agentTaskStep.update({
          where: { id: step.id },
          data: {
            status: "pending",
            outputJson: "{}",
            checksJson: "{}",
            errorMessage: null,
            confirmationDecision: step.requiresConfirmation ? null : step.confirmationDecision,
            confirmationReason: step.requiresConfirmation ? null : step.confirmationReason,
            decidedAt: step.requiresConfirmation ? null : step.decidedAt,
            startedAt: null,
            completedAt: null,
          },
        }),
      ),
  );
  await prisma.agentTaskRun.update({
    where: { id: run.id },
    data: {
      status: "planned",
      errorMessage: null,
      completedAt: null,
      workflowRunId: null,
      executionToken: null,
      leaseExpiresAt: null,
    },
  });

  return getAgentTaskRun(runId);
}

export async function retryAgentTaskRun(runId: string) {
  const prepared = await prepareAgentTaskRunRetry(runId);
  if (!prepared || prepared.status === "waiting_for_confirmation") return prepared;
  return startAgentTaskRun(runId);
}

export async function startAgentTaskRun(runId: string) {
  let run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });
  if (!run) return null;

  if (run.status === "preflight_failed") return serializeAgentRun(run);
  if (run.status === "waiting_for_confirmation") {
    const unconfirmed = run.steps.find((step) => step.requiresConfirmation && !step.confirmedAt);
    if (unconfirmed) return serializeAgentRun(run);
  }
  if (terminalRunStatuses.includes(run.status)) {
    return serializeAgentRun(run);
  }
  if (isAgentExecutionLeaseActive(run)) return serializeAgentRun(run);

  const wasRecovery = run.status === "running";
  const claim = await claimAgentTaskRunExecution(run.id);
  if (!claim.claimed) return getAgentTaskRun(run.id);
  if (wasRecovery) {
    await prisma.agentTaskStep.updateMany({
      where: { runId: run.id, status: "running" },
      data: {
        status: "pending",
        startedAt: null,
        completedAt: null,
        errorMessage: "上次执行未完成，已从本步骤恢复。",
      },
    });
  }
  run = await prisma.agentTaskRun.findUniqueOrThrow({
    where: { id: run.id },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });

  await writeAuditEvent({
    projectId: run.projectId,
    entityType: "agent_task_run",
    entityId: run.id,
    action: "agent.task.started",
    payload: { intent: run.intent, attempt: run.attempt, recovered: wasRecovery },
  });

  for (const step of run.steps) {
    if (["succeeded", "skipped"].includes(step.status)) continue;
    if (step.stepKey === "quality_report") continue;
    if (!(await refreshAgentExecutionLease(run.id, claim.executionToken))) return getAgentTaskRun(run.id);
    if (step.requiresConfirmation && !step.confirmedAt) {
      await blockForConfirmation(run, step, claim.executionToken);
      return getAgentTaskRun(run.id);
    }

    const result = await executeStep(run, step, claim.executionToken);
    if (result === "blocked") return getAgentTaskRun(run.id);
    if (result === "failed" && !shouldContinueAfterStepFailure(run.intent, step.stepKey)) break;
  }

  return finalizeAgentRun(run.id, claim.executionToken);
}

async function runPreflight(runId: string) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" } }, project: { include: { candidates: true, marketingPosts: true, supplyGaps: true } } },
  });
  if (!run) throw new Error("任务不存在。");

  const checkStep = run.steps.find((step) => step.stepKey === "check_project");
  if (!checkStep) return run;

  const preflight = await buildPreflight(run.intent, run.project);
  await prisma.agentTaskStep.update({
    where: { id: checkStep.id },
    data: {
      status: preflight.ok ? "succeeded" : "failed",
      startedAt: new Date(),
      completedAt: new Date(),
      outputJson: stringifyJson(preflight.output),
      checksJson: stringifyJson(preflight.checks),
      errorMessage: preflight.ok ? null : preflight.message,
    },
  });

  const status: AgentRunStatus = preflight.ok ? "planned" : "preflight_failed";
  const updated = await prisma.agentTaskRun.update({
    where: { id: run.id },
    data: {
      status,
      errorMessage: preflight.ok ? null : preflight.message,
      reportJson: stringifyJson(
        buildAgentRunReport({
          status,
          steps: [
            {
              stepKey: checkStep.stepKey,
              label: checkStep.label,
              status: preflight.ok ? "succeeded" : "failed",
              output: preflight.output,
              checks: preflight.checks,
              errorMessage: preflight.ok ? null : preflight.message,
            },
          ],
        }),
      ),
    },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });
  return updated;
}

async function executeStep(
  run: RunWithSteps,
  step: AgentTaskStep,
  executionToken: string,
): Promise<"succeeded" | "failed" | "blocked"> {
  const claimed = await prisma.agentTaskStep.updateMany({
    where: { id: step.id, status: "pending" },
    data: {
      status: "running",
      startedAt: new Date(),
      errorMessage: null,
      attempt: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return "blocked";

  try {
    const output = await executeStepAction(run, step.stepKey as AgentStepKey);
    const stepFailed = output.stepFailed === true;
    const errorMessage = typeof output.failureReason === "string" ? output.failureReason : stepFailed ? "本步未达到可用结果，请查看输出后重试。" : null;
    const status = output.skipped ? "skipped" : stepFailed ? "failed" : "succeeded";
    const committed = await prisma.agentTaskStep.updateMany({
      where: {
        id: step.id,
        status: "running",
        run: { executionToken, status: "running" },
      },
      data: {
        status,
        outputJson: stringifyJson(output),
        completedAt: new Date(),
        errorMessage,
      },
    });
    if (committed.count !== 1) return "blocked";
    await writeAuditEvent({
      projectId: run.projectId,
      entityType: "agent_task_run",
      entityId: run.id,
      action: output.skipped ? "agent.step.skipped" : stepFailed ? "agent.step.failed" : "agent.step.completed",
      payload: {
        intent: run.intent,
        step: step.stepKey,
        output,
        error: errorMessage,
      },
    });
    return stepFailed ? "failed" : "succeeded";
  } catch (error) {
    const message = toActionableError(error);
    const committed = await prisma.agentTaskStep.updateMany({
      where: {
        id: step.id,
        status: "running",
        run: { executionToken, status: "running" },
      },
      data: {
        status: "failed",
        errorMessage: message,
        completedAt: new Date(),
      },
    });
    if (committed.count !== 1) return "blocked";
    await writeAuditEvent({
      projectId: run.projectId,
      entityType: "agent_task_run",
      entityId: run.id,
      action: "agent.step.failed",
      payload: {
        intent: run.intent,
        step: step.stepKey,
        error: message,
      },
    });
    return "failed";
  }
}

async function refreshAgentExecutionLease(runId: string, executionToken: string) {
  const heartbeatAt = new Date();
  const leaseExpiresAt = new Date(heartbeatAt.getTime() + agentExecutionLeaseMs());
  const refreshed = await prisma.agentTaskRun.updateMany({
    where: { id: runId, status: "running", executionToken },
    data: { heartbeatAt, leaseExpiresAt },
  });
  return refreshed.count === 1;
}

async function executeStepAction(run: RunWithSteps, stepKey: AgentStepKey): Promise<Record<string, unknown>> {
  if (!isAgentIntent(run.intent)) throw new Error("任务类型不可识别。");

  switch (stepKey) {
    case "analyze_project":
      return executeAnalyzeProject(run.projectId);
    case "internal_match":
      return executeInternalMatch(run.projectId);
    case "analyze_supply_gap":
      return executeSupplyGap(run.projectId);
    case "external_research":
      return executeExternalResearch(
        run.projectId,
        getApprovedExternalSearchQueries(run.steps),
        buildExternalSearchToolContext(run, stepKey),
      );
    case "search_candidates":
      return executeSearchCandidates(
        run.projectId,
        getApprovedExternalSearchQueries(run.steps),
        buildExternalSearchToolContext(run, stepKey),
      );
    case "enrich_candidate_evidence":
      return executeCandidateEvidenceEnrichment(
        run.projectId,
        getApprovedExternalSearchQueries(run.steps),
        buildExternalSearchToolContext(run, stepKey),
      );
    case "rank_supply":
      return executeRankSupply(run.projectId);
    case "generate_marketing":
      return executeGenerateMarketing(run.projectId, run.instruction);
    case "recruitment_retrospective":
      return executeRetrospective(run.projectId);
    default:
      return { skipped: true, reason: "当前步骤无需执行。", nextActions: ["继续查看后续步骤。"] };
  }
}

async function executeAnalyzeProject(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("项目不存在或已被删除。");
  const result = await analyzeProjectDemand({
    rawDemand: project.rawDemand,
    existingFields: {
      title: project.title,
      domain: project.domain,
      taskType: project.taskType,
      quantity: project.quantity,
      budgetMin: project.budgetMin,
      budgetMax: project.budgetMax,
    },
  });
  if (!result.ok) throw new Error(result.error);
  const analysisQuality = assessProjectAnalysisQuality(result.data);
  if (!analysisQuality.ok) {
    throw new Error(`需求画像内容不完整：${analysisQuality.missing.join("、")}。项目未更新，请重新生成。`);
  }
  const data = normalizeProjectAnalysis(project, result.data);
  await prisma.project.update({
    where: { id: project.id },
    data: {
      title: data.title || project.title,
      domain: data.domain,
      taskType: data.taskType,
      quantity: data.quantity,
      budgetMin: data.budgetMin,
      budgetMax: data.budgetMax,
      languagesJson: stringifyJson(data.languages),
      regionsJson: stringifyJson(data.regions),
      riskLevel: data.riskLevel,
      personaJson: stringifyJson(data.persona),
      searchQueriesJson: stringifyJson(data.searchQueries),
      status: "analyzed",
    },
  });
  return {
    projectUpdated: true,
    searchQueries: data.searchQueries.length,
    needsReview: requiresProjectReview(data) ? ["高风险或强监管项目需人工复核后再触达。"] : [],
    nextActions: ["查看供给发现结果，优先召回内部专家。"],
  };
}

async function executeInternalMatch(projectId: string) {
  const result = await runInternalMatch(projectId);
  if (!result) throw new Error("项目不存在或已被删除。");
  return {
    runId: result.runId,
    candidates: result.candidates.length,
    candidatePreview: result.candidates.slice(0, 6).map((candidate) =>
      buildCandidatePreviewItem({
        id: candidate.id,
        sourceType: candidate.sourceType,
        humanReviewNeeded: candidate.humanReviewNeeded,
        nextAction: candidate.nextAction,
        expert: candidate.expert,
      }),
    ),
    needsReview: result.candidates.length ? ["内部召回候选仍需按证据和项目风险复核。"] : ["内部库未召回候选。"],
    nextActions: ["分析供给缺口，决定是否补充公开候选。"],
  };
}

async function executeSupplyGap(projectId: string) {
  const result = await analyzeProjectSupplyGap(projectId);
  if (!result) throw new Error("项目不存在或已被删除。");
  return {
    gaps: result.gaps.length,
    searchDirections: result.searchDirections.length,
    usedFallback: result.usedFallback,
    needsReview: result.gaps.filter((gap) => gap.severity === "high" || gap.severity === "critical").map((gap) => gap.description),
    nextActions: result.searchDirections.length ? ["按缺口方向确认是否补充公开候选。"] : ["查看候选排序并推进复核。"],
  };
}

async function executeExternalResearch(
  projectId: string,
  approvedQueries: string[],
  toolContext: AgentToolExecutionContext,
) {
  if (!approvedQueries.length) throw new Error("公开搜索计划尚未确认，请重新生成计划后确认搜索方向。");
  const result = await runExternalResearch(projectId, { queries: approvedQueries, toolContext });
  if (!result) throw new Error("项目不存在或已被删除。");
  if (!result.ok) throw new Error(result.error);
  const quality = evaluateExternalResearchStepQuality({
    candidateCount: result.candidates.length,
    acceptance: result.acceptance,
  });
  return {
    runId: result.runId,
    searchResults: result.searchResults.length,
    candidates: result.candidates.length,
    candidatePreview: result.candidates.slice(0, 6).map(buildSerializedCandidatePreviewItem),
    searchResultPreview: result.searchResults.slice(0, 6).map(buildSearchResultPreviewItem),
    providerStats: result.providerStats,
    cacheHits: result.cacheHits.length,
    autoScreenedOut: result.autoScreenedOut,
    usedFallback: result.usedFallback,
    extractionIssue: result.extractionIssue,
    acceptance: result.acceptance,
    needsReview: [
      "公开来源候选进入复核后，再判断是否可触达。",
      ...(result.acceptance?.needsReview ?? []),
      ...(result.acceptance?.passed ? [] : result.acceptance?.blockers ?? []),
    ],
    stepFailed: quality.stepFailed,
    failureReason: quality.failureReason,
    nextActions: result.acceptance?.nextActions ?? ["更新候选排序，优先处理高证据候选。"],
  };
}

async function executeSearchCandidates(
  projectId: string,
  approvedQueries: string[],
  toolContext: AgentToolExecutionContext,
) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("项目不存在或已被删除。");
  if (!approvedQueries.length) throw new Error("公开搜索计划尚未确认，请重新生成计划后确认搜索方向。");
  const result = await sourceProjectCandidates({
    project,
    queries: approvedQueries,
    maxQueries: approvedQueries.length,
    toolContext,
  });
  if (!result.ok) throw new Error(result.error);
  const acceptance = evaluateExternalResearchAcceptance({
    project,
    queries: result.queries,
    cacheHits: result.cacheHits,
    providerStats: result.providerStats,
    searchResults: result.searchResults,
    candidates: result.candidates,
  });
  const quality = evaluateExternalResearchStepQuality({
    candidateCount: result.candidates.length,
    acceptance,
  });
  await writeAuditEvent({
    projectId,
    entityType: "project",
    entityId: projectId,
    action: "search.completed",
    payload: {
      queries: result.queries,
      searchResults: result.searchResults.length,
      candidates: result.candidates.length,
      providerStats: result.providerStats,
      cacheHits: result.cacheHits.length,
      autoScreenedOut: result.autoScreenedOut,
      acceptance,
    },
  });
  return {
    searchResults: result.searchResults.map(serializeSearchResult).length,
    candidates: result.candidates.length,
    candidatePreview: result.candidates.slice(0, 6).map(buildSerializedCandidatePreviewItem),
    searchResultPreview: result.searchResults.slice(0, 6).map(buildSearchResultPreviewItem),
    providerStats: result.providerStats,
    cacheHits: result.cacheHits.length,
    autoScreenedOut: result.autoScreenedOut,
    usedFallback: result.usedFallback,
    extractionIssue: result.extractionIssue,
    acceptance,
    stepFailed: quality.stepFailed,
    failureReason: quality.failureReason,
    needsReview: ["搜索候选需完成证据复核后再触达。", ...acceptance.needsReview, ...(acceptance.passed ? [] : acceptance.blockers)],
    nextActions: acceptance.nextActions,
  };
}

async function executeCandidateEvidenceEnrichment(
  projectId: string,
  approvedQueries: string[],
  toolContext: AgentToolExecutionContext,
) {
  if (!approvedQueries.length) throw new Error("候选证据补查计划尚未确认，请重新生成计划后确认搜索方向。");
  const result = await runCandidateEvidenceEnrichment({ projectId, queries: approvedQueries, toolContext });
  if (!result) throw new Error("项目不存在或已被删除。");
  if (!result.ok) throw new Error(result.error);
  const stepFailed = !result.passed;
  return {
    runId: result.runId,
    searchResults: result.searchResults.length,
    candidates: result.candidates.length,
    candidatePreview: result.candidates.slice(0, 6).map(buildSerializedCandidatePreviewItem),
    searchResultPreview: result.searchResults.slice(0, 6).map(buildSearchResultPreviewItem),
    mergeSuggestions: result.mergeSuggestions.length,
    mergeSuggestionPreview: result.mergeSuggestions.slice(0, 6),
    readyCandidates: result.readyCandidates.length,
    providerStats: result.providerStats,
    cacheHits: result.cacheHits.length,
    usedFallback: result.usedFallback,
    extractionIssue: result.extractionIssue,
    stepFailed,
    failureReason: stepFailed
      ? "已保存补查结果，但还没有形成可确认的同人合并建议或完整证据候选。"
      : null,
    needsReview: result.mergeSuggestions.length
      ? [`${result.mergeSuggestions.length} 条同名专家关系需要人工确认后才能合并证据。`]
      : ["补查结果仍需人工核验身份，未自动合并专家档案。"],
    nextActions: result.mergeSuggestions.length
      ? ["打开供给发现中的合并建议，核对姓名、机构和来源后确认或拒绝。"]
      : ["调整候选姓名、机构或主页搜索方向后重试。"],
  };
}

function buildSearchResultPreviewItem(result: {
  id: string;
  title: string;
  url: string;
  domain?: string | null;
  query: string;
  snippet: string;
}) {
  return {
    searchResultId: result.id,
    title: result.title,
    url: result.url,
    domain: result.domain ?? null,
    query: result.query,
    snippet: result.snippet.slice(0, 240),
  };
}

function buildSerializedCandidatePreviewItem(candidate: {
  id: string;
  sourceType?: string | null;
  humanReviewNeeded?: boolean;
  nextAction?: string | null;
  expert?: {
    name?: string | null;
    title?: string | null;
    affiliation?: string | null;
    evidenceLevel?: string | null;
    sourceUrl?: string | null;
  };
}) {
  return buildCandidatePreviewItem(candidate);
}

function buildCandidatePreviewItem(candidate: {
  id: string;
  sourceType?: string | null;
  humanReviewNeeded?: boolean;
  nextAction?: string | null;
  expert?: {
    name?: string | null;
    title?: string | null;
    affiliation?: string | null;
    evidenceLevel?: string | null;
    sourceUrl?: string | null;
  };
}) {
  return {
    candidateId: candidate.id,
    name: candidate.expert?.name ?? "待复核候选",
    title: candidate.expert?.title ?? null,
    affiliation: candidate.expert?.affiliation ?? null,
    evidenceLevel: candidate.expert?.evidenceLevel ?? null,
    sourceType: candidate.sourceType ?? null,
    humanReviewNeeded: Boolean(candidate.humanReviewNeeded),
    sourceUrl: candidate.expert?.sourceUrl ?? null,
    nextAction: candidate.nextAction ?? "先核验证据，再决定是否触达。",
  };
}

async function executeRankSupply(projectId: string) {
  const result = await rankUnifiedSupply(projectId);
  if (!result) throw new Error("项目不存在或已被删除。");
  return buildRankSupplyStepOutput(result);
}

export function buildRankSupplyStepOutput(result: {
  usedFallback: boolean;
  candidates: Array<{ risks: string[]; nextAction?: string | null }>;
}) {
  const needsReview = Array.from(
    new Set(
      result.candidates
        .flatMap((candidate) => candidate.risks)
        .map(normalizeAgentUserFacingText)
        .filter(Boolean),
    ),
  ).slice(0, 8);
  const nextActions = Array.from(
    new Set(
      result.candidates
        .map((candidate) => candidate.nextAction ?? "")
        .map(normalizeAgentUserFacingText)
        .filter(Boolean),
    ),
  ).slice(0, 5);

  return {
    ranked: result.candidates.length,
    usedFallback: result.usedFallback,
    needsReview,
    nextActions: nextActions.length ? nextActions : ["先补充或召回候选，再更新候选排序。"],
  };
}

async function executeGenerateMarketing(projectId: string, instruction: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { candidates: { include: { expert: true } } },
  });
  if (!project) throw new Error("项目不存在或已被删除。");
  const channels = ["linkedin", "wechat", "xiaohongshu", "community"].filter(
    (channel): channel is (typeof MARKETING_CHANNELS)[number] => (MARKETING_CHANNELS as readonly string[]).includes(channel),
  );
  const projectBrief = serializeProjectForGeneration(project);
  const audience = ["领域专家", "专家推荐人", "技术社区成员"];
  const messageBrief =
    instruction ||
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

  const generatedChannels = new Set(campaignDraft.posts.map((post) => post.channel));
  const missingChannels = channels.filter((channel) => !generatedChannels.has(channel));
  if (missingChannels.length) throw new Error("渠道内容未生成完整，请重新生成渠道草稿。");
  const attractionReadiness = evaluateMarketingAttractionReadiness({
    posts: campaignDraft.posts,
    sourceText: marketingSourceText,
  });

  const campaign = await prisma.marketingCampaign.create({
    data: {
      projectId,
      objective: "recruit_experts",
      audienceJson: stringifyJson(campaignDraft.audience),
      channelsJson: stringifyJson(channels),
      messageBrief: campaignDraft.campaignSummary,
      status: "draft",
    },
  });
  const posts = await prisma.$transaction(
    campaignDraft.posts.map((post) =>
      prisma.marketingPost.create({
        data: {
          campaignId: campaign.id,
          projectId,
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
    projectId,
    entityType: "marketing_campaign",
    entityId: campaign.id,
    action: generation.fallbackChannels.length ? "ai.marketing.fallback" : "ai.marketing.completed",
    payload: {
      channels,
      posts: posts.length,
      usage: generation.usage,
      attractionReadiness,
      successfulChannels: generation.successfulChannels,
      fallbackChannels: generation.fallbackChannels,
      failures: generation.failures,
      fallback: generation.fallbackChannels.length > 0,
    },
  });
  return {
    campaignId: campaign.id,
    posts: posts.length,
    attractionReadiness,
    successfulChannels: generation.successfulChannels,
    fallbackChannels: generation.fallbackChannels,
    needsReview: [
      "渠道内容发布前需要人工审批，并确认报名动作清晰。",
      ...(generation.fallbackChannels.length
        ? [`${generation.fallbackChannels.join("、")} 使用基础模板，请重点复核后再审批。`]
        : []),
      ...attractionReadiness.needsReview,
      ...(attractionReadiness.passed ? [] : attractionReadiness.blockers),
    ],
    nextActions: attractionReadiness.nextActions,
  };
}

async function executeRetrospective(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { candidates: true, marketingPosts: true, recruitmentOutcomes: true },
  });
  if (!project) throw new Error("项目不存在或已被删除。");
  if (!project.candidates.length && !project.marketingPosts.length) {
    return {
      skipped: true,
      reason: "当前项目还没有候选或渠道数据。",
      needsReview: ["数据不足，暂不生成策略结论。"],
      nextActions: ["先完成内部召回、候选发现或渠道分发，再生成复盘。"],
    };
  }
  const outcome = await createRecruitmentRetrospective(projectId);
  if (!outcome) throw new Error("项目不存在或已被删除。");
  return {
    outcomeId: outcome.id,
    nextActions: ["查看数据复盘中的来源质量和下一轮策略。"],
  };
}

async function blockForConfirmation(run: RunWithSteps, step: AgentTaskStep, executionToken: string) {
  const preview = await buildExternalSearchConfirmation(run.projectId, run.instruction, run.intent);
  const stepUpdated = await prisma.agentTaskStep.updateMany({
    where: {
      id: step.id,
      status: "pending",
      run: { executionToken, status: "running" },
    },
    data: {
      status: "blocked",
      checksJson: stringifyJson(preview),
      errorMessage: "需要确认后再调用外部搜索。",
    },
  });
  if (stepUpdated.count !== 1) return false;
  const refreshed = await prisma.agentTaskRun.findUnique({
    where: { id: run.id },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });
  const runUpdated = await prisma.agentTaskRun.updateMany({
    where: { id: run.id, status: "running", executionToken },
    data: {
      status: "waiting_for_confirmation",
      reportJson: stringifyJson(buildReportFromSteps("waiting_for_confirmation", refreshed?.steps ?? run.steps)),
      errorMessage: null,
      executionToken: null,
      leaseExpiresAt: null,
    },
  });
  if (runUpdated.count !== 1) return false;
  await writeAuditEvent({
    projectId: run.projectId,
    entityType: "agent_task_run",
    entityId: run.id,
    action: "agent.task.waiting_for_confirmation",
    payload: {
      intent: run.intent,
      step: step.stepKey,
      preview,
    },
  });
  return true;
}

async function finalizeAgentRun(runId: string, executionToken: string) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });
  if (!run) return null;
  if (run.status !== "running" || run.executionToken !== executionToken) return serializeAgentRun(run);

  const dependentStepIds = getDependentStepsToSkip(run.steps);
  if (dependentStepIds.length) {
    await prisma.agentTaskStep.updateMany({
      where: {
        id: { in: dependentStepIds },
        run: { executionToken, status: "running" },
      },
      data: {
        status: "skipped",
        errorMessage: DEPENDENCY_SKIP_REASON,
        completedAt: new Date(),
      },
    });
  }
  const reportSteps = run.steps.map((step) =>
    dependentStepIds.includes(step.id)
      ? { ...step, status: "skipped", errorMessage: DEPENDENCY_SKIP_REASON, completedAt: new Date() }
      : step,
  );
  const failed = reportSteps.some((step) => step.status === "failed");
  const succeeded = reportSteps.some((step) => step.status === "succeeded" || step.status === "skipped");
  const status: AgentRunStatus = failed ? (succeeded ? "partially_succeeded" : "failed") : "succeeded";
  const report = buildReportFromSteps(status, reportSteps);
  const qualityStep = reportSteps.find((step) => step.stepKey === "quality_report");
  if (qualityStep && qualityStep.status !== "succeeded") {
    await prisma.agentTaskStep.updateMany({
      where: {
        id: qualityStep.id,
        run: { executionToken, status: "running" },
      },
      data: {
        status: "succeeded",
        startedAt: qualityStep.startedAt ?? new Date(),
        completedAt: new Date(),
        outputJson: stringifyJson({
          summary: report.summary,
          nextActions: report.nextActions,
        }),
      },
    });
  }

  const finalized = await prisma.agentTaskRun.updateMany({
    where: { id: run.id, status: "running", executionToken },
    data: {
      status,
      completedAt: new Date(),
      reportJson: stringifyJson(report),
      errorMessage: failed ? report.failed[0] ?? "任务未完成。" : null,
      executionToken: null,
      leaseExpiresAt: null,
    },
  });
  if (finalized.count !== 1) return getAgentTaskRun(run.id);
  const updated = await prisma.agentTaskRun.findUniqueOrThrow({
    where: { id: run.id },
    include: { steps: { orderBy: { order: "asc" }, include: { toolReceipts: { orderBy: { createdAt: "asc" } } } } },
  });

  await writeAuditEvent({
    projectId: updated.projectId,
    entityType: "agent_task_run",
    entityId: updated.id,
    action: status === "succeeded" ? "agent.task.completed" : "agent.task.partially_completed",
    payload: {
      intent: updated.intent,
      status,
      report,
    },
  });
  return serializeAgentRun(updated);
}

async function buildPreflight(intent: string, project: Project & { candidates: unknown[]; marketingPosts: unknown[]; supplyGaps: unknown[] }) {
  const missing: string[] = [];
  const warnings: string[] = [];
  const needsReview: string[] = [];
  const rawDemandLength = project.rawDemand.trim().length;
  const hasPersona = Object.keys(parseJson<Record<string, unknown>>(project.personaJson, {})).length > 0;
  const searchQueries = parseJson<string[]>(project.searchQueriesJson, []).filter(Boolean);
  const internalExperts = await prisma.expert.count({
    where: {
      expertType: { in: ["internal", "referred"] },
      consentState: { notIn: ["do_not_contact", "delete_requested", "unsubscribed"] },
    },
  });
  const evidenceEnrichmentTargets =
    intent === "enrich_candidate_evidence" ? (await getCandidateEvidenceEnrichmentQueries(project.id)).length : 0;

  if (rawDemandLength < 8) missing.push("项目需求太短，请补充任务目标和专家要求。");
  if (!project.quantity || project.quantity <= 0) warnings.push("目标专家数量未填写，系统会按当前数据保守执行。");
  if (requiresProjectReview(project)) needsReview.push("高风险或强监管项目需人工复核后再触达。");
  const internalSupplyAvailability = assessInternalSupplyAvailability(intent, internalExperts);
  missing.push(...internalSupplyAvailability.missing);
  warnings.push(...internalSupplyAvailability.warnings);
  if ((intent === "search_candidates" || intent === "external_research") && !searchQueries.length && !project.supplyGaps.length) {
    missing.push("请先补齐需求画像或供给缺口，再补充公开候选。");
  }
  if (intent === "rank_supply" && project.candidates.length === 0) {
    missing.push("当前项目还没有候选，无法更新排序。");
  }
  if (intent === "enrich_candidate_evidence" && evidenceEnrichmentTargets === 0) {
    missing.push("当前没有 E2+ 且缺少机构主页证据的公开候选。");
  }
  if (intent === "generate_marketing" && !project.marketingPosts.length) warnings.push("生成后请先复核各渠道文案和报名动作。");
  if (intent === "recruitment_retrospective" && !project.candidates.length && !project.marketingPosts.length) {
    warnings.push("当前项目数据较少，复盘会保持保守。");
  }
  if (!hasPersona && intent !== "analyze_project") {
    warnings.push("项目画像不完整，建议先补齐需求画像。");
  }

  return {
    ok: missing.length === 0,
    message: missing[0] ?? null,
    checks: {
      missing,
      warnings,
      needsReview,
      internalExperts,
      candidateCount: project.candidates.length,
      evidenceEnrichmentTargets,
      searchQueries: searchQueries.length,
      channelPostCount: project.marketingPosts.length,
    },
    output: {
      missing,
      warnings,
      needsReview,
      nextActions: missing.length ? ["补齐前置条件后重新提交任务。"] : ["开始执行任务。"],
    },
  };
}

export function assessInternalSupplyAvailability(intent: string, internalExperts: number) {
  if (internalExperts > 0) return { missing: [], warnings: [] };
  if (intent === "internal_match") {
    return { missing: ["专家库暂无可召回的内部或推荐专家。"], warnings: [] };
  }
  if (intent === "full_sourcing") {
    return {
      missing: [],
      warnings: ["专家库暂无可召回的内部或推荐专家，将继续分析缺口并在确认后补充公开候选。"],
    };
  }
  return { missing: [], warnings: [] };
}

async function buildContextSnapshot(project: Project & { candidates: unknown[]; marketingPosts: unknown[]; supplyGaps: unknown[] }) {
  const searchQueries = parseJson<string[]>(project.searchQueriesJson, []).filter(Boolean);
  const cacheHits = shouldBypassSearchCache()
    ? 0
    : await prisma.searchCache.count({
        where: {
          query: { in: searchQueries.slice(0, 4) },
          expiresAt: { gt: new Date() },
        },
      });
  return {
    title: project.title,
    status: project.status,
    riskLevel: project.riskLevel,
    candidateCount: project.candidates.length,
    marketingPostCount: project.marketingPosts.length,
    openGapCount: project.supplyGaps.filter((gap) => typeof gap === "object" && gap && "status" in gap && gap.status === "open").length,
    searchQueries: searchQueries.length,
    cachedQueries: cacheHits,
    channelPostCount: project.marketingPosts.length,
  };
}

async function buildExternalSearchConfirmation(projectId: string, instruction: string, intent: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { supplyGaps: { where: { status: "open" }, orderBy: { createdAt: "desc" }, take: 6 } },
  });
  if (!project) return { queries: 0, cached: 0, uncached: 0, message: "项目不存在或已被删除。" };
  const projectQueries = parseJson<string[]>(project.searchQueriesJson, []);
  const gapQueries = project.supplyGaps.flatMap((gap) => buildConfirmationGapQueries(project, gap.description));
  const searchBase = buildSearchQueryBase(project);
  const explicitInstructionQueries = buildInstructionSourceQueries(searchBase, instruction);
  const personaQueries = buildPersonaSourceQueries(project);
  const queries =
    intent === "enrich_candidate_evidence"
      ? await getCandidateEvidenceEnrichmentQueries(projectId)
      : selectExternalResearchQueries({
          project,
          gapQueries,
          projectQueries,
          hardRequirementQueries: personaQueries,
          instructionQueries: explicitInstructionQueries,
          directionQueries: buildConfirmationDirectionQueries(project),
          maxQueries: 4,
        });
  const cachedRows = queries.length && !shouldBypassSearchCache()
      ? await prisma.searchCache.findMany({
        where: { query: { in: queries }, expiresAt: { gt: new Date() } },
        select: { query: true, provider: true },
      })
    : [];
  const compatibleCachedQueries = getCompatibleCachedQueries(cachedRows);
  const preview = buildExternalResearchAcceptancePreview({
    project,
    queries,
    cachedQueries: compatibleCachedQueries,
  });
  return {
    queries: preview.queryCount,
    cached: preview.cached,
    uncached: preview.uncached,
    queryPreview: preview.queryPreview,
    sourceCoverage: intent === "enrich_candidate_evidence" ? ["institution"] : preview.sourceCoverage,
    coverageLabels: intent === "enrich_candidate_evidence" ? ["机构主页"] : preview.coverageLabels,
    acceptanceChecks:
      intent === "enrich_candidate_evidence"
        ? ["页面明确出现候选姓名。", "来源属于大学、医院或研究机构公开页面。", "同人关系只生成建议，人工确认后才合并。"]
        : preview.acceptanceChecks,
    needsReview: preview.needsReview,
  };
}

function buildConfirmationDirectionQueries(project: Project) {
  const base = buildSearchQueryBase(project);
  return [
    `${base} 机构主页 专家`,
    `${base} 会议 讲者 专家`,
    `${base} 论文 作者 专家`,
    `${base} 行业协会 专家`,
  ]
    .map((query) => query.trim())
    .filter(Boolean);
}

function buildConfirmationGapQueries(project: Project, description: string) {
  const base = buildSearchQueryBase(project);
  if (/证据|E2|机构|论文|会议/.test(description)) {
    return [`${base} 机构主页 专家`, `${base} 论文 作者`, `${base} 会议 讲者`];
  }
  if (/联系|触达/.test(description)) {
    return [`${base} 专家 公开主页`, `${base} consultant profile`];
  }
  return [`${base} 专家`, `${base} professional profile`];
}

export function buildSearchQueryBase(project: Pick<Project, "domain" | "rawDemand" | "taskType" | "title">) {
  return (
    inferSearchBaseFromDemand(project) ||
    meaningfulProjectDomain(project) ||
    meaningfulProjectTitle(project) ||
    "专业专家"
  ).replace(/\s+/g, " ");
}

function meaningfulProjectDomain(project: Pick<Project, "domain">) {
  const domain = project.domain?.trim();
  if (!domain || /^(未分类领域|未分类|unknown|general|n\/a|none)$/i.test(domain)) return null;
  return domain;
}

function meaningfulProjectTitle(project: Pick<Project, "title">) {
  const title = project.title.trim();
  if (!title || /smoke|回归|测试|线上 ui|neon/i.test(title)) return null;
  return title;
}

function inferSearchBaseFromDemand(project: Pick<Project, "rawDemand" | "taskType">) {
  const text = `${project.rawDemand} ${project.taskType ?? ""}`;
  const softwareBase = inferSoftwareSearchBase(text);
  if (softwareBase) return softwareBase;
  if (/中文文本|标注指南|一致性审核|数据标注|中文NLP/.test(text)) {
    return "中文文本 标注质量 一致性审核 数据标注";
  }
  if (/肺结节|CT|放射|医学影像/.test(text)) {
    return "肺结节 CT 放射科 医生";
  }
  if (/生物|生命科学|bio/i.test(text)) {
    return "生物学 硕士 博士 研究员";
  }
  return null;
}

function inferSoftwareSearchBase(text: string) {
  if (!/python|pydantic|sqlmodel|fastapi|django|sqlalchemy|pytest|ruff|mypy|代码|后端|code review|backend/i.test(text)) {
    return null;
  }

  const technologies = [
    [/python/i, "Python"],
    [/fastapi/i, "FastAPI"],
    [/django/i, "Django"],
    [/sqlalchemy/i, "SQLAlchemy"],
    [/pydantic\s*v?2/i, "Pydantic v2"],
    [/pydantic-core/i, "pydantic-core"],
    [/sqlmodel/i, "SQLModel"],
    [/typeadapter/i, "TypeAdapter"],
    [/json\s+schema/i, "JSON Schema"],
    [/pytest/i, "pytest"],
    [/\bruff\b/i, "Ruff"],
    [/\bmypy\b/i, "mypy"],
  ] as const;
  const matched = technologies.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  const stack = matched.slice(0, 4);
  if (!stack.length) return null;
  return [...stack, /代码|code review|审查|评审/i.test(text) ? "代码评审" : "技术专家"].join(" ");
}

function buildReportFromSteps(status: AgentRunStatus | string, steps: AgentTaskStep[]) {
  return buildAgentRunReport({
    status,
    steps: steps.map((step) => ({
      stepKey: step.stepKey,
      label: step.label,
      status: step.status,
      output: parseJson<Record<string, unknown>>(step.outputJson, {}),
      checks: parseJson<Record<string, unknown>>(step.checksJson, {}),
      errorMessage: step.errorMessage,
    })),
  });
}

export function getApprovedExternalSearchQueries(
  steps: Array<Pick<AgentTaskStep, "stepKey" | "confirmedAt" | "outputJson" | "checksJson">>,
) {
  const confirmation = steps.find((step) => step.stepKey === "confirm_external_search" && step.confirmedAt);
  if (!confirmation) return [];
  const output = parseJson<{ approvedQueries?: unknown }>(confirmation.outputJson, {});
  return readStringList(output.approvedQueries);
}

function buildExternalSearchToolContext(
  run: RunWithSteps,
  stepKey: "external_research" | "search_candidates" | "enrich_candidate_evidence",
) {
  const executionStep = run.steps.find((step) => step.stepKey === stepKey);
  const confirmationStep = run.steps.find(
    (step) => step.stepKey === "confirm_external_search" && Boolean(step.confirmedAt),
  );
  if (!executionStep || !confirmationStep) {
    throw new Error("公开搜索计划尚未完成确认，未调用外部搜索服务。");
  }
  return {
    runId: run.id,
    stepId: executionStep.id,
    approvalId: confirmationStep.id,
  } satisfies AgentToolExecutionContext;
}

function readStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)));
}

export function serializeAgentRun(run: RunWithSteps): SerializedAgentRun {
  const safeRun: Omit<
    RunWithSteps,
    "workflowRunId" | "executionToken" | "leaseExpiresAt" | "heartbeatAt" | "planJson" | "contextSnapshotJson" | "reportJson"
  > &
    Partial<
      Pick<
        RunWithSteps,
        "workflowRunId" | "executionToken" | "leaseExpiresAt" | "heartbeatAt" | "planJson" | "contextSnapshotJson" | "reportJson"
      >
    > = {
    ...run,
  };
  delete safeRun.workflowRunId;
  delete safeRun.executionToken;
  delete safeRun.leaseExpiresAt;
  delete safeRun.heartbeatAt;
  delete safeRun.planJson;
  delete safeRun.contextSnapshotJson;
  delete safeRun.reportJson;
  return {
    ...safeRun,
    label: getAgentIntentLabel(run.intent),
    plan: parseJson<Record<string, unknown>>(run.planJson, {}),
    contextSnapshot: parseJson<Record<string, unknown>>(run.contextSnapshotJson, {}),
    report: parseJson<AgentRunReport | Record<string, unknown>>(run.reportJson, {}),
    steps: run.steps.map((step) => {
      const { toolReceipts = [], ...stepRecord } = step;
      const safeStep: Omit<AgentTaskStep, "inputJson" | "outputJson" | "checksJson"> &
        Partial<Pick<AgentTaskStep, "inputJson" | "outputJson" | "checksJson">> = { ...stepRecord };
      delete safeStep.inputJson;
      delete safeStep.outputJson;
      delete safeStep.checksJson;
      return {
        ...safeStep,
        input: parseJson<Record<string, unknown>>(step.inputJson, {}),
        output: parseJson<Record<string, unknown>>(step.outputJson, {}),
        checks: parseJson<Record<string, unknown>>(step.checksJson, {}),
        toolReceipts: toolReceipts.map((receipt) => {
          const { argumentDigest, toolCallId, resultSummaryJson, ...safeReceipt } = receipt;
          void argumentDigest;
          void toolCallId;
          return {
            ...safeReceipt,
            resultSummary: parseJson<Record<string, unknown>>(resultSummaryJson, {}),
          };
        }),
      };
    }),
  };
}

export function validateAgentRunStatusTransition(from: string, to: string): { ok: true } | { ok: false; reason: string } {
  const transitions: Record<AgentRunStatus, AgentRunStatus[]> = {
    planned: ["running", "preflight_failed", "cancelled"],
    preflight_failed: ["planned", "cancelled"],
    waiting_for_confirmation: ["planned", "running", "cancelled"],
    running: ["waiting_for_confirmation", "succeeded", "partially_succeeded", "failed", "cancelled"],
    succeeded: [],
    partially_succeeded: ["running"],
    failed: ["planned", "running"],
    cancelled: [],
  };
  if (from === to) return { ok: true };
  if (!(from in transitions) || !(to in transitions)) return { ok: false, reason: "任务状态不可识别。" };
  return transitions[from as AgentRunStatus].includes(to as AgentRunStatus)
    ? { ok: true }
    : { ok: false, reason: "当前任务状态不能执行该动作。" };
}

export function normalizeAgentIntent(value: unknown): AgentIntent | null {
  return isAgentIntent(value) ? value : null;
}
