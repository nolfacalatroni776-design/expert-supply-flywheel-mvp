import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readRoute(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("agent API boundaries", () => {
  it("keeps legacy full-run API behind the AgentTaskRun workflow", () => {
    const source = readRoute("src/app/api/projects/[id]/run/route.ts");
    expect(source).toContain("createAgentTaskRun");
    expect(source).toContain('intent: "full_sourcing"');
    expect(source).not.toContain("sourceProjectCandidates");
    expect(source).not.toContain("scoreCandidateFit");
  });

  it("keeps external research API behind explicit agent confirmation", () => {
    const source = readRoute("src/app/api/projects/[id]/external-research/route.ts");
    expect(source).toContain("createAgentTaskRun");
    expect(source).toContain('intent: "external_research"');
    expect(source).not.toContain("runExternalResearch");
    expect(source).not.toContain("sourceProjectCandidates");
  });

  it("keeps legacy candidate search API behind explicit agent confirmation", () => {
    const source = readRoute("src/app/api/projects/[id]/search/route.ts");
    expect(source).toContain("createAgentTaskRun");
    expect(source).toContain('intent: "search_candidates"');
    expect(source).not.toContain("sourceProjectCandidates");
    expect(source).not.toContain("serializeSearchResult");
    expect(source).not.toContain("writeAuditEvent");
  });

  it("hydrates the latest persisted Agent task back into the conversation", () => {
    const page = readRoute("src/app/page.tsx");
    const form = readRoute("src/components/agent-command-form.tsx");

    expect(page).toContain("serializeAgentRun");
    expect(page).toContain("initialRun=");
    expect(form).toContain("initialRun?: AgentRun | null");
    expect(form).toContain("useState<AgentRun | null>(initialRun ?? null)");
  });

  it("hydrates persisted task history in the project-header assistant drawer", () => {
    const page = readRoute("src/app/page.tsx");
    const drawer = page.match(/function AgentDrawer[\s\S]*?\n}\n\nfunction ProjectSwitcher/)?.[0] ?? "";

    expect(drawer).toContain("initialRun=");
    expect(drawer).toContain("initialRuns=");
    expect(drawer).toContain("serializeAgentRun");
  });

  it("normalizes persisted step and candidate guidance before rendering it", () => {
    const form = readRoute("src/components/agent-command-form.tsx");

    expect(form).toContain("normalizeAgentUserFacingText");
    expect(form).toContain("normalizeAgentUserFacingText(candidate.nextAction)");
    expect(form).toContain("values.map(normalizeAgentUserFacingText)");
  });

  it("applies the effective review gate before normalizing candidate scoring guidance", () => {
    const route = readRoute("src/app/api/project-candidates/[id]/score/route.ts");
    const reviewGatePosition = route.indexOf("const humanReviewNeeded");
    const scoreNormalizationPosition = route.indexOf("const score = normalizeCandidateScore");

    expect(reviewGatePosition).toBeGreaterThan(-1);
    expect(reviewGatePosition).toBeLessThan(scoreNormalizationPosition);
    expect(route).toContain("humanReviewNeeded,");
  });

  it("lets operators restore a recent search task without adding a second task list", () => {
    const page = readRoute("src/app/page.tsx");
    const form = readRoute("src/components/agent-command-form.tsx");

    expect(page).toContain("initialRuns=");
    expect(form).toContain("initialRuns?: AgentRun[]");
    expect(form).toContain('aria-label="查看最近任务"');
  });

  it("keeps execution leases server-side and atomically claims a run", () => {
    const runtime = readRoute("src/lib/agent-runtime.ts");

    expect(runtime).toContain("claimAgentTaskRunExecution");
    expect(runtime).toContain("prisma.agentTaskRun.updateMany");
    expect(runtime).toContain("executionToken");
    expect(runtime).toContain("leaseExpiresAt");
    expect(runtime).toContain("delete safeRun.executionToken");
  });

  it("starts and resumes Agent tasks through the durable workflow boundary", () => {
    const startRoute = readRoute("src/app/api/agent-runs/[id]/start/route.ts");
    const confirmRoute = readRoute("src/app/api/agent-runs/[id]/confirm/route.ts");

    expect(startRoute).toContain("startDurableAgentTaskWorkflow");
    expect(startRoute).not.toContain("startAgentTaskRun");
    expect(startRoute).not.toContain("maxDuration");
    expect(confirmRoute).toContain("resumeAgentTaskWorkflow");
    expect(confirmRoute).not.toContain("confirmAgentTaskRun");
  });

  it("cancels both the durable workflow and the persisted Agent task", () => {
    const cancelRoute = readRoute("src/app/api/agent-runs/[id]/cancel/route.ts");

    expect(cancelRoute).toContain("cancelDurableAgentTaskWorkflow");
    expect(cancelRoute).toContain("cancelAgentTaskRun");
  });

  it("prepares a retry before starting a fresh durable workflow owner", () => {
    const retryRoute = readRoute("src/app/api/agent-runs/[id]/retry/route.ts");

    expect(retryRoute).toContain("prepareAgentTaskRunRetry");
    expect(retryRoute).toContain("startDurableAgentTaskWorkflow");
    expect(retryRoute).not.toContain("retryAgentTaskRun");
  });

  it("enables Workflow SDK without sending internal workflow traffic through trial authentication", () => {
    const nextConfig = readRoute("next.config.ts");
    const proxy = readRoute("src/proxy.ts");

    expect(nextConfig).toContain("withWorkflow");
    expect(proxy).toContain(".well-known/workflow/");
  });

  it("persists the durable workflow owner on the business task", () => {
    const schema = readRoute("prisma/schema.prisma");

    expect(schema).toContain("workflowRunId");
    expect(schema).toContain("confirmationDecision");
    expect(schema).toContain("confirmationReason");
  });

  it("uses channel-isolated marketing generation from both task entry points", () => {
    const runtime = readRoute("src/lib/agent-runtime.ts");
    const route = readRoute("src/app/api/projects/[id]/marketing/route.ts");

    expect(runtime).toContain("generateMarketingByChannel");
    expect(route).toContain("generateMarketingByChannel");
  });

  it("updates an existing outreach draft instead of creating duplicates", () => {
    const route = readRoute("src/app/api/project-candidates/[id]/outreach/route.ts");

    expect(route).toContain("existingDraft");
    expect(route).toContain("prisma.outreachDraft.update");
  });

  it("offers a project-specific screened-out review outcome instead of misusing do-not-contact", () => {
    const route = readRoute("src/app/api/project-candidates/[id]/review/route.ts");
    const form = readRoute("src/components/candidate-action-forms.tsx");
    const reviewLogic = readRoute("src/lib/candidate-review.ts");

    expect(route).toContain('"rejected"');
    expect(route).toContain("buildCandidateReviewUpdate");
    expect(reviewLogic).toContain('stage: "screened_out"');
    expect(form).toContain('<option value="rejected">本项目暂不推进</option>');
  });

  it("does not spend a model call rescoring a candidate that is not progressing", () => {
    const route = readRoute("src/app/api/project-candidates/[id]/score/route.ts");

    expect(route).toContain('candidate.stage === "screened_out"');
    expect(route.indexOf('candidate.stage === "screened_out"')).toBeLessThan(route.indexOf("scoreCandidateFit({"));
  });

  it("updates an open trial task instead of creating duplicates", () => {
    const route = readRoute("src/app/api/project-candidates/[id]/trial/route.ts");

    expect(route).toContain("existingTrial");
    expect(route).toContain("prisma.trialTask.update");
  });

  it("keeps trial passing and onboarding as separate approved actions", () => {
    const trialResultRoute = readRoute("src/app/api/project-candidates/[id]/trial-result/route.ts");
    const stageRoute = readRoute("src/app/api/project-candidates/[id]/stage/route.ts");

    expect(trialResultRoute).toContain("getTrialResultCandidateUpdate");
    expect(stageRoute).toContain("validateOnboardingApproval");
  });

  it("keeps trial design and operator-approved trial start as separate actions", () => {
    const trialDraftRoute = readRoute("src/app/api/project-candidates/[id]/trial/route.ts");
    const trialStartRoute = readRoute("src/app/api/project-candidates/[id]/trial-start/route.ts");

    expect(trialDraftRoute).toContain("buildTrialPreparationStatus");
    expect(trialDraftRoute).not.toContain('data: { stage: "trial"');
    expect(trialStartRoute).toContain("validateTrialStartApproval");
    expect(trialStartRoute).toContain('stage: "trial"');
  });
});
