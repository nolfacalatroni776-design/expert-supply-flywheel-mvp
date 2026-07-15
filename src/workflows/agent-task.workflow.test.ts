import { afterAll, describe, expect, it } from "vitest";
import { resumeHook, start } from "workflow/api";
import { waitForHook } from "@workflow/vitest";
import { prisma } from "@/lib/prisma";
import {
  buildAgentApprovalHookToken,
  buildAgentWorkflowHookToken,
} from "@/lib/agent-workflow-contract";
import { cancelAgentTaskRun, createAgentTaskRun, getAgentTaskRun, prepareAgentTaskRunRetry } from "@/lib/agent-runtime";
import {
  cancelDurableAgentTaskWorkflow,
  resumeAgentTaskWorkflow,
  startDurableAgentTaskWorkflow,
} from "@/lib/agent-workflow-runtime";
import { executeAgentTaskWorkflow } from "@/workflows/agent-task";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("durable Agent task workflow", () => {
  it("deduplicates owners and resumes a rejected search without calling a provider", async () => {
    const project = await prisma.project.create({
      data: {
        id: "workflow-project-rejection",
        title: "Workflow 外部搜索审批验收",
        rawDemand: "为 Python 安全评审招募专家，公开搜索前必须审批。",
        domain: "Python 安全",
        taskType: "代码评审",
        quantity: 3,
        languagesJson: JSON.stringify(["中文"]),
        regionsJson: JSON.stringify(["中国"]),
        riskLevel: "high",
        status: "analyzed",
        personaJson: JSON.stringify({ summary: "Python 安全评审专家" }),
        searchQueriesJson: JSON.stringify(["Python security reviewer institution profile"]),
      },
    });
    const task = await createAgentTaskRun({
      projectId: project.id,
      intent: "external_research",
      instruction: "先展示搜索范围，确认后再调用公开搜索。",
    });
    expect(task).not.toBeNull();

    const owner = await start(executeAgentTaskWorkflow, [task!.id]);
    await waitForHook(owner, { token: buildAgentWorkflowHookToken(task!.id) });
    const duplicate = await start(executeAgentTaskWorkflow, [task!.id]);
    await expect(duplicate.returnValue).resolves.toMatchObject({
      runId: task!.id,
      status: "deduplicated",
      ownerWorkflowRunId: owner.runId,
    });

    await waitForStatus(task!.id, "waiting_for_confirmation");
    const waiting = await getAgentTaskRun(task!.id);
    const approvalStep = waiting?.steps.find(
      (step) => step.requiresConfirmation && !step.confirmedAt && step.status === "blocked",
    );
    expect(approvalStep?.id).toBeTruthy();
    expect(await prisma.agentToolReceipt.count({ where: { runId: task!.id } })).toBe(0);

    const approvalToken = buildAgentApprovalHookToken(task!.id, approvalStep!.id);
    await waitForHook(owner, { token: approvalToken });
    await resumeHook(approvalToken, {
      action: "reject",
      stepId: approvalStep!.id,
      reason: "机构范围太宽，请重新规划。",
    });

    await expect(owner.returnValue).resolves.toMatchObject({
      runId: task!.id,
      status: "partially_succeeded",
      kind: "terminal",
    });
    const rejected = await prisma.agentTaskStep.findUniqueOrThrow({ where: { id: approvalStep!.id } });
    expect(rejected.confirmationDecision).toBe("rejected");
    expect(rejected.confirmationReason).toBe("机构范围太宽，请重新规划。");
    expect(await prisma.agentToolReceipt.count({ where: { runId: task!.id } })).toBe(0);
    expect(await prisma.searchResult.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.projectCandidate.count({ where: { projectId: project.id } })).toBe(0);

    const retry = await prepareAgentTaskRunRetry(task!.id);
    expect(retry?.status).toBe("partially_succeeded");
    expect(retry?.steps.find((step) => step.id === approvalStep!.id)).toMatchObject({
      status: "blocked",
      confirmationDecision: "rejected",
      confirmationReason: "机构范围太宽，请重新规划。",
    });
  });

  it("resumes an approved cached search exactly once and keeps duplicate decisions idempotent", async () => {
    const project = await prisma.project.create({
      data: {
        id: "workflow-project-approval",
        title: "Workflow 缓存搜索审批验收",
        rawDemand: "为 Python 安全代码评审招募公开履历可核验的专家，所有搜索必须先审批。",
        domain: "Python 安全",
        taskType: "代码评审",
        quantity: 2,
        languagesJson: JSON.stringify(["中文", "英文"]),
        regionsJson: JSON.stringify(["远程"]),
        riskLevel: "high",
        status: "analyzed",
        personaJson: JSON.stringify({
          summary: "Python 安全代码评审专家",
          mustHave: ["Python 安全评审经验"],
          evidenceRequirements: ["公开机构主页或会议讲者资料"],
        }),
        searchQueriesJson: JSON.stringify(["Python security code review conference speaker"]),
      },
    });
    const task = await createAgentTaskRun({
      projectId: project.id,
      intent: "external_research",
      instruction: "先展示每条公开搜索，再在批准后复用缓存完成候选发现。",
    });
    expect(task).not.toBeNull();

    const owner = await start(executeAgentTaskWorkflow, [task!.id]);
    await waitForHook(owner, { token: buildAgentWorkflowHookToken(task!.id) });
    const waiting = await waitForStatus(task!.id, "waiting_for_confirmation");
    const approvalStep = waiting.steps.find(
      (step) => step.requiresConfirmation && !step.confirmedAt && step.status === "blocked",
    );
    expect(approvalStep?.id).toBeTruthy();
    const queryPreview = Array.isArray(approvalStep?.checks.queryPreview)
      ? approvalStep.checks.queryPreview.filter((query): query is string => typeof query === "string" && Boolean(query.trim()))
      : [];
    expect(queryPreview.length).toBeGreaterThan(0);
    await seedApprovedSearchCache(queryPreview);

    const approvalToken = buildAgentApprovalHookToken(task!.id, approvalStep!.id);
    await waitForHook(owner, { token: approvalToken });
    await resumeHook(approvalToken, {
      action: "approve",
      stepId: approvalStep!.id,
      reason: "查询范围和公开来源已核对。",
    });

    const terminal = await owner.returnValue;
    expect(terminal).toMatchObject({ runId: task!.id, kind: "terminal" });
    const completed = await getAgentTaskRun(task!.id);
    expect(["succeeded", "partially_succeeded"]).toContain(completed?.status);
    const receipts = await prisma.agentToolReceipt.findMany({ where: { runId: task!.id } });
    expect(receipts).toHaveLength(queryPreview.length);
    expect(receipts.every((receipt) => receipt.status === "succeeded" && receipt.provider === "cache")).toBe(true);
    expect(receipts.every((receipt) => receipt.attempt === 1)).toBe(true);
    expect(await prisma.searchResult.count({ where: { projectId: project.id } })).toBeGreaterThan(0);
    expect(await prisma.projectCandidate.count({ where: { projectId: project.id } })).toBeGreaterThan(0);

    const countsBeforeDuplicate = await workflowWriteCounts(task!.id, project.id);
    const duplicateDecision = await resumeAgentTaskWorkflow(task!.id, {
      action: "approve",
      stepId: approvalStep!.id,
      reason: "重复提交不应再次执行。",
    });
    expect(duplicateDecision?.status).toBe(completed?.status);
    await startDurableAgentTaskWorkflow(task!.id);
    expect(await workflowWriteCounts(task!.id, project.id)).toEqual(countsBeforeDuplicate);
  });

  it("cancels a workflow waiting for approval without executing its search", async () => {
    const project = await prisma.project.create({
      data: {
        id: "workflow-project-cancel",
        title: "Workflow 取消验收",
        rawDemand: "为 Python 安全评审招募专家，等待搜索审批时允许运营取消任务。",
        domain: "Python 安全",
        taskType: "代码评审",
        quantity: 2,
        languagesJson: JSON.stringify(["中文"]),
        regionsJson: JSON.stringify(["远程"]),
        riskLevel: "high",
        status: "analyzed",
        personaJson: JSON.stringify({ summary: "Python 安全评审专家" }),
        searchQueriesJson: JSON.stringify(["Python security reviewer public profile"]),
      },
    });
    const task = await createAgentTaskRun({
      projectId: project.id,
      intent: "external_research",
      instruction: "展示搜索范围后等待审批，运营可以在调用前取消。",
    });
    expect(task).not.toBeNull();

    const owner = await start(executeAgentTaskWorkflow, [task!.id]);
    await waitForHook(owner, { token: buildAgentWorkflowHookToken(task!.id) });
    await waitForStatus(task!.id, "waiting_for_confirmation");

    const cancelled = await cancelAgentTaskRun(task!.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(await cancelDurableAgentTaskWorkflow(task!.id)).toBe(true);
    await owner.returnValue.catch(() => null);

    const persisted = await getAgentTaskRun(task!.id);
    expect(persisted?.status).toBe("cancelled");
    expect(await prisma.agentToolReceipt.count({ where: { runId: task!.id } })).toBe(0);
    expect(await prisma.searchResult.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.projectCandidate.count({ where: { projectId: project.id } })).toBe(0);
  });
});

async function waitForStatus(runId: string, expectedStatus: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = await getAgentTaskRun(runId);
    if (run?.status === expectedStatus) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Agent task did not reach ${expectedStatus}.`);
}

async function seedApprovedSearchCache(queries: string[]) {
  for (const [index, query] of queries.entries()) {
    const publicationQuery = /paper\s*author|publication\s*author|论文\s*作者|scholar\s*author|orcid/i.test(query);
    const result = publicationQuery
      ? {
          title: `Python Security Review Study ${index + 1}`,
          url: `https://openalex.org/W-WORKFLOW-${index + 1}`,
          snippet: "Authors: Ada Review (Example Security University). DOI: 10.1000/workflow. Python security code review research.",
          domain: "openalex.org",
          position: 1,
        }
      : {
          title: "Dr. Ada Review",
          url: `https://security.example.edu/people/ada-review-${index + 1}`,
          snippet: "Dr. Ada Review is a Python security code review researcher and public conference speaker.",
          domain: "security.example.edu",
          position: 1,
        };
    await prisma.searchCache.upsert({
      where: { query },
      update: {
        provider: publicationQuery ? "openalex_works_v3" : "serper",
        resultsJson: JSON.stringify([result]),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      create: {
        query,
        provider: publicationQuery ? "openalex_works_v3" : "serper",
        resultsJson: JSON.stringify([result]),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }
}

async function workflowWriteCounts(runId: string, projectId: string) {
  return {
    receipts: await prisma.agentToolReceipt.count({ where: { runId } }),
    attempts: await prisma.agentToolReceipt.aggregate({ where: { runId }, _sum: { attempt: true } }),
    searchResults: await prisma.searchResult.count({ where: { projectId } }),
    candidates: await prisma.projectCandidate.count({ where: { projectId } }),
    discoveries: await prisma.candidateDiscovery.count({ where: { searchRun: { projectId } } }),
  };
}
