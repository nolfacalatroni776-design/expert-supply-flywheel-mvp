import { describe, expect, it } from "vitest";
import { resolveReviewMetric } from "@/lib/workspace-metrics";

describe("resolveReviewMetric", () => {
  it("shows only candidate reviews on project workflow pages", () => {
    expect(resolveReviewMetric({ candidateReviews: 9, marketingReviews: 11, scope: "project_candidates" })).toBe(9);
  });

  it("includes candidate and channel reviews in the review center", () => {
    expect(resolveReviewMetric({ candidateReviews: 9, marketingReviews: 11, scope: "all_reviews" })).toBe(20);
  });
});
