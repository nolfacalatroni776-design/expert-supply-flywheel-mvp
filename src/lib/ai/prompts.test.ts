import { describe, expect, it } from "vitest";
import { SCORE_PROMPT } from "@/lib/ai/prompts";

describe("SCORE_PROMPT", () => {
  it("requires business language instead of internal model and database fields", () => {
    expect(SCORE_PROMPT).toMatch(/internal (?:JSON|database) field names/i);
    expect(SCORE_PROMPT).toMatch(/business language/i);
    expect(SCORE_PROMPT).toMatch(/internal source identifiers/i);
  });
});
