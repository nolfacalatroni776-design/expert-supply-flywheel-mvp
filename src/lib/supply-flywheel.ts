import type { EvidenceItem, Expert, Project, ProjectCandidate } from "@prisma/client";
import { writeAuditEvent } from "@/lib/audit";
import { normalizeAgentUserFacingText } from "@/lib/agent-quality";
import {
  isCandidateEligibleForSupplyMetrics,
  preserveManualScreeningDecision,
} from "@/lib/candidate-status";
import { PIPELINE_STAGES } from "@/lib/constants";
import {
  buildPersonaSourceQueries,
  evaluateExternalResearchAcceptance,
  selectExternalResearchQueries,
} from "@/lib/external-research-acceptance";
import { canApproveForOutreach, requiresProjectReview } from "@/lib/gates";
import { extractHostname, parseJson, stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { publicErrorMessage } from "@/lib/redaction";
import { serializeProjectForGeneration } from "@/lib/serializers";
import { sourceProjectCandidates } from "@/lib/sourcing";
import { analyzeSupplyGap, draftRecruitmentRetrospective, rankSupplyCandidates } from "@/lib/workflows";
import type { AgentToolExecutionContext } from "@/lib/agent-tools";

const evidenceRank: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };

type ExpertRecord = Omit<Expert, "identityKey"> & Partial<Pick<Expert, "identityKey">>;
type CandidateWithExpert = ProjectCandidate & { expert: ExpertRecord };

export async function runInternalMatch(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return null;

  const run = await prisma.supplySearchRun.create({
    data: {
      projectId,
      runType: "internal",
      status: "running",
      goalJson: stringifyJson(buildSupplyGoal(project)),
      queriesJson: project.searchQueriesJson,
      summaryJson: stringifyJson({ startedAt: new Date().toISOString() }),
    },
  });

  const experts = await prisma.expert.findMany({
    where: {
      expertType: { in: ["internal", "referred"] },
      consentState: { notIn: ["do_not_contact", "delete_requested", "unsubscribed"] },
    },
    include: {
      evidenceItems: true,
      signals: true,
      qualityMetrics: true,
      candidates: { include: { project: true }, orderBy: { updatedAt: "desc" }, take: 5 },
    },
    orderBy: [{ lastActiveAt: "desc" }, { updatedAt: "desc" }],
    take: 80,
  });

  const ranked = experts
    .map((expert) => scoreInternalExpert(project, expert))
    .filter((item) => item.hasDirectMatch && item.score >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(12, Math.min(project.quantity ?? 12, 30)));

  const candidates: CandidateWithExpert[] = [];
  const selectedExpertIds = new Set(ranked.map((item) => item.expert.id));
  const existingRelations = selectedExpertIds.size
    ? await prisma.projectCandidate.findMany({
        where: { projectId, expertId: { in: Array.from(selectedExpertIds) } },
        select: { expertId: true, stage: true, humanReviewNeeded: true, nextAction: true },
      })
    : [];
  const existingByExpertId = new Map(existingRelations.map((candidate) => [candidate.expertId, candidate]));
  for (const item of ranked) {
    const humanReviewNeeded =
      item.evidenceLevelRank < 2 ||
      requiresProjectReview(project) ||
      item.risks.length > 0 ||
      item.score < 75;
    const reviewUpdate = preserveManualScreeningDecision(existingByExpertId.get(item.expert.id), {
      humanReviewNeeded,
      nextAction: item.nextAction,
    });
    const candidate = await prisma.projectCandidate.upsert({
      where: { projectId_expertId: { projectId, expertId: item.expert.id } },
      update: {
        sourceType: "internal",
        sourceRunId: run.id,
        fitScore: Math.round(item.score),
        scoringJson: stringifyJson({
          evidenceLevel: item.expert.evidenceLevel,
          scoreBreakdown: item.breakdown,
          topReasons: item.reasons.slice(0, 4),
          source: "internal_match",
        }),
        risksJson: stringifyJson(item.risks),
        missingJson: stringifyJson(item.missing),
        nextAction: reviewUpdate.nextAction,
        humanReviewNeeded: reviewUpdate.humanReviewNeeded,
        conversionProbability: item.conversionProbability,
        rankReasonJson: stringifyJson({ reasons: item.reasons, source: "internal_match" }),
      },
      create: {
        projectId,
        expertId: item.expert.id,
        stage: "sourced",
        sourceType: "internal",
        sourceRunId: run.id,
        fitScore: Math.round(item.score),
        scoringJson: stringifyJson({
          evidenceLevel: item.expert.evidenceLevel,
          scoreBreakdown: item.breakdown,
          topReasons: item.reasons.slice(0, 4),
          source: "internal_match",
        }),
        risksJson: stringifyJson(item.risks),
        missingJson: stringifyJson(item.missing),
        nextAction: item.nextAction,
        humanReviewNeeded,
        conversionProbability: item.conversionProbability,
        rankReasonJson: stringifyJson({ reasons: item.reasons, source: "internal_match" }),
      },
      include: { expert: true },
    });
    await syncInternalCandidateEvidence({
      projectId,
      candidateId: candidate.id,
      expert: item.expert,
    });
    candidates.push(candidate);

    await prisma.expertEngagementEvent.create({
      data: {
        expertId: item.expert.id,
        projectId,
        candidateId: candidate.id,
        eventType: "recalled",
        channel: "internal_library",
        payloadJson: stringifyJson({
          fitScore: Math.round(item.score),
          reasons: item.reasons,
          runId: run.id,
        }),
      },
    });
  }

  const removedStaleCandidates = await prisma.projectCandidate.deleteMany({
    where: {
      projectId,
      sourceType: "internal",
      stage: "sourced",
      expertId: selectedExpertIds.size ? { notIn: Array.from(selectedExpertIds) } : undefined,
    },
  });

  await prisma.supplySearchRun.update({
    where: { id: run.id },
    data: {
      status: "completed",
      summaryJson: stringifyJson({
        matched: candidates.length,
        eligibleExperts: experts.length,
        removedStaleCandidates: removedStaleCandidates.count,
        highEvidence: candidates.filter((candidate) => (evidenceRank[candidate.expert.evidenceLevel] ?? 0) >= 2).length,
      }),
    },
  });

  await writeAuditEvent({
    projectId,
    entityType: "project",
    entityId: projectId,
    action: "supply.internal_match.completed",
    payload: {
      runId: run.id,
      eligibleExperts: experts.length,
      candidates: candidates.length,
      removedStaleCandidates: removedStaleCandidates.count,
    },
  });

  return { runId: run.id, candidates };
}

export async function analyzeProjectSupplyGap(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { candidates: { include: { expert: true } } },
  });
  if (!project) return null;

  const targetCount = project.quantity ?? 10;
  const available = project.candidates.filter(
    (candidate) => candidate.sourceType === "internal" && isCandidateEligibleForSupplyMetrics(candidate),
  );
  const highEvidence = available.filter((candidate) => (evidenceRank[candidate.expert.evidenceLevel] ?? 0) >= 2);
  const outreachReady = project.candidates.filter((candidate) =>
    canApproveForOutreach({ candidate, expert: candidate.expert, project }).ok,
  );
  const ruleGaps = buildRuleGaps(project, {
    targetCount,
    internalCount: available.length,
    highEvidenceCount: highEvidence.length,
    outreachReadyCount: outreachReady.length,
  });

  const ai = await analyzeSupplyGap({
    project: serializeProjectForGeneration(project),
    internalSupply: available.map((candidate) => ({
      candidateId: candidate.id,
      expertName: candidate.expert.name,
      title: candidate.expert.title,
      evidenceLevel: candidate.expert.evidenceLevel,
      fitScore: candidate.fitScore,
      sourceType: candidate.sourceType,
      humanReviewNeeded: candidate.humanReviewNeeded,
    })),
    ruleGaps,
  });

  const gapOutput = buildSafeSupplyGapOutput({
    ruleGaps,
    fallbackSearchDirections: buildSearchDirections(project),
    model: ai.ok ? ai.data : null,
  });

  await prisma.supplyGap.updateMany({
    where: { projectId, status: "open" },
    data: { status: "superseded" },
  });

  const gaps = await prisma.$transaction(
    gapOutput.gaps.map((gap) =>
      prisma.supplyGap.create({
        data: {
          projectId,
          gapType: gap.gapType,
          description: gap.description,
          requiredCount: gap.requiredCount,
          availableCount: gap.availableCount,
          severity: gap.severity,
          recommendedAction: gap.recommendedAction,
          status: "open",
        },
      }),
    ),
  );

  await writeAuditEvent({
    projectId,
    entityType: "project",
    entityId: projectId,
    action: ai.ok ? "supply.gap.completed" : "supply.gap.completed_with_rules",
    payload: {
      gaps: gaps.length,
      searchDirections: gapOutput.searchDirections,
      aiFallbackReason: ai.ok ? undefined : ai.error,
    },
  });

  return { gaps, searchDirections: gapOutput.searchDirections, summary: gapOutput.summary, usedFallback: !ai.ok };
}

type SupplyGapFact = {
  gapType: string;
  description: string;
  requiredCount: number;
  availableCount: number;
  severity: "low" | "medium" | "high" | "critical";
  recommendedAction: string;
};

const INTERNAL_SUPPLY_FIELDS = /\b(?:persona|fitScore|riskLevel|humanReviewNeeded|sourceType|sourceRunId|conversionProbability)\b/i;

export function buildSafeSupplyGapOutput({
  ruleGaps,
  fallbackSearchDirections,
  model,
}: {
  ruleGaps: SupplyGapFact[];
  fallbackSearchDirections: string[];
  model?: {
    gaps?: SupplyGapFact[];
    searchDirections?: string[];
    summary?: string;
  } | null;
}) {
  const modelDirections = (model?.searchDirections ?? [])
    .map((direction) => direction.trim())
    .filter((direction) => direction.length >= 4 && !INTERNAL_SUPPLY_FIELDS.test(direction))
    .map(normalizeAgentUserFacingText)
    .filter(Boolean);
  const fallbackDirections = fallbackSearchDirections
    .map(normalizeAgentUserFacingText)
    .filter(Boolean);
  const modelSummary = model?.summary?.trim() ?? "";

  return {
    gaps: ruleGaps,
    searchDirections: Array.from(new Set([...modelDirections, ...fallbackDirections])).slice(0, 6),
    summary:
      modelSummary && !INTERNAL_SUPPLY_FIELDS.test(modelSummary)
        ? normalizeAgentUserFacingText(modelSummary)
        : "已根据当前候选和项目目标生成供给缺口。",
  };
}

export async function runExternalResearch(
  projectId: string,
  options?: { queries?: string[]; toolContext?: AgentToolExecutionContext },
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { supplyGaps: { where: { status: "open" }, orderBy: { createdAt: "desc" }, take: 6 } },
  });
  if (!project) return null;

  const gapQueries = project.supplyGaps
    .flatMap((gap) => buildGapQueries(project, gap.description))
    .filter(Boolean);
  const projectQueries = parseJson<string[]>(project.searchQueriesJson, []);
  const approvedQueries = options?.queries?.map((query) => query.trim()).filter(Boolean) ?? [];
  const queries = approvedQueries.length
    ? Array.from(new Set(approvedQueries)).slice(0, 4)
    : selectExternalResearchQueries({
        project,
        gapQueries,
        projectQueries,
        hardRequirementQueries: buildPersonaSourceQueries(project),
        directionQueries: buildSearchDirections(project),
        maxQueries: 4,
      });

  const run = await prisma.supplySearchRun.create({
    data: {
      projectId,
      runType: "external",
      status: "running",
      goalJson: stringifyJson({ gaps: project.supplyGaps.map((gap) => gap.description) }),
      queriesJson: stringifyJson(queries),
      summaryJson: stringifyJson({ startedAt: new Date().toISOString() }),
    },
  });

  const result = await sourceProjectCandidates({
    project,
    queries,
    maxQueries: 4,
    searchRunId: run.id,
    sourceType: "external",
    toolContext: options?.toolContext,
  });
  if (!result.ok) {
    await prisma.supplySearchRun.update({
      where: { id: run.id },
      data: { status: "failed", summaryJson: stringifyJson({ error: result.error }) },
    });
    await writeAuditEvent({
      projectId,
      entityType: "project",
      entityId: projectId,
      action: "supply.external_research.failed",
      payload: { runId: run.id, error: result.error },
    });
    return { ok: false as const, error: result.error, status: result.status, runId: run.id };
  }

  const acceptance = evaluateExternalResearchAcceptance({
    project,
    queries: result.queries,
    cacheHits: result.cacheHits,
    providerStats: result.providerStats,
    searchResults: result.searchResults,
    candidates: result.candidates,
  });

  await prisma.supplySearchRun.update({
    where: { id: run.id },
    data: {
      status: acceptance.passed ? "completed" : "quality_failed",
      summaryJson: stringifyJson({
        searchResults: result.searchResults.length,
        candidates: result.candidates.length,
        providerStats: result.providerStats,
        cacheHits: result.cacheHits.length,
        autoScreenedOut: result.autoScreenedOut,
        usedFallback: result.usedFallback,
        extractionIssue: result.extractionIssue,
        acceptance,
      }),
    },
  });

  await writeSearchSourceMetrics({
    projectId,
    runId: run.id,
    queries: result.queries,
  });

  await detectMergeCandidates(projectId);

  await writeAuditEvent({
    projectId,
    entityType: "project",
    entityId: projectId,
    action: "supply.external_research.completed",
    payload: {
      runId: run.id,
      queries: result.queries,
      searchResults: result.searchResults.length,
      candidates: result.candidates.length,
      providerStats: result.providerStats,
      cacheHits: result.cacheHits.length,
      acceptance,
    },
  });

  return {
    ...result,
    ok: true as const,
    runId: run.id,
    acceptance,
  };
}

export async function rankUnifiedSupply(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      candidates: {
        include: { expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
        orderBy: [{ fitScore: "desc" }, { updatedAt: "desc" }],
      },
    },
  });
  if (!project) return null;

  const candidates = project.candidates.filter(isCandidateEligibleForSupplyMetrics).slice(0, 40);
  const ruleRank = candidates.map((candidate) => {
    const gate = canApproveForOutreach({ candidate, expert: candidate.expert, project });
    const score = computeCandidateRank(project, candidate, gate.ok);
    return {
      candidateId: candidate.id,
      score,
      conversionProbability: Math.max(0.05, Math.min(0.92, score / 100)),
      outreachAllowed: gate.ok,
      rankReasons: buildRankReasons(candidate, gate.ok),
      risks: Array.from(
        new Set([
          ...parseJson<string[]>(candidate.risksJson, []),
          ...(gate.ok ? [] : ["候选尚未满足触达条件。"]),
        ]),
      ),
      nextAction: buildCandidateRankNextAction(candidate, gate.ok),
    };
  });

  const ai = await rankSupplyCandidates({
    project: serializeProjectForGeneration(project),
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.id,
      name: candidate.expert.name,
      evidenceLevel: candidate.expert.evidenceLevel,
      fitScore: candidate.fitScore,
      sourceType: candidate.sourceType,
      stage: candidate.stage,
      humanReviewNeeded: candidate.humanReviewNeeded,
      risks: parseJson<string[]>(candidate.risksJson, []),
      qualitySummary: parseJson(candidate.expert.qualitySummaryJson, {}),
    })),
    ruleRank,
  });

  const rankedById = new Map(ruleRank.map((item) => [item.candidateId, item]));
  if (ai.ok) {
    for (const item of ai.data.candidates) {
      const existing = rankedById.get(item.candidateId);
      if (!existing) continue;
      rankedById.set(item.candidateId, mergeRuleAndModelRank(existing, item));
    }
  }

  for (const item of rankedById.values()) {
    await prisma.projectCandidate.update({
      where: { id: item.candidateId },
      data: {
        conversionProbability: item.conversionProbability,
        rankReasonJson: stringifyJson({
          reasons: item.rankReasons,
          risks: item.risks,
          source: ai.ok ? "model_assisted" : "rules",
        }),
        nextAction: item.nextAction,
      },
    });
  }

  await writeAuditEvent({
    projectId,
    entityType: "project",
    entityId: projectId,
    action: ai.ok ? "supply.rank.completed" : "supply.rank.completed_with_rules",
    payload: {
      candidates: rankedById.size,
      aiFallbackReason: ai.ok ? undefined : ai.error,
    },
  });

  return { candidates: Array.from(rankedById.values()).sort((a, b) => b.conversionProbability - a.conversionProbability), usedFallback: !ai.ok };
}

export function mergeRuleAndModelRank<
  T extends {
    candidateId: string;
    conversionProbability: number;
    outreachAllowed: boolean;
    rankReasons: string[];
    risks: string[];
    nextAction: string;
  },
>(
  rule: T,
  model: {
    candidateId: string;
    conversionProbability: number;
    rankReasons: string[];
    risks: string[];
    nextAction: string;
  },
): T {
  const isChineseText = (value: string) => /[\u3400-\u9fff]/.test(value);
  const rankReasons =
    model.rankReasons.length &&
    model.rankReasons.every(isChineseText) &&
    !model.rankReasons.some(isUnsafeRankAction)
      ? model.rankReasons
      : rule.rankReasons;
  const modelRisks = model.risks.length && model.risks.every(isChineseText)
    ? model.risks.filter((risk) => !/^(?:暂无|没有|无).{0,6}风险[。.]?$/.test(risk.trim()))
    : [];
  const risks = Array.from(new Set([...rule.risks, ...modelRisks]));
  return {
    ...rule,
    conversionProbability: Math.max(0, Math.min(1, model.conversionProbability)),
    rankReasons,
    risks,
    nextAction: rule.nextAction,
  };
}

function isUnsafeRankAction(value: string) {
  return /立即触达|优先触达|直接触达|发送(?:邀请|邮件)|安排试标|直接进入试标|无需复核|自动发布/i.test(value);
}

export async function recordExpertQualityEvent({
  expertId,
  projectId,
  candidateId,
  eventType,
  channel,
  score,
  notes,
}: {
  expertId: string;
  projectId?: string | null;
  candidateId?: string | null;
  eventType: string;
  channel?: string | null;
  score?: number;
  notes?: string;
}) {
  const expert = await prisma.expert.findUnique({ where: { id: expertId } });
  if (!expert) return null;

  const event = await prisma.expertEngagementEvent.create({
    data: {
      expertId,
      projectId: projectId ?? null,
      candidateId: candidateId ?? null,
      eventType,
      channel: channel ?? null,
      payloadJson: stringifyJson({ score, notes }),
    },
  });

  if (typeof score === "number") {
    await prisma.expertQualityMetric.create({
      data: {
        expertId,
        projectId: projectId ?? null,
        metricType: eventType,
        score,
        source: "manual_feedback",
        notes,
      },
    });
  }

  await prisma.expert.update({
    where: { id: expertId },
    data: {
      lastActiveAt: new Date(),
      qualitySummaryJson: stringifyJson(await buildQualitySummary(expertId)),
    },
  });

  await writeAuditEvent({
    projectId: projectId ?? undefined,
    entityType: "expert",
    entityId: expertId,
    action: "expert.quality_event.recorded",
    payload: { eventType, hasScore: typeof score === "number", candidateId },
  });

  return event;
}

export async function resolveExpertMergeCandidate({
  mergeId,
  status,
}: {
  mergeId: string;
  status: "confirmed" | "rejected";
}) {
  const merge = await prisma.expertMergeCandidate.findUnique({
    where: { id: mergeId },
    include: { primaryExpert: true, duplicateExpert: true },
  });
  if (!merge) return findCompletedExpertMerge(mergeId, status);
  if (merge.primaryExpertId === merge.duplicateExpertId) {
    throw new Error("不能合并同一个专家档案。");
  }
  if (merge.status !== "pending") {
    if (merge.status === status) return merge;
    throw new Error("该专家合并建议已经处理，不能更改结果。");
  }

  if (status === "rejected") {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.expertMergeCandidate.update({
        where: { id: mergeId },
        data: { status },
      });
      await tx.auditEvent.create({
        data: {
          entityType: "expert_merge_candidate",
          entityId: merge.id,
          action: "expert.merge_candidate.resolved",
          payloadJson: stringifyJson({
            primaryExpertId: merge.primaryExpertId,
            duplicateExpertId: merge.duplicateExpertId,
            status,
          }),
        },
      });
      return updated;
    });
  }

  const resolvedAt = new Date();
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.expertMergeCandidate.updateMany({
      where: { id: merge.id, status: "pending" },
      data: { status: "confirmed" },
    });
    if (claimed.count !== 1) {
      const current = await tx.expertMergeCandidate.findUnique({ where: { id: merge.id } });
      if (current?.status === "confirmed") return current;
      throw new Error("该专家合并建议已由其他操作处理，请刷新后查看。");
    }

    const duplicateCandidates = await tx.projectCandidate.findMany({
      where: { expertId: merge.duplicateExpertId },
      orderBy: { createdAt: "asc" },
    });

    for (const duplicateCandidate of duplicateCandidates) {
      const primaryCandidate = await tx.projectCandidate.findUnique({
        where: {
          projectId_expertId: {
            projectId: duplicateCandidate.projectId,
            expertId: merge.primaryExpertId,
          },
        },
      });

      if (!primaryCandidate) {
        await tx.projectCandidate.update({
          where: { id: duplicateCandidate.id },
          data: { expertId: merge.primaryExpertId },
        });
        continue;
      }

      const discoveries = await tx.candidateDiscovery.findMany({
        where: { candidateId: duplicateCandidate.id },
      });
      for (const discovery of discoveries) {
        const existing = await tx.candidateDiscovery.findUnique({
          where: {
            searchRunId_candidateId: {
              searchRunId: discovery.searchRunId,
              candidateId: primaryCandidate.id,
            },
          },
        });
        if (existing) {
          await tx.candidateDiscovery.update({
            where: { id: existing.id },
            data: {
              sourceUrl: existing.sourceUrl ?? discovery.sourceUrl,
              evidenceLevel: strongerEvidenceLevel(existing.evidenceLevel, discovery.evidenceLevel),
            },
          });
        } else {
          await tx.candidateDiscovery.create({
            data: {
              searchRunId: discovery.searchRunId,
              candidateId: primaryCandidate.id,
              sourceUrl: discovery.sourceUrl,
              evidenceLevel: discovery.evidenceLevel,
              createdAt: discovery.createdAt,
            },
          });
        }
      }

      await tx.evidenceItem.updateMany({
        where: { candidateId: duplicateCandidate.id },
        data: { candidateId: primaryCandidate.id, expertId: merge.primaryExpertId },
      });
      await tx.outreachDraft.updateMany({
        where: { candidateId: duplicateCandidate.id },
        data: { candidateId: primaryCandidate.id },
      });
      await tx.trialTask.updateMany({
        where: { candidateId: duplicateCandidate.id },
        data: { candidateId: primaryCandidate.id },
      });
      await tx.expertEngagementEvent.updateMany({
        where: { candidateId: duplicateCandidate.id },
        data: { candidateId: primaryCandidate.id, expertId: merge.primaryExpertId },
      });
      await tx.projectCandidate.update({
        where: { id: primaryCandidate.id },
        data: mergeProjectCandidateData(primaryCandidate, duplicateCandidate),
      });
      await tx.projectCandidate.delete({ where: { id: duplicateCandidate.id } });
    }

    await tx.evidenceItem.updateMany({
      where: { expertId: merge.duplicateExpertId },
      data: { expertId: merge.primaryExpertId },
    });
    await tx.expertSignal.updateMany({
      where: { expertId: merge.duplicateExpertId },
      data: { expertId: merge.primaryExpertId },
    });
    await tx.expertEngagementEvent.updateMany({
      where: { expertId: merge.duplicateExpertId },
      data: { expertId: merge.primaryExpertId },
    });
    await tx.expertQualityMetric.updateMany({
      where: { expertId: merge.duplicateExpertId },
      data: { expertId: merge.primaryExpertId },
    });

    const [quality, metricCount, lastEvent, eventCount] = await Promise.all([
      tx.expertQualityMetric.aggregate({
        where: { expertId: merge.primaryExpertId },
        _avg: { score: true },
      }),
      tx.expertQualityMetric.count({ where: { expertId: merge.primaryExpertId } }),
      tx.expertEngagementEvent.findFirst({
        where: { expertId: merge.primaryExpertId },
        orderBy: { createdAt: "desc" },
      }),
      tx.expertEngagementEvent.count({ where: { expertId: merge.primaryExpertId } }),
    ]);

    await tx.expert.update({
      where: { id: merge.primaryExpertId },
      data: {
        title: preferProfileValue(merge.primaryExpert.title, merge.duplicateExpert.title),
        affiliation: preferProfileValue(merge.primaryExpert.affiliation, merge.duplicateExpert.affiliation),
        domainTagsJson: mergeStringArrayJson(merge.primaryExpert.domainTagsJson, merge.duplicateExpert.domainTagsJson),
        languagesJson: mergeStringArrayJson(merge.primaryExpert.languagesJson, merge.duplicateExpert.languagesJson),
        region: merge.primaryExpert.region ?? merge.duplicateExpert.region,
        contactJson: mergeContactJson(merge.primaryExpert.contactJson, merge.duplicateExpert.contactJson),
        sourceUrl: merge.primaryExpert.sourceUrl ?? merge.duplicateExpert.sourceUrl,
        evidenceLevel: strongerEvidenceLevel(merge.primaryExpert.evidenceLevel, merge.duplicateExpert.evidenceLevel) ?? "E0",
        consentState: moreRestrictiveConsentState(merge.primaryExpert.consentState, merge.duplicateExpert.consentState),
        riskFlagsJson: mergeStringArrayJson(merge.primaryExpert.riskFlagsJson, merge.duplicateExpert.riskFlagsJson),
        expertType: preferredExpertType(merge.primaryExpert.expertType, merge.duplicateExpert.expertType),
        lastActiveAt: latestDate(merge.primaryExpert.lastActiveAt, merge.duplicateExpert.lastActiveAt),
        qualitySummaryJson: stringifyJson({
          averageScore: quality._avg.score ?? 0,
          metricCount,
          lastEvent: lastEvent?.eventType ?? null,
          eventCount,
        }),
      },
    });

    await rewireRelatedMergeSuggestions(tx, {
      resolvedMergeId: merge.id,
      primaryExpertId: merge.primaryExpertId,
      duplicateExpertId: merge.duplicateExpertId,
    });

    await tx.auditEvent.create({
      data: {
        entityType: "expert_merge_candidate",
        entityId: merge.id,
        action: "expert.merge_candidate.resolved",
        payloadJson: stringifyJson({
          primaryExpertId: merge.primaryExpertId,
          duplicateExpertId: merge.duplicateExpertId,
          status: "confirmed",
          movedProjectCandidates: duplicateCandidates.length,
        }),
      },
    });
    await tx.expert.delete({ where: { id: merge.duplicateExpertId } });

    return {
      id: merge.id,
      primaryExpertId: merge.primaryExpertId,
      duplicateExpertId: merge.duplicateExpertId,
      reasonJson: merge.reasonJson,
      confidence: merge.confidence,
      status: "confirmed",
      createdAt: merge.createdAt,
      updatedAt: resolvedAt,
    };
  });
}

async function findCompletedExpertMerge(mergeId: string, requestedStatus: "confirmed" | "rejected") {
  const audit = await prisma.auditEvent.findFirst({
    where: {
      entityType: "expert_merge_candidate",
      entityId: mergeId,
      action: "expert.merge_candidate.resolved",
    },
    orderBy: { createdAt: "desc" },
  });
  if (!audit) return null;
  const payload = parseJson<Record<string, unknown>>(audit.payloadJson, {});
  const completedStatus = payload.status === "confirmed" || payload.status === "rejected" ? payload.status : null;
  if (!completedStatus) return null;
  if (completedStatus !== requestedStatus) {
    throw new Error("该专家合并建议已经处理，不能更改结果。");
  }
  return {
    id: mergeId,
    primaryExpertId: String(payload.primaryExpertId ?? ""),
    duplicateExpertId: String(payload.duplicateExpertId ?? ""),
    reasonJson: "{}",
    confidence: 1,
    status: completedStatus,
    createdAt: audit.createdAt,
    updatedAt: audit.createdAt,
  };
}

function mergeProjectCandidateData(primary: ProjectCandidate, duplicate: ProjectCandidate) {
  const stage = preferredCandidateStage(primary.stage, duplicate.stage);
  return {
    stage,
    fitScore: maximumNullable(primary.fitScore, duplicate.fitScore),
    scoringJson: mergeRecordJson(primary.scoringJson, duplicate.scoringJson, duplicate.id),
    risksJson: mergeStringArrayJson(primary.risksJson, duplicate.risksJson),
    missingJson: mergeStringArrayJson(primary.missingJson, duplicate.missingJson),
    nextAction:
      stage === "do_not_contact"
        ? "该专家已标记为不再联系。"
        : stage === "screened_out"
          ? primary.stage === "screened_out"
            ? primary.nextAction ?? "本项目暂不推进。如有新证据，可重新复核。"
            : duplicate.nextAction ?? "本项目暂不推进。如有新证据，可重新复核。"
        : primary.nextAction ?? duplicate.nextAction ?? "复核合并后的身份与证据，再决定下一步。",
    humanReviewNeeded: stage === "screened_out" ? false : primary.humanReviewNeeded || duplicate.humanReviewNeeded,
    sourceType: preferredCandidateSource(primary.sourceType, duplicate.sourceType),
    sourceRunId: primary.sourceRunId ?? duplicate.sourceRunId,
    conversionProbability: maximumNullable(primary.conversionProbability, duplicate.conversionProbability),
    rankReasonJson: mergeRecordJson(primary.rankReasonJson, duplicate.rankReasonJson, duplicate.id),
  };
}

async function rewireRelatedMergeSuggestions(
  tx: Pick<typeof prisma, "expertMergeCandidate">,
  {
    resolvedMergeId,
    primaryExpertId,
    duplicateExpertId,
  }: {
    resolvedMergeId: string;
    primaryExpertId: string;
    duplicateExpertId: string;
  },
) {
  const related = await tx.expertMergeCandidate.findMany({
    where: {
      id: { not: resolvedMergeId },
      OR: [{ primaryExpertId: duplicateExpertId }, { duplicateExpertId }],
    },
  });

  for (const suggestion of related) {
    const nextPrimaryId = suggestion.primaryExpertId === duplicateExpertId ? primaryExpertId : suggestion.primaryExpertId;
    const nextDuplicateId = suggestion.duplicateExpertId === duplicateExpertId ? primaryExpertId : suggestion.duplicateExpertId;
    if (nextPrimaryId === nextDuplicateId) {
      await tx.expertMergeCandidate.delete({ where: { id: suggestion.id } });
      continue;
    }

    const existing = await tx.expertMergeCandidate.findUnique({
      where: {
        primaryExpertId_duplicateExpertId: {
          primaryExpertId: nextPrimaryId,
          duplicateExpertId: nextDuplicateId,
        },
      },
    });
    if (existing && existing.id !== suggestion.id) {
      await tx.expertMergeCandidate.update({
        where: { id: existing.id },
        data: {
          confidence: Math.max(existing.confidence, suggestion.confidence),
          reasonJson: mergeRecordJson(existing.reasonJson, suggestion.reasonJson, suggestion.id),
        },
      });
      await tx.expertMergeCandidate.delete({ where: { id: suggestion.id } });
      continue;
    }

    await tx.expertMergeCandidate.update({
      where: { id: suggestion.id },
      data: {
        primaryExpertId: nextPrimaryId,
        duplicateExpertId: nextDuplicateId,
      },
    });
  }
}

function preferredCandidateStage(primary: string, duplicate: string) {
  if (primary === "do_not_contact" || duplicate === "do_not_contact") return "do_not_contact";
  if (primary === "screened_out" && duplicate === "screened_out") return "screened_out";
  if (primary === "screened_out" || duplicate === "screened_out") {
    const other = primary === "screened_out" ? duplicate : primary;
    return candidateStageRank(other) >= candidateStageRank("verified") ? other : "screened_out";
  }
  const primaryRank = (PIPELINE_STAGES as readonly string[]).indexOf(primary);
  const duplicateRank = (PIPELINE_STAGES as readonly string[]).indexOf(duplicate);
  if (primaryRank < 0) return duplicateRank < 0 ? "sourced" : duplicate;
  if (duplicateRank < 0) return primary;
  return duplicateRank > primaryRank ? duplicate : primary;
}

function candidateStageRank(stage: string) {
  const rank: Record<string, number> = {
    sourced: 0,
    enriched: 1,
    verified: 2,
    approved_for_outreach: 3,
    contacted: 4,
    replied: 5,
    screening: 6,
    trial: 7,
    contracting: 8,
    onboarded: 9,
    active: 10,
  };
  return rank[stage] ?? -1;
}

export const preferredCandidateStageForTest = preferredCandidateStage;

function preferredCandidateSource(primary: string, duplicate: string) {
  const rank: Record<string, number> = { external: 1, referred: 2, internal: 3 };
  return (rank[duplicate] ?? 0) > (rank[primary] ?? 0) ? duplicate : primary;
}

function preferredExpertType(primary: string, duplicate: string) {
  return preferredCandidateSource(primary, duplicate);
}

function strongerEvidenceLevel(primary: string | null | undefined, duplicate: string | null | undefined) {
  if (!primary) return duplicate ?? null;
  if (!duplicate) return primary;
  return (evidenceRank[duplicate] ?? 0) > (evidenceRank[primary] ?? 0) ? duplicate : primary;
}

function moreRestrictiveConsentState(primary: string, duplicate: string) {
  const rank: Record<string, number> = {
    consented: 0,
    legitimate_interest: 1,
    unknown: 2,
    unsubscribed: 3,
    do_not_contact: 4,
    delete_requested: 5,
  };
  return (rank[duplicate] ?? 2) > (rank[primary] ?? 2) ? duplicate : primary;
}

function mergeStringArrayJson(primary: string, duplicate: string) {
  const values = [
    ...parseJson<unknown[]>(primary, []),
    ...parseJson<unknown[]>(duplicate, []),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  return stringifyJson(Array.from(new Set(values)));
}

function mergeRecordJson(primary: string, duplicate: string, duplicateRecordId: string) {
  const primaryValue = asJsonRecord(parseJson<unknown>(primary, {}));
  const duplicateValue = asJsonRecord(parseJson<unknown>(duplicate, {}));
  const history = Array.isArray(primaryValue.mergedRecords) ? primaryValue.mergedRecords : [];
  return stringifyJson({
    ...duplicateValue,
    ...primaryValue,
    mergedRecords: [...history, { recordId: duplicateRecordId, value: duplicateValue }].slice(-20),
  });
}

function mergeContactJson(primary: string, duplicate: string) {
  const primaryValue = asJsonRecord(parseJson<unknown>(primary, {}));
  const duplicateValue = asJsonRecord(parseJson<unknown>(duplicate, {}));
  const merged: Record<string, unknown> = { ...duplicateValue, ...primaryValue };
  for (const permission of ["allowOutreach", "profileAllowsOutreach", "sourceAllowsOutreach"]) {
    if (primaryValue[permission] === false || duplicateValue[permission] === false) merged[permission] = false;
  }
  return stringifyJson(merged);
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function maximumNullable<T extends number | null>(primary: T, duplicate: T) {
  if (primary === null) return duplicate;
  if (duplicate === null) return primary;
  return Math.max(primary, duplicate);
}

function preferProfileValue(primary: string | null, duplicate: string | null) {
  const primaryValue = primary?.trim();
  if (primaryValue) return primaryValue;
  return duplicate?.trim() || null;
}

function latestDate(primary: Date | null, duplicate: Date | null) {
  if (!primary) return duplicate;
  if (!duplicate) return primary;
  return primary > duplicate ? primary : duplicate;
}

export async function createRecruitmentRetrospective(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      candidates: { include: { expert: true, outreachDrafts: true, trialTasks: true } },
      searchSourceMetrics: { orderBy: { updatedAt: "desc" }, take: 20 },
      marketingPosts: true,
      supplySearchRuns: { orderBy: { createdAt: "desc" }, take: 8 },
    },
  });
  if (!project) return null;

  const funnel = buildFunnel(project);
  const ai = await draftRecruitmentRetrospective({
    project: serializeProjectForGeneration(project),
    funnel,
    sourceMetrics: project.searchSourceMetrics,
    marketingPosts: project.marketingPosts.map((post) => ({
      channel: post.channel,
      status: post.status === "published" ? "internally_confirmed_publish_progress_only" : post.status,
      title: post.title,
      externalPublishConfirmed: false,
    })),
  });

  const rules = {
    summary: "已根据系统内候选、触达、试标和入池数据生成基础复盘。",
    wins: buildRuleWins(project, funnel),
    bottlenecks: buildRuleBottlenecks(project, funnel),
    sourceInsights: buildRuleSourceInsights(project),
    nextActions: buildRuleNextActions(project, funnel),
  };
  const summary = ai.ok
    ? buildSafeRecruitmentRetrospective(ai.data, rules)
    : { ...rules, usedModelNarrative: false };
  const aiFallbackReason = !ai.ok
    ? publicErrorMessage(ai.error)
    : summary.usedModelNarrative
      ? undefined
      : "模型复盘未通过运营语言或审批边界检查，已采用系统数据复盘。";

  const outcome = await prisma.recruitmentOutcome.create({
    data: {
      projectId,
      targetCount: project.quantity ?? 0,
      sourcedCount: funnel.sourcedCount,
      approvedCount: funnel.approvedCount,
      contactedCount: funnel.contactedCount,
      trialCount: funnel.trialCount,
      onboardedCount: funnel.onboardedCount,
      summaryJson: stringifyJson({ ...summary, aiFallbackReason }),
    },
  });

  await writeAuditEvent({
    projectId,
    entityType: "project",
    entityId: projectId,
    action: ai.ok && summary.usedModelNarrative ? "recruitment.retrospective.completed" : "recruitment.retrospective.completed_with_rules",
    payload: {
      outcomeId: outcome.id,
      funnel,
      aiFallbackReason,
    },
  });

  return outcome;
}

async function writeSearchSourceMetrics({ projectId, runId, queries }: { projectId: string; runId: string; queries: string[] }) {
  const [results, candidates] = await Promise.all([
    prisma.searchResult.findMany({ where: { projectId, searchRunId: runId } }),
    prisma.projectCandidate.findMany({ where: { projectId, sourceRunId: runId }, include: { expert: true } }),
  ]);

  for (const query of queries) {
    const queryResults = results.filter((result) => result.query === query);
    const domains = Array.from(new Set(queryResults.map((result) => result.domain ?? extractHostname(result.url) ?? "公开来源")));
    const scopedDomains = domains.length ? domains : ["公开来源"];
    for (const domain of scopedDomains.slice(0, 8)) {
      const domainCandidates = candidates.filter((candidate) => {
        const sourceDomain = candidate.expert.sourceUrl ? extractHostname(candidate.expert.sourceUrl) : null;
        return !sourceDomain || sourceDomain === domain || domain === "公开来源";
      });
      await prisma.searchSourceMetric.create({
        data: {
          projectId,
          searchRunId: runId,
          query,
          domain,
          resultCount: queryResults.filter((result) => (result.domain ?? extractHostname(result.url) ?? "公开来源") === domain).length,
          candidateCount: domainCandidates.length,
          e2PlusCount: domainCandidates.filter((candidate) => (evidenceRank[candidate.expert.evidenceLevel] ?? 0) >= 2).length,
          approvedCount: domainCandidates.filter((candidate) => !candidate.humanReviewNeeded).length,
          trialCount: domainCandidates.filter((candidate) => candidate.stage === "trial").length,
          onboardedCount: domainCandidates.filter((candidate) => ["onboarded", "active"].includes(candidate.stage)).length,
        },
      });
    }
  }
}

export async function detectMergeCandidates(projectId: string) {
  const candidates = await prisma.projectCandidate.findMany({
    where: { projectId },
    include: { expert: true },
  });
  const byName = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = candidate.expert.name.trim().toLowerCase();
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), candidate]);
  }
  for (const matches of byName.values()) {
    if (matches.length < 2) continue;
    const sorted = matches.slice().sort((a, b) => (evidenceRank[b.expert.evidenceLevel] ?? 0) - (evidenceRank[a.expert.evidenceLevel] ?? 0));
    const primary = sorted[0];
    for (const duplicate of sorted.slice(1)) {
      if (primary.expertId === duplicate.expertId) continue;
      await prisma.expertMergeCandidate.upsert({
        where: {
          primaryExpertId_duplicateExpertId: {
            primaryExpertId: primary.expertId,
            duplicateExpertId: duplicate.expertId,
          },
        },
        update: {
          reasonJson: stringifyJson({
            reason: "同名候选，需人工判断是否为同一专家。",
            primaryAffiliation: primary.expert.affiliation,
            duplicateAffiliation: duplicate.expert.affiliation,
          }),
          confidence: primary.expert.affiliation && primary.expert.affiliation === duplicate.expert.affiliation ? 0.82 : 0.55,
        },
        create: {
          primaryExpertId: primary.expertId,
          duplicateExpertId: duplicate.expertId,
          reasonJson: stringifyJson({
            reason: "同名候选，需人工判断是否为同一专家。",
            primaryAffiliation: primary.expert.affiliation,
            duplicateAffiliation: duplicate.expert.affiliation,
          }),
          confidence: primary.expert.affiliation && primary.expert.affiliation === duplicate.expert.affiliation ? 0.82 : 0.55,
          status: "pending",
        },
      });
    }
  }
}

function scoreInternalExpert(
  project: Project,
  expert: ExpertRecord & {
    evidenceItems: EvidenceItem[];
    signals: Array<{ type: string; value: string; source: string; evidenceLevel: string; confidence: number; sourceUrl?: string | null }>;
    qualityMetrics: Array<{ score: number; metricType: string; source: string; notes?: string | null }>;
    candidates: Array<ProjectCandidate & { project: Project }>;
  },
) {
  const projectText = `${project.title} ${project.rawDemand} ${project.domain ?? ""} ${project.taskType ?? ""}`.toLowerCase();
  const projectDomain = meaningfulProjectDomain(project)?.toLowerCase() ?? "";
  const tags = parseJson<string[]>(expert.domainTagsJson, []);
  const languages = parseJson<string[]>(expert.languagesJson, []);
  const qualityScore = average(expert.qualityMetrics.map((metric) => metric.score), 62);
  const domainHits = tags.filter((tag) => {
    const normalized = tag.toLowerCase();
    return projectText.includes(normalized) || Boolean(projectDomain && normalized.includes(projectDomain));
  });
  const signalHits = expert.signals.filter((signal) => projectText.includes(signal.value.toLowerCase()));
  const projectMatchTerms = buildProjectMatchTerms(project);
  const evidenceHits = expert.evidenceItems.filter((evidence) =>
    projectMatchTerms.some((term) =>
      includesMatchTerm(`${evidence.claim} ${evidence.snippet} ${evidence.sourceTitle ?? ""} ${evidence.sourceType}`, term),
    ),
  );
  const historyHits = expert.candidates.filter((candidate) =>
    candidate.projectId !== project.id &&
    projectMatchTerms.some((term) =>
      includesMatchTerm(
        `${candidate.project.title} ${candidate.project.rawDemand} ${candidate.project.domain ?? ""} ${candidate.project.taskType ?? ""}`,
        term,
      ),
    ),
  );
  const hasProfileEvidenceMatch = domainHits.length > 0 || signalHits.length > 0 || evidenceHits.length > 0;
  const hasDirectMatch = hasProfileEvidenceMatch || (!projectDomain && historyHits.length > 0);
  const evidenceScore = (evidenceRank[expert.evidenceLevel] ?? 0) * 18;
  const domainScore = Math.min(28, domainHits.length * 12 + signalHits.length * 6 + evidenceHits.length * 6 + historyHits.length * 4);
  const languageScore = languages.some((language) => project.rawDemand.includes(language) || (project.languagesJson ?? "").includes(language)) ? 10 : 4;
  const availabilityScore = expert.lastActiveAt ? 10 : 4;
  const score = Math.min(100, Math.round(qualityScore * 0.28 + evidenceScore + domainScore + languageScore + availabilityScore));
  const risks: string[] = [];
  const missing: string[] = [];
  if ((evidenceRank[expert.evidenceLevel] ?? 0) < 2) missing.push("证据等级低于 E2");
  if (["unknown", "legitimate_interest"].includes(expert.consentState)) missing.push("联系许可需确认");
  if (requiresProjectReview(project)) risks.push("高风险项目需人工复核");
  if (!hasProfileEvidenceMatch) missing.push("缺少与当前需求直接对应的能力信号");

  return {
    expert,
    hasDirectMatch,
    score,
    evidenceLevelRank: evidenceRank[expert.evidenceLevel] ?? 0,
    conversionProbability: Math.max(0.08, Math.min(0.9, score / 100 - (risks.length ? 0.12 : 0))),
    reasons: [
      domainHits.length ? `领域标签匹配：${domainHits.slice(0, 3).join("、")}` : null,
      signalHits.length ? `能力信号匹配：${signalHits.slice(0, 3).map((signal) => signal.value).join("、")}` : null,
      evidenceHits.length ? `证据文本匹配：${evidenceHits.slice(0, 2).map((evidence) => evidence.claim).join("、")}` : null,
      historyHits.length ? `有 ${historyHits.length} 个相似项目记录` : null,
      `历史质量均分 ${Math.round(qualityScore)}`,
      `证据等级 ${expert.evidenceLevel}`,
    ].filter(Boolean) as string[],
    risks,
    missing,
    nextAction: risks.length || missing.length ? "补齐证据和许可后复核。" : "可进入触达或试标安排。",
    breakdown: [
      { dimension: "领域匹配", score: Math.min(100, domainScore * 3), weight: 35, evidence: [...domainHits, ...signalHits.map((signal) => signal.value), ...evidenceHits.map((evidence) => evidence.claim)].slice(0, 4).join("、") || "未发现直接证据", reason: hasProfileEvidenceMatch ? "内部资料与项目需求匹配。" : "需要补充能力证据。" },
      { dimension: "历史质量", score: Math.round(qualityScore), weight: 30, evidence: `${expert.qualityMetrics.length} 条质量记录`, reason: "基于历史试标/交付记录。" },
      { dimension: "证据与合规", score: Math.min(100, evidenceScore + languageScore + availabilityScore), weight: 35, evidence: `${expert.evidenceLevel} / ${expert.consentState}`, reason: "综合证据等级、语言和联系许可。" },
    ],
  };
}

export const scoreInternalExpertForTest = scoreInternalExpert;

const genericInternalMatchTerms = new Set([
  "专家",
  "专家招募",
  "招募",
  "项目",
  "任务",
  "人员",
  "经验",
  "众包",
  "标注",
  "数据",
  "采集",
  "咨询",
  "内部",
  "历史",
  "质量",
  "review",
  "expert",
  "project",
  "task",
  "data",
]);

function buildProjectMatchTerms(project: Project) {
  const domain = meaningfulProjectDomain(project);
  const sourceValues = domain ? [domain] : [project.title, project.rawDemand];
  const values = sourceValues
    .filter(Boolean)
    .flatMap((value) => extractMatchTerms(String(value)));
  return Array.from(new Set(values)).filter((term) => !genericInternalMatchTerms.has(term.toLowerCase()));
}

function extractMatchTerms(value: string) {
  return value
    .split(/[\s,，;；、/|()（）"'“”<>《》:：]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .flatMap((term) => {
      const matches = term.match(/[A-Za-z][A-Za-z0-9+#.-]{1,}|[\u4e00-\u9fff]{2,}/g) ?? [];
      return matches.length ? matches : [term];
    });
}

function includesMatchTerm(text: string, term: string) {
  const normalizedText = text.toLowerCase();
  const normalizedTerm = term.toLowerCase();
  return normalizedTerm.length >= 2 && normalizedText.includes(normalizedTerm);
}

async function syncInternalCandidateEvidence({
  projectId,
  candidateId,
  expert,
}: {
  projectId: string;
  candidateId: string;
  expert: ExpertRecord & {
    evidenceItems: EvidenceItem[];
    signals: Array<{ type: string; value: string; source: string; evidenceLevel: string; confidence: number; sourceUrl?: string | null }>;
    qualityMetrics: Array<{ metricType: string; score: number; source: string; notes?: string | null }>;
  };
}) {
  let existing = await prisma.evidenceItem.count({ where: { candidateId } });
  if (existing > 0) return;

  const reusableIds = findReusableInternalEvidenceIds(expert.evidenceItems, projectId);
  if (reusableIds.length) {
    await prisma.evidenceItem.updateMany({
      where: { id: { in: reusableIds }, candidateId: null },
      data: { candidateId },
    });
    existing = await prisma.evidenceItem.count({ where: { candidateId } });
  }
  if (existing >= 3) return;

  const fromProfile = expert.evidenceItems
    .filter((evidence) => evidence.projectId !== projectId)
    .slice(0, Math.max(0, 3 - existing))
    .map((evidence) => ({
    projectId,
    expertId: expert.id,
    candidateId,
    claim: evidence.claim,
    sourceUrl: evidence.sourceUrl,
    sourceTitle: evidence.sourceTitle ?? "专家主档证据",
    sourceType: evidence.sourceType,
    snippet: evidence.snippet,
    evidenceLevel: evidence.evidenceLevel,
    confidence: evidence.confidence,
    }));

  const fromSignals = expert.signals
    .filter((signal) => signal.sourceUrl || expert.sourceUrl)
    .slice(0, Math.max(0, 3 - existing - fromProfile.length))
    .map((signal) => ({
      projectId,
      expertId: expert.id,
      candidateId,
      claim: `内部专家库记录：${signal.value}`,
      sourceUrl: signal.sourceUrl ?? expert.sourceUrl ?? "",
      sourceTitle: signal.source || "专家能力信号",
      sourceType: "internal_signal",
      snippet: `${signal.type} 信号显示候选具备 ${signal.value} 相关经验。`,
      evidenceLevel: signal.evidenceLevel,
      confidence: signal.confidence,
    }));

  const fromQuality =
    existing + fromProfile.length + fromSignals.length < 3 && expert.sourceUrl
      ? expert.qualityMetrics.slice(0, 3 - existing - fromProfile.length - fromSignals.length).map((metric) => ({
          projectId,
          expertId: expert.id,
          candidateId,
          claim: `历史质量记录：${metric.metricType}`,
          sourceUrl: expert.sourceUrl ?? "",
          sourceTitle: metric.source || "历史质量记录",
          sourceType: "internal_quality_metric",
          snippet: `${metric.metricType} 得分 ${Math.round(metric.score)}。${metric.notes ?? ""}`.trim(),
          evidenceLevel: expert.evidenceLevel,
          confidence: Math.min(0.96, Math.max(0.55, metric.score / 100)),
        }))
      : [];

  const evidence = [...fromProfile, ...fromSignals, ...fromQuality].filter((item) => item.sourceUrl);
  for (const item of evidence) {
    await prisma.evidenceItem.create({ data: item });
  }
}

export function findReusableInternalEvidenceIds(
  evidenceItems: Array<{ id: string; projectId: string | null; candidateId: string | null }>,
  projectId: string,
  limit = 3,
) {
  return evidenceItems
    .filter((evidence) => evidence.projectId === projectId && evidence.candidateId === null)
    .slice(0, limit)
    .map((evidence) => evidence.id);
}

function buildRuleGaps(
  project: Project,
  counts: { targetCount: number; internalCount: number; highEvidenceCount: number; outreachReadyCount: number },
) {
  const gaps: Array<{
    gapType: string;
    description: string;
    requiredCount: number;
    availableCount: number;
    severity: "low" | "medium" | "high" | "critical";
    recommendedAction: string;
  }> = [];
  if (counts.internalCount < counts.targetCount) {
    gaps.push({
      gapType: "quantity",
      description: `内部库当前召回 ${counts.internalCount} 位，距离目标 ${counts.targetCount} 位仍有缺口。`,
      requiredCount: counts.targetCount,
      availableCount: counts.internalCount,
      severity: counts.internalCount === 0 ? "critical" : counts.internalCount < counts.targetCount * 0.4 ? "high" : "medium",
      recommendedAction: "先补外部深搜，并同步优化渠道分发内容和报名路径。",
    });
  }
  if (counts.highEvidenceCount < Math.ceil(counts.targetCount * 0.5)) {
    gaps.push({
      gapType: "evidence",
      description: `E2+ 证据候选只有 ${counts.highEvidenceCount} 位，需要补充可核验来源。`,
      requiredCount: Math.ceil(counts.targetCount * 0.5),
      availableCount: counts.highEvidenceCount,
      severity: "high",
      recommendedAction: "优先搜索机构主页、论文、会议讲者和公开项目页。",
    });
  }
  if (counts.outreachReadyCount < Math.min(5, counts.targetCount)) {
    gaps.push({
      gapType: "contactability",
      description: `当前可触达候选 ${counts.outreachReadyCount} 位，无法支撑首批触达。`,
      requiredCount: Math.min(5, counts.targetCount),
      availableCount: counts.outreachReadyCount,
      severity: requiresProjectReview(project) ? "high" : "medium",
      recommendedAction: "补齐联系许可、复核低证据候选，并记录合规联系路径。",
    });
  }
  return gaps.length
    ? gaps
    : [
        {
          gapType: "coverage",
          description: "内部供给暂未发现明显缺口，可继续推进复核和触达。",
          requiredCount: counts.targetCount,
          availableCount: counts.internalCount,
          severity: "low" as const,
          recommendedAction: "优先复核高证据候选并进入触达或试标。",
        },
      ];
}

function buildSearchDirections(project: Project) {
  const base = buildSearchQueryBase(project);
  const softwareQueries = buildSoftwareProfileQueries(project);
  return Array.from(new Set([
    ...softwareQueries,
    `${base} 机构主页 专家`,
    `${base} 会议 讲者 专家`,
    `${base} 论文 作者 专家`,
    `${base} 行业协会 专家`,
  ].map((item) => item.trim()).filter(Boolean))).slice(0, 6);
}

function buildSoftwareProfileQueries(project: Project) {
  const text = `${project.title} ${project.rawDemand} ${project.domain ?? ""} ${project.taskType ?? ""}`;
  if (!/python|fastapi|django|sqlalchemy|github|代码|code|backend|后端|开源|review/i.test(text)) return [];
  const terms = Array.from(text.match(/\b(FastAPI|Django|SQLAlchemy|Python|pytest|ruff|mypy)\b/gi) ?? []);
  const uniqueTerms = Array.from(new Set(terms.map((term) => term.toLowerCase() === "python" ? "Python" : term))).slice(0, 4);
  const stack = uniqueTerms.length ? uniqueTerms.join(" ") : "Python backend";
  return [
    `GitHub user profile ${stack} maintainer`,
    `GitHub user profile ${stack} code review`,
    `${stack} conference speaker profile`,
  ];
}

function buildGapQueries(project: Project, description: string) {
  const base = buildSearchQueryBase(project);
  if (/证据|E2|机构|论文|会议/.test(description)) {
    return [`${base} 机构主页 专家`, `${base} 论文 作者`, `${base} 会议 讲者`];
  }
  if (/联系|触达/.test(description)) {
    return [`${base} 专家 公开主页`, `${base} consultant profile`];
  }
  return [`${base} 专家`, `${base} professional profile`];
}

function buildSearchQueryBase(project: Project) {
  return (
    meaningfulProjectDomain(project) ||
    inferSearchBaseFromDemand(project) ||
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
  if (/中文文本|标注指南|一致性审核|试标|数据标注|中文NLP|质量评估/.test(text)) {
    return "中文文本 标注质量 一致性审核 数据标注";
  }
  if (/python|fastapi|django|sqlalchemy|pytest|代码|后端|code review/i.test(text)) {
    return "Python FastAPI Django 代码评审";
  }
  if (/肺结节|CT|放射|医学影像/.test(text)) {
    return "肺结节 CT 放射科 医生";
  }
  if (/生物|生命科学|bio/i.test(text)) {
    return "生物学 硕士 博士 研究员";
  }
  return null;
}

function computeCandidateRank(project: Project, candidate: ProjectCandidate & { expert: ExpertRecord }, gateOk: boolean) {
  const fit = candidate.fitScore ?? 45;
  const evidence = (evidenceRank[candidate.expert.evidenceLevel] ?? 0) * 12;
  const sourceBonus = candidate.sourceType === "internal" ? 8 : candidate.sourceType === "referred" ? 6 : 0;
  const reviewPenalty = candidate.humanReviewNeeded ? 12 : 0;
  const riskPenalty = requiresProjectReview(project) ? 8 : 0;
  const gateBonus = gateOk ? 12 : 0;
  return Math.max(0, Math.min(100, fit * 0.55 + evidence + sourceBonus + gateBonus - reviewPenalty - riskPenalty));
}

function buildRankReasons(candidate: ProjectCandidate & { expert: ExpertRecord }, gateOk: boolean) {
  const reasons = [
    `${candidate.sourceType === "internal" ? "内部专家" : "外部候选"} · 证据 ${candidate.expert.evidenceLevel}`,
    candidate.fitScore !== null ? `匹配分 ${candidate.fitScore}` : "尚未完成匹配评分",
    gateOk ? "联系门禁已通过" : "需要补齐证据或许可",
  ];
  const rankReasons = parseJson<{ reasons?: string[] }>(candidate.rankReasonJson, {}).reasons ?? [];
  return Array.from(new Set([...reasons, ...rankReasons])).slice(0, 5);
}

function buildCandidateRankNextAction(candidate: ProjectCandidate, gateOk: boolean) {
  if (candidate.stage === "trial") return "继续当前试标，记录提交结果并完成人工复核。";
  if (["onboarded", "active"].includes(candidate.stage)) return "记录本轮交付质量，作为后续项目召回依据。";
  if (gateOk) return "生成触达草稿，提交人工确认后再发送；或准备试标材料并提交审批。";
  return "先完成人工复核并补齐必要证据或联系许可，再决定是否生成触达草稿。";
}

async function buildQualitySummary(expertId: string) {
  const metrics = await prisma.expertQualityMetric.findMany({
    where: { expertId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const events = await prisma.expertEngagementEvent.findMany({
    where: { expertId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return {
    averageScore: average(metrics.map((metric) => metric.score), 0),
    metricCount: metrics.length,
    lastEvent: events[0]?.eventType ?? null,
    eventCount: events.length,
  };
}

function buildSupplyGoal(project: Project) {
  return {
    targetCount: project.quantity ?? 10,
    domain: project.domain,
    taskType: project.taskType,
    riskLevel: project.riskLevel,
  };
}

function buildFunnel(project: Project & { candidates: Array<ProjectCandidate & { expert: ExpertRecord; outreachDrafts: unknown[]; trialTasks: Array<{ outcome: string | null }> }> }) {
  return {
    sourcedCount: project.candidates.length,
    approvedCount: project.candidates.filter((candidate) => !candidate.humanReviewNeeded).length,
    contactedCount: project.candidates.filter((candidate) => ["contacted", "replied", "screening", "trial", "contracting", "onboarded", "active"].includes(candidate.stage)).length,
    trialCount: project.candidates.filter(
      (candidate) => candidate.stage === "trial" || candidate.trialTasks.some((trial) => trial.outcome !== null),
    ).length,
    trialPassedCount: project.candidates.filter((candidate) => candidate.trialTasks.some((trial) => trial.outcome === "passed")).length,
    onboardedCount: project.candidates.filter((candidate) => ["onboarded", "active"].includes(candidate.stage)).length,
    internalCount: project.candidates.filter((candidate) => candidate.sourceType === "internal").length,
    externalCount: project.candidates.filter((candidate) => candidate.sourceType === "external").length,
  };
}

function buildRuleWins(project: { supplySearchRuns: Array<{ runType: string }> }, funnel: ReturnType<typeof buildFunnel>) {
  return [
    funnel.internalCount ? `内部库召回 ${funnel.internalCount} 位候选` : null,
    funnel.externalCount ? `外部发现补充 ${funnel.externalCount} 位候选` : null,
    project.supplySearchRuns.length ? `已沉淀 ${project.supplySearchRuns.length} 次供给运行记录` : null,
  ].filter(Boolean) as string[];
}

function buildRuleBottlenecks(_project: Project, funnel: ReturnType<typeof buildFunnel>) {
  return [
    funnel.approvedCount < funnel.sourcedCount ? "部分候选仍需人工复核或补证据" : null,
    funnel.contactedCount === 0 ? "尚未形成可观察的触达转化" : null,
    funnel.trialCount === 0 ? "尚未进入试标，无法评估真实交付质量" : null,
  ].filter(Boolean) as string[];
}

export function buildRuleSourceInsights(project: { searchSourceMetrics: Array<{ domain: string | null; candidateCount: number; e2PlusCount: number }> }) {
  const hasSpecificDomains = project.searchSourceMetrics.some((metric) => Boolean(metric.domain?.trim()));
  const byDomain = new Map<string, { domain: string | null; candidateCount: number; e2PlusCount: number }>();
  for (const metric of project.searchSourceMetrics) {
    if (hasSpecificDomains && !metric.domain?.trim()) continue;
    const key = metric.domain?.trim().toLowerCase() || "公开来源";
    const current = byDomain.get(key);
    byDomain.set(key, {
      domain: metric.domain?.trim() || null,
      candidateCount: Math.max(current?.candidateCount ?? 0, metric.candidateCount),
      e2PlusCount: Math.max(current?.e2PlusCount ?? 0, metric.e2PlusCount),
    });
  }
  const top = Array.from(byDomain.values())
    .sort((a, b) => b.e2PlusCount - a.e2PlusCount || b.candidateCount - a.candidateCount)
    .slice(0, 3);
  return top.length
    ? top.map((metric) => `${metric.domain ?? "公开来源"} 贡献 ${metric.candidateCount} 位候选，其中 ${metric.e2PlusCount} 位达到 E2+。`)
    : ["当前来源数据不足，后续需要持续记录 query 和来源域名表现。"];
}

export function buildSafeRecruitmentRetrospective(
  model: { summary: string; wins: string[]; bottlenecks: string[]; sourceInsights: string[]; nextActions: string[] },
  rules: { summary: string; wins: string[]; bottlenecks: string[]; sourceInsights: string[]; nextActions: string[] },
) {
  const narrative = [model.summary, ...model.wins, ...model.bottlenecks].filter(Boolean);
  const usesChinese = narrative.length > 0 && narrative.every((item) => /[\u3400-\u9fff]/.test(item));
  const violatesApprovalBoundary = [...narrative, ...model.sourceInsights, ...model.nextActions].some((item) =>
    /立即触达|直接(?:进入|推进).{0,8}试标|无需复核|自动发布|直接发布|已成功发布|渠道.{0,12}已发布|招募帖.{0,8}已发布|共触达\s*\d|contact.{0,20}immediately|move.{0,20}directly.{0,20}trial|approve.{0,20}publish|100% effective|stop all|cease/i.test(
      item,
    ),
  );
  const usedModelNarrative = usesChinese && !violatesApprovalBoundary;
  return {
    summary: usedModelNarrative ? model.summary : rules.summary,
    wins: usedModelNarrative && model.wins.length ? model.wins : rules.wins,
    bottlenecks: usedModelNarrative && model.bottlenecks.length ? model.bottlenecks : rules.bottlenecks,
    sourceInsights: rules.sourceInsights,
    nextActions: rules.nextActions,
    usedModelNarrative,
  };
}

function buildRuleNextActions(project: Project, funnel: ReturnType<typeof buildFunnel>) {
  return [
    funnel.approvedCount < Math.min(project.quantity ?? 10, 5) ? "优先复核高分候选并补齐联系许可。" : "推进已通过候选进入触达和试标。",
    funnel.externalCount < funnel.internalCount ? "如内部供给不足，再开启外部深搜补量。" : "复盘外部来源质量，保留高转化 query。",
    "根据渠道反馈优化报名动作、候选筛选问题和下一轮分发内容。",
  ];
}

function average(values: number[], fallback: number) {
  if (!values.length) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
