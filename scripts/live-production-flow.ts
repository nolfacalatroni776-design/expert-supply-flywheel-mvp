import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assessLiveAgentRun,
  assessLiveExternalSearch,
  type LiveExternalSearchAssessment,
} from "../src/lib/live-production-acceptance";

type Checkpoint = {
  name: string;
  ok: boolean;
  detail: string;
  data?: Record<string, unknown>;
};

type AgentRuntime = typeof import("../src/lib/agent-runtime");
type PrismaModule = typeof import("../src/lib/prisma");

const checkpoints: Checkpoint[] = [];
const runStamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const projectId = `live-flow-${runStamp}`;

async function main() {
  loadLocalEnv();
  requireConfiguredEnv();
  process.env.ENABLE_RUNTIME_DB_INIT ??= "1";
  const requireNetworkSearch = process.env.LIVE_FLOW_REQUIRE_NETWORK_SEARCH === "1";
  if (requireNetworkSearch) process.env.SEARCH_CACHE_BYPASS = "1";

  const { prisma } = (await import("../src/lib/prisma")) as PrismaModule;
  const runtime = (await import("../src/lib/agent-runtime")) as AgentRuntime;
  let externalSearchAssessment: LiveExternalSearchAssessment | null = null;

  try {
    const cleanup = await cleanupLiveFlowData(prisma);
    checkpoint("live data isolated", true, "Removed prior smoke projects before creating this run.", cleanup);
    await seedLiveProject(prisma);
    checkpoint("live project prepared", true, `Created isolated project ${projectId}.`);

    const fullRun = await runAgent(runtime, {
      projectId,
      intent: "full_sourcing",
      instruction: "真实生产验收：补齐画像、召回内部专家、分析缺口、确认后执行外部搜索、抽取候选并排序。",
      confirmExternalSearch: true,
    });
    const fullRunAssessment = assessLiveAgentRun({
      status: fullRun.status,
      failed: readStringList(fullRun.report?.failed),
    });
    checkpoint("full sourcing agent", fullRunAssessment.ok, `Run ended as ${fullRun.status}.`, {
      runId: fullRun.id,
      report: fullRun.report,
      acceptanceReasons: fullRunAssessment.reasons,
    });

    const postSourcing = await collectProjectSnapshot(prisma);
    const externalSummary = readLatestExternalSummary(postSourcing.supplySearchRuns);
    checkpoint("external search records", postSourcing.externalRuns > 0 && postSourcing.searchResults > 0, "External search wrote run and result records.", {
      externalRuns: postSourcing.externalRuns,
      searchResults: postSourcing.searchResults,
      externalCandidates: postSourcing.externalCandidates,
      providerStats: externalSummary.providerStats,
      cacheHits: externalSummary.cacheHits,
      acceptance: externalSummary.acceptance,
    });
    const externalAcceptance = readRecord(externalSummary.acceptance);
    const providerStats = readNumberRecord(externalSummary.providerStats);
    externalSearchAssessment = assessLiveExternalSearch({
      externalRuns: postSourcing.externalRuns,
      searchResults: postSourcing.searchResults,
      externalCandidates: postSourcing.externalCandidates,
      requireNetworkCall: requireNetworkSearch,
      acceptance: {
        passed: externalAcceptance.passed === true,
        uncached: numberValue(externalAcceptance.uncached),
        hardRequirementReadyCandidates: numberValue(externalAcceptance.hardRequirementReadyCandidates),
        blockers: readStringList(externalAcceptance.blockers),
      },
      providerStats,
    });
    checkpoint(
      "external search acceptance",
      externalSearchAssessment.ok,
      externalSearchAssessment.ok
        ? "External candidates passed the project gates and the required provider boundary was verified."
        : externalSearchAssessment.reasons.join(" "),
      {
        networkCallRequired: requireNetworkSearch,
        networkCallVerified: externalSearchAssessment.networkCallVerified,
        providers: externalSearchAssessment.providers,
        reasons: externalSearchAssessment.reasons,
      },
    );
    const externalCandidateQuality = evaluateExternalCandidateAudit(postSourcing.externalCandidateAudit);
    checkpoint("external candidate quality", externalCandidateQuality.issues.length === 0, "External candidates passed per-person evidence and review gates.", {
      candidateCount: postSourcing.externalCandidateAudit.length,
      issues: externalCandidateQuality.issues,
    });
    checkpoint("candidate pool usable", postSourcing.candidates > 0, "Candidate pool has at least one candidate for downstream workflow.", {
      candidates: postSourcing.candidates,
      internalCandidates: postSourcing.internalCandidates,
      externalCandidates: postSourcing.externalCandidates,
      e2PlusCandidates: postSourcing.e2PlusCandidates,
    });

    const candidate = await selectCandidateForNoSendFlow(prisma);
    checkpoint("candidate selected", Boolean(candidate), "Selected candidate for score, review, outreach draft and trial.", {
      candidateId: candidate?.id,
      expertName: candidate?.expert.name,
      sourceType: candidate?.sourceType,
    });
    if (!candidate) throw new Error("No candidate available for downstream workflow.");

    const scored = await callCandidateRoute("score", candidate.id, "POST");
    checkpoint("candidate scored by GLM", scored.ok, "Candidate scoring endpoint completed.", scored.data);

    const reviewed = await callCandidateRoute("review", candidate.id, "PATCH", {
      decision: "approved",
      note: "Live smoke 人工复核通过：仅用于生产验收，不代表真实触达。",
    });
    checkpoint("candidate review approved", reviewed.ok, "Human review path approved the candidate for next controlled steps.", reviewed.data);

    const outreach = await generateOutreachDraftOnly(candidate.id);
    checkpoint("outreach draft generated", outreach.ok, "Outreach draft only; no email is sent.", outreach.data);

    const screening = await callCandidateRoute("stage", candidate.id, "PATCH", {
      stage: "screening",
      reason: "Live smoke：仅模拟运营筛选，不发送邮件。",
    });
    checkpoint("candidate moved to screening", screening.ok, "Candidate moved through pipeline without email send.", screening.data);

    const trial = await callCandidateRoute("trial", candidate.id, "POST");
    checkpoint("trial task generated", trial.ok, "Trial task and rubric were generated.", trial.data);
    const trialStarted = await callCandidateRoute("trial-start", candidate.id, "POST", {
      samplesDeidentified: true,
      guidanceAttached: true,
      goldAnswersValidated: true,
      approvalNote: "Live smoke：脱敏样本、任务指引和标准答案均已完成测试校验。",
    });
    checkpoint("trial start approved", trialStarted.ok, "Operator approved required trial materials before trial start.", trialStarted.data);

    const marketingRun = await runAgent(runtime, {
      projectId,
      intent: "generate_marketing",
      instruction: "真实生产验收：生成多渠道专家招募内容，进入人工复核，不自动外发。",
      confirmExternalSearch: false,
    });
    const marketingAssessment = assessLiveAgentRun({
      status: marketingRun.status,
      failed: readStringList(marketingRun.report?.failed),
    });
    checkpoint("marketing agent", marketingAssessment.ok, `Run ended as ${marketingRun.status}.`, {
      runId: marketingRun.id,
      report: marketingRun.report,
      acceptanceReasons: marketingAssessment.reasons,
    });

    const marketingProgress = await approveOneMarketingPostInternally(prisma);
    checkpoint("marketing approval path", marketingProgress.ok, "Approved one channel draft and marked internal publishing progress only.", marketingProgress.data);

    const retrospectiveRun = await runAgent(runtime, {
      projectId,
      intent: "recruitment_retrospective",
      instruction: "真实生产验收：基于本轮候选、渠道内容、试标记录生成复盘。",
      confirmExternalSearch: false,
    });
    const retrospectiveAssessment = assessLiveAgentRun({
      status: retrospectiveRun.status,
      failed: readStringList(retrospectiveRun.report?.failed),
    });
    checkpoint("retrospective agent", retrospectiveAssessment.ok, `Run ended as ${retrospectiveRun.status}.`, {
      runId: retrospectiveRun.id,
      report: retrospectiveRun.report,
      acceptanceReasons: retrospectiveAssessment.reasons,
    });

    const finalSnapshot = await collectProjectSnapshot(prisma);
    checkpoint("audit trail complete", finalSnapshot.auditEvents >= 8, "Audit events were written for the live workflow.", {
      auditEvents: finalSnapshot.auditEvents,
      outreachDrafts: finalSnapshot.outreachDrafts,
      trialTasks: finalSnapshot.trialTasks,
      marketingPosts: finalSnapshot.marketingPosts,
      retrospectiveOutcomes: finalSnapshot.retrospectiveOutcomes,
    });

    const report = buildReport(finalSnapshot, externalSearchAssessment);
    writeReport(report);
    printSummary(report);
    if (report.checkpoints.some((item) => !item.ok)) process.exitCode = 1;
  } finally {
    if (process.env.LIVE_FLOW_KEEP_DATA !== "1") {
      await cleanupLiveFlowData(prisma);
    }
    await prisma.$disconnect();
  }
}

function loadLocalEnv() {
  const lockedEnvKeys = new Set(Object.keys(process.env));
  for (const file of [".env", ".env.local"]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (lockedEnvKeys.has(key)) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  }
}

function requireConfiguredEnv() {
  const missing = ["DATABASE_URL", "DASHSCOPE_API_KEY", "DASHSCOPE_BASE_URL", "BAILIAN_MODEL", "SERPER_API_KEY"].filter(
    (key) => !process.env[key],
  );
  if (missing.length) throw new Error(`Missing required live-flow configuration: ${missing.join(", ")}`);
  if (process.env.LIVE_FLOW_ALLOW_EXTERNAL_SEARCH !== "1") {
    throw new Error("Set LIVE_FLOW_ALLOW_EXTERNAL_SEARCH=1 to run the real external-search portion of this smoke test.");
  }
}

async function cleanupLiveFlowData(prisma: PrismaModule["prisma"]) {
  const deletedProjects = await prisma.project.deleteMany({
    where: { id: { startsWith: "live-flow-" } },
  });
  const deletedExperts = await prisma.expert.deleteMany({
    where: {
      sourceUrl: { startsWith: "https://expert-ops.local/live/" },
      candidates: { none: {} },
    },
  });
  return {
    deletedProjects: deletedProjects.count,
    deletedOrphanExperts: deletedExperts.count,
    currentRunRetained: process.env.LIVE_FLOW_KEEP_DATA === "1",
  };
}

async function seedLiveProject(prisma: PrismaModule["prisma"]) {
  await prisma.project.create({
    data: {
      id: projectId,
      title: `Live Smoke Python 后端代码评审专家招募 ${runStamp}`,
      rawDemand:
        "为企业级 Python 后端代码评审任务招募 3 位专家，要求熟悉 FastAPI、Django、SQLAlchemy、测试质量、代码安全和工程规范。专家需要能完成小规模试标、给出可解释审查意见，并接受人工复核后再进入正式任务。",
      domain: "Python 后端",
      taskType: "代码评审 / 标注质检",
      quantity: 3,
      budgetMin: 120,
      budgetMax: 260,
      languagesJson: JSON.stringify(["中文", "英文"]),
      regionsJson: JSON.stringify(["远程", "UTC+8"]),
      riskLevel: "medium",
      status: "draft",
      searchQueriesJson: JSON.stringify([
        "FastAPI maintainer GitHub profile Python backend",
        "Django contributor Python code review public profile",
        "Python backend code review expert conference speaker",
        "SQLAlchemy Python backend maintainer profile",
      ]),
    },
  });

  const expert = await prisma.expert.create({
    data: {
      name: `Live Smoke 内部 Python 专家 ${runStamp}`,
      title: "资深 Python 后端工程师",
      affiliation: "内部专家库",
      sourceUrl: `https://expert-ops.local/live/${runStamp}/python-backend`,
      domainTagsJson: JSON.stringify(["Python", "FastAPI", "Django", "SQLAlchemy", "代码评审", "后端"]),
      languagesJson: JSON.stringify(["中文", "英文"]),
      region: "远程",
      contactJson: JSON.stringify({
        profileUrl: `https://expert-ops.local/live/${runStamp}/python-backend`,
        contactPermissionBasis: "direct_consent",
        profileAllowsOutreach: true,
      }),
      evidenceLevel: "E4",
      consentState: "consented",
      expertType: "internal",
      lastActiveAt: new Date(),
      qualitySummaryJson: JSON.stringify({ averageScore: 96, metricCount: 2 }),
    },
  });

  await prisma.evidenceItem.createMany({
    data: [
      {
        projectId,
        expertId: expert.id,
        claim: "具备 FastAPI / Django / SQLAlchemy 后端代码评审经验",
        sourceUrl: expert.sourceUrl ?? `https://expert-ops.local/live/${runStamp}/python-backend`,
        sourceTitle: "内部专家主档",
        sourceType: "internal_profile",
        snippet: "内部专家主档记录该专家完成过 Python 后端代码评审、测试质量检查和安全风险审查。",
        evidenceLevel: "E4",
        confidence: 0.96,
      },
      {
        projectId,
        expertId: expert.id,
        claim: "历史试标和质检表现稳定",
        sourceUrl: expert.sourceUrl ?? `https://expert-ops.local/live/${runStamp}/python-backend`,
        sourceTitle: "历史质量记录",
        sourceType: "internal_quality_metric",
        snippet: "历史试标得分 96，覆盖代码安全、工程规范和可解释审查意见。",
        evidenceLevel: "E4",
        confidence: 0.95,
      },
    ],
  });

  for (const value of ["FastAPI", "Django", "SQLAlchemy", "代码评审"]) {
    await prisma.expertSignal.create({
      data: {
        expertId: expert.id,
        type: "skill",
        value,
        source: "live_smoke_internal_profile",
        evidenceLevel: "E4",
        confidence: 0.95,
        sourceUrl: expert.sourceUrl,
      },
    });
  }

  await prisma.expertQualityMetric.create({
    data: {
      expertId: expert.id,
      projectId,
      metricType: "historical_trial_score",
      score: 96,
      source: "live_smoke_fixture",
      notes: "Live smoke fixture for production-flow validation.",
    },
  });
}

async function runAgent(
  runtime: AgentRuntime,
  input: {
    projectId: string;
    intent: Parameters<AgentRuntime["createAgentTaskRun"]>[0]["intent"];
    instruction: string;
    confirmExternalSearch: boolean;
  },
) {
  const created = await runtime.createAgentTaskRun({
    projectId: input.projectId,
    intent: input.intent,
    instruction: input.instruction,
  });
  if (!created) throw new Error(`Could not create ${input.intent} run.`);

  const started = await runtime.startAgentTaskRun(created.id);
  if (!started) throw new Error(`Could not start ${input.intent} run.`);
  if (started.status !== "waiting_for_confirmation") return started;
  if (!input.confirmExternalSearch) return started;

  const confirmed = await runtime.confirmAgentTaskRun(started.id);
  if (!confirmed) throw new Error(`Could not confirm ${input.intent} run.`);
  return confirmed;
}

async function collectProjectSnapshot(prisma: PrismaModule["prisma"]) {
  const [
    candidates,
    internalCandidates,
    externalCandidates,
    e2PlusCandidates,
    externalRuns,
    searchResults,
    auditEvents,
    outreachDrafts,
    trialTasks,
    marketingPosts,
    retrospectiveOutcomes,
    supplySearchRuns,
    externalCandidateAudit,
  ] = await Promise.all([
    prisma.projectCandidate.count({ where: { projectId } }),
    prisma.projectCandidate.count({ where: { projectId, sourceType: "internal" } }),
    prisma.projectCandidate.count({ where: { projectId, sourceType: "external" } }),
    prisma.projectCandidate.count({ where: { projectId, expert: { evidenceLevel: { in: ["E2", "E3", "E4"] } } } }),
    prisma.supplySearchRun.count({ where: { projectId, runType: "external" } }),
    prisma.searchResult.count({ where: { projectId } }),
    prisma.auditEvent.count({ where: { projectId } }),
    prisma.outreachDraft.count({ where: { candidate: { projectId } } }),
    prisma.trialTask.count({ where: { candidate: { projectId } } }),
    prisma.marketingPost.count({ where: { projectId } }),
    prisma.recruitmentOutcome.count({ where: { projectId } }),
    prisma.supplySearchRun.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } }),
    prisma.projectCandidate.findMany({
      where: { projectId, sourceType: "external" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        stage: true,
        fitScore: true,
        humanReviewNeeded: true,
        nextAction: true,
        risksJson: true,
        missingJson: true,
        expert: {
          select: {
            name: true,
            title: true,
            affiliation: true,
            sourceUrl: true,
            evidenceLevel: true,
            consentState: true,
            lastActiveAt: true,
          },
        },
        evidenceItems: {
          orderBy: { createdAt: "asc" },
          select: {
            claim: true,
            sourceUrl: true,
            sourceTitle: true,
            sourceType: true,
            snippet: true,
            evidenceLevel: true,
            confidence: true,
          },
        },
      },
    }),
  ]);
  return {
    candidates,
    internalCandidates,
    externalCandidates,
    e2PlusCandidates,
    externalRuns,
    searchResults,
    auditEvents,
    outreachDrafts,
    trialTasks,
    marketingPosts,
    retrospectiveOutcomes,
    supplySearchRuns,
    externalCandidateAudit: externalCandidateAudit.map((candidate) => ({
      id: candidate.id,
      stage: candidate.stage,
      fitScore: candidate.fitScore,
      humanReviewNeeded: candidate.humanReviewNeeded,
      nextAction: candidate.nextAction,
      risks: safeStringArray(candidate.risksJson),
      missingEvidence: safeStringArray(candidate.missingJson),
      expert: candidate.expert,
      evidenceItems: candidate.evidenceItems.map((evidence) => ({
        ...evidence,
        snippet: sanitizeEvidenceSnippet(evidence.snippet),
      })),
    })),
  };
}

function safeStringArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function readStringList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readNumberRecord(value: unknown) {
  const input = readRecord(value);
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, count]) => [key, Number(count)] as const)
      .filter(([, count]) => Number.isFinite(count) && count >= 0),
  );
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeEvidenceSnippet(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[公开联系信息已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[敏感信息已隐藏]")
    .slice(0, 1200);
}

function evaluateExternalCandidateAudit(
  candidates: Awaited<ReturnType<typeof collectProjectSnapshot>>["externalCandidateAudit"],
) {
  const issues: string[] = [];
  const internalFieldPattern = /\b(?:persona|fitScore|riskLevel|humanReviewNeeded|sourceType|sourceRunId|conversionProbability)\b/i;
  const unsafeActionPattern = /立即触达|优先触达|直接触达|发送(?:邮件|邀请)|(?:立即|直接).{0,8}(?:安排|启动|进入)试标|无需.{0,4}复核/i;
  const githubFreshnessCutoff = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;

  for (const candidate of candidates) {
    const label = candidate.expert.name || candidate.id;
    if (!candidate.humanReviewNeeded) issues.push(`${label} 未保持人工复核状态。`);
    if (!candidate.expert.sourceUrl) issues.push(`${label} 缺少公开来源地址。`);
    if (/^https:\/\/github\.com\//i.test(candidate.expert.sourceUrl ?? "")) {
      const lastActiveAt = candidate.expert.lastActiveAt?.getTime() ?? 0;
      if (lastActiveAt < githubFreshnessCutoff) issues.push(`${label} 缺少近三年的公开活动信号。`);
    }
    if (!candidate.evidenceItems.length) issues.push(`${label} 没有可复核证据。`);

    for (const evidence of candidate.evidenceItems) {
      if (!evidence.claim.trim()) issues.push(`${label} 存在空证据结论。`);
      if (!evidence.sourceUrl.trim()) issues.push(`${label} 存在无来源地址的证据。`);
      if (!evidence.sourceTitle?.trim()) issues.push(`${label} 存在无来源标题的证据。`);
      if (!evidence.snippet.trim()) issues.push(`${label} 存在无来源摘要的证据。`);
    }

    const guidance = [...candidate.risks, ...candidate.missingEvidence, candidate.nextAction ?? ""].join(" ");
    if (internalFieldPattern.test(guidance)) issues.push(`${label} 的用户可见文案包含内部字段。`);
    if (unsafeActionPattern.test(guidance)) issues.push(`${label} 的下一步越过了人工审批。`);
  }

  return { issues };
}

function readLatestExternalSummary(runs: Awaited<ReturnType<typeof collectProjectSnapshot>>["supplySearchRuns"]) {
  const latest = runs.find((run) => run.runType === "external");
  if (!latest) return {};
  try {
    return JSON.parse(latest.summaryJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function selectCandidateForNoSendFlow(prisma: PrismaModule["prisma"]) {
  const candidates = await prisma.projectCandidate.findMany({
    where: { projectId },
    include: { expert: true },
    orderBy: [{ sourceType: "asc" }, { fitScore: "desc" }, { updatedAt: "desc" }],
  });
  return (
    candidates.find((candidate) => candidate.expert.name.includes(runStamp)) ??
    candidates.find((candidate) => candidate.sourceType === "internal" && candidate.expert.consentState === "consented") ??
    candidates[0] ??
    null
  );
}

async function callCandidateRoute(
  routeName: "score" | "outreach" | "trial" | "trial-start" | "stage" | "review",
  candidateId: string,
  method: "POST" | "PATCH",
  body?: unknown,
) {
  const route =
    routeName === "score"
      ? await import("../src/app/api/project-candidates/[id]/score/route")
      : routeName === "outreach"
        ? await import("../src/app/api/project-candidates/[id]/outreach/route")
        : routeName === "trial"
          ? await import("../src/app/api/project-candidates/[id]/trial/route")
          : routeName === "trial-start"
            ? await import("../src/app/api/project-candidates/[id]/trial-start/route")
          : routeName === "stage"
            ? await import("../src/app/api/project-candidates/[id]/stage/route")
            : await import("../src/app/api/project-candidates/[id]/review/route");

  const handlers = route as {
    POST?: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
    PATCH?: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  const handler = method === "POST" ? handlers.POST : handlers.PATCH;
  if (!handler) throw new Error(`${routeName} route does not support ${method}.`);
  const request = new Request(`http://localhost/api/project-candidates/${candidateId}/${routeName}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handler(request, { params: Promise.resolve({ id: candidateId }) });
  const payload = (await response.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: string };
  return {
    ok: response.ok,
    status: response.status,
    data: {
      ...(payload.data ?? {}),
      error: payload.error,
    },
  };
}

async function generateOutreachDraftOnly(candidateId: string) {
  const first = await callCandidateRoute("outreach", candidateId, "POST");
  if (first.ok || !isTransientAiFailure(first.data.error)) return first;
  return callCandidateRoute("outreach", candidateId, "POST");
}

function isTransientAiFailure(error: unknown) {
  return /智能处理服务暂不可用|fetch failed|network|Bailian network request failed/i.test(String(error ?? ""));
}

async function approveOneMarketingPostInternally(prisma: PrismaModule["prisma"]) {
  const post = await prisma.marketingPost.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  if (!post) {
    return { ok: false, data: { error: "No marketing post generated." } };
  }
  const route = await import("../src/app/api/marketing-posts/[id]/status/route");
  const approveResponse = await route.PATCH(
    new Request(`http://localhost/api/marketing-posts/${post.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    }),
    { params: Promise.resolve({ id: post.id }) },
  );
  const publishResponse = await route.PATCH(
    new Request(`http://localhost/api/marketing-posts/${post.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "published" }),
    }),
    { params: Promise.resolve({ id: post.id }) },
  );
  const updated = await prisma.marketingPost.findUnique({ where: { id: post.id } });
  return {
    ok: approveResponse.ok && publishResponse.ok && updated?.status === "published",
    data: {
      postId: post.id,
      channel: post.channel,
      approveStatus: approveResponse.status,
      publishStatus: publishResponse.status,
      finalStatus: updated?.status,
      note: "Internal publishing progress marker only; no external social post is sent.",
    },
  };
}

function checkpoint(name: string, ok: boolean, detail: string, data?: Record<string, unknown>) {
  checkpoints.push({ name, ok, detail, data });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function buildReport(
  finalSnapshot: Awaited<ReturnType<typeof collectProjectSnapshot>>,
  externalSearchAssessment: LiveExternalSearchAssessment | null,
) {
  return {
    projectId,
    generatedAt: new Date().toISOString(),
    realExternalSearchEnabled: process.env.LIVE_FLOW_ALLOW_EXTERNAL_SEARCH === "1",
    externalSearchNetworkRequired: process.env.LIVE_FLOW_REQUIRE_NETWORK_SEARCH === "1",
    realExternalSearchExecuted: externalSearchAssessment?.networkCallVerified ?? false,
    externalSearchProviders: externalSearchAssessment?.providers ?? [],
    externalSearchAcceptance: externalSearchAssessment,
    emailSent: false,
    externalSocialPostSent: false,
    checkpoints,
    externalCandidateAudit: finalSnapshot.externalCandidateAudit,
    finalSnapshot: {
      candidates: finalSnapshot.candidates,
      internalCandidates: finalSnapshot.internalCandidates,
      externalCandidates: finalSnapshot.externalCandidates,
      e2PlusCandidates: finalSnapshot.e2PlusCandidates,
      externalRuns: finalSnapshot.externalRuns,
      searchResults: finalSnapshot.searchResults,
      auditEvents: finalSnapshot.auditEvents,
      outreachDrafts: finalSnapshot.outreachDrafts,
      trialTasks: finalSnapshot.trialTasks,
      marketingPosts: finalSnapshot.marketingPosts,
      retrospectiveOutcomes: finalSnapshot.retrospectiveOutcomes,
    },
  };
}

function writeReport(report: { projectId: string; generatedAt: string; [key: string]: unknown }) {
  const outputDir = resolve(process.cwd(), "../../outputs");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `live-production-flow-${runStamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`REPORT ${outputPath}`);
}

function printSummary(report: ReturnType<typeof buildReport>) {
  const failed = report.checkpoints.filter((item) => !item.ok);
  console.log(
    JSON.stringify(
      {
        projectId: report.projectId,
        passed: failed.length === 0,
        failed: failed.map((item) => item.name),
        finalSnapshot: report.finalSnapshot,
        realExternalSearchExecuted: report.realExternalSearchExecuted,
        externalSearchProviders: report.externalSearchProviders,
        emailSent: report.emailSent,
        externalSocialPostSent: report.externalSocialPostSent,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  checkpoint("live flow crashed", false, error instanceof Error ? error.message : "Unknown live flow failure.");
  const report = {
    projectId,
    generatedAt: new Date().toISOString(),
    realExternalSearchEnabled: process.env.LIVE_FLOW_ALLOW_EXTERNAL_SEARCH === "1",
    externalSearchNetworkRequired: process.env.LIVE_FLOW_REQUIRE_NETWORK_SEARCH === "1",
    realExternalSearchExecuted: false,
    externalSearchProviders: [],
    externalSearchAcceptance: null,
    emailSent: false,
    externalSocialPostSent: false,
    checkpoints,
  };
  writeReport(report);
  process.exit(1);
});

export {};
