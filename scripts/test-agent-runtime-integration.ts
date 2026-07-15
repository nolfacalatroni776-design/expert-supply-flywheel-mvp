import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  buildIsolatedIntegrationDatabaseUrl,
  createIntegrationSchemaName,
  resolveIntegrationDatabaseUrl,
} from "../src/lib/integration-database";

const integrationSchema = createIntegrationSchemaName("agent_runtime");

process.env.SEARCH_FALLBACK_PROVIDERS = "";
delete process.env.SERPER_API_KEY;
delete process.env.DASHSCOPE_API_KEY;

type PrismaModule = typeof import("../src/lib/prisma");
type AgentRuntimeModule = typeof import("../src/lib/agent-runtime");
type GatesModule = typeof import("../src/lib/gates");
type SupplyFlywheelModule = typeof import("../src/lib/supply-flywheel");
type SourcingModule = typeof import("../src/lib/sourcing");

async function main() {
  const database = await prepareIntegrationDatabase();
  process.env.DATABASE_URL = buildIsolatedIntegrationDatabaseUrl(database.databaseUrl, integrationSchema);
  delete process.env.ENABLE_RUNTIME_DB_INIT;

  let prisma: PrismaModule["prisma"] | null = null;

  try {
    prepareIntegrationSchema();
    ({ prisma } = (await import("../src/lib/prisma")) as PrismaModule);
    const runtime = (await import("../src/lib/agent-runtime")) as AgentRuntimeModule;
    const gates = (await import("../src/lib/gates")) as GatesModule;
    const supplyFlywheel = (await import("../src/lib/supply-flywheel")) as SupplyFlywheelModule;
    const sourcing = (await import("../src/lib/sourcing")) as SourcingModule;

    await testAtomicExecutionClaims(prisma, runtime);
    await testDurableWorkflowOwnershipAndRejectedConfirmation(prisma, runtime);
    await testTechnicalFailureRetryRerunsDownstream(prisma, runtime, sourcing);
    await testInternalMatchWritesReviewableCandidates(prisma, runtime);
    await testExternalResearchUsesApprovedPlanAndCreatesReviewOnlyLeads(prisma, runtime, gates, sourcing);
    await testCandidateEvidenceEnrichmentCreatesReviewableMergeSuggestion(prisma, runtime, supplyFlywheel);
    await testSearchResultOccurrencesPreserveEveryRun(prisma, sourcing);
    await testConfirmedExpertMergeCombinesTheCompleteRecord(prisma, supplyFlywheel);
    await testLegacyRoutesCreateAgentRunsOnly(prisma);
  } finally {
    try {
      if (prisma) {
        await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${integrationSchema}" CASCADE`);
      }
    } finally {
      await prisma?.$disconnect();
      await database.stop();
    }
  }
}

async function testTechnicalFailureRetryRerunsDownstream(
  prisma: PrismaModule["prisma"],
  runtime: AgentRuntimeModule,
  sourcing: SourcingModule,
) {
  const project = await createProject(prisma, {
    id: "project-technical-retry",
    title: "外部搜索失败恢复验收",
    rawDemand: "为 Python 安全代码评审招募具有公开机构资料的专家。",
    domain: "Python 安全",
    taskType: "代码评审",
    quantity: 2,
    riskLevel: "high",
    searchQueriesJson: JSON.stringify(["Python security reviewer institution profile"]),
    personaJson: JSON.stringify({
      summary: "Python 安全代码评审专家",
      evidenceRequirements: ["机构团队公开主页"],
    }),
  });
  const run = await runtime.createAgentTaskRun({
    projectId: project.id,
    intent: "external_research",
    instruction: "只从机构团队主页和公开专家主页补充候选。",
  });
  assert(run);
  const waiting = await runtime.startAgentTaskRun(run.id);
  assert(waiting);
  assert.equal(waiting.status, "waiting_for_confirmation");
  const confirmation = waiting.steps.find((step) => step.stepKey === "confirm_external_search");
  const queryPreview = confirmation?.checks.queryPreview;
  assert(Array.isArray(queryPreview) && queryPreview.every((query) => typeof query === "string"));
  assert(queryPreview.length > 0);

  const failed = await runtime.confirmAgentTaskRun(run.id, { stepId: confirmation!.id });
  assert(failed);
  assert.equal(failed.status, "partially_succeeded");
  assert.equal(failed.steps.find((step) => step.stepKey === "external_research")?.status, "failed");
  const firstReport = failed.steps.find((step) => step.stepKey === "quality_report");
  assert.equal(firstReport?.status, "succeeded");
  assert(firstReport?.completedAt);
  assert.equal(
    await prisma.agentToolReceipt.count({ where: { runId: run.id, status: "failed", errorCategory: "configuration" } }),
    1,
  );

  await seedIntegrationSearchCache(prisma, queryPreview, sourcing);
  const prepared = await runtime.prepareAgentTaskRunRetry(run.id);
  assert(prepared);
  assert.equal(prepared.status, "planned");
  assert.deepEqual(prepared.steps.find((step) => step.stepKey === "external_research")?.output, {});
  assert.equal(prepared.steps.find((step) => step.stepKey === "external_research")?.status, "pending");
  assert.deepEqual(prepared.steps.find((step) => step.stepKey === "quality_report")?.output, {});
  assert.equal(prepared.steps.find((step) => step.stepKey === "quality_report")?.status, "pending");
  assert.equal(prepared.steps.find((step) => step.stepKey === "confirm_external_search")?.status, "succeeded");

  const retried = await runtime.startAgentTaskRun(run.id);
  assert(retried);
  assert(["succeeded", "partially_succeeded"].includes(retried.status));
  const retriedReport = retried.steps.find((step) => step.stepKey === "quality_report");
  assert.equal(retriedReport?.status, "succeeded");
  assert.notEqual(retriedReport?.completedAt?.toISOString(), firstReport.completedAt?.toISOString());
  assert(
    (await prisma.searchResult.count({ where: { projectId: project.id } })) > 0,
    "A successful retry must persist the approved search results even when candidate identity gates reject every result",
  );

  const receipts = await prisma.agentToolReceipt.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
  assert.equal(receipts.length, queryPreview.length);
  assert(receipts.every((receipt) => receipt.status === "succeeded" && receipt.provider === "cache"));
  assert.equal(receipts[0].attempt, 2, "The failed approved query must retain its stable receipt and increment its attempt");
  assert(receipts.slice(1).every((receipt) => receipt.attempt === 1));
  await prisma.searchCache.deleteMany({ where: { query: { in: queryPreview } } });
}

async function testDurableWorkflowOwnershipAndRejectedConfirmation(
  prisma: PrismaModule["prisma"],
  runtime: AgentRuntimeModule,
) {
  const project = await createProject(prisma, {
    id: "project-durable-approval",
    title: "耐久审批边界验收",
    rawDemand: "为 Python 安全代码评审招募专家，公开搜索必须逐条审批。",
    domain: "Python 安全",
    taskType: "代码评审",
    quantity: 3,
    riskLevel: "high",
    searchQueriesJson: JSON.stringify(["Python security reviewer institution profile"]),
  });
  const created = await runtime.createAgentTaskRun({
    projectId: project.id,
    intent: "external_research",
    instruction: "先展示公开搜索计划，确认后再执行。",
  });
  assert(created);

  assert.equal(await runtime.attachAgentTaskWorkflowRun(created.id, "wrun-owner"), true);
  assert.equal(
    await runtime.attachAgentTaskWorkflowRun(created.id, "wrun-duplicate"),
    false,
    "A second durable workflow must not replace the active owner",
  );
  assert.equal(
    (await prisma.agentTaskRun.findUniqueOrThrow({ where: { id: created.id } })).workflowRunId,
    "wrun-owner",
  );

  const waiting = await runtime.startAgentTaskRun(created.id);
  assert(waiting);
  assert.equal(waiting.status, "waiting_for_confirmation");
  const confirmation = waiting.steps.find((step) => step.stepKey === "confirm_external_search");
  assert(confirmation);

  const rejected = await runtime.rejectAgentTaskRunConfirmation(created.id, {
    stepId: confirmation.id,
    reason: "当前机构范围太宽，需要重新规划查询。",
  });
  assert(rejected);
  assert.equal(rejected.status, "partially_succeeded");
  const rejectedStep = await prisma.agentTaskStep.findUniqueOrThrow({ where: { id: confirmation.id } });
  assert.equal(rejectedStep.status, "blocked");
  assert.equal(rejectedStep.confirmationDecision, "rejected");
  assert.equal(rejectedStep.confirmationReason, "当前机构范围太宽，需要重新规划查询。");
  assert(rejectedStep.decidedAt);
  assert.equal(rejectedStep.confirmedAt, null);
  assert.equal(await prisma.agentToolReceipt.count({ where: { runId: created.id } }), 0);
  assert.equal(await prisma.searchResult.count({ where: { projectId: project.id } }), 0);
  assert.equal(await prisma.projectCandidate.count({ where: { projectId: project.id } }), 0);
  assert.equal(
    await prisma.auditEvent.count({ where: { entityId: created.id, action: "agent.task.confirmation_rejected" } }),
    1,
  );

  const prepared = await runtime.prepareAgentTaskRunRetry(created.id);
  assert(prepared);
  assert.equal(prepared.status, "partially_succeeded");
  assert.equal(
    prepared.steps.find((step) => step.id === confirmation.id)?.confirmationDecision,
    "rejected",
    "A business rejection must not be converted back into a pending approval",
  );
  assert.equal(
    (await prisma.agentTaskRun.findUniqueOrThrow({ where: { id: created.id } })).workflowRunId,
    "wrun-owner",
    "A rejected terminal run keeps its durable workflow association for audit history",
  );
}

async function testCandidateEvidenceEnrichmentCreatesReviewableMergeSuggestion(
  prisma: PrismaModule["prisma"],
  runtime: AgentRuntimeModule,
  supplyFlywheel: SupplyFlywheelModule,
) {
  const project = await createProject(prisma, {
    id: "project-evidence-enrichment",
    title: "候选证据补全验收",
    rawDemand: "为肿瘤免疫评审招募专家，所有候选必须有机构公开主页。",
    domain: "肿瘤免疫",
    taskType: "专家评审",
    quantity: 2,
    riskLevel: "regulated",
    searchQueriesJson: "[]",
  });
  const author = await prisma.expert.create({
    data: {
      name: "Junjie Hu",
      title: "论文作者",
      affiliation: "Tongji University",
      sourceUrl: "https://openalex.org/W-EVIDENCE",
      evidenceLevel: "E2",
      domainTagsJson: JSON.stringify(["肿瘤免疫"]),
    },
  });
  const authorCandidate = await prisma.projectCandidate.create({
    data: { projectId: project.id, expertId: author.id, sourceType: "external", humanReviewNeeded: true },
  });
  await prisma.evidenceItem.create({
    data: {
      projectId: project.id,
      expertId: author.id,
      candidateId: authorCandidate.id,
      claim: "Junjie Hu 列于公开论文作者名单",
      sourceUrl: author.sourceUrl!,
      sourceTitle: "OpenAlex publication",
      sourceType: "openalex_api",
      snippet: "Authors: Junjie Hu (Tongji University).",
      evidenceLevel: "E2",
      confidence: 0.9,
    },
  });

  const run = await runtime.createAgentTaskRun({
    projectId: project.id,
    intent: "enrich_candidate_evidence",
    instruction: "为现有高证据候选补齐机构主页，只生成同人合并建议。",
  });
  assert(run);
  assert.equal(run.status, "planned");

  const waiting = await runtime.startAgentTaskRun(run.id);
  assert(waiting);
  assert.equal(waiting.status, "waiting_for_confirmation");
  const confirmation = waiting.steps.find((step) => step.stepKey === "confirm_external_search");
  const queryPreview = confirmation?.checks.queryPreview;
  assert.deepEqual(queryPreview, ['"Junjie Hu" "Tongji University" institution profile']);
  const query = (queryPreview as string[])[0];

  await prisma.searchCache.create({
    data: {
      query,
      provider: "integration_fixture",
      resultsJson: JSON.stringify([
        {
          title: "Dr. Junjie Hu",
          url: "https://example.edu/researcher/junjie-hu",
          snippet: "Dr. Junjie Hu is a principal investigator at Tongji University working in tumor immunology.",
          domain: "example.edu",
          position: 1,
        },
      ]),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const completed = await runtime.confirmAgentTaskRun(run.id);
  assert(completed);
  assert.equal(completed.status, "succeeded");
  const enrichmentStep = completed.steps.find((step) => step.stepKey === "enrich_candidate_evidence");
  assert.equal(enrichmentStep?.status, "succeeded");
  assert.equal(enrichmentStep?.output.mergeSuggestions, 1);
  assert.equal(enrichmentStep?.toolReceipts.length, 1);
  assert.equal(enrichmentStep?.toolReceipts[0].provider, "cache");
  assert.equal(
    await prisma.projectCandidate.count({ where: { projectId: project.id } }),
    2,
    "Evidence enrichment must not auto-merge candidate identities",
  );
  assert.equal(
    await prisma.auditEvent.count({
      where: { projectId: project.id, action: "candidate.evidence_enrichment.completed" },
    }),
    1,
  );

  const suggestion = await prisma.expertMergeCandidate.findFirstOrThrow({
    where: {
      status: "pending",
      OR: [
        { primaryExpertId: author.id },
        { duplicateExpertId: author.id },
      ],
    },
  });
  await supplyFlywheel.resolveExpertMergeCandidate({ mergeId: suggestion.id, status: "rejected" });
  await supplyFlywheel.detectMergeCandidates(project.id);
  assert.equal(
    (await prisma.expertMergeCandidate.findUniqueOrThrow({ where: { id: suggestion.id } })).status,
    "rejected",
    "A human-rejected identity merge must not be reopened by a later search run",
  );
}

async function testSearchResultOccurrencesPreserveEveryRun(
  prisma: PrismaModule["prisma"],
  sourcing: SourcingModule,
) {
  const project = await createProject(prisma, {
    id: "project-search-occurrences",
    title: "搜索结果运行归属验收",
    rawDemand: "为 Python 代码评审寻找有公开主页的专家。",
    domain: "Python",
    taskType: "代码评审",
    quantity: 2,
    riskLevel: "medium",
    searchQueriesJson: "[]",
  });
  const [firstRun, secondRun] = await Promise.all([
    prisma.supplySearchRun.create({
      data: { projectId: project.id, runType: "external", status: "running", queriesJson: "[]" },
    }),
    prisma.supplySearchRun.create({
      data: { projectId: project.id, runType: "external", status: "running", queriesJson: "[]" },
    }),
  ]);
  const firstQuery = "Python code review expert profile";
  const secondQuery = "Python maintainer public profile";
  const sharedResult = {
    title: "Ada Lovelace",
    url: "https://experts.example.com/ada-lovelace",
    snippet: "Ada Lovelace is a named Python code review expert with a public profile.",
    domain: "experts.example.com",
    position: 1,
  };
  await prisma.searchCache.createMany({
    data: [firstQuery, secondQuery].map((query) => ({
      query,
      provider: "integration_fixture",
      resultsJson: JSON.stringify([sharedResult]),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });

  const first = await sourcing.sourceProjectCandidates({
    project,
    queries: [firstQuery],
    maxQueries: 1,
    searchRunId: firstRun.id,
  });
  const second = await sourcing.sourceProjectCandidates({
    project,
    queries: [secondQuery],
    maxQueries: 1,
    searchRunId: secondRun.id,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(await prisma.searchResult.count({ where: { projectId: project.id } }), 1);

  const occurrences = await prisma.searchResultOccurrence.findMany({
    where: { searchRunId: { in: [firstRun.id, secondRun.id] } },
    orderBy: { query: "asc" },
  });
  assert.equal(occurrences.length, 2);
  assert.deepEqual(
    new Set(occurrences.map((occurrence) => occurrence.searchRunId)),
    new Set([firstRun.id, secondRun.id]),
  );
  assert.deepEqual(new Set(occurrences.map((occurrence) => occurrence.query)), new Set([firstQuery, secondQuery]));
  assert.equal(occurrences[0].searchResultId, occurrences[1].searchResultId);
}

async function testConfirmedExpertMergeCombinesTheCompleteRecord(
  prisma: PrismaModule["prisma"],
  supplyFlywheel: SupplyFlywheelModule,
) {
  const project = await createProject(prisma, {
    id: "project-expert-merge",
    title: "专家主档合并验收",
    rawDemand: "验证同一专家的论文记录和机构主页经人工确认后合并为一个项目候选。",
    domain: "肿瘤免疫",
    taskType: "专家评审",
    quantity: 1,
    riskLevel: "regulated",
    searchQueriesJson: "[]",
  });
  const [publicationRun, profileRun] = await Promise.all([
    prisma.supplySearchRun.create({
      data: { projectId: project.id, runType: "external", status: "completed", queriesJson: "[]" },
    }),
    prisma.supplySearchRun.create({
      data: { projectId: project.id, runType: "external", status: "completed", queriesJson: "[]" },
    }),
  ]);
  const primary = await prisma.expert.create({
    data: {
      name: "Merge Expert",
      title: "论文作者",
      affiliation: "Example University",
      sourceUrl: "https://openalex.org/W-MERGE",
      evidenceLevel: "E2",
      domainTagsJson: JSON.stringify(["肿瘤免疫"]),
      languagesJson: JSON.stringify(["English"]),
      consentState: "consented",
    },
  });
  const duplicate = await prisma.expert.create({
    data: {
      name: "Merge Expert",
      title: "Principal Investigator",
      affiliation: "Example University",
      sourceUrl: "https://example.edu/researcher/merge-expert",
      evidenceLevel: "E1",
      domainTagsJson: JSON.stringify(["单细胞"]),
      languagesJson: JSON.stringify(["中文"]),
      consentState: "do_not_contact",
    },
  });
  const primaryCandidate = await prisma.projectCandidate.create({
    data: {
      projectId: project.id,
      expertId: primary.id,
      sourceType: "external",
      sourceRunId: publicationRun.id,
      stage: "verified",
      humanReviewNeeded: false,
    },
  });
  const duplicateCandidate = await prisma.projectCandidate.create({
    data: {
      projectId: project.id,
      expertId: duplicate.id,
      sourceType: "external",
      sourceRunId: profileRun.id,
      stage: "do_not_contact",
      humanReviewNeeded: true,
    },
  });

  const secondProject = await createProject(prisma, {
    id: "project-expert-merge-second",
    title: "跨项目专家主档合并验收",
    rawDemand: "验证没有候选关系冲突的项目也会转移到主专家档案。",
    domain: "肿瘤免疫",
    taskType: "专家评审",
    quantity: 1,
    riskLevel: "regulated",
    searchQueriesJson: "[]",
  });
  const secondProjectCandidate = await prisma.projectCandidate.create({
    data: {
      projectId: secondProject.id,
      expertId: duplicate.id,
      sourceType: "external",
      stage: "sourced",
    },
  });
  await prisma.candidateDiscovery.createMany({
    data: [
      { searchRunId: publicationRun.id, candidateId: primaryCandidate.id, sourceUrl: primary.sourceUrl, evidenceLevel: "E2" },
      { searchRunId: profileRun.id, candidateId: duplicateCandidate.id, sourceUrl: duplicate.sourceUrl, evidenceLevel: "E1" },
    ],
  });
  await prisma.evidenceItem.createMany({
    data: [
      {
        projectId: project.id,
        expertId: primary.id,
        candidateId: primaryCandidate.id,
        claim: "论文作者证据",
        sourceUrl: primary.sourceUrl!,
        sourceType: "openalex_api",
        snippet: "Authors: Merge Expert.",
        evidenceLevel: "E2",
      },
      {
        projectId: project.id,
        expertId: duplicate.id,
        candidateId: duplicateCandidate.id,
        claim: "机构主页证据",
        sourceUrl: duplicate.sourceUrl!,
        sourceType: "institution_profile",
        snippet: "Merge Expert is a principal investigator.",
        evidenceLevel: "E1",
      },
    ],
  });
  await prisma.outreachDraft.create({
    data: { candidateId: duplicateCandidate.id, subject: "Draft", body: "Review only", status: "draft" },
  });
  await prisma.trialTask.create({
    data: { candidateId: duplicateCandidate.id, instructions: "Trial", rubricJson: "{}" },
  });
  await prisma.expertEngagementEvent.create({
    data: { expertId: duplicate.id, projectId: project.id, candidateId: duplicateCandidate.id, eventType: "sourced" },
  });
  const suggestion = await prisma.expertMergeCandidate.create({
    data: {
      primaryExpertId: primary.id,
      duplicateExpertId: duplicate.id,
      reasonJson: JSON.stringify({ reason: "integration test" }),
      confidence: 0.9,
    },
  });

  const resolved = await supplyFlywheel.resolveExpertMergeCandidate({ mergeId: suggestion.id, status: "confirmed" });
  assert.equal(resolved?.status, "confirmed");
  assert.equal(await prisma.expert.findUnique({ where: { id: duplicate.id } }), null, "Duplicate expert must be removed");

  const candidates = await prisma.projectCandidate.findMany({ where: { projectId: project.id } });
  assert.equal(candidates.length, 1, "Same-project candidate relations must be consolidated");
  assert.equal(candidates[0].expertId, primary.id);
  assert.equal(candidates[0].stage, "do_not_contact", "A DNC state must survive an identity merge");
  assert.equal(candidates[0].humanReviewNeeded, true, "A merge must never clear an existing review requirement");
  assert.equal(await prisma.evidenceItem.count({ where: { candidateId: primaryCandidate.id, expertId: primary.id } }), 2);
  assert.equal(await prisma.candidateDiscovery.count({ where: { candidateId: primaryCandidate.id } }), 2);
  assert.equal(await prisma.outreachDraft.count({ where: { candidateId: primaryCandidate.id } }), 1);
  assert.equal(await prisma.trialTask.count({ where: { candidateId: primaryCandidate.id } }), 1);
  assert.equal(
    await prisma.expertEngagementEvent.count({ where: { candidateId: primaryCandidate.id, expertId: primary.id } }),
    1,
  );

  const reassignedCandidate = await prisma.projectCandidate.findUniqueOrThrow({
    where: { id: secondProjectCandidate.id },
  });
  assert.equal(reassignedCandidate.expertId, primary.id, "Non-conflicting project relations must move to the primary expert");

  const mergedExpert = await prisma.expert.findUniqueOrThrow({ where: { id: primary.id } });
  assert.equal(mergedExpert.consentState, "do_not_contact", "The most restrictive consent state must win");
  assert.deepEqual(JSON.parse(mergedExpert.domainTagsJson).sort(), ["单细胞", "肿瘤免疫"].sort());
  assert.deepEqual(JSON.parse(mergedExpert.languagesJson).sort(), ["English", "中文"].sort());

  const repeated = await supplyFlywheel.resolveExpertMergeCandidate({ mergeId: suggestion.id, status: "confirmed" });
  assert.equal(repeated?.status, "confirmed", "Repeating the same merge confirmation must be idempotent");
  assert.equal(await prisma.projectCandidate.count({ where: { projectId: project.id } }), 1);
}

async function testAtomicExecutionClaims(prisma: PrismaModule["prisma"], runtime: AgentRuntimeModule) {
  const project = await createProject(prisma, {
    id: "project-atomic-claim",
    title: "原子执行抢占测试",
    rawDemand: "为 Python 后端代码评审招募 2 位专家，验证同一任务不会被并发执行两次。",
    domain: "Python",
    taskType: "代码评审",
    quantity: 2,
    riskLevel: "medium",
    searchQueriesJson: JSON.stringify(["Python code review expert profile"]),
  });
  const run = await runtime.createAgentTaskRun({
    projectId: project.id,
    intent: "analyze_project",
    instruction: "并发抢占验收：只允许一个执行者获得任务。",
  });
  assert(run);

  const now = new Date("2026-07-16T00:00:00.000Z");
  const claims = await Promise.all(
    Array.from({ length: 8 }, (_, index) => runtime.claimAgentTaskRunExecution(run.id, `claim-${index}`, now)),
  );
  const winners = claims.filter((claim) => claim.claimed);
  assert.equal(winners.length, 1, "Only one concurrent executor may claim a planned run");

  const claimedRun = await prisma.agentTaskRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(claimedRun.status, "running");
  assert.equal(claimedRun.attempt, 1);
  assert.equal(claimedRun.executionToken, winners[0].executionToken);

  const duplicateStart = await runtime.startAgentTaskRun(run.id);
  assert(duplicateStart);
  assert.equal(duplicateStart.status, "running", "A live lease must not be stolen by a duplicate start request");
  assert.equal(
    await prisma.agentTaskStep.count({ where: { runId: run.id, status: "running" } }),
    0,
    "A duplicate start must not execute a pending step",
  );

  const recovered = await runtime.claimAgentTaskRunExecution(
    run.id,
    "recovery-owner",
    new Date("2026-07-16T00:20:00.000Z"),
  );
  assert.equal(recovered.claimed, true, "An expired execution lease must be recoverable");
  const recoveredRun = await prisma.agentTaskRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(recoveredRun.executionToken, "recovery-owner");
  assert.equal(recoveredRun.attempt, 2);

  const cancelled = await runtime.cancelAgentTaskRun(run.id);
  assert(cancelled);
  assert.equal(cancelled.status, "cancelled");
  const releasedRun = await prisma.agentTaskRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(releasedRun.executionToken, null);
  assert.equal(releasedRun.leaseExpiresAt, null);
}

async function prepareIntegrationDatabase() {
  const hasExplicitDatabase = Boolean(process.env.AGENT_INTEGRATION_DATABASE_URL?.trim());
  const optedIntoConfiguredDatabase = process.env.ALLOW_INTEGRATION_DATABASE_WRITES === "1";

  if (hasExplicitDatabase || optedIntoConfiguredDatabase) {
    return {
      databaseUrl: resolveIntegrationDatabaseUrl(),
      stop: async () => undefined,
    };
  }

  const runningLocalDatabase = resolveRunningLocalPostgres();
  if (runningLocalDatabase) {
    console.log("Using the running local PostgreSQL instance with an isolated schema.");
    return {
      databaseUrl: runningLocalDatabase,
      stop: async () => undefined,
    };
  }

  return startEphemeralPostgres();
}

function resolveRunningLocalPostgres() {
  const host = "127.0.0.1";
  const port = "5432";
  const readiness = spawnSync("pg_isready", ["-h", host, "-p", port, "-d", "postgres"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (readiness.status !== 0) return null;

  const identity = spawnSync("psql", ["-h", host, "-p", port, "-d", "postgres", "-Atc", "select current_user"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const username = identity.status === 0 ? identity.stdout.trim() : "";
  if (!username) return null;

  return `postgresql://${encodeURIComponent(username)}@${host}:${port}/postgres?sslmode=disable`;
}

async function startEphemeralPostgres() {
  const binaries = ["initdb", "pg_ctl"];
  for (const binary of binaries) {
    const check = spawnSync(binary, ["--version"], { encoding: "utf8" });
    if (check.status !== 0) {
      throw new Error(
        "Agent integration tests need local PostgreSQL tools or AGENT_INTEGRATION_DATABASE_URL pointing to a disposable PostgreSQL database.",
      );
    }
  }

  const root = mkdtempSync(join(tmpdir(), "expert-agent-postgres-"));
  const dataDir = join(root, "data");
  const socketDir = join(root, "socket");
  const logPath = join(root, "postgres.log");
  mkdirSync(socketDir, { recursive: true });
  const port = await reserveLocalPort();

  try {
    runPostgresCommand("initdb", ["-D", dataDir, "-A", "trust", "-U", "agent_test", "--no-locale", "--encoding=UTF8"]);
    runPostgresCommand("pg_ctl", [
      "-D",
      dataDir,
      "-l",
      logPath,
      "-o",
      `-F -p ${port} -h 127.0.0.1 -k ${socketDir}`,
      "-w",
      "start",
    ]);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  console.log("Using an isolated local PostgreSQL instance for Agent integration tests.");
  return {
    databaseUrl: `postgresql://agent_test@127.0.0.1:${port}/postgres?sslmode=disable`,
    stop: async () => {
      try {
        runPostgresCommand("pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function reserveLocalPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("Unable to reserve a local PostgreSQL port."));
      });
    });
  });
}

function runPostgresCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.status === 0) return;
  const detail = (result.stderr || result.stdout || result.error?.message || "unknown error").trim();
  throw new Error(`${command} failed: ${detail}`);
}

function prepareIntegrationSchema() {
  const prismaBinary = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");
  const result = spawnSync(prismaBinary, ["db", "push", "--skip-generate"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });

  if (result.status === 0) return;

  const detail = redactDatabaseCredentials(result.stderr || result.stdout || result.error?.message || "unknown error");
  throw new Error(`Unable to prepare the isolated PostgreSQL integration schema. ${detail.trim()}`);
}

function redactDatabaseCredentials(value: string) {
  return value.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://[redacted]@");
}

async function testInternalMatchWritesReviewableCandidates(prisma: PrismaModule["prisma"], runtime: AgentRuntimeModule) {
  const project = await createProject(prisma, {
    id: "project-python",
    title: "Python 后端代码评审专家招募",
    rawDemand: "为 Python 后端代码评审任务招募 12 位专家，要求熟悉 FastAPI、Django、数据库设计和代码质量评审。",
    domain: "Python",
    taskType: "代码评审",
    quantity: 12,
    riskLevel: "medium",
    searchQueriesJson: JSON.stringify(["Python FastAPI Django code review expert"]),
  });

  await prisma.expert.create({
    data: {
      id: "expert-python-internal",
      name: "林澈",
      title: "资深 Python 后端工程师",
      affiliation: "内部专家库",
      sourceUrl: "https://internal.example.com/experts/python-lin",
      domainTagsJson: JSON.stringify(["Python", "FastAPI", "Django", "代码评审"]),
      languagesJson: JSON.stringify(["中文"]),
      contactJson: JSON.stringify({ contactPermissionBasis: "referral_consent", profileAllowsOutreach: true }),
      evidenceLevel: "E3",
      consentState: "consented",
      expertType: "internal",
      lastActiveAt: new Date("2026-06-20T08:00:00.000Z"),
    },
  });

  await prisma.expert.create({
    data: {
      id: "expert-dnc-internal",
      name: "周宁",
      title: "Python 代码审查专家",
      affiliation: "内部专家库",
      sourceUrl: "https://internal.example.com/experts/python-dnc",
      domainTagsJson: JSON.stringify(["Python", "代码评审"]),
      languagesJson: JSON.stringify(["中文"]),
      contactJson: JSON.stringify({ contactPermissionBasis: "direct_consent" }),
      evidenceLevel: "E4",
      consentState: "do_not_contact",
      expertType: "internal",
    },
  });

  await prisma.expertSignal.create({
    data: {
      expertId: "expert-python-internal",
      type: "skill",
      value: "FastAPI",
      source: "internal_profile",
      evidenceLevel: "E3",
      confidence: 0.9,
    },
  });

  await prisma.expertQualityMetric.create({
    data: {
      expertId: "expert-python-internal",
      projectId: project.id,
      metricType: "trial_score",
      score: 92,
      source: "historical_project",
    },
  });

  const run = await runtime.createAgentTaskRun({
    projectId: project.id,
    intent: "internal_match",
    instruction: "召回内部 Python 后端代码评审专家",
  });
  assert(run, "internal_match run should be created");
  assert.equal(run.status, "planned");

  const completed = await runtime.startAgentTaskRun(run.id);
  assert(completed, "internal_match run should complete");
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.steps.find((step) => step.stepKey === "internal_match")?.status, "succeeded");

  const candidates = await prisma.projectCandidate.findMany({ where: { projectId: project.id }, include: { expert: true } });
  assert.equal(candidates.length, 1, "DNC expert must not be recalled into the candidate pool");
  assert.equal(candidates[0].expertId, "expert-python-internal");
  assert.equal(candidates[0].sourceType, "internal");
  assert.notEqual(candidates[0].fitScore, null);

  const secondRun = await runtime.createAgentTaskRun({
    projectId: project.id,
    intent: "internal_match",
    instruction: "再次召回内部 Python 专家，验证候选不重复",
  });
  assert(secondRun);
  await runtime.startAgentTaskRun(secondRun.id);
  const candidateCountAfterRerun = await prisma.projectCandidate.count({ where: { projectId: project.id } });
  assert.equal(candidateCountAfterRerun, 1, "Repeated internal matching must not duplicate core candidates");
}

async function testExternalResearchUsesApprovedPlanAndCreatesReviewOnlyLeads(
  prisma: PrismaModule["prisma"],
  runtime: AgentRuntimeModule,
  gates: GatesModule,
  sourcing: SourcingModule,
) {
  const project = await createProject(prisma, {
    id: "project-external",
    title: "开源安全代码审计专家招募",
    rawDemand: "为开源安全代码审计项目招募 Python 和 Rust 专家，需要公开项目经历和安全审计经验。",
    domain: "软件安全",
    taskType: "代码审计",
    quantity: 8,
    riskLevel: "medium",
    searchQueriesJson: JSON.stringify(["Python Rust security audit expert public profile"]),
    personaJson: JSON.stringify({
      summary: "开源安全代码审计专家",
      taskFitSignals: ["GitHub 仓库中有 FastAPI 或 Django 的近期维护和代码评审记录"],
      evidenceRequirements: ["提供可核验的漏洞修复 PR、提交或代码评审记录"],
    }),
  });

  const run = await runtime.createAgentTaskRun({
    projectId: project.id,
    intent: "external_research",
    instruction: "补充公开个人主页和机构团队成员，优先核验近期活跃情况。",
  });
  assert(run);

  const waiting = await runtime.startAgentTaskRun(run.id);
  assert(waiting);
  assert.equal(waiting.status, "waiting_for_confirmation");
  const confirmation = waiting.steps.find((step) => step.stepKey === "confirm_external_search");
  assert.equal(confirmation?.status, "blocked");
  assert.equal(confirmation?.requiresConfirmation, true);
  assert.equal(confirmation?.confirmedAt, null);
  const uncachedQueries = confirmation?.checks.uncached;
  if (typeof uncachedQueries !== "number") throw new Error("External search confirmation should include uncached query count");
  assert(uncachedQueries > 0, "External search confirmation should show uncached query count");
  const queryPreview = confirmation?.checks.queryPreview;
  if (!Array.isArray(queryPreview) || !queryPreview.every((query) => typeof query === "string")) {
    throw new Error("External search confirmation should include the exact query plan");
  }
  assert(queryPreview.length > 0, "External search confirmation should include at least one query");
  assert(
    queryPreview.some((query) => /github/i.test(query)),
    "Project hard-evidence requirements must remain in the approved plan even when the operator does not repeat them",
  );
  assert(
    queryPreview.some((query) => /institution|team member/i.test(query)),
    "The operator's requested institution direction must remain in the approved plan",
  );
  const githubQueryIndex = queryPreview.findIndex((query) => /github/i.test(query));
  const staleProfileUrl = "https://github.com/legacy-security-reviewer";

  const staleExpert = await prisma.expert.create({
    data: {
      id: "expert-stale-rediscovery",
      name: "Legacy Security Reviewer",
      title: "历史开源贡献者",
      sourceUrl: staleProfileUrl,
      evidenceLevel: "E2",
      expertType: "external",
    },
  });
  const staleCandidate = await prisma.projectCandidate.create({
    data: {
      id: "candidate-stale-rediscovery",
      projectId: project.id,
      expertId: staleExpert.id,
      stage: "sourced",
      sourceType: "external",
      humanReviewNeeded: true,
      nextAction: "人工复核公开贡献后决定是否推进。",
    },
  });

  assert.equal(await prisma.supplySearchRun.count({ where: { projectId: project.id } }), 0);
  assert.equal(await prisma.searchResult.count({ where: { projectId: project.id } }), 0);
  assert.equal(
    await prisma.projectCandidate.count({ where: { projectId: project.id, sourceType: "external" } }),
    1,
    "No new external candidate may be created before confirmation",
  );
  assert.equal(
    await prisma.agentToolReceipt.count({ where: { runId: run.id } }),
    0,
    "No public-search tool receipt may exist before the query plan is confirmed",
  );

  await prisma.searchCache.createMany({
    data: queryPreview.map((query, index) => {
      const names = ["Ada Lovelace", "Grace Hopper", "Margaret Hamilton", "Edsger Dijkstra"];
      const name = names[index] ?? `Security Expert ${index + 1}`;
      const github = /github/i.test(query);
      return {
        query,
        provider: github ? sourcing.SEARCH_CACHE_PROVIDERS.githubMaintainers : "integration_fixture",
        resultsJson: JSON.stringify([
          {
            title: `${name}${github ? " GitHub profile" : " expert profile"}`,
            url: github ? "https://github.com/ada-security-review" : `https://experts.example.com/security-${index}`,
            snippet: github
              ? `Open-source Rust security maintainer. Repository evidence: 120 contributions to rust-lang/rust (100000 stars). Recent public activity: ${new Date().toISOString()}.`
              : `${name} is a named Python and Rust security audit expert with a public profile for this source direction.`,
            domain: github ? "github.com" : "experts.example.com",
            position: 1,
          },
          ...(index === githubQueryIndex
            ? [
                {
                  title: "Legacy Security Reviewer GitHub profile",
                  url: staleProfileUrl,
                  snippet:
                    "Repository evidence: 400 contributions to rust-lang/rust (100000 stars). Profile updated: 2021-01-01T00:00:00Z.",
                  domain: "github.com",
                  position: 2,
                },
              ]
            : []),
        ]),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };
    }),
  });

  const completed = await runtime.confirmAgentTaskRun(run.id);
  assert(completed, "Confirmed external research run should complete from cached results");
  assert.equal(
    completed.status,
    "partially_succeeded",
    "Review-only leads must remain visible without reporting a quality-gate pass",
  );

  const confirmedStep = completed.steps.find((step) => step.stepKey === "confirm_external_search");
  assert.deepEqual(confirmedStep?.output.approvedQueries, queryPreview, "Confirmation must freeze the approved query plan");

  const searchRun = await prisma.supplySearchRun.findFirstOrThrow({
    where: { projectId: project.id, runType: "external" },
    orderBy: { createdAt: "desc" },
  });
  assert.deepEqual(JSON.parse(searchRun.queriesJson), queryPreview, "Execution must use exactly the approved queries");
  assert.equal(searchRun.status, "quality_failed");
  assert.equal(
    await prisma.searchResultOccurrence.count({ where: { searchRunId: searchRun.id } }),
    queryPreview.length + 1,
    "Each query result occurrence must remain attached to this exact search run",
  );

  const screenedOutCandidate = await prisma.projectCandidate.findUniqueOrThrow({ where: { id: staleCandidate.id } });
  assert.equal(screenedOutCandidate.stage, "screened_out");
  assert.equal(screenedOutCandidate.humanReviewNeeded, false);
  assert.match(screenedOutCandidate.nextAction ?? "", /暂不推进/);

  const candidate = await prisma.projectCandidate.findFirstOrThrow({
    where: { projectId: project.id, sourceType: "external", expert: { name: "Ada Lovelace" } },
    include: { expert: true },
  });
  assert.equal(candidate.expert.name, "Ada Lovelace");
  assert.equal(candidate.expert.evidenceLevel, "E2");
  assert.equal(candidate.humanReviewNeeded, true);
  assert.equal(candidate.stage, "sourced");
  assert.equal(gates.canApproveForOutreach({ project, candidate, expert: candidate.expert }).ok, false);

  const researchStep = completed.steps.find((step) => step.stepKey === "external_research");
  assert.equal(researchStep?.status, "failed");
  assert.equal(
    researchStep?.toolReceipts.length,
    queryPreview.length,
    "The task response must expose user-safe execution receipts for every approved query",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(researchStep?.toolReceipts[0] ?? {}, "argumentDigest"),
    false,
    "Internal argument digests must not be exposed to the operator UI",
  );
  assert.equal(typeof researchStep?.output.candidates, "number");
  assert(Number(researchStep?.output.candidates) >= 1);
  assert.equal(researchStep?.output.autoScreenedOut, 1);
  assert(Array.isArray(researchStep?.output.candidatePreview));
  assert(Array.isArray(researchStep?.output.searchResultPreview));
  const acceptance = researchStep?.output.acceptance;
  const blockers =
    acceptance && typeof acceptance === "object" && !Array.isArray(acceptance)
      ? (acceptance as { blockers?: unknown }).blockers
      : null;
  assert(
    Array.isArray(blockers) && blockers.length > 0,
    "A partial search run must explain which quality gates remain unmet",
  );
  assert.equal(await prisma.auditEvent.count({ where: { projectId: project.id, action: "ai.extract_candidates.fallback" } }), 1);

  const toolReceipts = await prisma.agentToolReceipt.findMany({
    where: { runId: run.id, stepId: researchStep?.id },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(toolReceipts.length, queryPreview.length, "Every approved query must have one durable tool receipt");
  for (const receipt of toolReceipts) {
    assert.equal(receipt.toolName, "public_search");
    assert.equal(receipt.approvalId, confirmation?.id);
    assert.equal(receipt.idempotencyClass, "read_only");
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.provider, "cache");
    assert.equal(receipt.attempt, 1);
    assert.equal(typeof receipt.durationMs, "number");
    assert.match(receipt.argumentDigest, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(receipt.resultSummaryJson, /api.?key|secret-value/i);
  }
}

async function testLegacyRoutesCreateAgentRunsOnly(prisma: PrismaModule["prisma"]) {
  await prisma.expert.create({
    data: {
      id: "expert-route-internal",
      name: "路线测试专家",
      sourceUrl: "https://internal.example.com/experts/route",
      domainTagsJson: JSON.stringify(["Python"]),
      languagesJson: JSON.stringify(["中文"]),
      contactJson: JSON.stringify({ contactPermissionBasis: "direct_consent" }),
      evidenceLevel: "E3",
      consentState: "consented",
      expertType: "internal",
    },
  });

  const project = await createProject(prisma, {
    id: "project-legacy-route",
    title: "旧入口收口验证",
    rawDemand: "为 Python 后端代码审计项目招募 10 位专家，需要内部召回和公开候选补充。",
    domain: "Python",
    taskType: "代码审计",
    quantity: 10,
    riskLevel: "medium",
    searchQueriesJson: JSON.stringify(["Python code audit expert public profile"]),
    personaJson: JSON.stringify({ summary: "代码审计专家" }),
  });

  const externalRoute = await import("../src/app/api/projects/[id]/external-research/route");
  const runRoute = await import("../src/app/api/projects/[id]/run/route");

  const externalResponse = await externalRoute.POST(new Request("http://localhost/api/projects/x/external-research", { method: "POST" }), {
    params: Promise.resolve({ id: project.id }),
  });
  assert.equal(externalResponse.status, 202);
  const externalJson = (await externalResponse.json()) as { data: { run: { intent: string; status: string } } };
  assert.equal(externalJson.data.run.intent, "external_research");
  assert.equal(externalJson.data.run.status, "waiting_for_confirmation");

  const runResponse = await runRoute.POST(new Request("http://localhost/api/projects/x/run", { method: "POST" }), {
    params: Promise.resolve({ id: project.id }),
  });
  assert.equal(runResponse.status, 202);
  const runJson = (await runResponse.json()) as { data: { run: { intent: string; status: string } } };
  assert.equal(runJson.data.run.intent, "full_sourcing");
  assert.equal(runJson.data.run.status, "planned");

  assert.equal(await prisma.supplySearchRun.count({ where: { projectId: project.id, runType: "external" } }), 0);
  assert.equal(await prisma.searchResult.count({ where: { projectId: project.id } }), 0);
}

async function seedIntegrationSearchCache(
  prisma: PrismaModule["prisma"],
  queries: string[],
  sourcing: SourcingModule,
) {
  await prisma.searchCache.createMany({
    data: queries.map((query, index) => {
      const publicationQuery = /paper\s*author|publication\s*author|论文\s*作者|scholar\s*author|orcid/i.test(query);
      const githubQuery = /github/i.test(query);
      const result = publicationQuery
        ? {
            title: `Python Security Review Study ${index + 1}`,
            url: `https://openalex.org/W-RETRY-${index + 1}`,
            snippet: "Authors: Retry Expert (Example Security University). DOI: 10.1000/retry. Python security code review research.",
            domain: "openalex.org",
            position: 1,
          }
        : githubQuery
          ? {
              title: `Retry Expert ${index + 1} GitHub profile`,
              url: `https://github.com/retry-security-expert-${index + 1}`,
              snippet: "Python security maintainer. Repository evidence: 42 contributions to example/security-review (12000 stars). Recent public activity: 2026-07-15.",
              domain: "github.com",
              position: 1,
            }
          : {
              title: `Dr. Retry Expert ${index + 1}`,
              url: `https://security.example.edu/people/retry-expert-${index + 1}`,
              snippet: `Dr. Retry Expert ${index + 1} is a Python security code review researcher with a public institution profile.`,
              domain: "security.example.edu",
              position: 1,
            };
      return {
        query,
        provider: publicationQuery
          ? sourcing.SEARCH_CACHE_PROVIDERS.openAlexWorks
          : githubQuery
            ? sourcing.SEARCH_CACHE_PROVIDERS.githubMaintainers
            : "integration_fixture",
        resultsJson: JSON.stringify([result]),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };
    }),
  });
}

async function createProject(
  prisma: PrismaModule["prisma"],
  data: {
    id: string;
    title: string;
    rawDemand: string;
    domain: string;
    taskType: string;
    quantity: number;
    riskLevel: string;
    searchQueriesJson: string;
    personaJson?: string;
  },
) {
  return prisma.project.create({
    data: {
      id: data.id,
      title: data.title,
      rawDemand: data.rawDemand,
      domain: data.domain,
      taskType: data.taskType,
      quantity: data.quantity,
      languagesJson: JSON.stringify(["中文"]),
      regionsJson: JSON.stringify(["中国"]),
      riskLevel: data.riskLevel,
      status: "analyzed",
      personaJson: data.personaJson ?? JSON.stringify({ summary: data.title }),
      searchQueriesJson: data.searchQueriesJson,
    },
  });
}

main()
  .then(() => {
    console.log("PASS agent runtime integration");
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  });

export {};
