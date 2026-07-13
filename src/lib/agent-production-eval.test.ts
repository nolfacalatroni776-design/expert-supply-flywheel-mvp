import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { evaluateAgentCase, loadAgentEvalCases } from "@/lib/agent-production-eval";

describe("agent production eval cases", () => {
  const cases = loadAgentEvalCases(join(process.cwd(), "evals", "agent-cases"));

  it("loads a meaningful golden dataset", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(cases.map((item) => item.id)).toContain("lung-ct-regulated");
    expect(cases.map((item) => item.id)).toContain("prompt-injection-search");
  });

  it("passes rule-based production gates for every golden case", () => {
    const results = cases.map(evaluateAgentCase);
    const failed = results.filter((result) => !result.passed);
    expect(failed).toEqual([]);
  });
});

