import { describe, expect, it } from "vitest";
import { groupEvidenceBySource } from "@/lib/candidate-evidence";

describe("groupEvidenceBySource", () => {
  it("presents repeated claims from one public profile as one source", () => {
    const grouped = groupEvidenceBySource([
      { id: "1", claim: "Pydantic maintainer", sourceUrl: "https://github.com/example", sourceTitle: null, snippet: "", evidenceLevel: "E2", confidence: 0.5 },
      { id: "2", claim: "1170 repository contributions", sourceUrl: "https://github.com/example", sourceTitle: "GitHub profile", snippet: "Public contribution history", evidenceLevel: "E2", confidence: 0.9 },
      { id: "3", claim: "Pydantic company member", sourceUrl: "https://github.com/example", sourceTitle: null, snippet: "", evidenceLevel: "E1", confidence: 0.5 },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      sourceUrl: "https://github.com/example",
      sourceTitle: "GitHub profile",
      evidenceLevel: "E2",
      confidence: 0.9,
    });
    expect(grouped[0].claims).toHaveLength(3);
    expect(grouped[0].snippets).toEqual(["Public contribution history"]);
  });
});
