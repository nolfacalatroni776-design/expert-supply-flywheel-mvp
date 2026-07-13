import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const tmpRoot = mkdtempSync(join(tmpdir(), "expert-agent-runtime-"));
const dbPath = join(tmpRoot, "agent-runtime.db");

process.env.DATABASE_URL = `file:${dbPath}`;
process.env.ENABLE_RUNTIME_DB_INIT = "1";
process.env.SEARCH_FALLBACK_PROVIDERS = "";

type PrismaModule = typeof import("../src/lib/prisma");
type AgentRuntimeModule = typeof import("../src/lib/agent-runtime");

async function main() {
  const { prisma } = (await import("../src/lib/prisma")) as PrismaModule;
  const runtime = (await import("../src/lib/agent-runtime")) as AgentRuntimeModule;

  try {
    await testInternalMatchWritesReviewableCandidates(prisma, runtime);
    await testExternalResearchWaitsForConfirmation(prisma, runtime);
    await testLegacyRoutesCreateAgentRunsOnly(prisma);
  } finally {
    await prisma.$disconnect();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
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

async function testExternalResearchWaitsForConfirmation(prisma: PrismaModule["prisma"], runtime: AgentRuntimeModule) {
  const project = await createProject(prisma, {
    id: "project-external",
    title: "开源安全代码审计专家招募",
    rawDemand: "为开源安全代码审计项目招募 Python 和 Rust 专家，需要公开项目经历和安全审计经验。",
    domain: "软件安全",
    taskType: "代码审计",
    quantity: 8,
    riskLevel: "medium",
    searchQueriesJson: JSON.stringify(["Python Rust security audit expert public profile"]),
  });

  const run = await runtime.createAgentTaskRun({
    projectId: project.id,
    intent: "external_research",
    instruction: "补充公开候选",
  });
  assert(run);

  const waiting = await runtime.startAgentTaskRun(run.id);
  assert(waiting);
  assert.equal(waiting.status, "waiting_for_confirmation");
  const confirmation = waiting.steps.find((step) => step.stepKey === "confirm_external_search");
  assert.equal(confirmation?.status, "blocked");
  assert.equal(confirmation?.requiresConfirmation, true);
  assert.equal(confirmation?.confirmedAt, null);
  assert.equal(confirmation?.checks.uncached, 1);

  assert.equal(await prisma.supplySearchRun.count({ where: { projectId: project.id } }), 0);
  assert.equal(await prisma.searchResult.count({ where: { projectId: project.id } }), 0);
  assert.equal(await prisma.projectCandidate.count({ where: { projectId: project.id, sourceType: "external" } }), 0);

  const cancelled = await runtime.cancelAgentTaskRun(run.id);
  assert(cancelled);
  assert.equal(cancelled.status, "cancelled");
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
  assert.equal(externalJson.data.run.status, "planned");

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
    rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(1);
  });

export {};
