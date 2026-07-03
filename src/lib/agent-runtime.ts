import type { AgentTaskRun, AgentTaskStep, Project } from "@prisma/client";
import { writeAuditEvent } from "@/lib/audit";
import {
  type AgentIntent,
  type AgentRunStatus,
  type AgentStepKey,
  getAgentIntentLabel,
  getAgentTaskTemplate,
  isAgentIntent,
} from "@/lib/agent-tasks";
import { buildAgentRunReport, toActionableError, type AgentRunReport } from "@/lib/agent-quality";
import { MARKETING_CHANNELS } from "@/lib/constants";
import { requiresProjectReview } from "@/lib/gates";
import { parseJson, stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { normalizeProjectAnalysis } from "@/lib/project-analysis";
import { redactSensitiveText } from "@/lib/redaction";
import { serializeProject, serializeSearchResult } from "@/lib/serializers";
import { sourceProjectCandidates } from "@/lib/sourcing";
import {
  analyzeProjectSupplyGap,
  createRecruitmentRetrospective,
  rankUnifiedSupply,
  runExternalResearch,
  runInternalMatch,
} from "@/lib/supply-flywheel";
import { analyzeProjectDemand, draftMarketingCampaign } from "@/lib/workflows";

export type SerializedAgentStep = Omit<AgentTaskStep, "inputJson" | "outputJson" | "checksJson"> & {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  checks: Record<string, unknown>;
};

export type SerializedAgentRun = Omit<AgentTaskRun, "planJson" | "contextSnapshotJson" | "reportJson"> & {
  label: string;
  plan: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
  report: AgentRunReport | Record<string, unknown>;
  steps: SerializedAgentStep[];
};

type RunWithSteps = AgentTaskRun & { steps: AgentTaskStep[] };

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
    include: { steps: { orderBy: { order: "asc" } } },
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
    include: { steps: { orderBy: { order: "asc" } } },
  });
  return run ? serializeAgentRun(run) : null;
}

export async function cancelAgentTaskRun(runId: string) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!run) return null;
  if (["succeeded", "partially_succeeded", "failed", "cancelled"].includes(run.status)) {
    return serializeAgentRun(run);
  }

  const updated = await prisma.agentTaskRun.update({
    where: { id: runId },
    data: {
      status: "cancelled",
      completedAt: new Date(),
      reportJson: stringifyJson(buildReportFromSteps("cancelled", run.steps)),
    },
    include: { steps: { orderBy: { order: "asc" } } },
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

export async function confirmAgentTaskRun(runId: string, options?: { resume?: boolean }) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!run) return null;

  const confirmationSteps = run.steps.filter((step) => step.requiresConfirmation && !step.confirmedAt);
  if (!confirmationSteps.length) return options?.resume === false ? serializeAgentRun(run) : startAgentTaskRun(run.id);

  await prisma.$transaction(
    confirmationSteps.map((step) =>
      prisma.agentTaskStep.update({
        where: { id: step.id },
        data: {
          status: "succeeded",
          confirmedAt: new Date(),
          completedAt: new Date(),
          outputJson: stringifyJson({
            confirmed: true,
            nextActions: ["继续执行公开候选补充。"],
          }),
          errorMessage: null,
        },
      }),
    ),
  );
  await prisma.agentTaskRun.update({
    where: { id: run.id },
    data: { status: "planned", errorMessage: null },
  });
  await writeAuditEvent({
    projectId: run.projectId,
    entityType: "agent_task_run",
    entityId: run.id,
    action: "agent.task.confirmed",
    payload: {
      intent: run.intent,
      steps: confirmationSteps.map((step) => step.stepKey),
    },
  });

  return options?.resume === false ? getAgentTaskRun(runId) : startAgentTaskRun(runId);
}

export async function retryAgentTaskRun(runId: string) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!run) return null;

  await prisma.$transaction(
    run.steps
      .filter((step) => ["failed", "blocked", "running"].includes(step.status))
      .map((step) =>
        prisma.agentTaskStep.update({
          where: { id: step.id },
          data: {
            status: step.requiresConfirmation && !step.confirmedAt ? "blocked" : "pending",
            errorMessage: step.requiresConfirmation && !step.confirmedAt ? step.errorMessage : null,
            startedAt: null,
            completedAt: null,
          },
        }),
      ),
  );
  await prisma.agentTaskRun.update({
    where: { id: run.id },
    data: {
      status: run.steps.some((step) => step.requiresConfirmation && !step.confirmedAt) ? "waiting_for_confirmation" : "planned",
      errorMessage: null,
      completedAt: null,
    },
  });

  const refreshed = await getAgentTaskRun(runId);
  if (refreshed?.status === "waiting_for_confirmation") return refreshed;
  return startAgentTaskRun(runId);
}

export async function startAgentTaskRun(runId: string) {
  let run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!run) return null;

  if (run.status === "preflight_failed") return serializeAgentRun(run);
  if (run.status === "waiting_for_confirmation") {
    const unconfirmed = run.steps.find((step) => step.requiresConfirmation && !step.confirmedAt);
    if (unconfirmed) return serializeAgentRun(run);
  }
  if (["succeeded", "partially_succeeded", "failed", "cancelled"].includes(run.status)) {
    return serializeAgentRun(run);
  }

  run = await prisma.agentTaskRun.update({
    where: { id: run.id },
    data: {
      status: "running",
      startedAt: run.startedAt ?? new Date(),
      errorMessage: null,
    },
    include: { steps: { orderBy: { order: "asc" } } },
  });

  await writeAuditEvent({
    projectId: run.projectId,
    entityType: "agent_task_run",
    entityId: run.id,
    action: "agent.task.started",
    payload: { intent: run.intent },
  });

  for (const step of run.steps) {
    if (["succeeded", "skipped"].includes(step.status)) continue;
    if (step.stepKey === "quality_report") continue;
    if (step.requiresConfirmation && !step.confirmedAt) {
      await blockForConfirmation(run, step);
      return getAgentTaskRun(run.id);
    }

    const result = await executeStep(run, step);
    if (result === "blocked") return getAgentTaskRun(run.id);
    if (result === "failed") break;
  }

  return finalizeAgentRun(run.id);
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
    include: { steps: { orderBy: { order: "asc" } } },
  });
  return updated;
}

async function executeStep(run: RunWithSteps, step: AgentTaskStep): Promise<"succeeded" | "failed" | "blocked"> {
  await prisma.agentTaskStep.update({
    where: { id: step.id },
    data: {
      status: "running",
      startedAt: new Date(),
      errorMessage: null,
    },
  });

  try {
    const output = await executeStepAction(run, step.stepKey as AgentStepKey);
    await prisma.agentTaskStep.update({
      where: { id: step.id },
      data: {
        status: output.skipped ? "skipped" : "succeeded",
        outputJson: stringifyJson(output),
        completedAt: new Date(),
        errorMessage: null,
      },
    });
    await writeAuditEvent({
      projectId: run.projectId,
      entityType: "agent_task_run",
      entityId: run.id,
      action: output.skipped ? "agent.step.skipped" : "agent.step.completed",
      payload: {
        intent: run.intent,
        step: step.stepKey,
        output,
      },
    });
    return "succeeded";
  } catch (error) {
    const message = toActionableError(error);
    await prisma.agentTaskStep.update({
      where: { id: step.id },
      data: {
        status: "failed",
        errorMessage: message,
        completedAt: new Date(),
      },
    });
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
      return executeExternalResearch(run.projectId);
    case "search_candidates":
      return executeSearchCandidates(run.projectId);
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

async function executeExternalResearch(projectId: string) {
  const result = await runExternalResearch(projectId);
  if (!result) throw new Error("项目不存在或已被删除。");
  if (!result.ok) throw new Error(result.error);
  return {
    runId: result.runId,
    searchResults: result.searchResults.length,
    candidates: result.candidates.length,
    providerStats: result.providerStats,
    cacheHits: result.cacheHits.length,
    needsReview: ["公开来源候选进入复核后，再判断是否可触达。"],
    nextActions: ["更新候选排序，优先处理高证据候选。"],
  };
}

async function executeSearchCandidates(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("项目不存在或已被删除。");
  const queries = parseJson<string[]>(project.searchQueriesJson, []).slice(0, 4);
  if (!queries.length) throw new Error("请先补齐需求画像，生成搜索方向后再搜索候选。");
  const result = await sourceProjectCandidates({ project, queries });
  if (!result.ok) throw new Error(result.error);
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
    },
  });
  return {
    searchResults: result.searchResults.map(serializeSearchResult).length,
    candidates: result.candidates.length,
    providerStats: result.providerStats,
    cacheHits: result.cacheHits.length,
    needsReview: ["搜索候选需完成证据复核后再触达。"],
    nextActions: ["查看候选推进列表，处理低证据和高风险候选。"],
  };
}

async function executeRankSupply(projectId: string) {
  const result = await rankUnifiedSupply(projectId);
  if (!result) throw new Error("项目不存在或已被删除。");
  return {
    ranked: result.candidates.length,
    usedFallback: result.usedFallback,
    needsReview: result.candidates.filter((candidate) => candidate.risks.length).slice(0, 5).map((candidate) => candidate.nextAction),
    nextActions: ["从候选推进中筛选高证据和可触达候选。"],
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
  const result = await draftMarketingCampaign({
    project: serializeProject(project),
    channels,
    audience: ["领域专家", "专家推荐人", "技术社区成员"],
    messageBrief:
      instruction ||
      "生成公开渠道可发布的专家招募项目需求文案，强调任务类型、专家要求、合规试标和人工审核，不承诺虚假收益。",
    existingCandidateSignals: project.candidates.slice(0, 5).map((candidate) => ({
      name: candidate.expert.name,
      title: candidate.expert.title,
      evidenceLevel: candidate.expert.evidenceLevel,
    })),
  });
  if (!result.ok) throw new Error(result.error);

  const generatedChannels = new Set(result.data.posts.map((post) => post.channel));
  const missingChannels = channels.filter((channel) => !generatedChannels.has(channel));
  if (missingChannels.length) throw new Error("渠道内容未生成完整，请重新生成渠道草稿。");

  const campaign = await prisma.marketingCampaign.create({
    data: {
      projectId,
      objective: "recruit_experts",
      audienceJson: stringifyJson(result.data.audience),
      channelsJson: stringifyJson(channels),
      messageBrief: result.data.campaignSummary,
      status: "draft",
    },
  });
  const posts = await prisma.$transaction(
    result.data.posts.map((post) =>
      prisma.marketingPost.create({
        data: {
          campaignId: campaign.id,
          projectId,
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
    projectId,
    entityType: "marketing_campaign",
    entityId: campaign.id,
    action: "ai.marketing.completed",
    payload: { channels, posts: posts.length, usage: result.usage },
  });
  return {
    campaignId: campaign.id,
    posts: posts.length,
    needsReview: ["渠道内容发布前需要人工审批，并确认报名动作清晰。"],
    nextActions: ["前往渠道中心复核内容。"],
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

async function blockForConfirmation(run: RunWithSteps, step: AgentTaskStep) {
  const preview = await buildExternalSearchConfirmation(run.projectId);
  await prisma.agentTaskStep.update({
    where: { id: step.id },
    data: {
      status: "blocked",
      checksJson: stringifyJson(preview),
      errorMessage: "需要确认后再调用外部搜索。",
    },
  });
  const refreshed = await prisma.agentTaskRun.findUnique({
    where: { id: run.id },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  await prisma.agentTaskRun.update({
    where: { id: run.id },
    data: {
      status: "waiting_for_confirmation",
      reportJson: stringifyJson(buildReportFromSteps("waiting_for_confirmation", refreshed?.steps ?? run.steps)),
      errorMessage: null,
    },
  });
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
}

async function finalizeAgentRun(runId: string) {
  const run = await prisma.agentTaskRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!run) return null;

  const failed = run.steps.some((step) => step.status === "failed");
  const succeeded = run.steps.some((step) => step.status === "succeeded" || step.status === "skipped");
  const status: AgentRunStatus = failed ? (succeeded ? "partially_succeeded" : "failed") : "succeeded";
  const report = buildReportFromSteps(status, run.steps);
  const qualityStep = run.steps.find((step) => step.stepKey === "quality_report");
  if (qualityStep && qualityStep.status !== "succeeded") {
    await prisma.agentTaskStep.update({
      where: { id: qualityStep.id },
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

  const updated = await prisma.agentTaskRun.update({
    where: { id: run.id },
    data: {
      status,
      completedAt: new Date(),
      reportJson: stringifyJson(report),
      errorMessage: failed ? report.failed[0] ?? "任务未完成。" : null,
    },
    include: { steps: { orderBy: { order: "asc" } } },
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

  if (rawDemandLength < 8) missing.push("项目需求太短，请补充任务目标和专家要求。");
  if (!project.quantity || project.quantity <= 0) warnings.push("目标专家数量未填写，系统会按当前数据保守执行。");
  if (requiresProjectReview(project)) needsReview.push("高风险或强监管项目需人工复核后再触达。");
  if ((intent === "internal_match" || intent === "full_sourcing") && internalExperts === 0) {
    missing.push("专家库暂无可召回的内部或推荐专家。");
  }
  if ((intent === "search_candidates" || intent === "external_research") && !searchQueries.length && !project.supplyGaps.length) {
    missing.push("请先补齐需求画像或供给缺口，再补充公开候选。");
  }
  if (intent === "rank_supply" && project.candidates.length === 0) {
    missing.push("当前项目还没有候选，无法更新排序。");
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

async function buildContextSnapshot(project: Project & { candidates: unknown[]; marketingPosts: unknown[]; supplyGaps: unknown[] }) {
  const searchQueries = parseJson<string[]>(project.searchQueriesJson, []).filter(Boolean);
  const cacheHits = await prisma.searchCache.count({
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

async function buildExternalSearchConfirmation(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { supplyGaps: { where: { status: "open" }, orderBy: { createdAt: "desc" }, take: 6 } },
  });
  if (!project) return { queries: 0, cached: 0, uncached: 0, message: "项目不存在或已被删除。" };
  const projectQueries = parseJson<string[]>(project.searchQueriesJson, []);
  const gapQueries = project.supplyGaps.map((gap) => `${project.domain ?? project.title} ${gap.description} 专家 公开资料`);
  const queries = Array.from(new Set([...gapQueries, ...projectQueries])).filter(Boolean).slice(0, 4);
  const cached = queries.length
    ? await prisma.searchCache.count({
        where: { query: { in: queries }, expiresAt: { gt: new Date() } },
      })
    : 0;
  return {
    queries: queries.length,
    cached,
    uncached: Math.max(0, queries.length - cached),
    queryPreview: queries,
    needsReview: ["确认后会优先复用已保存结果；未保存的查询会调用外部搜索服务。"],
  };
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

export function serializeAgentRun(run: RunWithSteps): SerializedAgentRun {
  return {
    ...run,
    label: getAgentIntentLabel(run.intent),
    plan: parseJson<Record<string, unknown>>(run.planJson, {}),
    contextSnapshot: parseJson<Record<string, unknown>>(run.contextSnapshotJson, {}),
    report: parseJson<AgentRunReport | Record<string, unknown>>(run.reportJson, {}),
    steps: run.steps.map((step) => ({
      ...step,
      input: parseJson<Record<string, unknown>>(step.inputJson, {}),
      output: parseJson<Record<string, unknown>>(step.outputJson, {}),
      checks: parseJson<Record<string, unknown>>(step.checksJson, {}),
    })),
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
