import { describe, expect, it } from "vitest";
import { AGENT_INTENTS, getAgentTaskTemplate, isAgentIntent } from "@/lib/agent-tasks";

describe("agent task templates", () => {
  it("defines a deterministic plan for every supported intent", () => {
    expect(AGENT_INTENTS).toHaveLength(9);
    for (const intent of AGENT_INTENTS) {
      const template = getAgentTaskTemplate(intent);
      expect(template.intent).toBe(intent);
      expect(template.steps[0].key).toBe("check_project");
      expect(template.steps.at(-1)?.key).toBe("quality_report");
      expect(template.steps.every((step) => step.label && step.description)).toBe(true);
    }
  });

  it("keeps external search behind an explicit confirmation step", () => {
    expect(getAgentTaskTemplate("external_research").steps.map((step) => step.key)).toContain("confirm_external_search");
    expect(getAgentTaskTemplate("search_candidates").steps.map((step) => step.key)).toContain("confirm_external_search");
    expect(getAgentTaskTemplate("full_sourcing").steps.map((step) => step.key)).toContain("confirm_external_search");
  });

  it("rejects unknown intents", () => {
    expect(isAgentIntent("full_sourcing")).toBe(true);
    expect(isAgentIntent("delete_everything")).toBe(false);
  });
});
