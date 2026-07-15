import {
  BarChart3,
  Database,
  Megaphone,
  ShieldCheck,
  Sparkles,
  UserCheck,
  type LucideIcon,
} from "lucide-react";

export type CanonicalView =
  | "agent"
  | "projects"
  | "experts"
  | "channels"
  | "review"
  | "analytics"
  | "demand"
  | "supply"
  | "pipeline"
  | "growth";

export type CandidateFilter = "all" | "external" | "highEvidence" | "outreachReady" | "review" | "trial" | "active" | "screenedOut";
export type MarketingPostStatusFilter = "all" | "draft" | "needs_review" | "approved" | "scheduled" | "published" | "archived";

export const legacyViewToCanonicalView: Record<string, CanonicalView> = {
  detail: "demand",
  overview: "demand",
  recruitment: "demand",
  matching: "supply",
  discovery: "supply",
  sourcing: "pipeline",
  marketing: "growth",
  retrospective: "growth",
};

const canonicalViews = new Set<CanonicalView>([
  "agent",
  "projects",
  "experts",
  "channels",
  "review",
  "analytics",
  "demand",
  "supply",
  "pipeline",
  "growth",
]);

export function normalizeView(input?: string | null): CanonicalView {
  if (!input) return "agent";
  if (input in legacyViewToCanonicalView) return legacyViewToCanonicalView[input];
  return canonicalViews.has(input as CanonicalView) ? (input as CanonicalView) : "agent";
}

export function isProjectView(view: CanonicalView) {
  return view === "demand" || view === "supply" || view === "pipeline" || view === "growth";
}

export function isCandidateFilter(value: unknown): value is CandidateFilter {
  return value === "all" || value === "external" || value === "highEvidence" || value === "outreachReady" || value === "review" || value === "trial" || value === "active" || value === "screenedOut";
}

export function filterCandidatesBySourceRun<
  T extends { sourceRunId?: string | null; discoveries?: Array<{ searchRunId: string }> },
>(candidates: T[], sourceRunId?: string | null) {
  if (!sourceRunId) return candidates;
  return candidates.filter(
    (candidate) =>
      candidate.sourceRunId === sourceRunId ||
      candidate.discoveries?.some((discovery) => discovery.searchRunId === sourceRunId),
  );
}

export function getCandidatePipelineHref({
  projectId,
  candidateId,
  candidateFilter = "all",
  sourceRunId,
}: {
  projectId: string;
  candidateId: string;
  candidateFilter?: CandidateFilter;
  sourceRunId?: string | null;
}) {
  const params = new URLSearchParams({
    project: projectId,
    view: "pipeline",
    candidateFilter,
    candidate: candidateId,
  });
  if (sourceRunId) params.set("sourceRun", sourceRunId);
  return `/?${params.toString()}`;
}

export function isMarketingPostStatusFilter(value: unknown): value is MarketingPostStatusFilter {
  return value === "all" || value === "draft" || value === "needs_review" || value === "approved" || value === "scheduled" || value === "published" || value === "archived";
}

export function getWorkspaceNavItems() {
  return [
    { id: "agent", label: "招募指挥台", icon: Sparkles, href: "/?view=agent" },
    { id: "projects", label: "项目库", icon: Database, href: "/?view=projects" },
    { id: "experts", label: "专家库", icon: UserCheck, href: "/?view=experts" },
    { id: "channels", label: "渠道中心", icon: Megaphone, href: "/?view=channels" },
    { id: "review", label: "复核中心", icon: ShieldCheck, href: "/?view=review" },
    { id: "analytics", label: "数据复盘", icon: BarChart3, href: "/?view=analytics" },
  ] satisfies Array<{ id: CanonicalView; label: string; icon: LucideIcon; href: string }>;
}

export function getProjectSteps(projectId: string, activeView: CanonicalView) {
  return [
    { id: "demand", label: "需求与策略", href: `/?project=${projectId}&view=demand`, active: activeView === "demand" },
    { id: "supply", label: "供给发现", href: `/?project=${projectId}&view=supply`, active: activeView === "supply" },
    { id: "pipeline", label: "候选推进", href: `/?project=${projectId}&view=pipeline`, active: activeView === "pipeline" },
    { id: "growth", label: "分发与复盘", href: `/?project=${projectId}&view=growth`, active: activeView === "growth" },
  ] satisfies Array<{ id: CanonicalView; label: string; href: string; active: boolean }>;
}

export function formatViewName(view: CanonicalView | string) {
  const labels: Record<string, string> = {
    agent: "招募指挥台",
    projects: "项目库",
    experts: "专家库",
    channels: "渠道中心",
    review: "复核中心",
    analytics: "数据复盘",
    demand: "需求与策略",
    supply: "供给发现",
    pipeline: "候选推进",
    growth: "分发与复盘",
  };
  return labels[view] ?? "工作台";
}
