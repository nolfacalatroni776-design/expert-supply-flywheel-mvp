import { describe, expect, it } from "vitest";
import { getCandidateExtractionTimeoutMs } from "@/lib/workflows";

describe("candidate extraction runtime settings", () => {
  it("uses a production-safe timeout range for the real GLM latency", () => {
    expect(getCandidateExtractionTimeoutMs(undefined)).toBe(35_000);
    expect(getCandidateExtractionTimeoutMs("5000")).toBe(15_000);
    expect(getCandidateExtractionTimeoutMs("120000")).toBe(60_000);
    expect(getCandidateExtractionTimeoutMs("invalid")).toBe(35_000);
  });
});
