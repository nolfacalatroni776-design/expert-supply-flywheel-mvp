import { describe, expect, it } from "vitest";
import {
  filterCandidatesBySourceRun,
  getCandidatePipelineHref,
  getProjectSteps,
  getWorkspaceNavItems,
  isCandidateFilter,
  isMarketingPostStatusFilter,
  legacyViewToCanonicalView,
  normalizeView,
} from "@/lib/navigation";

describe("navigation", () => {
  it("maps legacy project views to the four project steps", () => {
    expect(legacyViewToCanonicalView.recruitment).toBe("demand");
    expect(legacyViewToCanonicalView.overview).toBe("demand");
    expect(legacyViewToCanonicalView.matching).toBe("supply");
    expect(legacyViewToCanonicalView.discovery).toBe("supply");
    expect(legacyViewToCanonicalView.sourcing).toBe("pipeline");
    expect(legacyViewToCanonicalView.marketing).toBe("growth");
    expect(legacyViewToCanonicalView.retrospective).toBe("growth");
  });

  it("normalizes unknown views to the command center", () => {
    expect(normalizeView(undefined)).toBe("agent");
    expect(normalizeView("not-a-view")).toBe("agent");
    expect(normalizeView("experts")).toBe("experts");
    expect(normalizeView("discovery")).toBe("supply");
  });

  it("keeps workspace navigation at object level", () => {
    const items = getWorkspaceNavItems();
    expect(items.map((item) => item.id)).toEqual(["agent", "projects", "experts", "channels", "review", "analytics"]);
    expect(items.some((item) => ["demand", "supply", "pipeline", "growth"].includes(item.id))).toBe(false);
    expect(items.map((item) => item.href)).toEqual(["/?view=agent", "/?view=projects", "/?view=experts", "/?view=channels", "/?view=review", "/?view=analytics"]);
    expect(items.every((item) => !item.href.includes("project="))).toBe(true);
  });

  it("returns exactly four project steps", () => {
    const steps = getProjectSteps("project-1", "supply");
    expect(steps.map((step) => step.id)).toEqual(["demand", "supply", "pipeline", "growth"]);
    expect(steps.filter((step) => step.active)).toHaveLength(1);
    expect(steps.find((step) => step.active)?.id).toBe("supply");
  });

  it("accepts candidate filter routes used by KPI links", () => {
    expect(isCandidateFilter("all")).toBe(true);
    expect(isCandidateFilter("external")).toBe(true);
    expect(isCandidateFilter("highEvidence")).toBe(true);
    expect(isCandidateFilter("outreachReady")).toBe(true);
    expect(isCandidateFilter("review")).toBe(true);
    expect(isCandidateFilter("trial")).toBe(true);
    expect(isCandidateFilter("active")).toBe(true);
    expect(isCandidateFilter("screenedOut")).toBe(true);
    expect(isCandidateFilter("outreach")).toBe(false);
  });

  it("scopes a task result link to candidates from the selected search run", () => {
    const candidates = [
      { id: "current", sourceRunId: "search-run-5" },
      { id: "historical", sourceRunId: "search-run-2" },
      { id: "manual", sourceRunId: null },
    ];

    expect(filterCandidatesBySourceRun(candidates, "search-run-5").map((candidate) => candidate.id)).toEqual(["current"]);
    expect(filterCandidatesBySourceRun(candidates, null)).toEqual(candidates);
  });

  it("keeps a candidate visible in an older run after a later run finds the same person", () => {
    const candidates = [
      {
        id: "repeated-candidate",
        sourceRunId: "new-run",
        discoveries: [{ searchRunId: "old-run" }, { searchRunId: "new-run" }],
      },
    ];

    expect(filterCandidatesBySourceRun(candidates, "old-run").map((candidate) => candidate.id)).toEqual([
      "repeated-candidate",
    ]);
  });

  it("keeps the candidate filter and search run when opening evidence", () => {
    expect(
      getCandidatePipelineHref({
        projectId: "project 1",
        candidateId: "candidate 2",
        candidateFilter: "external",
        sourceRunId: "search run 3",
      }),
    ).toBe(
      "/?project=project+1&view=pipeline&candidateFilter=external&candidate=candidate+2&sourceRun=search+run+3",
    );
  });

  it("accepts marketing status filters used by channel queue links", () => {
    expect(isMarketingPostStatusFilter("all")).toBe(true);
    expect(isMarketingPostStatusFilter("draft")).toBe(true);
    expect(isMarketingPostStatusFilter("needs_review")).toBe(true);
    expect(isMarketingPostStatusFilter("approved")).toBe(true);
    expect(isMarketingPostStatusFilter("scheduled")).toBe(true);
    expect(isMarketingPostStatusFilter("published")).toBe(true);
    expect(isMarketingPostStatusFilter("archived")).toBe(true);
    expect(isMarketingPostStatusFilter("sent")).toBe(false);
  });
});
