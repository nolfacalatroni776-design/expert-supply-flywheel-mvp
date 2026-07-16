import { describe, expect, it } from "vitest";
import {
  assessLiveAgentRun,
  assessLiveExternalSearch,
} from "@/lib/live-production-acceptance";

describe("live production acceptance", () => {
  it("does not report a partially successful sourcing run as production-ready", () => {
    const result = assessLiveAgentRun({
      status: "partially_succeeded",
      failed: ["补充公开候选未满足项目硬条件"],
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("任务仅部分完成。补充公开候选未满足项目硬条件");
  });

  it("rejects a cache-only run when the smoke test promises a real provider call", () => {
    const result = assessLiveExternalSearch({
      externalRuns: 1,
      searchResults: 20,
      externalCandidates: 3,
      requireNetworkCall: true,
      acceptance: {
        passed: true,
        uncached: 0,
        hardRequirementReadyCandidates: 1,
      },
      providerStats: { cache: 20 },
    });

    expect(result.ok).toBe(false);
    expect(result.networkCallVerified).toBe(false);
    expect(result.reasons).toContain("本次仅复用了缓存，没有验证真实公开搜索服务。");
  });

  it("rejects discovered people when none satisfies the project hard requirements", () => {
    const result = assessLiveExternalSearch({
      externalRuns: 1,
      searchResults: 20,
      externalCandidates: 3,
      requireNetworkCall: false,
      acceptance: {
        passed: false,
        uncached: 0,
        hardRequirementReadyCandidates: 0,
        blockers: ["没有候选同时满足高证据和代码评审经历。"],
      },
      providerStats: { cache: 20 },
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("公开候选未通过项目质量门禁。没有候选同时满足高证据和代码评审经历。");
  });

  it("accepts a successful run with a non-cache provider and a hard-requirement-ready candidate", () => {
    const result = assessLiveExternalSearch({
      externalRuns: 1,
      searchResults: 8,
      externalCandidates: 2,
      requireNetworkCall: true,
      acceptance: {
        passed: true,
        uncached: 2,
        hardRequirementReadyCandidates: 1,
      },
      providerStats: { github: 3, serper: 5 },
    });

    expect(result).toEqual({
      ok: true,
      networkCallVerified: true,
      providers: ["github", "serper"],
      reasons: [],
    });
  });
});
