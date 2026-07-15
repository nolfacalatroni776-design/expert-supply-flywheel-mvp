import { describe, expect, it } from "vitest";
import {
  filterCandidatePipeline,
  isCandidateEligibleForSupplyMetrics,
  isHighEvidenceCandidate,
  needsCandidateReview,
  preserveManualScreeningDecision,
} from "@/lib/candidate-status";

const candidate = {
  id: "candidate-1",
  stage: "sourced",
  sourceType: "external",
  humanReviewNeeded: true,
  expert: { evidenceLevel: "E1", consentState: "unknown" },
};

describe("screened-out candidate visibility", () => {
  it("removes screened-out candidates from active supply and review metrics", () => {
    const screenedOut = { ...candidate, stage: "screened_out", humanReviewNeeded: false };

    expect(isCandidateEligibleForSupplyMetrics(screenedOut)).toBe(false);
    expect(isHighEvidenceCandidate({ ...screenedOut, expert: { ...screenedOut.expert, evidenceLevel: "E3" } })).toBe(false);
    expect(needsCandidateReview({ ...screenedOut, humanReviewNeeded: true })).toBe(false);
  });

  it("keeps screened-out candidates in a dedicated history filter and out of active external supply", () => {
    const screenedOut = { ...candidate, id: "screened", stage: "screened_out", humanReviewNeeded: false };
    const reviewable = { ...candidate, id: "reviewable" };
    const candidates = [screenedOut, reviewable];

    expect(filterCandidatePipeline(candidates, "all").map((item) => item.id)).toEqual(["screened", "reviewable"]);
    expect(filterCandidatePipeline(candidates, "external").map((item) => item.id)).toEqual(["reviewable"]);
    expect(filterCandidatePipeline(candidates, "screenedOut").map((item) => item.id)).toEqual(["screened"]);
    expect(filterCandidatePipeline(candidates, "review").map((item) => item.id)).toEqual(["reviewable"]);
    expect(filterCandidatePipeline(candidates, "highEvidence")).toEqual([]);
  });

  it("keeps DNC records in compliance review but out of effective supply metrics", () => {
    const dnc = { ...candidate, stage: "do_not_contact", humanReviewNeeded: false };

    expect(isCandidateEligibleForSupplyMetrics(dnc)).toBe(false);
    expect(needsCandidateReview(dnc)).toBe(true);
  });

  it("does not let a repeated search overwrite a manual screen-out decision", () => {
    expect(
      preserveManualScreeningDecision(
        {
          stage: "screened_out",
          humanReviewNeeded: false,
          nextAction: "本项目暂不推进：领域经历不匹配。如有新证据，可重新复核。",
        },
        {
          humanReviewNeeded: true,
          nextAction: "复核新搜索结果后触达。",
        },
      ),
    ).toEqual({
      humanReviewNeeded: false,
      nextAction: "本项目暂不推进：领域经历不匹配。如有新证据，可重新复核。",
    });
  });
});
