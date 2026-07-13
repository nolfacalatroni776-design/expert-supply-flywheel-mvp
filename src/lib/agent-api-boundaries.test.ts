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
});

