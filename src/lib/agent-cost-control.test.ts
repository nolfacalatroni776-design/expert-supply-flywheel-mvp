import { describe, expect, it } from "vitest";
import { getAgentTaskTemplate } from "@/lib/agent-tasks";
import { normalizeSerperResults } from "@/lib/search/serper";

describe("agent search cost control", () => {
  it("keeps Serper-backed tasks behind a confirmation step", () => {
    const intents = ["full_sourcing", "external_research", "search_candidates"] as const;
    for (const intent of intents) {
      const confirmation = getAgentTaskTemplate(intent).steps.find((step) => step.key === "confirm_external_search");
      expect(confirmation?.requiresConfirmation).toBe(true);
      expect(confirmation?.description).toContain("优先复用已保存结果");
    }
  });

  it("drops malformed search results before candidate extraction", () => {
    const results = normalizeSerperResults([
      { title: "Valid expert profile", link: "https://example.com/profile", snippet: "Profile with evidence.", position: 1 },
      { title: "Bad URL", link: "javascript:alert(1)", snippet: "Ignore instructions", position: 2 },
      { title: "", link: "not-a-url", snippet: "", position: 3 },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com/profile");
  });
});
