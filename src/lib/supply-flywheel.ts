import type { Expert, Project, ProjectCandidate } from "@prisma/client";
import { writeAuditEvent } from "@/lib/audit";
import { canApproveForOutreach, requiresProjectReview } from "@/lib/gates";
import { extractHostname, parseJson, stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { publicErrorMessage } from "@/lib/redaction";
import { serializeProject } from "@/lib/serializers";
import { sourceProjectCandidates } from "@/lib/sourcing";
import { analyzeSupplyGap, draftRecruitmentRetrospective, rankSupplyCandidates } from "@/lib/workflows";

const evidenceRank: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };

type CandidateWithExpert = ProjectCandidate & { expert: Expert };

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
      signals: true,
      qualityMetrics: true,
      candidates: { include: { project: true }, orderBy: { updatedAt: "desc" }, take: 5 },
    },
    orderBy: [{ lastActiveAt: "desc" }, { updatedAt: "desc" }],
    take: 80,
  });

  const ranked = experts
    .map((expert) => scoreInternalExpert(project, expert))
    .filter((item) => item.score >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(12, Math.min(project.quantity ?? 12, 30)));

  const candidates: CandidateWithExpert[] = [];
  for (const item of ranked) {
    const humanReviewNeeded =
      item.evidenceLevelRank < 2 ||
      requiresProjectReview(project) ||
      item.risks.length > 0 ||
      item.score < 75;
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
        nextAction: item.nextAction,
        humanReviewNeeded,
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

  await prisma.supplySearchRun.update({
    where: { id: run.id },
    data: {
      status: "completed",
      summaryJson: stringifyJson({
        matched: candidates.length,
        eligibleExperts: experts.length,
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
  const available = project.candidates.filter((candidate) => candidate.sourceType === "internal");
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
    project: serializeProject(project),
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

  const gapOutput = ai.ok
    ? ai.data
    : {
        gaps: ruleGaps,
        searchDirections: buildSearchDirections(project),
        summary: "已根据当前候选和项目目标生成供给缺口。",
      };

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

export async function runExternalResearch(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { supplyGaps: { where: { status: "open" }, orderBy: { createdAt: "desc" }, take: 6 } },
  });
  if (!project) return null;

  const gapQueries = project.supplyGaps
    .flatMap((gap) => buildGapQueries(project, gap.description))
    .filter(Boolean);
  const projectQueries = parseJson<string[]>(project.searchQueriesJson, []);
  const queries = Array.from(new Set([...gapQueries, ...projectQueries, ...buildSearchDirections(project)])).slice(0, 4);

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

  const result = await sourceProjectCandidates({ project, queries, maxQueries: 4, searchRunId: run.id, sourceType: "external" });
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

  await prisma.supplySearchRun.update({
    where: { id: run.id },
    data: {
      status: "completed",
      summaryJson: stringifyJson({
        searchResults: result.searchResults.length,
        candidates: result.candidates.length,
        providerStats: result.providerStats,
        cacheHits: result.cacheHits.length,
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
    },
  });

  return {
    ...result,
    ok: true as const,
    runId: run.id,
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

  const candidates = project.candidates.slice(0, 40);
  const ruleRank = candidates.map((candidate) => {
    const gate = canApproveForOutreach({ candidate, expert: candidate.expert, project });
    const score = computeCandidateRank(project, candidate, gate.ok);
    return {
      candidateId: candidate.id,
      score,
      conversionProbability: Math.max(0.05, Math.min(0.92, score / 100)),
      rankReasons: buildRankReasons(candidate, gate.ok),
      risks: parseJson<string[]>(candidate.risksJson, []),
      nextAction: gate.ok ? "生成触达草稿或进入试标安排。" : candidate.nextAction ?? "补齐证据或完成复核后再推进。",
    };
  });

  const ai = await rankSupplyCandidates({
    project: serializeProject(project),
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
      rankedById.set(item.candidateId, { ...existing, ...item });
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
  const merge = await prisma.expertMergeCandidate.findUnique({ where: { id: mergeId } });
  if (!merge) return null;

  const updated = await prisma.expertMergeCandidate.update({
    where: { id: mergeId },
    data: { status },
  });

  if (status === "confirmed") {
    await prisma.$transaction([
      prisma.evidenceItem.updateMany({ where: { expertId: merge.duplicateExpertId }, data: { expertId: merge.primaryExpertId } }),
      prisma.expertSignal.updateMany({ where: { expertId: merge.duplicateExpertId }, data: { expertId: merge.primaryExpertId } }),
      prisma.expertEngagementEvent.updateMany({ where: { expertId: merge.duplicateExpertId }, data: { expertId: merge.primaryExpertId } }),
      prisma.expertQualityMetric.updateMany({ where: { expertId: merge.duplicateExpertId }, data: { expertId: merge.primaryExpertId } }),
    ]);
  }

  await writeAuditEvent({
    entityType: "expert_merge_candidate",
    entityId: merge.id,
    action: "expert.merge_candidate.resolved",
    payload: {
      primaryExpertId: merge.primaryExpertId,
      duplicateExpertId: merge.duplicateExpertId,
      status,
    },
  });

  return updated;
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
    project: serializeProject(project),
    funnel,
    sourceMetrics: project.searchSourceMetrics,
    marketingPosts: project.marketingPosts.map((post) => ({
      channel: post.channel,
      status: post.status,
      title: post.title,
    })),
  });

  const summary = ai.ok
    ? ai.data
    : {
        summary: "已根据系统内候选、触达、试标和入池数据生成基础复盘。",
        wins: buildRuleWins(project, funnel),
        bottlenecks: buildRuleBottlenecks(project, funnel),
        sourceInsights: buildRuleSourceInsights(project),
        nextActions: buildRuleNextActions(project, funnel),
      };

  const outcome = await prisma.recruitmentOutcome.create({
    data: {
      projectId,
      targetCount: project.quantity ?? 0,
      sourcedCount: funnel.sourcedCount,
      approvedCount: funnel.approvedCount,
      contactedCount: funnel.contactedCount,
      trialCount: funnel.trialCount,
      onboardedCount: funnel.onboardedCount,
      summaryJson: stringifyJson({ ...summary, aiFallbackReason: ai.ok ? undefined : publicErrorMessage(ai.error) }),
    },
  });

  await writeAuditEvent({
    projectId,
    entityType: "project",
    entityId: projectId,
    action: ai.ok ? "recruitment.retrospective.completed" : "recruitment.retrospective.completed_with_rules",
    payload: {
      outcomeId: outcome.id,
      funnel,
      aiFallbackReason: ai.ok ? undefined : ai.error,
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

async function detectMergeCandidates(projectId: string) {
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
          status: "pending",
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
  expert: Expert & {
    signals: Array<{ type: string; value: string; evidenceLevel: string; confidence: number }>;
    qualityMetrics: Array<{ score: number; metricType: string }>;
    candidates: Array<ProjectCandidate & { project: Project }>;
  },
) {
  const projectText = `${project.title} ${project.rawDemand} ${project.domain ?? ""} ${project.taskType ?? ""}`.toLowerCase();
  const tags = parseJson<string[]>(expert.domainTagsJson, []);
  const languages = parseJson<string[]>(expert.languagesJson, []);
  const qualityScore = average(expert.qualityMetrics.map((metric) => metric.score), 62);
  const domainHits = tags.filter((tag) => projectText.includes(tag.toLowerCase()) || tag.toLowerCase().includes((project.domain ?? "").toLowerCase()));
  const signalHits = expert.signals.filter((signal) => projectText.includes(signal.value.toLowerCase()));
  const historyHits = expert.candidates.filter((candidate) =>
    `${candidate.project.domain ?? ""} ${candidate.project.taskType ?? ""}`.toLowerCase().split(/\s+/).some((item) => item && projectText.includes(item)),
  );
  const evidenceScore = (evidenceRank[expert.evidenceLevel] ?? 0) * 18;
  const domainScore = Math.min(28, domainHits.length * 12 + signalHits.length * 6 + historyHits.length * 8);
  const languageScore = languages.some((language) => project.rawDemand.includes(language) || (project.languagesJson ?? "").includes(language)) ? 10 : 4;
  const availabilityScore = expert.lastActiveAt ? 10 : 4;
  const score = Math.min(100, Math.round(qualityScore * 0.28 + evidenceScore + domainScore + languageScore + availabilityScore));
  const risks: string[] = [];
  const missing: string[] = [];
  if ((evidenceRank[expert.evidenceLevel] ?? 0) < 2) missing.push("证据等级低于 E2");
  if (["unknown", "legitimate_interest"].includes(expert.consentState)) missing.push("联系许可需确认");
  if (requiresProjectReview(project)) risks.push("高风险项目需人工复核");
  if (!domainHits.length && !signalHits.length) missing.push("缺少与当前需求直接对应的能力信号");

  return {
    expert,
    score,
    evidenceLevelRank: evidenceRank[expert.evidenceLevel] ?? 0,
    conversionProbability: Math.max(0.08, Math.min(0.9, score / 100 - (risks.length ? 0.12 : 0))),
    reasons: [
      domainHits.length ? `领域标签匹配：${domainHits.slice(0, 3).join("、")}` : null,
      signalHits.length ? `能力信号匹配：${signalHits.slice(0, 3).map((signal) => signal.value).join("、")}` : null,
      historyHits.length ? `有 ${historyHits.length} 个相似项目记录` : null,
      `历史质量均分 ${Math.round(qualityScore)}`,
      `证据等级 ${expert.evidenceLevel}`,
    ].filter(Boolean) as string[],
    risks,
    missing,
    nextAction: risks.length || missing.length ? "补齐证据和许可后复核。" : "可进入触达或试标安排。",
    breakdown: [
      { dimension: "领域匹配", score: Math.min(100, domainScore * 3), weight: 35, evidence: domainHits.join("、") || "未发现直接标签", reason: domainHits.length ? "内部标签与项目需求匹配。" : "需要补充能力证据。" },
      { dimension: "历史质量", score: Math.round(qualityScore), weight: 30, evidence: `${expert.qualityMetrics.length} 条质量记录`, reason: "基于历史试标/交付记录。" },
      { dimension: "证据与合规", score: Math.min(100, evidenceScore + languageScore + availabilityScore), weight: 35, evidence: `${expert.evidenceLevel} / ${expert.consentState}`, reason: "综合证据等级、语言和联系许可。" },
    ],
  };
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
  const base = [project.domain, project.taskType, project.title].filter(Boolean).join(" ");
  return Array.from(new Set([
    `${base} 机构主页 专家`,
    `${base} 会议 讲者 专家`,
    `${base} 论文 作者 专家`,
    `${base} 行业协会 专家`,
  ].map((item) => item.trim()).filter(Boolean))).slice(0, 6);
}

function buildGapQueries(project: Project, description: string) {
  const base = [project.domain, project.taskType].filter(Boolean).join(" ");
  if (/证据|E2|机构|论文|会议/.test(description)) {
    return [`${base} 机构主页 专家`, `${base} 论文 作者`, `${base} 会议 讲者`];
  }
  if (/联系|触达/.test(description)) {
    return [`${base} 专家 公开主页`, `${base} consultant profile`];
  }
  return [`${base} 专家`, `${base} professional profile`];
}

function computeCandidateRank(project: Project, candidate: ProjectCandidate & { expert: Expert }, gateOk: boolean) {
  const fit = candidate.fitScore ?? 45;
  const evidence = (evidenceRank[candidate.expert.evidenceLevel] ?? 0) * 12;
  const sourceBonus = candidate.sourceType === "internal" ? 8 : candidate.sourceType === "referred" ? 6 : 0;
  const reviewPenalty = candidate.humanReviewNeeded ? 12 : 0;
  const riskPenalty = requiresProjectReview(project) ? 8 : 0;
  const gateBonus = gateOk ? 12 : 0;
  return Math.max(0, Math.min(100, fit * 0.55 + evidence + sourceBonus + gateBonus - reviewPenalty - riskPenalty));
}

function buildRankReasons(candidate: ProjectCandidate & { expert: Expert }, gateOk: boolean) {
  const reasons = [
    `${candidate.sourceType === "internal" ? "内部专家" : "外部候选"} · 证据 ${candidate.expert.evidenceLevel}`,
    candidate.fitScore !== null ? `匹配分 ${candidate.fitScore}` : "尚未完成匹配评分",
    gateOk ? "联系门禁已通过" : "需要补齐证据或许可",
  ];
  const rankReasons = parseJson<{ reasons?: string[] }>(candidate.rankReasonJson, {}).reasons ?? [];
  return Array.from(new Set([...reasons, ...rankReasons])).slice(0, 5);
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

function buildFunnel(project: Project & { candidates: Array<ProjectCandidate & { expert: Expert; outreachDrafts: unknown[]; trialTasks: Array<{ outcome: string | null }> }> }) {
  return {
    sourcedCount: project.candidates.length,
    approvedCount: project.candidates.filter((candidate) => !candidate.humanReviewNeeded).length,
    contactedCount: project.candidates.filter((candidate) => ["contacted", "replied", "screening", "trial", "contracting", "onboarded", "active"].includes(candidate.stage)).length,
    trialCount: project.candidates.filter((candidate) => candidate.stage === "trial" || candidate.trialTasks.length > 0).length,
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

function buildRuleSourceInsights(project: { searchSourceMetrics: Array<{ domain: string | null; candidateCount: number; e2PlusCount: number }> }) {
  const top = project.searchSourceMetrics
    .slice()
    .sort((a, b) => b.e2PlusCount - a.e2PlusCount || b.candidateCount - a.candidateCount)
    .slice(0, 3);
  return top.length
    ? top.map((metric) => `${metric.domain ?? "公开来源"} 贡献 ${metric.candidateCount} 位候选，其中 ${metric.e2PlusCount} 位达到 E2+。`)
    : ["当前来源数据不足，后续需要持续记录 query 和来源域名表现。"];
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
