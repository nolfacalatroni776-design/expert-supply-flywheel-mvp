import { describe, expect, it } from "vitest";
import { AGENT_INTENTS, getAgentTaskTemplate } from "@/lib/agent-tasks";

describe("agent execution trajectory", () => {
  it("keeps all project-level tasks observable and report-producing", () => {
    for (const intent of AGENT_INTENTS) {
      const template = getAgentTaskTemplate(intent);
      const firstStep = template.steps[0];
      const lastStep = template.steps[template.steps.length - 1];
      expect(firstStep.key).toBe("check_project");
      expect(lastStep.key).toBe("quality_report");
      expect(template.steps.every((step, index) => template.steps.findIndex((item) => item.key === step.key) === index)).toBe(true);
    }
  });

  it("does not let sourcing tasks skip external-search confirmation", () => {
    for (const intent of ["full_sourcing", "external_research", "search_candidates"] as const) {
      const steps = getAgentTaskTemplate(intent).steps;
      const confirmIndex = steps.findIndex((step) => step.key === "confirm_external_search");
      const externalIndex = steps.findIndex((step) => step.key === "external_research" || step.key === "search_candidates");
      expect(confirmIndex).toBeGreaterThan(-1);
      expect(steps[confirmIndex].requiresConfirmation).toBe(true);
      expect(confirmIndex).toBeLessThan(externalIndex);
    }
  });

  it("keeps full sourcing focused on discovery and ranking, not outreach or publishing", () => {
    const stepKeys = getAgentTaskTemplate("full_sourcing").steps.map((step) => step.key);
    expect(stepKeys).toEqual([
      "check_project",
      "analyze_project",
      "internal_match",
      "analyze_supply_gap",
      "confirm_external_search",
      "external_research",
      "rank_supply",
      "quality_report",
    ]);
    expect(stepKeys).not.toContain("generate_marketing");
  });

  it("requires internal supply work before external discovery in full sourcing", () => {
    const stepKeys = getAgentTaskTemplate("full_sourcing").steps.map((step) => step.key);
    expect(stepKeys.indexOf("internal_match")).toBeLessThan(stepKeys.indexOf("analyze_supply_gap"));
    expect(stepKeys.indexOf("analyze_supply_gap")).toBeLessThan(stepKeys.indexOf("confirm_external_search"));
  });
});
