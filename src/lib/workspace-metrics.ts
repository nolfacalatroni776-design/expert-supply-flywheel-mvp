export function resolveReviewMetric({
  candidateReviews,
  marketingReviews,
  scope,
}: {
  candidateReviews: number;
  marketingReviews: number;
  scope: "project_candidates" | "all_reviews";
}) {
  return scope === "project_candidates" ? candidateReviews : candidateReviews + marketingReviews;
}
