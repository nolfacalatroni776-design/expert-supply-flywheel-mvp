import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("live production flow smoke script", () => {
  it("keeps real external search explicit and never sends email", () => {
    const source = readFileSync(join(process.cwd(), "scripts/live-production-flow.ts"), "utf8");

    expect(source).toContain("LIVE_FLOW_ALLOW_EXTERNAL_SEARCH");
    expect(source).toContain("LIVE_FLOW_REQUIRE_NETWORK_SEARCH");
    expect(source).toContain('process.env.SEARCH_CACHE_BYPASS = "1"');
    expect(source).toContain("assessLiveAgentRun");
    expect(source).toContain("assessLiveExternalSearch");
    expect(source).toContain("realExternalSearchExecuted");
    expect(source).toContain("confirmAgentTaskRun");
    expect(source).toContain("generateOutreachDraftOnly");
    expect(source).toContain("Outreach draft only; no email is sent.");
    expect(source).toContain('callCandidateRoute("trial-start"');
    expect(source).toContain("samplesDeidentified: true");
    expect(source).toContain("goldAnswersValidated: true");
    expect(source).toContain("const lockedEnvKeys = new Set(Object.keys(process.env));");
    expect(source).toContain("if (lockedEnvKeys.has(key)) continue;");
    expect(source).toContain('JSON.stringify({ status: "approved" })');
    expect(source).toContain('JSON.stringify({ status: "published" })');
    expect(source).not.toContain("if (process.env[key]) continue;");
    expect(source).not.toContain("function isGoodTerminal");
    expect(source).not.toMatch(/\bsend(Mail|Email)\s*\(/i);
    expect(source).not.toContain("smtp");
  });

  it("isolates repeated smoke runs and only removes experts left orphaned by smoke projects", () => {
    const source = readFileSync(join(process.cwd(), "scripts/live-production-flow.ts"), "utf8");

    expect(source).toContain("cleanupLiveFlowData");
    expect(source).toContain("LIVE_FLOW_KEEP_DATA");
    expect(source).toContain('id: { startsWith: "live-flow-" }');
    expect(source).toContain("candidates: { none: {} }");
    expect(source).toContain("project.deleteMany");
    expect(source).toContain("expert.deleteMany");
  });

  it("records reviewable external candidate evidence without contact data", () => {
    const source = readFileSync(join(process.cwd(), "scripts/live-production-flow.ts"), "utf8");

    expect(source).toContain("externalCandidateAudit");
    expect(source).toContain("humanReviewNeeded: true");
    expect(source).toContain("evidenceItems:");
    expect(source).toContain("sourceUrl: true");
    expect(source).toContain("evaluateExternalCandidateAudit");
    expect(source).toContain('checkpoint("external candidate quality"');
    expect(source).not.toContain("externalCandidateAudit: externalCandidates");
  });
});
