import { ApiButton } from "@/components/api-button";
import { AgentCommandForm } from "@/components/agent-command-form";
import { Badge } from "@/components/badge";
import {
  CandidateReviewForm,
  ContactPermissionForm,
  DncForm,
  DraftStatusButton,
  TrialResultForm,
  TrialStartForm,
} from "@/components/candidate-action-forms";
import { CreateProjectForm, QuickProjectStartForm } from "@/components/create-project-form";
import { DynamicLogo } from "@/components/dynamic-logo";
import { ExpertQualityEventForm } from "@/components/supply-action-forms";
import type { ExternalResearchAcceptanceReport } from "@/lib/external-research-acceptance";
import { groupEvidenceBySource } from "@/lib/candidate-evidence";
import {
  filterCandidatePipeline,
  isCandidateEligibleForSupplyMetrics,
  isHighEvidenceCandidate,
  needsCandidateReview,
} from "@/lib/candidate-status";
import { serializeAgentRun } from "@/lib/agent-runtime";
import { canApproveForOutreach } from "@/lib/gates";
import { parseJson } from "@/lib/json";
import { evaluateMarketingAttractionReadiness, type MarketingAttractionReport } from "@/lib/marketing-attraction";
import {
  formatViewName,
  filterCandidatesBySourceRun,
  getCandidatePipelineHref,
  getProjectSteps,
  getWorkspaceNavItems,
  isCandidateFilter,
  isMarketingPostStatusFilter,
  isProjectView,
  normalizeView,
  type CandidateFilter,
  type CanonicalView,
  type MarketingPostStatusFilter,
} from "@/lib/navigation";
import { resolveReviewMetric } from "@/lib/workspace-metrics";
import { prisma } from "@/lib/prisma";
import { publicErrorMessage } from "@/lib/redaction";
import { formatOutreachDraftStatus } from "@/lib/outreach-status";
import { serializeProject } from "@/lib/serializers";
import { canTransitionCandidateStage } from "@/lib/state-machines";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  CopyCheck,
  Database,
  FileSearch,
  HomeIcon,
  Megaphone,
  Mail,
  MessageSquare,
  Network,
  Radar,
  Radio,
  ShieldCheck,
  Sparkles,
  UserCheck,
} from "lucide-react";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ project?: string; candidate?: string; view?: string; post?: string; candidateFilter?: string; sourceRun?: string; channel?: string; postStatus?: string }>;
};

type ProjectWorkspaceData = Prisma.ProjectGetPayload<{
  include: {
    candidates: {
      include: { expert: { include: { signals: true; qualityMetrics: true; engagementEvents: true } }; evidenceItems: true; outreachDrafts: true; trialTasks: true };
    };
    searchResults: true;
    auditEvents: true;
    marketingCampaigns: { include: { posts: true } };
    marketingPosts: true;
    supplySearchRuns: true;
    supplyGaps: true;
    searchSourceMetrics: true;
    recruitmentOutcomes: true;
    agentTaskRuns: { include: { steps: true } };
  };
}>;

type ExpertLibraryData = Prisma.ExpertGetPayload<{
  include: {
    signals: true;
    qualityMetrics: true;
    engagementEvents: true;
    candidates: { include: { project: true } };
  };
}>;

type MergeSuggestionData = Prisma.ExpertMergeCandidateGetPayload<{
  include: { primaryExpert: true; duplicateExpert: true };
}>;

type CandidateWorkspaceData = ProjectWorkspaceData["candidates"][number];

type ReviewCandidateData = Prisma.ProjectCandidateGetPayload<{
  include: { project: true; expert: true; evidenceItems: true; outreachDrafts: true; trialTasks: true };
}>;

type ReviewMarketingPostData = Prisma.MarketingPostGetPayload<{
  include: { project: true };
}>;

type WorkspaceMarketingPostData = Prisma.MarketingPostGetPayload<{
  include: { project: true };
}>;

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams;
  const projects = await prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      candidates: { include: { expert: true }, orderBy: { updatedAt: "desc" } },
    },
  });

  const activeProject =
    (params.project
      ? await prisma.project.findUnique({
          where: { id: params.project },
          include: {
            candidates: {
              include: {
                expert: { include: { signals: true, qualityMetrics: true, engagementEvents: true } },
                evidenceItems: true,
                outreachDrafts: true,
                trialTasks: true,
                discoveries: true,
              },
              orderBy: [{ fitScore: "desc" }, { updatedAt: "desc" }],
            },
            searchResults: { orderBy: { createdAt: "desc" }, take: 12 },
            auditEvents: { orderBy: { createdAt: "desc" }, take: 18 },
            marketingCampaigns: { include: { posts: { orderBy: { createdAt: "desc" } } }, orderBy: { createdAt: "desc" }, take: 4 },
            marketingPosts: { orderBy: { createdAt: "desc" }, take: 24 },
            supplySearchRuns: { orderBy: { createdAt: "desc" }, take: 12 },
            supplyGaps: { orderBy: { createdAt: "desc" }, take: 12 },
            searchSourceMetrics: { orderBy: { updatedAt: "desc" }, take: 24 },
            recruitmentOutcomes: { orderBy: { createdAt: "desc" }, take: 5 },
            agentTaskRuns: {
              include: { steps: { orderBy: { order: "asc" } } },
              orderBy: { createdAt: "desc" },
              take: 8,
            },
          },
        })
      : null) ?? null;

  const selectedProject = activeProject;
  const requestedView = normalizeView(params.view);
  const selectedView = activeProject && (!params.view || isProjectView(requestedView)) ? (isProjectView(requestedView) ? requestedView : "demand") : requestedView;
  const candidateFilter = isCandidateFilter(params.candidateFilter) ? params.candidateFilter : "all";
  const candidateSourceRunId = params.sourceRun?.trim() || null;
  const selectedProjectCandidates = selectedProject?.candidates ?? [];
  const selectedProjectFilteredCandidates = filterCandidatePipeline(
    filterCandidatesBySourceRun(selectedProjectCandidates, candidateSourceRunId),
    candidateFilter,
  );
  const selectedCandidate = params.candidate
    ? selectedProjectFilteredCandidates.find((candidate) => candidate.id === params.candidate) ?? null
    : null;
  const selectedPostId = params.post ?? null;
  const selectedChannelFilter = params.channel ?? "all";
  const selectedPostStatusFilter = isMarketingPostStatusFilter(params.postStatus) ? params.postStatus : "all";

  const expertLibrary = await prisma.expert.findMany({
    include: {
      signals: { orderBy: { createdAt: "desc" }, take: 8 },
      qualityMetrics: { orderBy: { createdAt: "desc" }, take: 8 },
      engagementEvents: { orderBy: { createdAt: "desc" }, take: 8 },
      candidates: { include: { project: true }, orderBy: { updatedAt: "desc" }, take: 5 },
    },
    orderBy: [{ expertType: "asc" }, { updatedAt: "desc" }],
    take: 80,
  });

  const mergeSuggestions = await prisma.expertMergeCandidate.findMany({
    where: { status: "pending" },
    include: { primaryExpert: true, duplicateExpert: true },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  const expertCount = await prisma.expert.count();

  const reviewCandidates = await prisma.projectCandidate.findMany({
    where: {
      ...(selectedProject ? { projectId: selectedProject.id } : {}),
      AND: [
        { stage: { not: "screened_out" } },
        {
          OR: [
            { humanReviewNeeded: true },
            { stage: "approved_for_outreach" },
            { stage: "do_not_contact" },
            { expert: { evidenceLevel: { in: ["E0", "E1"] } } },
          ],
        },
      ],
    },
    include: { project: true, expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  const reviewMarketingPosts = await prisma.marketingPost.findMany({
    where: {
      ...(selectedProject ? { projectId: selectedProject.id } : {}),
      status: "needs_review",
    },
    include: { project: true },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  const workspaceMarketingPosts = await prisma.marketingPost.findMany({
    include: { project: true },
    orderBy: { updatedAt: "desc" },
    take: 80,
  });

  const currentCandidates = selectedProject?.candidates ?? projects.flatMap((project) => project.candidates);
  const currentReviewCandidateCount = currentCandidates.filter(needsCandidateReview).length;
  const currentReviewMarketingPostCount =
    selectedProject?.marketingPosts.filter((post) => post.status === "needs_review").length ??
    (await prisma.marketingPost.count({ where: { status: "needs_review" } }));
  const stats = {
    projects: projects.length,
    candidates: currentCandidates.length,
    review: resolveReviewMetric({
      candidateReviews: currentReviewCandidateCount,
      marketingReviews: currentReviewMarketingPostCount,
      scope: selectedProject && isProjectView(selectedView) ? "project_candidates" : "all_reviews",
    }),
    outreachReady: selectedProject
      ? countOutreachReady(selectedProject)
      : currentCandidates.filter((candidate) => candidate.stage === "approved_for_outreach").length,
    trial: currentCandidates.filter((candidate) => candidate.stage === "trial").length,
    active: currentCandidates.filter((candidate) => ["onboarded", "active"].includes(candidate.stage)).length,
    internal: currentCandidates.filter(
      (candidate) => candidate.sourceType === "internal" && isCandidateEligibleForSupplyMetrics(candidate),
    ).length,
    highEvidence: currentCandidates.filter(isHighEvidenceCandidate).length,
    experts: expertCount,
    marketingPosts: selectedProject?.marketingPosts.length ?? (await prisma.marketingPost.count()),
  };
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const isTemporaryTrialRuntime = process.env.ENABLE_RUNTIME_DB_INIT === "1" && /^file:\/{1,3}tmp\//.test(databaseUrl);

  return (
    <main className="h-screen overflow-hidden bg-[#f7f7f4] text-[#28251e]">
      <div className="grid h-full grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="hidden h-screen overflow-hidden border-r border-[#e7e7e2] bg-white lg:flex lg:flex-col">
          <div className="px-4 pb-4 pt-5">
            <div className="flex items-center gap-3">
              <DynamicLogo />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[#28251e]">专家供给增长</p>
                <p className="truncate text-xs text-[#7a7469]">招募运营工作台</p>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
            <SidebarNav selectedView={selectedView} />

            <div className="mt-5">
              <Link
                href="/?view=projects#create-project"
                className="group grid gap-2 rounded-lg border border-[#dbe4ee] bg-[#f6f9fc] p-4 text-left transition hover:border-[#9db7d3] hover:bg-white"
              >
                <span className="inline-flex size-9 items-center justify-center rounded-lg bg-white text-[#2563eb] shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
                  <Sparkles className="size-4" />
                </span>
                <span className="text-sm font-semibold text-[#28251e]">创建新招募项目</span>
                <span className="text-xs leading-5 text-[#7a7469]">填写需求、预算、语言和地区。</span>
              </Link>
            </div>

            <div className="mt-5 border-t border-[#f0eee8] pt-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a9388]">最近项目</h2>
                <Badge>{projects.length}</Badge>
              </div>
              <div className="no-scrollbar grid max-h-52 gap-1 overflow-y-auto pb-1">
                {projects.map((project) => (
                  <a
                    key={project.id}
                    href={`/?project=${project.id}&view=${selectedView === "agent" ? "agent" : isProjectView(selectedView) ? selectedView : "demand"}`}
                    className={`grid gap-1 rounded-lg px-3 py-2.5 text-sm transition ${
                      selectedProject?.id === project.id
                        ? "bg-[#eef5ff] text-[#28251e]"
                        : "text-[#5f5a50] hover:bg-[#f9f9f9] hover:text-[#28251e]"
                    }`}
                  >
                    <span className="truncate font-medium">{project.title}</span>
                    <span className="truncate text-xs text-[#8c8578]">
                      {project.candidates.length} 候选 / {formatProjectStatus(project.status)}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-[#f0eee8] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="rounded-lg bg-[#fef3c7] px-3 py-2">
              <div className="flex items-center justify-between text-xs font-medium text-[#5f5a50]">
                <span>候选总数</span>
                <span>{stats.candidates}</span>
              </div>
            </div>
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto">
          <div className="mx-auto grid w-full max-w-[1440px] gap-4 px-4 py-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between gap-3 lg:hidden">
              <div className="flex min-w-0 items-center gap-3">
                <DynamicLogo />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">专家供给增长工作台</p>
                  <p className="truncate text-xs text-[#7a7469]">招募运营工作台</p>
                </div>
              </div>
              <Badge>{stats.projects} 项目</Badge>
            </div>
            {isTemporaryTrialRuntime ? <TrialWorkspaceNotice /> : null}
            {isProjectView(selectedView) ? (
              <MobileProjectSwitcher projects={projects} selectedProject={selectedProject} selectedView={selectedView} />
            ) : null}
            {selectedView === "agent" ? null : <StatsGrid stats={stats} selectedProjectId={selectedProject?.id ?? null} selectedView={selectedView} />}
            {selectedProject && isProjectView(selectedView) ? (
              <ProjectWorkspace
                project={selectedProject}
                projects={projects}
                selectedCandidate={selectedCandidate}
                selectedView={selectedView}
                selectedPostId={selectedPostId}
                candidateFilter={candidateFilter}
                candidateSourceRunId={candidateSourceRunId}
                mergeSuggestions={mergeSuggestions}
                selectedChannel={selectedChannelFilter}
                selectedStatus={selectedPostStatusFilter}
              />
            ) : selectedView === "projects" ? (
              <RecruitmentList projects={projects} selectedProjectId={selectedProject?.id ?? null} />
            ) : selectedView === "experts" ? (
              <ExpertLibraryModule experts={expertLibrary} selectedProjectId={selectedProject?.id ?? null} />
            ) : selectedView === "channels" ? (
              <ChannelsCenter
                selectedProject={selectedProject}
                projects={projects}
                posts={workspaceMarketingPosts}
                selectedPostId={selectedPostId}
                selectedChannel={selectedChannelFilter}
                selectedStatus={selectedPostStatusFilter}
              />
            ) : selectedView === "analytics" ? (
              <AnalyticsCenter projects={projects} selectedProject={selectedProject} />
            ) : selectedView === "review" ? (
              <ReviewModule reviewCandidates={reviewCandidates} reviewMarketingPosts={reviewMarketingPosts} events={selectedProject?.auditEvents ?? []} />
            ) : selectedView === "agent" ? (
              <WorkspaceCommandCenter projects={projects} selectedProject={selectedProject} stats={stats} />
            ) : projects.length ? (
              <ProjectSelectionGate projects={projects} targetView={selectedView} />
            ) : (
              <EmptyState />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function SidebarNav({ selectedView }: { selectedView: CanonicalView }) {
  const items = getWorkspaceNavItems();

  return (
    <nav className="grid gap-1 text-sm font-medium text-[#5f5a50]" data-sidebar-nav>
      {items.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          className={`flex h-10 items-center gap-3 rounded-lg px-3 transition ${
            selectedView === item.id ? "bg-[#eef5ff] text-[#1f3b57]" : "hover:bg-[#f6f7f8] hover:text-[#28251e]"
          }`}
        >
          <item.icon className={`size-4 ${selectedView === item.id ? "text-[#2563eb]" : "text-[#8c8578]"}`} />
          <span className="truncate">{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}

function TrialWorkspaceNotice() {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
      当前为试用工作区，数据可能会重置。重要项目请使用正式工作区；若项目打不开，请返回项目库重新进入。
    </div>
  );
}

function MobileProjectSwitcher({
  projects,
  selectedProject,
  selectedView,
}: {
  projects: Array<{
    id: string;
    title: string;
    status: string;
    candidates: Array<{ id: string }>;
  }>;
  selectedProject: { id: string; title: string; status: string } | null;
  selectedView: CanonicalView;
}) {
  return (
    <details
      open={!selectedProject}
      data-mobile-project-switcher
      className="rounded-lg border border-[#e7e7e2] bg-white shadow-[0_1px_2px_rgba(17,17,17,0.04)] lg:hidden"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a9388]">{selectedProject ? "当前项目" : "选择项目"}</p>
          <p className="mt-1 truncate text-sm font-semibold text-[#28251e]">{selectedProject?.title ?? `进入${formatViewName(selectedView)}`}</p>
        </div>
        <span className="inline-flex h-8 shrink-0 items-center rounded-lg border border-[#e7e7e2] px-3 text-xs font-semibold text-[#5f5a50]">
          切换
        </span>
      </summary>
      <div className="grid gap-4 border-t border-[#f0eee8] p-4">
        <div className="grid gap-2">
          {projects.map((project) => (
            <a
              key={project.id}
              href={`/?project=${project.id}&view=${isProjectView(selectedView) ? selectedView : "demand"}`}
              className={`grid gap-1 rounded-lg border px-3 py-2.5 text-sm transition ${
                selectedProject?.id === project.id
                  ? "border-[#2563eb33] bg-[#2563eb14] text-[#28251e]"
                  : "border-[#f0eee8] bg-[#f9f9f9] text-[#5f5a50]"
              }`}
            >
              <span className="truncate font-semibold">{project.title}</span>
              <span className="truncate text-xs text-[#8c8578]">
                {project.candidates.length} 候选 / {formatProjectStatus(project.status)}
              </span>
            </a>
          ))}
          {!projects.length ? <p className="text-sm text-[#7a7469]">暂无项目，先创建一个需求。</p> : null}
        </div>
        <details className="rounded-lg border border-[#f0eee8] bg-[#f9f9f9] p-3">
          <summary className="cursor-pointer list-none text-sm font-semibold text-[#28251e] [&::-webkit-details-marker]:hidden">
            新建专家招募项目
          </summary>
          <div className="mt-3">
            <CreateProjectForm variant="compact" />
          </div>
        </details>
      </div>
    </details>
  );
}

function CreateProjectPanel() {
  return (
    <details
      open
      id="create-project"
      data-create-project-panel
      className="group rounded-lg border border-[#e7e7e2] bg-white shadow-[0_1px_2px_rgba(17,17,17,0.04)]"
    >
      <summary className="grid cursor-pointer list-none gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center lg:px-5 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#28251e] text-white">
            <Sparkles className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[#28251e]">新建专家招募项目</span>
            <span className="mt-0.5 block truncate text-xs text-[#7a7469]">
              填写任务需求、预算、语言和地区。
            </span>
          </span>
        </span>
        <span className="inline-flex h-9 w-fit items-center justify-center rounded-lg border border-[#e7e7e2] px-4 text-sm font-semibold text-[#5f5a50] group-open:bg-[#f9f9f9]">
          展开填写
        </span>
      </summary>
      <div className="border-t border-[#f0eee8] p-4 lg:p-5">
        <CreateProjectForm variant="spacious" />
      </div>
    </details>
  );
}

function StatsGrid({
  stats,
  selectedProjectId,
  selectedView,
}: {
  stats: Record<string, number>;
  selectedProjectId: string | null;
  selectedView: CanonicalView;
}) {
  const projectQuery = selectedProjectId ? `project=${selectedProjectId}&` : "";
  const projectMetricHref = (suffix = "") => `/?${projectQuery}view=pipeline${suffix}`;
  const projectItems = [
    { label: "内部召回", value: stats.internal, icon: UserCheck, href: projectMetricHref("&candidateFilter=all"), helper: "查看内部召回候选" },
    { label: "可触达", value: stats.outreachReady, icon: Mail, href: projectMetricHref("&candidateFilter=outreachReady"), helper: "查看可触达候选" },
    { label: "待复核", value: stats.review, icon: ShieldCheck, href: projectMetricHref("&candidateFilter=review"), helper: "处理候选复核" },
    { label: "试标中", value: stats.trial, icon: ClipboardCheck, href: projectMetricHref("&candidateFilter=trial"), helper: "查看试标候选" },
  ];
  const workspaceItems = [
    { label: "项目", value: stats.projects, icon: Database, href: "/?view=projects", helper: "查看项目库" },
    { label: "专家", value: stats.experts, icon: UserCheck, href: "/?view=experts", helper: "查看专家库" },
    { label: "待复核", value: stats.review, icon: ShieldCheck, href: "/?view=review", helper: "处理复核任务" },
    { label: "渠道", value: stats.marketingPosts, icon: Megaphone, href: "/?view=channels", helper: "查看渠道队列" },
  ];
  const items = selectedProjectId && isProjectView(selectedView) ? projectItems : workspaceItems;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <Link
          key={item.label}
          href={item.href}
          aria-label={`${item.label}：${item.value}，${item.helper}`}
          className="group rounded-lg border border-[#e2e6ea] bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(17,17,17,0.04)] transition hover:border-[#9db7d3] hover:bg-[#fbfdff] focus:outline-none focus:ring-2 focus:ring-[#bfdbfe]"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[#7a7469] group-hover:text-[#5f5a50]">{item.label}</span>
            <item.icon className="size-4 text-[#aaa398] group-hover:text-[#2563eb]" />
          </div>
          <p className="mt-1 text-xl font-semibold tabular-nums text-[#28251e]">{item.value}</p>
        </Link>
      ))}
    </div>
  );
}

function RecruitmentList({
  projects,
  selectedProjectId,
}: {
  projects: Array<{
    id: string;
    title: string;
    status: string;
    riskLevel: string;
    domain: string | null;
    taskType: string | null;
    quantity: number | null;
    updatedAt: Date;
    candidates: Array<{ id: string }>;
  }>;
  selectedProjectId: string | null;
}) {
  return (
    <section data-recruitment-list className="grid gap-4">
      <div className="grid gap-4 rounded-lg border border-[#e7e7e2] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9a9388]">项目库</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.01em] text-[#28251e]">招募项目列表</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5a50]">
            管理专家招募项目，查看进展并进入对应工作流。
          </p>
        </div>
        <a
          href="#create-project"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#28251e] px-4 text-sm font-semibold text-white transition hover:bg-black"
        >
          <Sparkles className="size-4" />
          新建招募项目
        </a>
      </div>

      <CreateProjectPanel />

      <div className="grid gap-3">
        {projects.map((project) => (
          <a
            key={project.id}
            href={`/?project=${project.id}&view=demand`}
            className={`grid gap-3 rounded-lg border bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)] transition hover:border-[#2563eb33] hover:bg-[#fbfdff] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center ${
              selectedProjectId === project.id ? "border-[#2563eb55]" : "border-[#e7e7e2]"
            }`}
          >
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-[#28251e]">{project.title}</span>
                <RiskBadge risk={project.riskLevel} />
                <Badge tone="blue">{formatProjectStatus(project.status)}</Badge>
              </span>
              <span className="mt-2 block text-sm leading-6 text-[#5f5a50]">
                {[project.domain, project.taskType, project.quantity ? `${project.quantity} 位专家` : null].filter(Boolean).join(" · ") || "需求待完善"}
              </span>
            </span>
            <span className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:w-[360px]">
              <Info label="候选" value={project.candidates.length.toString()} />
              <Info label="状态" value={formatProjectStatus(project.status)} />
              <Info label="更新" value={project.updatedAt.toLocaleDateString("zh-CN")} />
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

function ProjectSelectionGate({
  projects,
  targetView,
}: {
  projects: Array<{
    id: string;
    title: string;
    status: string;
    riskLevel: string;
    domain: string | null;
    taskType: string | null;
    quantity: number | null;
    updatedAt: Date;
    candidates: Array<{
      id: string;
      humanReviewNeeded: boolean;
      stage: string;
      expert: { evidenceLevel: string };
    }>;
  }>;
  targetView: string;
}) {
  const target = formatViewName(targetView);
  return (
    <section data-project-selection-gate className="grid gap-4">
      <div className="rounded-lg border border-[#e7e7e2] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9a9388]">选择招募项目</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.01em] text-[#28251e]">进入{target}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5a50]">
              {target}需要先确定一个招募项目。选择项目后会进入对应工作区，项目可以随时在页面顶部切换。
            </p>
          </div>
          <Link
            href="/?view=projects#create-project"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#28251e] px-4 text-sm font-semibold text-white transition hover:bg-black"
          >
            <Sparkles className="size-4" />
            新建招募项目
          </Link>
        </div>
      </div>

      <div className="grid gap-3">
        {projects.map((project) => {
          const reviewCount = project.candidates.filter(needsCandidateReview).length;
          const highEvidenceCount = project.candidates.filter(isHighEvidenceCandidate).length;
          const activeCount = project.candidates.filter((candidate) => ["onboarded", "active"].includes(candidate.stage)).length;
          return (
            <Link
              key={project.id}
              href={`/?project=${project.id}&view=${targetView}`}
              className="grid gap-4 rounded-lg border border-[#e7e7e2] bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)] transition hover:border-[#2563eb33] hover:bg-[#fbfdff] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-[#28251e]">{project.title}</span>
                  <RiskBadge risk={project.riskLevel} />
                  <Badge tone="blue">{formatProjectStatus(project.status)}</Badge>
                </span>
                <span className="mt-2 block text-sm leading-6 text-[#5f5a50]">
                  {[project.domain, project.taskType, project.quantity ? `${project.quantity} 位专家` : null].filter(Boolean).join(" · ") || "需求待完善"}
                </span>
              </span>
              <span className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[520px]">
                <Info label="候选" value={project.candidates.length.toString()} />
                <Info label="高证据" value={highEvidenceCount.toString()} />
                <Info label="待复核" value={reviewCount.toString()} />
                <Info label="入池" value={activeCount.toString()} />
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function ProjectWorkspace({
  project,
  projects,
  selectedCandidate,
  selectedView,
  selectedPostId,
  candidateFilter,
  candidateSourceRunId,
  mergeSuggestions,
  selectedChannel,
  selectedStatus,
}: {
  project: ProjectWorkspaceData;
  projects: Array<{
    id: string;
    title: string;
    status: string;
    candidates: Array<{ id: string }>;
  }>;
  selectedCandidate: CandidateWorkspaceData | null;
  selectedView: CanonicalView;
  selectedPostId: string | null;
  candidateFilter: CandidateFilter;
  candidateSourceRunId: string | null;
  mergeSuggestions: MergeSuggestionData[];
  selectedChannel: string;
  selectedStatus: MarketingPostStatusFilter;
}) {
  const serialized = serializeProject(project);
  const persona = parseJson<{
    summary?: string;
    mustHave?: string[];
    niceToHave?: string[];
    evidenceRequirements?: string[];
    humanReviewPoints?: string[];
  }>(project.personaJson, {});
  return (
    <div className="grid gap-4">
      <div className="grid gap-4">
        <section className="sticky top-0 z-20 overflow-visible rounded-lg border border-[#e2e6ea] bg-white shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
          <div className="grid gap-3 border-b border-[#edf0f2] p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start lg:p-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-start gap-3">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#eef5ff] text-[#2563eb]">
                  <HomeIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="max-w-full break-words text-xl font-semibold leading-tight text-[#28251e]">
                      {project.title}
                    </h1>
                    <RiskBadge risk={project.riskLevel} />
                    <Badge tone="blue">{formatProjectStatus(project.status)}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-1 max-w-5xl text-sm leading-6 text-[#5f5a50]">{project.rawDemand}</p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-2 lg:justify-end">
              <ProjectPrimaryAction project={project} selectedView={selectedView} />
              <AgentDrawer project={project} />
              <ProjectSwitcher projects={projects} project={project} selectedView={selectedView} />
            </div>
          </div>

          <ProjectStepTabs projectId={project.id} selectedView={selectedView} />
        </section>

        <RecruitmentFlowBar project={project} selectedView={selectedView} />
        <LatestAgentRunCard project={project} />

        {selectedView === "demand" ? (
          <DemandAndIntakeModule project={project} persona={persona} searchQueries={serialized.searchQueries} />
        ) : selectedView === "supply" ? (
          <SupplyDiscoveryModule project={project} mergeSuggestions={mergeSuggestions} />
        ) : selectedView === "pipeline" ? (
          <SourcingModule
            project={project}
            selectedCandidateId={selectedCandidate?.id}
            candidateFilter={candidateFilter}
            candidateSourceRunId={candidateSourceRunId}
          />
        ) : selectedView === "growth" ? (
          <GrowthAndRetrospectiveModule project={project} selectedPostId={selectedPostId} selectedChannel={selectedChannel} selectedStatus={selectedStatus} />
        ) : (
          <DemandAndIntakeModule project={project} persona={persona} searchQueries={serialized.searchQueries} />
        )}
      </div>
    </div>
  );
}

function ProjectPrimaryAction({ project, selectedView }: { project: ProjectWorkspaceData; selectedView: CanonicalView }) {
  const recommended = getRecommendedProjectAction(project);
  if (recommended.kind === "agent") {
    return (
      <ApiButton
        label={recommended.label}
        endpoint={`/api/projects/${project.id}/run`}
        icon="run"
        variant="primary"
        successLabel="执行计划已生成。"
      />
    );
  }
  if (selectedView === "demand") {
    return <ApiButton label="补齐需求画像" endpoint={`/api/projects/${project.id}/analyze`} icon="analyze" variant="primary" />;
  }
  if (selectedView === "supply") {
    return <ApiButton label="召回内部专家" endpoint={`/api/projects/${project.id}/internal-match`} icon="run" variant="primary" successLabel="内部专家召回已完成。" />;
  }
  if (selectedView === "pipeline") {
    const candidate = project.candidates.find(
      (item) => item.fitScore === null && isCandidateEligibleForSupplyMetrics(item),
    );
    return candidate ? (
      <ApiButton label="补评候选" endpoint={`/api/project-candidates/${candidate.id}/score`} icon="analyze" variant="primary" />
    ) : (
      <Link href={`/?project=${project.id}&view=supply`} className="inline-flex h-9 items-center justify-center rounded-lg bg-[#28251e] px-3 text-sm font-semibold text-white transition hover:bg-black">
        补充候选
      </Link>
    );
  }
  if (selectedView === "growth") {
    return <ApiButton label="生成分发内容" endpoint={`/api/projects/${project.id}/marketing`} icon="marketing" variant="primary" />;
  }
  return null;
}

function RecruitmentFlowBar({ project, selectedView }: { project: ProjectWorkspaceData; selectedView: CanonicalView }) {
  const profileReady = Object.keys(parseJson<Record<string, unknown>>(project.personaJson, {})).length > 0;
  const internalCount = project.candidates.filter(
    (candidate) => candidate.sourceType === "internal" && isCandidateEligibleForSupplyMetrics(candidate),
  ).length;
  const externalCount = project.candidates.filter(
    (candidate) => candidate.sourceType === "external" && isCandidateEligibleForSupplyMetrics(candidate),
  ).length;
  const reviewCount = project.candidates.filter(needsCandidateReview).length;
  const outreachReady = countOutreachReady(project);
  const recommended = getRecommendedProjectAction(project);
  const steps = [
    { id: "demand", label: "确认需求", href: `/?project=${project.id}&view=demand`, done: profileReady, active: selectedView === "demand", value: profileReady ? "已画像" : "待补齐" },
    { id: "supply", label: "内部召回", href: `/?project=${project.id}&view=supply`, done: internalCount > 0, active: selectedView === "supply", value: `${internalCount} 位` },
    { id: "supply-external", label: "补充公开候选", href: `/?project=${project.id}&view=supply`, done: externalCount > 0, active: false, value: `${externalCount} 位` },
    { id: "pipeline", label: "候选复核", href: `/?project=${project.id}&view=pipeline&candidateFilter=review`, done: reviewCount === 0 && project.candidates.length > 0, active: selectedView === "pipeline", value: `${reviewCount} 待处理` },
    { id: "outreach", label: "触达/试标", href: `/?project=${project.id}&view=pipeline&candidateFilter=outreachReady`, done: outreachReady > 0, active: false, value: `${outreachReady} 可触达` },
  ];
  return (
    <section data-recruitment-flow className="rounded-lg border border-[#dbe4ee] bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="size-4 text-[#2563eb]" />
            <h2 className="text-sm font-semibold text-[#28251e]">当前招募路径</h2>
            <Badge tone={recommended.tone}>{recommended.stage}</Badge>
          </div>
          <p className="mt-1 text-sm leading-6 text-[#5f5a50]">{recommended.description}</p>
        </div>
        <PrimaryFlowAction project={project} action={recommended} />
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-5">
        {steps.map((step, index) => (
          <Link
            key={step.id}
            href={step.href}
            className={`rounded-lg border px-3 py-3 transition ${
              step.active
                ? "border-[#9db7d3] bg-[#eef5ff]"
                : step.done
                  ? "border-emerald-100 bg-emerald-50/70 hover:border-emerald-200"
                  : "border-[#edf0f2] bg-[#f8fafc] hover:border-[#ccd6df] hover:bg-white"
            }`}
          >
            <span className="flex items-center gap-2">
              <span className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step.done ? "bg-emerald-600 text-white" : step.active ? "bg-[#2563eb] text-white" : "bg-white text-[#7a7469]"}`}>
                {step.done ? <CheckCircle2 className="size-3.5" /> : index + 1}
              </span>
              <span className="min-w-0 truncate text-sm font-semibold text-[#28251e]">{step.label}</span>
            </span>
            <span className="mt-2 block truncate text-xs text-[#7a7469]">{step.value}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

type RecommendedProjectAction =
  | { kind: "button"; label: string; endpoint: string; icon: "analyze" | "run" | "search" | "marketing"; stage: string; description: string; tone: "blue" | "amber" | "green" | "red" | "indigo" | "zinc"; confirmMessage?: string }
  | { kind: "link"; label: string; href: string; stage: string; description: string; tone: "blue" | "amber" | "green" | "red" | "indigo" | "zinc" }
  | { kind: "agent"; label: string; stage: string; description: string; tone: "blue" | "amber" | "green" | "red" | "indigo" | "zinc" };

function getRecommendedProjectAction(project: ProjectWorkspaceData): RecommendedProjectAction {
  const profileReady = Object.keys(parseJson<Record<string, unknown>>(project.personaJson, {})).length > 0;
  const internalCount = project.candidates.filter(
    (candidate) => candidate.sourceType === "internal" && isCandidateEligibleForSupplyMetrics(candidate),
  ).length;
  const highEvidenceCount = project.candidates.filter(isHighEvidenceCandidate).length;
  const reviewCount = project.candidates.filter(needsCandidateReview).length;
  const outreachReady = countOutreachReady(project);
  if (!profileReady) {
    return {
      kind: "button",
      label: "补齐需求画像",
      endpoint: `/api/projects/${project.id}/analyze`,
      icon: "analyze",
      stage: "先确认需求",
      description: "先把项目需求整理成专家画像、证据要求和搜索方向。",
      tone: "amber",
    };
  }
  if (!internalCount) {
    return {
      kind: "button",
      label: "召回内部专家",
      endpoint: `/api/projects/${project.id}/internal-match`,
      icon: "run",
      stage: "优先复用内部供给",
      description: "先从专家库和历史合作记录中找可复用候选。",
      tone: "blue",
    };
  }
  if (reviewCount > 0) {
    return {
      kind: "link",
      label: "处理候选复核",
      href: `/?project=${project.id}&view=pipeline&candidateFilter=review`,
      stage: "处理候选准入",
      description: `${reviewCount} 位候选需要补证据、确认许可或完成人工复核。`,
      tone: "amber",
    };
  }
  if (highEvidenceCount < Math.min(project.quantity ?? 5, 5)) {
    return {
      kind: "button",
      label: "确认补充公开候选",
      endpoint: `/api/projects/${project.id}/external-research`,
      icon: "search",
      stage: "供给不足",
      description: "内部高证据候选不足，确认后再调用外部搜索服务补充公开候选。",
      tone: "indigo",
      confirmMessage: "本次会创建外部深搜任务；执行搜索前仍需要在招募助手中确认。继续？",
    };
  }
  if (outreachReady > 0) {
    return {
      kind: "link",
      label: "推进触达",
      href: `/?project=${project.id}&view=pipeline&candidateFilter=outreachReady`,
      stage: "可以触达",
      description: `${outreachReady} 位候选已满足触达门禁，可生成触达草稿或安排试标。`,
      tone: "green",
    };
  }
  return {
    kind: "agent",
    label: "生成完整执行计划",
    stage: "继续推进",
    description: "让招募助手重新整理画像、召回、缺口和排序，给出下一步建议。",
    tone: "blue",
  };
}

function PrimaryFlowAction({ project, action }: { project: ProjectWorkspaceData; action: RecommendedProjectAction }) {
  if (action.kind === "link") {
    return (
      <Link href={action.href} className="inline-flex h-10 items-center justify-center rounded-lg bg-[#28251e] px-4 text-sm font-semibold text-white transition hover:bg-black">
        {action.label}
      </Link>
    );
  }
  if (action.kind === "agent") {
    return (
      <ApiButton
        label={action.label}
        endpoint={`/api/projects/${project.id}/run`}
        icon="run"
        variant="primary"
        successLabel="执行计划已生成。"
      />
    );
  }
  return (
    <ApiButton
      label={action.label}
      endpoint={action.endpoint}
      icon={action.icon}
      variant="primary"
      confirmMessage={action.confirmMessage}
      successLabel="已更新，正在刷新。"
    />
  );
}

function LatestAgentRunCard({ project }: { project: ProjectWorkspaceData }) {
  const latest = project.agentTaskRuns[0];
  if (!latest) return null;
  const report = parseJson<{
    summary?: string;
    completed?: string[];
    failed?: string[];
    written?: string[];
    needsReview?: string[];
    nextActions?: string[];
  }>(latest.reportJson, {});
  const isWaiting = latest.status === "waiting_for_confirmation";
  const isRunning = latest.status === "running" || latest.status === "planned";
  return (
    <section data-latest-agent-run className="rounded-lg border border-[#e7e7e2] bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <MessageSquare className="size-4 text-[#2563eb]" />
            <h2 className="text-sm font-semibold text-[#28251e]">最近一次招募助手</h2>
            <Badge tone={agentRunStatusTone(latest.status)}>{formatAgentRunStatus(latest.status)}</Badge>
          </div>
          <p className="mt-1 text-sm leading-6 text-[#5f5a50]">{report.summary ?? "执行记录已保存。"}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(report.written ?? []).slice(0, 3).map((item) => <Badge key={item} tone="blue">{item}</Badge>)}
            {(report.needsReview ?? []).slice(0, 2).map((item) => <Badge key={item} tone="amber">{item}</Badge>)}
            {(report.failed ?? []).slice(0, 1).map((item) => <Badge key={item} tone="red">{item}</Badge>)}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          {isWaiting ? (
            <Link href={`/?project=${project.id}&view=supply`} className="inline-flex h-9 items-center justify-center rounded-lg bg-[#2563eb] px-3 text-sm font-semibold text-white transition hover:bg-[#1d4ed8]">
              查看确认项
            </Link>
          ) : null}
          {isRunning ? (
            <Link href={`/?project=${project.id}&view=demand`} className="inline-flex h-9 items-center justify-center rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm font-semibold text-[#28251e] transition hover:bg-[#f9f9f9]">
              查看进度
            </Link>
          ) : null}
          <Link href={`/?project=${project.id}&view=pipeline&candidateFilter=review`} className="inline-flex h-9 items-center justify-center rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm font-semibold text-[#28251e] transition hover:bg-[#f9f9f9]">
            处理候选
          </Link>
        </div>
      </div>
    </section>
  );
}

function AgentDrawer({ project }: { project: ProjectWorkspaceData }) {
  return (
    <details className="relative z-[80]">
      <summary className="inline-flex h-9 cursor-pointer list-none items-center justify-center gap-2 rounded-lg border border-[#dbe4ee] bg-white px-3 text-sm font-semibold text-[#28251e] transition hover:border-[#9db7d3] hover:bg-[#fbfdff] [&::-webkit-details-marker]:hidden">
        <MessageSquare className="size-4 text-[#2563eb]" />
        招募助手
      </summary>
      <div className="fixed inset-x-4 top-24 z-[90] max-h-[calc(100vh-7rem)] overflow-y-auto rounded-lg border border-[#dbe4ee] bg-white p-4 shadow-[0_18px_45px_rgba(17,17,17,0.12)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-[min(760px,calc(100vw-2rem))]">
        <AgentCommandForm
          projectId={project.id}
          projectTitle={project.title}
          initialRun={project.agentTaskRuns[0] ? serializeAgentRun(project.agentTaskRuns[0]) : null}
          initialRuns={project.agentTaskRuns.map((run) => serializeAgentRun(run))}
        />
      </div>
    </details>
  );
}

function ProjectSwitcher({
  projects,
  project,
  selectedView,
}: {
  projects: Array<{
    id: string;
    title: string;
    status: string;
    candidates: Array<{ id: string }>;
  }>;
  project: ProjectWorkspaceData;
  selectedView: CanonicalView;
}) {
  return (
    <details className="relative w-full sm:w-[220px]">
      <summary className="flex h-9 cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-[#dbe4ee] bg-[#f8fafc] px-3 text-sm font-semibold text-[#28251e] transition hover:border-[#9db7d3] [&::-webkit-details-marker]:hidden">
        <span className="truncate">切换项目</span>
        <ArrowRight className="size-4 rotate-90 text-[#9a9388]" />
      </summary>
      <div className="absolute right-0 z-30 mt-2 grid max-h-80 w-full gap-1 overflow-y-auto rounded-lg border border-[#dbe4ee] bg-white p-2 shadow-[0_18px_45px_rgba(17,17,17,0.12)]">
        {projects.map((item) => (
          <Link
            key={item.id}
            href={`/?project=${item.id}&view=${selectedView}`}
            className={`grid gap-1 rounded-lg px-3 py-2 text-sm transition ${
              item.id === project.id ? "bg-[#eef5ff] text-[#28251e]" : "text-[#5f5a50] hover:bg-[#f8fafc] hover:text-[#28251e]"
            }`}
          >
            <span className="truncate font-semibold">{item.title}</span>
            <span className="truncate text-xs text-[#8c8578]">{item.candidates.length} 候选 / {formatProjectStatus(item.status)}</span>
          </Link>
        ))}
        <Link href="/?view=projects#create-project" className="mt-1 rounded-lg border border-dashed border-[#d8d8d0] px-3 py-2 text-sm font-semibold text-[#2563eb] hover:bg-[#fbfdff]">
          新建招募项目
        </Link>
      </div>
    </details>
  );
}

function ProjectStepTabs({ projectId, selectedView }: { projectId: string; selectedView: CanonicalView }) {
  const steps = getProjectSteps(projectId, selectedView);
  return (
    <div data-project-steps className="grid grid-cols-2 gap-2 p-3 sm:flex sm:overflow-x-auto lg:px-4">
      {steps.map((step) => (
        <Link
          key={step.id}
          href={step.href}
          className={`inline-flex h-9 shrink-0 items-center justify-center rounded-lg border px-3 text-sm font-semibold leading-none transition ${
            step.active
              ? "border-[#9db7d3] bg-[#eef5ff] text-[#1f3b57]"
              : "border-[#e2e6ea] bg-white text-[#5f5a50] hover:border-[#ccd6df] hover:bg-[#f8fafc] hover:text-[#28251e]"
          }`}
        >
          {step.label}
        </Link>
      ))}
    </div>
  );
}

function WorkspaceCommandCenter({
  projects,
  selectedProject,
  stats,
}: {
  projects: Array<{
    id: string;
    title: string;
    status: string;
    riskLevel: string;
    domain: string | null;
    taskType: string | null;
    quantity: number | null;
    candidates: Array<{
      id: string;
      stage: string;
      sourceType: string;
      humanReviewNeeded: boolean;
      expert: { evidenceLevel: string };
    }>;
  }>;
  selectedProject: ProjectWorkspaceData | null;
  stats: Record<string, number>;
}) {
  const rankedProjects = projects
    .map((project) => ({
      project,
      reviewCount: project.candidates.filter(needsCandidateReview).length,
      activeCount: project.candidates.filter((candidate) => ["onboarded", "active"].includes(candidate.stage)).length,
      highEvidenceCount: project.candidates.filter(isHighEvidenceCandidate).length,
      internalCount: project.candidates.filter(
        (candidate) => candidate.sourceType === "internal" && isCandidateEligibleForSupplyMetrics(candidate),
      ).length,
    }))
    .sort((a, b) => riskPriority(b.project.riskLevel) - riskPriority(a.project.riskLevel) || b.reviewCount - a.reviewCount || b.highEvidenceCount - a.highEvidenceCount)
    .slice(0, 6);

  if (!selectedProject) {
    return (
      <section className="grid gap-4">
        <div className="rounded-lg border border-[#e2e6ea] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <div>
              <h1 className="text-xl font-semibold text-[#28251e]">招募助手</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5a50]">
                选择一个项目后，先让助手生成执行计划，再确认召回、搜索、复核和触达准备。
              </p>
            </div>
            <Link href="/?view=projects#create-project" className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#28251e] px-3 text-sm font-semibold text-white transition hover:bg-black">
              <Sparkles className="size-4" />
              创建项目
            </Link>
          </div>
        </div>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="grid gap-4">
            <Panel title="描述需求开始">
              <QuickProjectStartForm />
            </Panel>
            <Panel title="继续一个项目">
              <div className="grid max-h-[360px] gap-2 overflow-y-auto pr-1">
                {rankedProjects.map(({ project, reviewCount, activeCount, highEvidenceCount, internalCount }) => {
                  const action = getWorkspaceProjectAction(project, { reviewCount, activeCount, highEvidenceCount, internalCount });
                  return (
                    <Link key={project.id} href={`/?project=${project.id}&view=agent`} className="grid gap-3 rounded-lg border border-[#edf0f2] bg-[#f8fafc] p-3 transition hover:border-[#9db7d3] hover:bg-white">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-[#28251e]">{project.title}</span>
                        <RiskBadge risk={project.riskLevel} />
                        <Badge tone={action.tone}>{action.label}</Badge>
                      </span>
                      <span className="text-sm text-[#5f5a50]">
                        {[project.domain, project.taskType, project.quantity ? `${project.quantity} 位专家` : null].filter(Boolean).join(" · ") || "需求待完善"}
                      </span>
                      <span className="grid grid-cols-4 gap-2">
                        <Info label="内部" value={internalCount.toString()} />
                        <Info label="高证据" value={highEvidenceCount.toString()} />
                        <Info label="待复核" value={reviewCount.toString()} />
                        <Info label="入池" value={activeCount.toString()} />
                      </span>
                      <span className="text-xs leading-5 text-[#7a7469]">下一步：{action.description}</span>
                    </Link>
                  );
                })}
                {!rankedProjects.length ? <p className="rounded-lg border border-dashed border-[#d8d8d0] bg-[#f9f9f9] p-4 text-sm text-[#7a7469]">先创建一个招募项目。</p> : null}
              </div>
            </Panel>
          </section>

          <div className="grid content-start gap-4">
            <NewUserGuide
              title="推荐路径"
              steps={[
                "选择或创建项目",
                "生成执行计划",
                "确认敏感动作",
                "处理复核和试标",
              ]}
            />
            <Panel title="工作量概览">
              <FunnelRow label="项目" value={stats.projects} tone="blue" href="/?view=projects" />
              <FunnelRow label="待复核" value={stats.review} tone="amber" href="/?view=review" />
              <FunnelRow label="高证据候选" value={stats.highEvidence} tone="green" href="/?view=projects" />
              <FunnelRow label="可触达" value={stats.outreachReady} tone="blue" href="/?view=projects" />
            </Panel>
          </div>
        </section>
      </section>
    );
  }

  const projectReviewCount = selectedProject.candidates.filter(needsCandidateReview).length;
  const internalCount = selectedProject.candidates.filter(
    (candidate) => candidate.sourceType === "internal" && isCandidateEligibleForSupplyMetrics(candidate),
  ).length;
  const externalCount = selectedProject.candidates.filter(
    (candidate) => candidate.sourceType === "external" && isCandidateEligibleForSupplyMetrics(candidate),
  ).length;
  const highEvidenceCount = selectedProject.candidates.filter(isHighEvidenceCandidate).length;
  const outreachReady = countOutreachReady(selectedProject);
  const activeCount = selectedProject.candidates.filter((candidate) => ["onboarded", "active"].includes(candidate.stage)).length;
  const recommended = getWorkspaceProjectAction(selectedProject, { reviewCount: projectReviewCount, activeCount, highEvidenceCount, internalCount });
  const headerPrimaryAction =
    projectReviewCount > 0
      ? { href: `/?project=${selectedProject.id}&view=pipeline&candidateFilter=review`, label: "处理复核" }
      : { href: "#agent-command", label: "生成执行计划" };

  return (
    <section className="grid gap-4">
      <div className="rounded-lg border border-[#e2e6ea] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-[#28251e]">招募助手</h1>
              <Badge tone={recommended.tone}>{recommended.label}</Badge>
            </div>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-[#5f5a50]">
              当前项目：{selectedProject.title}。先生成计划，再执行可恢复的步骤；外部搜索、触达和发布仍需要人工确认。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <a href={headerPrimaryAction.href} className="inline-flex h-9 items-center justify-center rounded-lg bg-[#28251e] px-3 text-sm font-semibold text-white transition hover:bg-black">
              {headerPrimaryAction.label}
            </a>
            <Link href={`/?project=${selectedProject.id}&view=demand`} className="inline-flex h-9 items-center justify-center rounded-lg border border-[#dbe4ee] bg-white px-3 text-sm font-semibold text-[#28251e] transition hover:border-[#9db7d3] hover:bg-[#fbfdff]">
              项目详情
            </Link>
          </div>
        </div>
      </div>

      <section className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <div className="order-2 grid content-start gap-4 xl:order-1">
          <Panel title="当前项目">
            <div className="grid gap-2">
              <Info label="目标" value={selectedProject.quantity?.toString() ?? "-"} />
              <Info label="内部召回" value={internalCount.toString()} href={`/?project=${selectedProject.id}&view=supply`} />
              <Info label="外部发现" value={externalCount.toString()} href={`/?project=${selectedProject.id}&view=pipeline&candidateFilter=external`} />
              <Info label="高证据" value={highEvidenceCount.toString()} href={`/?project=${selectedProject.id}&view=pipeline&candidateFilter=highEvidence`} />
              <Info label="待复核" value={projectReviewCount.toString()} href={`/?project=${selectedProject.id}&view=pipeline&candidateFilter=review`} />
              <Info label="可触达" value={outreachReady.toString()} href={`/?project=${selectedProject.id}&view=pipeline&candidateFilter=outreachReady`} />
            </div>
          </Panel>
        </div>

        <section id="agent-command" className="order-1 scroll-mt-4 rounded-lg border border-[#e7e7e2] bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)] xl:order-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[#28251e]">和招募助手推进</h2>
              <p className="mt-1 text-sm leading-6 text-[#5f5a50]">选择下一步工作，先看计划和检查结果，再执行。</p>
            </div>
            <Badge tone={selectedProject.riskLevel === "regulated" || selectedProject.riskLevel === "high" ? "red" : "amber"}>
              {formatRiskLevel(selectedProject.riskLevel)}
            </Badge>
          </div>
          <AgentCommandForm
            key={selectedProject.id}
            projectId={selectedProject.id}
            projectTitle={selectedProject.title}
            initialRun={selectedProject.agentTaskRuns[0] ? serializeAgentRun(selectedProject.agentTaskRuns[0]) : null}
            initialRuns={selectedProject.agentTaskRuns.map((run) => serializeAgentRun(run))}
          />
        </section>
      </section>
    </section>
  );
}

function ChannelsCenter({
  selectedProject,
  projects,
  posts,
  selectedPostId,
  selectedChannel,
  selectedStatus,
}: {
  selectedProject: ProjectWorkspaceData | null;
  projects: Array<{ id: string; title: string; candidates: Array<{ id: string }> }>;
  posts: WorkspaceMarketingPostData[];
  selectedPostId: string | null;
  selectedChannel: string;
  selectedStatus: MarketingPostStatusFilter;
}) {
  return (
    <WorkspaceChannelsModule
      projects={projects}
      posts={posts}
      selectedProject={selectedProject}
      selectedPostId={selectedPostId}
      selectedChannel={selectedChannel}
      selectedStatus={selectedStatus}
    />
  );
}

function AnalyticsCenter({
  projects,
  selectedProject,
}: {
  projects: Array<{ id: string; title: string; candidates: Array<{ id: string }> }>;
  selectedProject: ProjectWorkspaceData | null;
}) {
  if (selectedProject) return <RecruitmentRetrospectiveModule project={selectedProject} />;
  const totalCandidates = projects.reduce((sum, project) => sum + project.candidates.length, 0);
  return (
    <section className="grid gap-4">
      <div className="rounded-lg border border-[#e2e6ea] bg-white p-5">
        <h1 className="text-xl font-semibold text-[#28251e]">数据复盘</h1>
        <p className="mt-2 text-sm leading-6 text-[#5f5a50]">查看跨项目供给漏斗，进入项目后可生成详细复盘。</p>
      </div>
      <section className="grid gap-4 md:grid-cols-3">
        <Panel title="项目规模">
          <Info label="项目" value={projects.length.toString()} />
        </Panel>
        <Panel title="候选规模">
          <Info label="候选" value={totalCandidates.toString()} />
        </Panel>
        <Panel title="项目复盘">
          <div className="grid gap-2">
            {projects.slice(0, 6).map((project) => (
              <Link key={project.id} href={`/?project=${project.id}&view=growth`} className="rounded-lg border border-[#edf0f2] bg-[#f8fafc] px-3 py-2 text-sm font-semibold text-[#28251e] transition hover:border-[#9db7d3] hover:bg-white">
                {project.title}
              </Link>
            ))}
          </div>
        </Panel>
      </section>
    </section>
  );
}

function DemandAndIntakeModule({
  project,
  persona,
  searchQueries,
}: {
  project: ProjectWorkspaceData;
  persona: {
    summary?: string;
    mustHave?: string[];
    niceToHave?: string[];
    evidenceRequirements?: string[];
    humanReviewPoints?: string[];
  };
  searchQueries: string[];
}) {
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid gap-4">
        <RecruitmentAssetModule project={project} persona={persona} searchQueries={searchQueries} />
      </div>
      <Panel title="项目摘要">
        <Info label="领域" value={project.domain ?? "-"} />
        <div className="mt-2">
          <Info label="任务" value={project.taskType ?? "-"} />
        </div>
        <div className="mt-2">
          <Info label="目标专家" value={project.quantity?.toString() ?? "-"} />
        </div>
        <div className="mt-2">
          <Info label="风险等级" value={formatRiskLevel(project.riskLevel)} />
        </div>
      </Panel>
    </section>
  );
}

function SupplyDiscoveryModule({
  project,
  mergeSuggestions,
}: {
  project: ProjectWorkspaceData;
  mergeSuggestions: MergeSuggestionData[];
}) {
  return (
    <section className="grid gap-4">
      <SupplyMatchingModule project={project} />
      <ExpertDiscoveryModule project={project} mergeSuggestions={mergeSuggestions} />
    </section>
  );
}

function GrowthAndRetrospectiveModule({
  project,
  selectedPostId,
  selectedChannel,
  selectedStatus,
}: {
  project: ProjectWorkspaceData;
  selectedPostId: string | null;
  selectedChannel?: string;
  selectedStatus?: MarketingPostStatusFilter;
}) {
  return (
    <section className="grid gap-4">
      <MarketingModule project={project} selectedPostId={selectedPostId} selectedChannel={selectedChannel ?? "all"} selectedStatus={selectedStatus ?? "all"} />
      <RecruitmentRetrospectiveModule project={project} />
    </section>
  );
}

function WorkspaceChannelsModule({
  projects,
  posts,
  selectedProject,
  selectedPostId,
  selectedChannel,
  selectedStatus,
}: {
  projects: Array<{ id: string; title: string; candidates: Array<{ id: string }> }>;
  posts: WorkspaceMarketingPostData[];
  selectedProject: ProjectWorkspaceData | null;
  selectedPostId: string | null;
  selectedChannel: string;
  selectedStatus: MarketingPostStatusFilter;
}) {
  const scopedPosts = selectedProject ? posts.filter((post) => post.projectId === selectedProject.id) : posts;
  const visiblePosts = filterMarketingPosts(scopedPosts, selectedChannel, selectedStatus);
  const selectedPost = visiblePosts.find((post) => post.id === selectedPostId) ?? visiblePosts[0] ?? scopedPosts.find((post) => post.id === selectedPostId) ?? null;
  const counts = marketingStatusCounts(scopedPosts, selectedChannel);
  const channelCounts = getChannelCounts(scopedPosts);

  return (
    <section className="grid gap-4">
      <section className="rounded-lg border border-[#e2e6ea] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
          <div>
            <div className="flex items-center gap-2">
              <Megaphone className="size-5 text-[#2563eb]" />
              <h1 className="text-xl font-semibold text-[#28251e]">渠道中心</h1>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5a50]">按渠道处理招募内容，复核文案、审批发布稿并确认各平台发布进展。</p>
          </div>
          <ProjectChannelScope projects={projects} selectedProject={selectedProject} selectedChannel={selectedChannel} selectedStatus={selectedStatus} />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
          <ChannelMetricLink href={workspaceMarketingFilterHref(selectedProject?.id ?? null, selectedChannel, "all")} label="内容" value={counts.all} active={selectedStatus === "all"} />
          <ChannelMetricLink href={workspaceMarketingFilterHref(selectedProject?.id ?? null, selectedChannel, "needs_review")} label="待复核" value={counts.needsReview} active={selectedStatus === "needs_review"} tone="amber" />
          <ChannelMetricLink href={workspaceMarketingFilterHref(selectedProject?.id ?? null, selectedChannel, "approved")} label="可发布" value={counts.approved} active={selectedStatus === "approved"} tone="blue" />
          <ChannelMetricLink href={workspaceMarketingFilterHref(selectedProject?.id ?? null, selectedChannel, "published")} label="已确认进展" value={counts.published} active={selectedStatus === "published"} tone="green" />
          <ChannelMetricLink href={workspaceMarketingFilterHref(selectedProject?.id ?? null, selectedChannel, "draft")} label="草稿" value={counts.draft} active={selectedStatus === "draft"} />
        </div>

        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          <ChannelTab href={workspaceMarketingFilterHref(selectedProject?.id ?? null, "all", selectedStatus)} label="全部渠道" value={scopedPosts.length} active={selectedChannel === "all"} />
          {channelCounts.map((item) => (
            <ChannelTab
              key={item.channel}
              href={workspaceMarketingFilterHref(selectedProject?.id ?? null, item.channel, selectedStatus)}
              label={formatChannel(item.channel)}
              value={item.count}
              active={selectedChannel === item.channel}
            />
          ))}
        </div>
      </section>

      {!posts.length ? (
        <NewUserGuide
          title="渠道内容从这里开始"
          steps={[
            "进入项目的分发与复盘，生成多渠道草稿。",
            "回到渠道中心按平台复核标题、正文和行动按钮。",
            "审批通过后，人工发布到对应渠道。",
            "发布后确认进展，后续用于项目复盘。",
          ]}
        />
      ) : null}

      <section data-channel-center-workspace className="grid gap-4 lg:grid-cols-[minmax(280px,0.42fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3 rounded-lg border border-[#e7e7e2] bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)] lg:p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-semibold text-[#28251e]">发布队列</h3>
              <p className="mt-1 text-xs text-[#7a7469]">{selectedProject ? selectedProject.title : "全部项目"} · {formatChannelFilter(selectedChannel)} · {formatPostStatusFilter(selectedStatus)}</p>
            </div>
            <Badge>{visiblePosts.length} 条</Badge>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <MiniFilterLink href={workspaceMarketingFilterHref(selectedProject?.id ?? null, selectedChannel, "needs_review")} label="复核" value={counts.needsReview} active={selectedStatus === "needs_review"} />
            <MiniFilterLink href={workspaceMarketingFilterHref(selectedProject?.id ?? null, selectedChannel, "approved")} label="可发布" value={counts.approved} active={selectedStatus === "approved"} />
            <MiniFilterLink href={workspaceMarketingFilterHref(selectedProject?.id ?? null, selectedChannel, "published")} label="已确认进展" value={counts.published} active={selectedStatus === "published"} />
          </div>
          <div className="grid max-h-[560px] gap-2 overflow-y-auto pr-1">
            {visiblePosts.map((post) => (
              <MarketingPostListItem key={post.id} post={post} selected={selectedPost?.id === post.id} href={workspacePostHref(post.projectId, post.id, selectedChannel, selectedStatus)} projectTitle={post.project.title} />
            ))}
            {!visiblePosts.length ? (
              <div className="rounded-lg border border-dashed border-[#d8d8d0] bg-[#f9f9f9] p-8 text-center">
                <Radio className="mx-auto size-9 text-[#aaa398]" />
                <h3 className="mt-3 font-semibold text-[#28251e]">{scopedPosts.length ? "当前筛选无内容" : "暂无渠道内容"}</h3>
                <p className="mt-2 text-sm text-[#7a7469]">{scopedPosts.length ? "切换渠道、状态或项目查看其他内容。" : "进入项目生成分发内容后，可在这里统一处理。"}</p>
              </div>
            ) : null}
          </div>
        </div>

        <MarketingPostReader post={selectedPost} backHref={selectedPost ? `/?project=${selectedPost.projectId}&view=growth&post=${selectedPost.id}` : undefined} />
      </section>
    </section>
  );
}

function ProjectChannelScope({
  projects,
  selectedProject,
  selectedChannel,
  selectedStatus,
}: {
  projects: Array<{ id: string; title: string; candidates: Array<{ id: string }> }>;
  selectedProject: ProjectWorkspaceData | null;
  selectedChannel: string;
  selectedStatus: MarketingPostStatusFilter;
}) {
  return (
    <details className="relative">
      <summary className="flex h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-[#dbe4ee] bg-[#f8fafc] px-3 text-sm font-semibold text-[#28251e] transition hover:border-[#9db7d3] [&::-webkit-details-marker]:hidden">
        <span className="truncate">{selectedProject ? selectedProject.title : "全部项目"}</span>
        <ArrowRight className="size-4 rotate-90 text-[#9a9388]" />
      </summary>
      <div className="absolute right-0 z-30 mt-2 grid max-h-80 w-full min-w-[280px] gap-1 overflow-y-auto rounded-lg border border-[#dbe4ee] bg-white p-2 shadow-[0_18px_45px_rgba(17,17,17,0.12)]">
        <Link href={workspaceMarketingFilterHref(null, selectedChannel, selectedStatus)} className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${selectedProject ? "text-[#5f5a50] hover:bg-[#f8fafc] hover:text-[#28251e]" : "bg-[#eef5ff] text-[#28251e]"}`}>
          全部项目
        </Link>
        {projects.map((project) => (
          <Link
            key={project.id}
            href={workspaceMarketingFilterHref(project.id, selectedChannel, selectedStatus)}
            className={`grid gap-1 rounded-lg px-3 py-2 text-sm transition ${
              selectedProject?.id === project.id ? "bg-[#eef5ff] text-[#28251e]" : "text-[#5f5a50] hover:bg-[#f8fafc] hover:text-[#28251e]"
            }`}
          >
            <span className="truncate font-semibold">{project.title}</span>
            <span className="truncate text-xs text-[#8c8578]">{project.candidates.length} 候选</span>
          </Link>
        ))}
      </div>
    </details>
  );
}


function FollowUpSuggestions({
  project,
  projectId,
  candidates,
}: {
  project: { riskLevel: string; domain: string | null };
  projectId: string;
  candidates: ProjectWorkspaceData["candidates"];
}) {
  const topCandidate = candidates.find((candidate) => canApproveForOutreach({ candidate, expert: candidate.expert, project }).ok);
  const unscoredCandidate = candidates.find(
    (candidate) => candidate.fitScore === null && isCandidateEligibleForSupplyMetrics(candidate),
  );
  const trialCandidate = candidates.find((candidate) => canTransitionCandidateStage(candidate.stage, "trial").ok);

  return (
    <section className="rounded-lg border border-[#e7e7e2] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
      <div className="mb-3 flex items-center gap-2">
        <MessageSquare className="size-4 text-[#2563eb]" />
        <h3 className="text-sm font-semibold text-[#28251e]">建议下一步</h3>
      </div>
      <div className="flex flex-wrap gap-2">
        <ApiButton label="重跑候选发现" endpoint={`/api/projects/${projectId}/run`} icon="run" />
        {unscoredCandidate ? (
          <ApiButton label={`补评 ${unscoredCandidate.expert.name}`} endpoint={`/api/project-candidates/${unscoredCandidate.id}/score`} icon="analyze" />
        ) : null}
        {topCandidate ? (
          <ApiButton label={`触达 ${topCandidate.expert.name}`} endpoint={`/api/project-candidates/${topCandidate.id}/outreach`} icon="outreach" />
        ) : null}
        {trialCandidate ? (
          <ApiButton label={`设计试标 ${trialCandidate.expert.name}`} endpoint={`/api/project-candidates/${trialCandidate.id}/trial`} icon="trial" />
        ) : null}
      </div>
    </section>
  );
}


function SourcingModule({
  project,
  selectedCandidateId,
  candidateFilter,
  candidateSourceRunId,
}: {
  project: ProjectWorkspaceData;
  selectedCandidateId?: string;
  candidateFilter: CandidateFilter;
  candidateSourceRunId: string | null;
}) {
  const filteredCandidates = filterCandidatePipeline(
    filterCandidatesBySourceRun(project.candidates, candidateSourceRunId),
    candidateFilter,
  );
  const selectedCandidate =
    filteredCandidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="grid content-start gap-4">
        <FollowUpSuggestions
          project={{ riskLevel: project.riskLevel, domain: project.domain }}
          projectId={project.id}
          candidates={project.candidates}
        />
        <CandidateTable
          project={{ riskLevel: project.riskLevel, domain: project.domain }}
          projectId={project.id}
          candidates={filteredCandidates}
          selectedCandidateId={selectedCandidateId}
          candidateFilter={candidateFilter}
          candidateSourceRunId={candidateSourceRunId}
          screenedOutCount={project.candidates.filter((candidate) => candidate.stage === "screened_out").length}
        />
      </div>
      <CandidatePanel
        project={{ riskLevel: project.riskLevel, domain: project.domain }}
        candidate={selectedCandidate}
      />
    </section>
  );
}

function RecruitmentAssetModule({
  project,
  persona,
  searchQueries,
}: {
  project: ProjectWorkspaceData;
  persona: {
    summary?: string;
    mustHave?: string[];
    niceToHave?: string[];
    evidenceRequirements?: string[];
    humanReviewPoints?: string[];
  };
  searchQueries: string[];
}) {
  return (
    <>
      <section className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="需求画像">
          <div className="grid gap-4 xl:grid-cols-[minmax(360px,1fr)_minmax(280px,320px)]">
            <div className="min-w-0 rounded-lg border border-[#f0eee8] bg-[#f9f9f9] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <RiskBadge risk={project.riskLevel} />
                <Badge tone="blue">{formatProjectStatus(project.status)}</Badge>
              </div>
              <h3 className="mt-3 max-w-2xl text-lg font-semibold leading-8 text-[#28251e]">{project.title}</h3>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5a50]">{project.rawDemand}</p>
            </div>
            <div className="grid gap-2">
              <Info label="领域" value={project.domain ?? "-"} />
              <Info label="任务" value={project.taskType ?? "-"} />
              <Info label="目标专家" value={project.quantity?.toString() ?? "-"} />
              <Info label="风险等级" value={formatRiskLevel(project.riskLevel)} />
            </div>
          </div>
        </Panel>
        <Panel title="发布前检查">
          <FunnelRow label="专家画像" value={persona.summary ? 1 : 0} tone={persona.summary ? "green" : "amber"} />
          <FunnelRow label="搜索策略" value={searchQueries.length} tone={searchQueries.length ? "blue" : "amber"} />
          <FunnelRow label="渠道草稿" value={project.marketingPosts.length} tone={project.marketingPosts.length ? "blue" : "amber"} />
          <FunnelRow label="复核任务" value={project.supplyGaps.filter((gap) => gap.status === "open").length} tone="indigo" />
        </Panel>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Panel title="专家要求">
          <p className="text-sm leading-6 text-[#5f5a50]">{persona.summary ?? "先补齐需求画像。"}</p>
          <List label="硬性要求" items={persona.mustHave ?? []} />
          <List label="加分项" items={persona.niceToHave ?? []} />
        </Panel>
        <Panel title="证据与风险">
          <List label="证据要求" items={persona.evidenceRequirements ?? []} />
          <List label="人工复核点" items={persona.humanReviewPoints ?? []} tone={project.riskLevel === "regulated" || project.riskLevel === "high" ? "amber" : "zinc"} />
        </Panel>
      </section>
    </>
  );
}

function SupplyMatchingModule({ project }: { project: ProjectWorkspaceData }) {
  const internalCandidates = project.candidates.filter(
    (candidate) => candidate.sourceType === "internal" && isCandidateEligibleForSupplyMetrics(candidate),
  );
  const externalCandidates = project.candidates.filter(
    (candidate) => candidate.sourceType === "external" && isCandidateEligibleForSupplyMetrics(candidate),
  );
  const openGaps = project.supplyGaps.filter((gap) => gap.status === "open");
  const rankedCandidates = project.candidates
    .filter(isCandidateEligibleForSupplyMetrics)
    .slice()
    .sort((a, b) => (b.conversionProbability ?? 0) - (a.conversionProbability ?? 0) || (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, 12);

  return (
    <>
      <section className="rounded-lg border border-[#e7e7e2] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div>
            <div className="flex items-center gap-2">
              <Radar className="size-5 text-[#2563eb]" />
              <h3 className="font-semibold text-[#28251e]">供给匹配</h3>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5a50]">
              先召回内部专家，再分析缺口，必要时补充外部深搜。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <ApiButton label="内部召回" endpoint={`/api/projects/${project.id}/internal-match`} icon="run" variant="primary" successLabel="内部专家召回已完成。" />
            <ApiButton label="分析缺口" endpoint={`/api/projects/${project.id}/supply-gap`} icon="analyze" successLabel="供给缺口已更新。" />
            <ApiButton label="统一排序" endpoint={`/api/projects/${project.id}/unified-rank`} icon="analyze" successLabel="候选优先级已更新。" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
          <Info label="目标" value={project.quantity?.toString() ?? "-"} />
          <Info label="内部召回" value={internalCandidates.length.toString()} />
          <Info label="外部发现" value={externalCandidates.length.toString()} />
          <Info label="高证据" value={project.candidates.filter(isHighEvidenceCandidate).length.toString()} />
          <Info label="缺口" value={openGaps.length.toString()} />
        </div>
      </section>

      <section data-supply-matching className="grid gap-4 xl:grid-cols-3">
        <SupplyColumn title="内部召回" count={internalCandidates.length}>
          {internalCandidates.map((candidate) => (
            <SupplyCandidateCard key={candidate.id} projectId={project.id} candidate={candidate} />
          ))}
          {!internalCandidates.length ? <EmptyListText text="先召回内部专家。" /> : null}
        </SupplyColumn>
        <SupplyColumn title="供给缺口" count={openGaps.length}>
          {openGaps.map((gap) => (
            <div key={gap.id} className="rounded-lg border border-[#f0eee8] bg-[#f9f9f9] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={gap.severity === "critical" || gap.severity === "high" ? "red" : gap.severity === "medium" ? "amber" : "green"}>
                  {formatGapSeverity(gap.severity)}
                </Badge>
                <Badge>{gap.gapType}</Badge>
              </div>
              <p className="mt-2 text-sm font-medium leading-6 text-[#28251e]">{gap.description}</p>
              <p className="mt-2 text-xs leading-5 text-[#7a7469]">建议：{gap.recommendedAction}</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Info label="需要" value={gap.requiredCount.toString()} />
                <Info label="已有" value={gap.availableCount.toString()} />
              </div>
            </div>
          ))}
          {!openGaps.length ? <EmptyListText text="先分析供给缺口。" /> : null}
        </SupplyColumn>
        <SupplyColumn title="统一排序" count={rankedCandidates.length}>
          {rankedCandidates.map((candidate) => (
            <SupplyCandidateCard key={candidate.id} projectId={project.id} candidate={candidate} showRank />
          ))}
          {!rankedCandidates.length ? <EmptyListText text="完成候选召回后可排序。" /> : null}
        </SupplyColumn>
      </section>
    </>
  );
}

function ExpertDiscoveryModule({
  project,
  mergeSuggestions,
}: {
  project: ProjectWorkspaceData;
  mergeSuggestions: MergeSuggestionData[];
}) {
  const externalRuns = project.supplySearchRuns.filter((run) => run.runType === "external");
  const latestExternalSummary = externalRuns[0] ? parseJson<Record<string, unknown>>(externalRuns[0].summaryJson, {}) : {};
  const latestAcceptance = readExternalResearchAcceptance(latestExternalSummary.acceptance);
  const pendingExternalTask = project.agentTaskRuns.find((run) =>
    ["external_research", "search_candidates", "enrich_candidate_evidence", "full_sourcing"].includes(run.intent) &&
    ["planned", "waiting_for_confirmation", "running", "failed", "partially_succeeded"].includes(run.status),
  );
  return (
    <>
      <section className="rounded-lg border border-[#e7e7e2] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div>
            <div className="flex items-center gap-2">
              <Network className="size-5 text-[#2563eb]" />
              <h3 className="font-semibold text-[#28251e]">专家发现</h3>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5a50]">
              根据供给缺口补充公开候选，搜索结果会先进入复核和证据整理。
            </p>
          </div>
          <ApiButton
            label="准备外部深搜"
            endpoint={`/api/projects/${project.id}/external-research`}
            icon="search"
            variant="primary"
            confirmMessage="系统会先展示需要确认的搜索方向，确认后才会调用公开搜索。继续？"
            successLabel="外部深搜已准备，请确认搜索方向后继续。"
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Info label="深搜次数" value={externalRuns.length.toString()} />
          <Info label="搜索结果" value={project.searchResults.length.toString()} />
          <Info label="来源指标" value={project.searchSourceMetrics.length.toString()} />
          <Info label="合并建议" value={mergeSuggestions.length.toString()} />
        </div>
        {pendingExternalTask ? <ExternalTaskContinuePanel run={pendingExternalTask} /> : null}
        {latestAcceptance ? <ExternalResearchAcceptancePanel acceptance={latestAcceptance} /> : null}
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.5fr)]">
        <Panel title="搜索运行">
          <div className="grid max-h-[520px] gap-2 overflow-y-auto pr-1">
            {project.supplySearchRuns.map((run) => {
              const queries = parseJson<string[]>(run.queriesJson, []);
              const summary = parseJson<Record<string, unknown>>(run.summaryJson, {});
              const acceptance = readExternalResearchAcceptance(summary.acceptance);
              return (
                <div key={run.id} className="rounded-lg border border-[#f0eee8] bg-[#f9f9f9] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={run.runType === "internal" ? "blue" : "indigo"}>{formatRunType(run.runType)}</Badge>
                    <Badge tone={run.status === "failed" ? "red" : run.status === "completed" ? "green" : "amber"}>{formatRunStatus(run.status)}</Badge>
                    <span className="text-xs text-[#9a9388]">{run.createdAt.toLocaleString("zh-CN", { hour12: false })}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[#7a7469]">
                    {typeof summary.candidates === "number" ? `${summary.candidates} 候选` : "运行记录已保存"}
                    {typeof summary.searchResults === "number" ? ` · ${summary.searchResults} 搜索结果` : ""}
                  </p>
                  {acceptance ? (
                    <p className="mt-2 text-xs font-medium text-[#4d473e]">
                      {acceptance.passed ? "可继续复核" : "需补齐证据"} · E2+ {acceptance.e2PlusCandidates} · 覆盖 {acceptance.coverageLabels.join("、") || "-"}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {queries.slice(0, 4).map((query) => <Badge key={query}>{query}</Badge>)}
                  </div>
                </div>
              );
            })}
            {!project.supplySearchRuns.length ? <EmptyListText text="执行召回或深搜后可查看记录。" /> : null}
          </div>
        </Panel>
        <div id="merge-suggestions" className="scroll-mt-28">
        <Panel title="合并建议">
          <div className="grid max-h-[520px] gap-2 overflow-y-auto pr-1">
            {mergeSuggestions.map((item) => {
              const reason = parseJson<{ reason?: string }>(item.reasonJson, {});
              return (
                <div key={item.id} className="rounded-lg border border-[#f0eee8] bg-[#f9f9f9] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[#28251e]">{item.primaryExpert.name}</p>
                      <p className="truncate text-xs text-[#7a7469]">可能重复：{item.duplicateExpert.name}</p>
                    </div>
                    <Badge tone={item.confidence >= 0.8 ? "amber" : "zinc"}>{Math.round(item.confidence * 100)}%</Badge>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[#7a7469]">{reason.reason ?? "需人工判断是否为同一专家。"}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ApiButton
                      label="确认合并"
                      endpoint={`/api/expert-merge-candidates/${item.id}/resolve`}
                      body={{ status: "confirmed" }}
                      icon="analyze"
                      successLabel="合并建议已确认。"
                    />
                    <ApiButton
                      label="保留分开"
                      endpoint={`/api/expert-merge-candidates/${item.id}/resolve`}
                      body={{ status: "rejected" }}
                      icon="dnc"
                      successLabel="合并建议已关闭。"
                    />
                  </div>
                </div>
              );
            })}
            {!mergeSuggestions.length ? <EmptyListText text="发现同名候选后可处理合并建议。" /> : null}
          </div>
        </Panel>
        </div>
      </section>

      <section id="search-results" className="scroll-mt-28">
        <Panel title="公开搜索结果">
          <div className="grid max-h-[520px] gap-2 overflow-y-auto pr-1">
            {project.searchResults.map((result) => (
              <a
                key={result.id}
                href={result.url}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-[#f0eee8] bg-[#f9f9f9] p-3 transition hover:border-[#c9d7e6] hover:bg-white"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-semibold leading-5 text-[#28251e]">{result.title}</p>
                  <Badge>{result.domain ?? "公开网页"}</Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#7a7469]">{result.snippet || "暂无摘要，打开来源查看。"}</p>
                <p className="mt-2 text-[11px] leading-5 text-[#8c8578]">搜索方向：{result.query}</p>
              </a>
            ))}
            {!project.searchResults.length ? <EmptyListText text="完成公开搜索后可在这里查看来源结果。" /> : null}
          </div>
        </Panel>
      </section>
    </>
  );
}

function MarketingModule({
  project,
  selectedPostId,
  selectedChannel,
  selectedStatus,
  centerMode = false,
}: {
  project: ProjectWorkspaceData;
  selectedPostId: string | null;
  selectedChannel: string;
  selectedStatus: MarketingPostStatusFilter;
  centerMode?: boolean;
}) {
  const campaigns = project.marketingCampaigns;
  const posts = project.marketingPosts;
  const counts = marketingStatusCounts(posts, selectedChannel);
  const visiblePosts = filterMarketingPosts(posts, selectedChannel, selectedStatus);
  const selectedPost = visiblePosts.find((post) => post.id === selectedPostId) ?? visiblePosts[0] ?? posts.find((post) => post.id === selectedPostId) ?? null;
  const channelCounts = getChannelCounts(posts);
  return (
    <>
      <section className="rounded-lg border border-[#e7e7e2] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div>
            <div className="flex items-center gap-2">
              <Megaphone className="size-5 text-[#2563eb]" />
              <h3 className="font-semibold text-[#28251e]">{centerMode ? "渠道中心" : "渠道分发"}</h3>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5a50]">
              按渠道查看招募内容，完成复核、审批和发布进展确认。
            </p>
          </div>
          <ApiButton label="生成多渠道草稿" endpoint={`/api/projects/${project.id}/marketing`} icon="marketing" variant="primary" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
          <ChannelMetricLink href={marketingFilterHref(project.id, selectedChannel, "all")} label="内容" value={counts.all} active={selectedStatus === "all"} />
          <ChannelMetricLink href={marketingFilterHref(project.id, selectedChannel, "needs_review")} label="待复核" value={counts.needsReview} active={selectedStatus === "needs_review"} tone="amber" />
          <ChannelMetricLink href={marketingFilterHref(project.id, selectedChannel, "approved")} label="可发布" value={counts.approved} active={selectedStatus === "approved"} tone="blue" />
          <ChannelMetricLink href={marketingFilterHref(project.id, selectedChannel, "published")} label="已确认进展" value={counts.published} active={selectedStatus === "published"} tone="green" />
          <ChannelMetricLink href={marketingFilterHref(project.id, selectedChannel, "draft")} label="草稿" value={counts.draft} active={selectedStatus === "draft"} />
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          <ChannelTab href={marketingFilterHref(project.id, "all", selectedStatus)} label="全部渠道" value={posts.length} active={selectedChannel === "all"} />
          {channelCounts.map((item) => (
            <ChannelTab
              key={item.channel}
              href={marketingFilterHref(project.id, item.channel, selectedStatus)}
              label={formatChannel(item.channel)}
              value={item.count}
              active={selectedChannel === item.channel}
            />
          ))}
        </div>
        {campaigns.length ? <p className="mt-3 text-xs leading-5 text-[#7a7469]">已生成 {campaigns.length} 组渠道内容，当前显示 {visiblePosts.length} 条。</p> : null}
      </section>

      <section data-marketing-workspace className="grid gap-4 lg:grid-cols-[minmax(260px,0.42fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3 rounded-lg border border-[#e7e7e2] bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)] lg:p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-semibold text-[#28251e]">发布队列</h3>
              <p className="mt-1 text-xs text-[#7a7469]">按渠道和状态处理发布内容。</p>
            </div>
            <Badge>{visiblePosts.length} 条</Badge>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <MiniFilterLink href={marketingFilterHref(project.id, selectedChannel, "needs_review")} label="复核" value={counts.needsReview} active={selectedStatus === "needs_review"} />
            <MiniFilterLink href={marketingFilterHref(project.id, selectedChannel, "approved")} label="可发布" value={counts.approved} active={selectedStatus === "approved"} />
            <MiniFilterLink href={marketingFilterHref(project.id, selectedChannel, "published")} label="已确认进展" value={counts.published} active={selectedStatus === "published"} />
          </div>
          <div className="grid max-h-[520px] gap-2 overflow-y-auto pr-1">
            {visiblePosts.map((post) => (
              <MarketingPostListItem key={post.id} post={post} selected={selectedPost?.id === post.id} href={`/?project=${project.id}&view=growth&post=${post.id}`} />
            ))}
            {!visiblePosts.length ? (
              <div className="rounded-lg border border-dashed border-[#d8d8d0] bg-[#f9f9f9] p-8 text-center">
                <Radio className="mx-auto size-9 text-[#aaa398]" />
                <h3 className="mt-3 font-semibold text-[#28251e]">{posts.length ? "当前筛选无内容" : "暂无渠道内容"}</h3>
                <p className="mt-2 text-sm text-[#7a7469]">{posts.length ? "切换渠道或状态查看其他内容。" : "先生成分发内容，再进行审批和发布进展确认。"}</p>
              </div>
            ) : null}
          </div>
        </div>

        <MarketingPostReader post={selectedPost} />
      </section>
    </>
  );
}

function ExpertLibraryModule({ experts, selectedProjectId }: { experts: ExpertLibraryData[]; selectedProjectId: string | null }) {
  const sortedExperts = [...experts].sort(compareExpertAssets);
  const badConsentStates = ["do_not_contact", "delete_requested", "unsubscribed"];
  const internalExperts = experts.filter((expert) => expert.expertType === "internal" && !badConsentStates.includes(expert.consentState));
  const historicalExperts = experts.filter((expert) =>
    expert.qualityMetrics.length > 0 || expert.candidates.some((candidate) => ["trial", "onboarded", "active"].includes(candidate.stage)),
  );
  const externalPendingExperts = experts.filter((expert) => expert.expertType === "external" && evidenceRankForUi(expert.evidenceLevel) < 2);
  const compliantReachableExperts = experts.filter((expert) => !badConsentStates.includes(expert.consentState) && evidenceRankForUi(expert.evidenceLevel) >= 2);
  return (
    <>
      <section className="rounded-lg border border-[#e7e7e2] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <UserCheck className="size-5 text-[#2563eb]" />
              <h3 className="font-semibold text-[#28251e]">专家库</h3>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5a50]">
              经营内部专家、历史参与者和推荐专家，供新项目优先召回。
            </p>
          </div>
          {selectedProjectId ? (
            <Link
              href={`/?project=${selectedProjectId}&view=supply`}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#28251e] px-4 text-sm font-semibold text-white transition hover:bg-black"
            >
              <Radar className="size-4" />
              回到供给匹配
            </Link>
          ) : (
            <Link
              href="/?view=projects"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#e7e7e2] bg-white px-4 text-sm font-semibold text-[#28251e] transition hover:border-[#d8d8d0] hover:bg-[#f9f9f9]"
            >
              <Radar className="size-4" />
              选择项目匹配
            </Link>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Info label="内部可激活" value={internalExperts.length.toString()} />
          <Info label="历史通过" value={historicalExperts.length.toString()} />
          <Info label="外部待核验" value={externalPendingExperts.length.toString()} />
          <Info label="合规可触达" value={compliantReachableExperts.length.toString()} />
        </div>
      </section>

      <section data-expert-library className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.6fr)]">
        <Panel title="专家列表">
          <div className="max-h-[620px] overflow-auto">
            <table className="w-full min-w-[840px] text-left text-sm">
              <thead className="sticky top-0 z-10 bg-[#f9f9f9] text-xs uppercase text-[#8c8578] shadow-[0_1px_0_#f0eee8]">
                <tr>
                  <th className="px-3 py-3">专家</th>
                  <th className="px-3 py-3">类型</th>
                  <th className="px-3 py-3">证据</th>
                  <th className="px-3 py-3">质量</th>
                  <th className="px-3 py-3">最近活跃</th>
                  <th className="px-3 py-3">项目</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0eee8]">
                {sortedExperts.map((expert) => {
                  const quality = parseJson<{ averageScore?: number }>(expert.qualitySummaryJson, {});
                  const typeLabel = expert.expertType === "external" && evidenceRankForUi(expert.evidenceLevel) < 2 ? "外部待核验" : formatExpertType(expert.expertType);
                  return (
                    <tr key={expert.id} className="hover:bg-[#f9f9f9]">
                      <td className="px-3 py-3">
                        <p className="font-medium text-[#28251e]">{expert.name}</p>
                        <p className="max-w-[260px] truncate text-xs text-[#7a7469]">{[expert.title, expert.affiliation].filter(Boolean).join(" · ") || "-"}</p>
                      </td>
                      <td className="px-3 py-3"><Badge tone={expert.expertType === "internal" ? "blue" : expert.expertType === "referred" ? "indigo" : "zinc"}>{typeLabel}</Badge></td>
                      <td className="px-3 py-3"><EvidenceBadge level={expert.evidenceLevel} /></td>
                      <td className="px-3 py-3">{typeof quality.averageScore === "number" && quality.averageScore > 0 ? Math.round(quality.averageScore) : "-"}</td>
                      <td className="px-3 py-3">{expert.lastActiveAt ? expert.lastActiveAt.toLocaleDateString("zh-CN") : "-"}</td>
                      <td className="px-3 py-3">{expert.candidates.length}</td>
                    </tr>
                  );
                })}
                {!experts.length ? (
                  <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-[#7a7469]">暂无专家资料。</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="专家 360">
          <div className="grid max-h-[620px] gap-3 overflow-y-auto pr-1">
            {sortedExperts.slice(0, 8).map((expert) => (
              <div key={expert.id} className="rounded-lg border border-[#f0eee8] bg-[#f9f9f9] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[#28251e]">{expert.name}</p>
                    <p className="truncate text-xs text-[#7a7469]">{[expert.title, expert.affiliation].filter(Boolean).join(" · ") || "-"}</p>
                  </div>
                  <EvidenceBadge level={expert.evidenceLevel} />
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {parseJson<string[]>(expert.domainTagsJson, []).slice(0, 5).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <Info label="信号" value={expert.signals.length.toString()} />
                  <Info label="质量" value={expert.qualityMetrics.length.toString()} />
                  <Info label="事件" value={expert.engagementEvents.length.toString()} />
                </div>
                <div className="mt-3">
                  <ExpertQualityEventForm expertId={expert.id} />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </section>
    </>
  );
}

function ChannelMetricLink({
  href,
  label,
  value,
  active,
  tone = "zinc",
}: {
  href: string;
  label: string;
  value: number;
  active?: boolean;
  tone?: "zinc" | "amber" | "blue" | "green";
}) {
  const toneClass =
    tone === "amber"
      ? "hover:border-[#f5c35b] hover:bg-[#fffbeb]"
      : tone === "blue"
        ? "hover:border-[#bfdbfe] hover:bg-[#eff6ff]"
        : tone === "green"
          ? "hover:border-emerald-200 hover:bg-emerald-50"
          : "hover:border-[#9db7d3] hover:bg-[#fbfdff]";
  return (
    <Link
      href={href}
      className={`rounded-lg border px-3 py-2.5 transition focus:outline-none focus:ring-2 focus:ring-[#bfdbfe] ${
        active ? "border-[#2563eb55] bg-[#2563eb14]" : `border-[#e7e7e2] bg-[#f9f9f9] ${toneClass}`
      }`}
      aria-label={`${label}：${value}，查看对应渠道内容`}
    >
      <span className="block truncate text-xs font-medium text-[#7a7469]">{label}</span>
      <span className="mt-1 block text-xl font-semibold tabular-nums text-[#28251e]">{value}</span>
    </Link>
  );
}

function ChannelTab({ href, label, value, active }: { href: string; label: string; value: number; active?: boolean }) {
  return (
    <Link
      href={href}
      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition ${
        active ? "border-[#2563eb55] bg-[#2563eb14] text-[#1d4ed8]" : "border-[#e7e7e2] bg-white text-[#4d473e] hover:border-[#d8d8d0] hover:bg-[#f9f9f9]"
      }`}
    >
      <span>{label}</span>
      <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs tabular-nums">{value}</span>
    </Link>
  );
}

function MiniFilterLink({ href, label, value, active }: { href: string; label: string; value: number; active?: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-lg border px-3 py-2 transition ${
        active ? "border-[#2563eb55] bg-[#2563eb14]" : "border-[#f0eee8] bg-[#f9f9f9] hover:border-[#d8d8d0] hover:bg-white"
      }`}
    >
      <span className="block truncate text-xs font-medium text-[#7a7469]">{label}</span>
      <span className="mt-1 block text-lg font-semibold tabular-nums text-[#28251e]">{value}</span>
    </Link>
  );
}

function getChannelCounts<T extends { channel: string }>(posts: T[]) {
  const counts = new Map<string, number>();
  for (const post of posts) counts.set(post.channel, (counts.get(post.channel) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count || formatChannel(a.channel).localeCompare(formatChannel(b.channel), "zh-CN"));
}

function marketingFilterHref(projectId: string, channel: string, status: MarketingPostStatusFilter) {
  const params = new URLSearchParams({ project: projectId, view: "growth" });
  if (channel && channel !== "all") params.set("channel", channel);
  if (status && status !== "all") params.set("postStatus", status);
  return `/?${params.toString()}`;
}

function workspaceMarketingFilterHref(projectId: string | null, channel: string, status: MarketingPostStatusFilter) {
  const params = new URLSearchParams({ view: "channels" });
  if (projectId) params.set("project", projectId);
  if (channel && channel !== "all") params.set("channel", channel);
  if (status && status !== "all") params.set("postStatus", status);
  return `/?${params.toString()}`;
}

function workspacePostHref(projectId: string, postId: string, channel: string, status: MarketingPostStatusFilter) {
  const params = new URLSearchParams({ view: "channels", project: projectId, post: postId });
  if (channel && channel !== "all") params.set("channel", channel);
  if (status && status !== "all") params.set("postStatus", status);
  return `/?${params.toString()}`;
}

function filterMarketingPosts<T extends { channel: string; status: string }>(posts: T[], channel: string, status: MarketingPostStatusFilter) {
  return posts.filter((post) => {
    const channelOk = channel === "all" || post.channel === channel;
    const statusOk = status === "all" || post.status === status;
    return channelOk && statusOk;
  });
}

function marketingStatusCounts<T extends { channel: string; status: string }>(posts: T[], channel: string) {
  const scoped = channel === "all" ? posts : posts.filter((post) => post.channel === channel);
  return {
    all: scoped.length,
    draft: scoped.filter((post) => post.status === "draft").length,
    needsReview: scoped.filter((post) => post.status === "needs_review").length,
    approved: scoped.filter((post) => post.status === "approved").length,
    published: scoped.filter((post) => post.status === "published").length,
  };
}

function formatChannelFilter(channel: string) {
  return channel === "all" ? "全部渠道" : formatChannel(channel);
}

function formatPostStatusFilter(status: MarketingPostStatusFilter) {
  const labels: Record<MarketingPostStatusFilter, string> = {
    all: "全部状态",
    draft: "草稿",
    needs_review: "待复核",
    approved: "可发布",
    scheduled: "待发布",
    published: "已确认进展",
    archived: "已归档",
  };
  return labels[status];
}

function RecruitmentRetrospectiveModule({ project }: { project: ProjectWorkspaceData }) {
  const latest = project.recruitmentOutcomes[0] ?? null;
  const latestSummary = latest ? parseJson<{
    summary?: string;
    wins?: string[];
    bottlenecks?: string[];
    sourceInsights?: string[];
    nextActions?: string[];
  }>(latest.summaryJson, {}) : {};
  const funnel = {
    sourced: project.candidates.length,
    approved: project.candidates.filter((candidate) => !candidate.humanReviewNeeded).length,
    contacted: project.candidates.filter((candidate) => ["contacted", "replied", "screening", "trial", "contracting", "onboarded", "active"].includes(candidate.stage)).length,
    trial: project.candidates.filter((candidate) => candidate.stage === "trial").length,
    onboarded: project.candidates.filter((candidate) => ["onboarded", "active"].includes(candidate.stage)).length,
  };
  return (
    <>
      <section className="rounded-lg border border-[#e7e7e2] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div>
            <div className="flex items-center gap-2">
              <BarChart3 className="size-5 text-[#2563eb]" />
              <h3 className="font-semibold text-[#28251e]">招募复盘</h3>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5f5a50]">
              汇总候选来源、触达、试标和入池表现，沉淀下一轮供给策略。
            </p>
          </div>
          <ApiButton
            label="生成复盘"
            endpoint={`/api/projects/${project.id}/recruitment-retrospective`}
            icon="analyze"
            variant="primary"
            successLabel="招募复盘已生成。"
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
          <Info label="召回/发现" value={funnel.sourced.toString()} />
          <Info label="复核通过" value={funnel.approved.toString()} />
          <Info label="已触达" value={funnel.contacted.toString()} />
          <Info label="试标" value={funnel.trial.toString()} />
          <Info label="入池" value={funnel.onboarded.toString()} />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.55fr)]">
        <Panel title="漏斗复盘">
          <div className="grid gap-3">
            <FunnelRow label="召回/发现" value={funnel.sourced} tone="blue" />
            <FunnelRow label="复核通过" value={funnel.approved} tone="green" />
            <FunnelRow label="已触达" value={funnel.contacted} tone="indigo" />
            <FunnelRow label="试标" value={funnel.trial} tone="amber" />
            <FunnelRow label="入池" value={funnel.onboarded} tone="green" />
          </div>
          {latest ? <p className="mt-4 text-xs text-[#7a7469]">最近复盘：{latest.createdAt.toLocaleString("zh-CN", { hour12: false })}</p> : null}
        </Panel>
        <Panel title="下一轮策略">
          <p className="text-sm leading-6 text-[#4d473e]">{latestSummary.summary ?? "生成复盘后显示策略摘要。"}</p>
          <List label="有效动作" items={latestSummary.wins ?? []} />
          <List label="瓶颈" items={latestSummary.bottlenecks ?? []} tone="amber" />
          <List label="来源洞察" items={latestSummary.sourceInsights ?? []} />
          <List label="建议动作" items={latestSummary.nextActions ?? []} />
        </Panel>
      </section>

      <Panel title="来源质量">
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-[#f9f9f9] text-xs uppercase text-[#8c8578] shadow-[0_1px_0_#f0eee8]">
              <tr>
                <th className="px-3 py-3">来源</th>
                <th className="px-3 py-3">Query</th>
                <th className="px-3 py-3">结果</th>
                <th className="px-3 py-3">候选</th>
                <th className="px-3 py-3">E2+</th>
                <th className="px-3 py-3">试标</th>
                <th className="px-3 py-3">入池</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0eee8]">
              {project.searchSourceMetrics.map((metric) => (
                <tr key={metric.id} className="hover:bg-[#f9f9f9]">
                  <td className="px-3 py-3">{metric.domain ?? "公开来源"}</td>
                  <td className="max-w-[300px] truncate px-3 py-3">{metric.query}</td>
                  <td className="px-3 py-3">{metric.resultCount}</td>
                  <td className="px-3 py-3">{metric.candidateCount}</td>
                  <td className="px-3 py-3">{metric.e2PlusCount}</td>
                  <td className="px-3 py-3">{metric.trialCount}</td>
                  <td className="px-3 py-3">{metric.onboardedCount}</td>
                </tr>
              ))}
              {!project.searchSourceMetrics.length ? (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-sm text-[#7a7469]">运行外部深搜后显示来源质量。</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function SupplyColumn({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-3 rounded-lg border border-[#e7e7e2] bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-[#28251e]">{title}</h3>
        <Badge>{count}</Badge>
      </div>
      <div className="grid max-h-[560px] gap-2 overflow-y-auto pr-1">{children}</div>
    </div>
  );
}

function SupplyCandidateCard({
  projectId,
  candidate,
  showRank,
}: {
  projectId: string;
  candidate: CandidateWorkspaceData;
  showRank?: boolean;
}) {
  const rank = parseJson<{ reasons?: string[]; risks?: string[] }>(candidate.rankReasonJson, {});
  const scoring = parseJson<{ topReasons?: string[] }>(candidate.scoringJson, {});
  const risks = parseJson<string[]>(candidate.risksJson, []);
  const missing = parseJson<string[]>(candidate.missingJson, []);
  const signalValues = candidate.expert.signals.slice(0, 3).map((signal) => signal.value);
  const qualityScores = candidate.expert.qualityMetrics.map((metric) => metric.score).filter((score) => Number.isFinite(score));
  const qualityAverage = qualityScores.length
    ? Math.round(qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length)
    : null;
  const reasons = (scoring.topReasons?.length ? scoring.topReasons : rank.reasons ?? []).slice(0, 3);
  const gate = canApproveForOutreach({ candidate, expert: candidate.expert });
  return (
    <a href={`/?project=${projectId}&view=pipeline&candidate=${candidate.id}`} className="grid gap-3 rounded-lg border border-[#f0eee8] bg-[#f9f9f9] p-3 transition hover:border-[#2563eb33] hover:bg-[#fbfdff]">
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-[#28251e]">{candidate.expert.name}</span>
          <span className="mt-1 block truncate text-xs text-[#7a7469]">{[candidate.expert.title, candidate.expert.affiliation].filter(Boolean).join(" · ") || "-"}</span>
        </span>
        <EvidenceBadge level={candidate.expert.evidenceLevel} />
      </span>
      <span className="flex flex-wrap gap-2">
        <Badge tone={candidate.sourceType === "internal" ? "blue" : "zinc"}>{formatSourceType(candidate.sourceType)}</Badge>
        <Badge tone="zinc">匹配 {candidate.fitScore ?? "-"}</Badge>
        <Badge tone={candidate.humanReviewNeeded ? "amber" : "green"}>{candidate.humanReviewNeeded ? "待复核" : "已通过"}</Badge>
        {showRank && typeof candidate.conversionProbability === "number" ? <Badge tone="indigo">{Math.round(candidate.conversionProbability * 100)}%</Badge> : null}
        <Badge tone={gate.ok ? "green" : "amber"}>{gate.ok ? "可触达" : "需处理"}</Badge>
      </span>
      <span className="grid gap-1 text-xs leading-5 text-[#6f695f]">
        {reasons.length ? <span className="line-clamp-2">推荐依据：{reasons.join("；")}</span> : null}
        {signalValues.length ? <span className="line-clamp-1">能力信号：{signalValues.join("、")}</span> : null}
        <span>
          质量记录：{qualityAverage ? `${qualityAverage} 分 / ${qualityScores.length} 条` : "暂无"} · 证据项：{candidate.evidenceItems.length}
        </span>
      </span>
      {missing.length || risks.length ? (
        <span className="grid gap-1 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-[#7a7469]">
          {missing.length ? <span>需补齐：{missing.slice(0, 2).join("；")}</span> : null}
          {risks.length ? <span className="text-rose-700">风险：{risks.slice(0, 2).join("；")}</span> : null}
          {candidate.nextAction ? <span className="font-medium text-[#4d473e]">下一步：{candidate.nextAction}</span> : null}
        </span>
      ) : candidate.nextAction ? (
        <span className="text-xs font-medium leading-5 text-[#4d473e]">下一步：{candidate.nextAction}</span>
      ) : null}
    </a>
  );
}

function EmptyListText({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed border-[#d8d8d0] bg-[#f9f9f9] p-4 text-sm text-[#7a7469]">{text}</p>;
}

function MarketingPostListItem({
  post,
  selected,
  href,
  projectTitle,
}: {
  post: ProjectWorkspaceData["marketingPosts"][number];
  selected: boolean;
  href: string;
  projectTitle?: string;
}) {
  const riskNotes = parseJson<string[]>(post.riskNotesJson, []);
  const statusLabel = formatMarketingStatusCompact(post.status);
  return (
    <a
      href={href}
      className={`grid h-[156px] grid-rows-[auto_auto_1fr] gap-2 overflow-hidden rounded-lg border p-3 text-left transition ${
        selected ? "border-[#2563eb55] bg-[#2563eb14]" : "border-[#f0eee8] bg-[#f9f9f9] hover:border-[#2563eb33] hover:bg-[#fbfdff]"
      }`}
    >
      <span className="flex items-center gap-2 overflow-hidden">
        <Badge tone="indigo">{formatChannel(post.channel)}</Badge>
        <Badge tone={post.status === "published" ? "green" : post.status === "needs_review" ? "amber" : "zinc"}>{statusLabel}</Badge>
        {riskNotes.length ? <Badge tone="amber">{riskNotes.length}项</Badge> : null}
      </span>
      <span className="line-clamp-2 break-words text-sm font-semibold leading-5 text-[#28251e]">{post.title}</span>
      <span className="min-h-0 text-xs leading-5 text-[#7a7469]">
        {projectTitle ? <span className="mb-1 block truncate text-[#9a9388]">{projectTitle}</span> : null}
        <span className="line-clamp-2 break-words">{post.body}</span>
      </span>
    </a>
  );
}

function MarketingPostReader({
  post,
  backHref,
}: {
  post: ProjectWorkspaceData["marketingPosts"][number] | null;
  backHref?: string;
}) {
  if (!post) {
    return (
      <section className="rounded-lg border border-dashed border-[#d8d8d0] bg-white p-10 text-center shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
        <Radio className="mx-auto size-9 text-[#aaa398]" />
        <h3 className="mt-3 font-semibold text-[#28251e]">暂无渠道内容</h3>
        <p className="mt-2 text-sm text-[#7a7469]">生成分发内容后可在这里审批和确认发布进展。</p>
      </section>
    );
  }

  const hashtags = parseJson<string[]>(post.hashtagsJson, []);
  const riskNotes = parseJson<string[]>(post.riskNotesJson, []);
  const canApprove = post.status === "draft" || post.status === "needs_review";
  const canMarkPublished = post.status === "approved" || post.status === "scheduled";
  const statusLabel = formatMarketingStatus(post.status);
  const attractionReport = evaluateMarketingAttractionReadiness({
    posts: [
      {
        channel: post.channel,
        title: post.title,
        body: post.body,
        cta: post.cta,
        riskNotes,
      },
    ],
  });
  return (
    <article className="min-h-[520px] rounded-lg border border-[#e7e7e2] bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)] lg:p-5">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="indigo">{formatChannel(post.channel)}</Badge>
            <Badge tone={post.status === "published" ? "green" : post.status === "needs_review" ? "amber" : "zinc"}>{statusLabel}</Badge>
          </div>
          <h3 className="mt-3 break-words text-base font-semibold leading-7 text-[#28251e]">{post.title}</h3>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          {backHref ? (
            <Link
              href={backHref}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-[#dbe4ee] bg-white px-3 text-sm font-semibold text-[#28251e] transition hover:border-[#9db7d3] hover:bg-[#fbfdff]"
            >
              打开项目页
            </Link>
          ) : null}
          <ApiButton
            label={post.status === "approved" || post.status === "published" ? "已审批" : "审批通过"}
            endpoint={`/api/marketing-posts/${post.id}/status`}
            method="PATCH"
            body={{ status: "approved" }}
            icon="analyze"
            disabled={!canApprove}
            disabledReason={post.status === "published" ? "该内容已确认发布进展。" : post.status === "approved" ? "已审批通过，等待发布进展确认。" : undefined}
            successLabel="已审批，正在刷新发布队列。"
          />
          <ApiButton
            label={post.status === "published" ? "已确认进展" : "确认发布进展"}
            endpoint={`/api/marketing-posts/${post.id}/status`}
            method="PATCH"
            body={{ status: "published" }}
            icon="marketing"
            disabled={!canMarkPublished}
            disabledReason={post.status === "published" ? "该渠道内容已确认发布进展。" : "审批通过后才能确认发布进展。"}
            successLabel="发布进展已确认。"
          />
        </div>
      </div>
      <div className="mt-4 max-h-[440px] overflow-y-auto rounded-lg border border-[#f0eee8] bg-[#fbfdff] p-4">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#9a9388]">
          <CopyCheck className="size-3.5" />
          发布稿
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#4d473e]">{post.body}</p>
      </div>
      <p className="mt-3 break-words text-sm font-medium text-[#2563eb]">{post.cta}</p>
      {hashtags.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {hashtags.map((tag) => (
            <Badge key={tag}>#{tag.replace(/^#/, "")}</Badge>
          ))}
        </div>
      ) : null}
      <MarketingAttractionPanel report={attractionReport} />
      {riskNotes.length ? <RiskReviewList items={riskNotes} /> : null}
    </article>
  );
}

function ExternalTaskContinuePanel({ run }: { run: ProjectWorkspaceData["agentTaskRuns"][number] }) {
  const confirmationStep = run.steps.find((step) => step.stepKey === "confirm_external_search");
  const checks = parseJson<{
    queries?: number;
    cached?: number;
    uncached?: number;
    coverageLabels?: string[];
    queryPreview?: string[];
  }>(confirmationStep?.checksJson ?? "{}", {});
  const canConfirm = run.status === "waiting_for_confirmation";
  const canStart = run.status === "planned";
  const canRetry = run.status === "failed" || run.status === "partially_succeeded";

  return (
    <div className="mt-4 rounded-lg border border-[#dbe4ee] bg-[#fbfdff] p-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={agentRunStatusTone(run.status)}>{formatAgentRunStatus(run.status)}</Badge>
            <h4 className="text-sm font-semibold text-[#28251e]">外部深搜任务</h4>
          </div>
          <p className="mt-2 text-sm leading-6 text-[#5f5a50]">
            {canConfirm
              ? "请确认搜索方向，确认后会查找公开来源并抽取候选。"
              : canStart
                ? "任务已准备好，先生成确认信息再继续。"
                : "任务记录已保存，可按当前状态继续处理。"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          {canStart ? (
            <ApiButton
              label="查看搜索方向"
              endpoint={`/api/agent-runs/${run.id}/start`}
              icon="search"
              variant="primary"
              successLabel="搜索方向已准备，请确认后继续。"
            />
          ) : null}
          {canConfirm ? (
            <ApiButton
              label="确认并查找"
              endpoint={`/api/agent-runs/${run.id}/confirm`}
              icon="search"
              variant="primary"
              confirmMessage="确认后会调用公开搜索并写入候选和证据。继续？"
              successLabel="公开候选已查找，正在刷新结果。"
            />
          ) : null}
          {canRetry ? (
            <ApiButton
              label="重试未完成"
              endpoint={`/api/agent-runs/${run.id}/retry`}
              icon="run"
              successLabel="任务已重新推进。"
            />
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 md:grid-cols-4">
        <Info label="搜索方向" value={typeof checks.queries === "number" ? checks.queries.toString() : "-"} />
        <Info label="已保存" value={typeof checks.cached === "number" ? checks.cached.toString() : "-"} />
        <Info label="需新查" value={typeof checks.uncached === "number" ? checks.uncached.toString() : "-"} />
        <Info label="覆盖" value={checks.coverageLabels?.length ? checks.coverageLabels.join("、") : "-"} />
      </div>
      {checks.queryPreview?.length ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {checks.queryPreview.slice(0, 4).map((query) => <Badge key={query}>{query}</Badge>)}
        </div>
      ) : null}
    </div>
  );
}

function ExternalResearchAcceptancePanel({ acceptance }: { acceptance: ExternalResearchAcceptanceReport }) {
  return (
    <div className="mt-4 rounded-lg border border-[#e7e7e2] bg-[#fbfdff] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge tone={acceptance.passed ? "green" : "amber"}>{acceptance.passed ? "可继续复核" : "需补齐证据"}</Badge>
            <h4 className="text-sm font-semibold text-[#28251e]">公开候选质量</h4>
          </div>
          <p className="mt-2 text-sm leading-6 text-[#5f5a50]">
            覆盖 {acceptance.coverageLabels.join("、") || "-"}，找到 {acceptance.e2PlusCandidates} 位 E2+ 候选，{acceptance.reviewRequiredCandidates} 位需复核。
          </p>
          {acceptance.candidateSourceCoverage.length ? (
            <p className="mt-1 text-xs leading-5 text-[#7a7469]">
              候选实际来自 {acceptance.candidateSourceCoverage.map(formatCandidateSourceCoverage).join("、")}。
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-2 text-right">
          <Info label="查询" value={acceptance.queryCount.toString()} />
          <Info label="复用" value={acceptance.cached.toString()} />
          <Info label="新查" value={acceptance.uncached.toString()} />
        </div>
      </div>
      {acceptance.blockers.length ? <List label="需要补齐" items={acceptance.blockers} tone="amber" /> : null}
      {acceptance.nextActions.length ? <List label="下一步" items={acceptance.nextActions} /> : null}
    </div>
  );
}

function MarketingAttractionPanel({ report }: { report: MarketingAttractionReport }) {
  return (
    <div className="mt-4 rounded-lg border border-[#e7eef7] bg-[#fbfdff] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={report.passed ? "green" : "amber"}>{report.passed ? "报名动作完整" : "需要修改"}</Badge>
          <span className="text-sm font-semibold text-[#28251e]">报名动作检查</span>
        </div>
        <span className="text-xs text-[#7a7469]">{report.readyPosts}/{report.totalPosts} 条可进入审批</span>
      </div>
      {report.blockers.length ? <List label="修改项" items={report.blockers} tone="amber" /> : null}
      {report.passed ? <List label="下一步" items={report.nextActions} /> : null}
    </div>
  );
}

function readExternalResearchAcceptance(value: unknown): ExternalResearchAcceptanceReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<ExternalResearchAcceptanceReport>;
  if (typeof item.passed !== "boolean") return null;
  return {
    passed: item.passed,
    queryCount: safeNumber(item.queryCount),
    cached: safeNumber(item.cached),
    uncached: safeNumber(item.uncached),
    sourceCoverage: safeStringArray(item.sourceCoverage),
    coverageLabels: safeStringArray(item.coverageLabels),
    candidateSourceCoverage: safeStringArray(item.candidateSourceCoverage),
    unmetSourceCoverage: safeStringArray(item.unmetSourceCoverage),
    providerStats: item.providerStats && typeof item.providerStats === "object" && !Array.isArray(item.providerStats) ? (item.providerStats as Record<string, number>) : {},
    resultCount: safeNumber(item.resultCount),
    candidateCount: safeNumber(item.candidateCount),
    e2PlusCandidates: safeNumber(item.e2PlusCandidates),
    hardRequirementReadyCandidates: safeNumber(item.hardRequirementReadyCandidates),
    candidateHardRequirements: safeStringArray(item.candidateHardRequirements),
    reviewRequiredCandidates: safeNumber(item.reviewRequiredCandidates),
    outreachReadyCandidates: safeNumber(item.outreachReadyCandidates),
    blockers: safeStringArray(item.blockers),
    needsReview: safeStringArray(item.needsReview),
    nextActions: safeStringArray(item.nextActions),
  };
}

function formatCandidateSourceCoverage(value: string) {
  const labels: Record<string, string> = {
    community: "开源社区",
    academic: "会议/论文",
    institution: "机构主页",
    professional_profile: "专家主页",
  };
  return labels[value] ?? value;
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeStringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function RiskReviewList({ items }: { items: string[] }) {
  const preview = items.slice(0, 3);
  const hidden = items.length - preview.length;
  return (
    <details className="group mt-4 rounded-lg border border-[#f5c35b] bg-[#fef3c7] p-3" open={items.length <= 3}>
      <summary className="cursor-pointer text-sm font-semibold text-[#8f4300]">
        发布前复核 {items.length} 项{hidden > 0 ? ` · 显示前 3 项` : ""}
      </summary>
      <ul className="mt-2 grid gap-1">
        {preview.map((item) => (
          <li key={`preview-${item}`} className="flex gap-2 text-sm leading-6 text-[#4d473e]">
            <span className="mt-2 size-1.5 shrink-0 rounded-lg bg-[#f5a623]" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <ul className="mt-2 hidden gap-1 group-open:grid">
          {items.slice(3).map((item) => (
            <li key={`hidden-${item}`} className="flex gap-2 text-sm leading-6 text-[#4d473e]">
              <span className="mt-2 size-1.5 shrink-0 rounded-lg bg-[#f5a623]" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {hidden > 0 ? (
        <p className="mt-2 text-xs text-[#8f4300]">展开可查看全部 {items.length} 条复核项。</p>
      ) : null}
    </details>
  );
}

function ReviewModule({
  reviewCandidates,
  reviewMarketingPosts,
  events,
}: {
  reviewCandidates: ReviewCandidateData[];
  reviewMarketingPosts: ReviewMarketingPostData[];
  events: ProjectWorkspaceData["auditEvents"];
}) {
  return (
    <>
      <ReviewQueue candidates={reviewCandidates} marketingPosts={reviewMarketingPosts} />
      <AgentTimeline events={events} />
    </>
  );
}

function AgentTimeline({ events }: { events: ProjectWorkspaceData["auditEvents"] }) {
  return (
    <section className="overflow-hidden rounded-lg border border-[#e7e7e2] bg-white shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
      <div className="border-b border-[#f0eee8] px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-[#2563eb]" />
          <h3 className="font-semibold text-[#28251e]">任务记录</h3>
        </div>
        <Badge>{events.length} 条</Badge>
      </div>
      <p className="text-sm text-[#7a7469]">最近任务按时间更新。</p>
      </div>
      <div className="max-h-[420px] overflow-y-auto px-5 py-4">
      <div className="grid gap-2">
        {events.map((event) => {
          const payload = parseJson<Record<string, unknown>>(event.payloadJson, {});
          const tone = event.action.includes("failed") || event.action.includes("rejected") ? "red" : event.action.includes("completed") || event.action.includes("recorded") || event.action.includes("updated") ? "green" : "blue";
          const Icon = tone === "red" ? AlertTriangle : tone === "green" ? CheckCircle2 : Clock3;
          return (
            <div key={event.id} className="grid grid-cols-[24px_minmax(0,1fr)] gap-3 rounded-lg border border-[#f0eee8] bg-[#f9f9f9] px-3 py-3">
              <Icon className={`mt-0.5 size-4 ${tone === "red" ? "text-rose-600" : tone === "green" ? "text-emerald-600" : "text-[#2563eb]"}`} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-[#28251e]">{formatAction(event.action)}</p>
                  <Badge tone={tone}>{payload.step ? formatTaskStep(String(payload.step)) : formatEntityType(event.entityType)}</Badge>
                  <span className="text-xs text-[#9a9388]">{event.createdAt.toLocaleString("zh-CN", { hour12: false })}</span>
                </div>
                <p className="mt-1 truncate text-xs text-[#7a7469]">{summarizePayload(payload)}</p>
              </div>
            </div>
          );
        })}
        {!events.length ? <p className="rounded-lg border border-dashed border-[#d8d8d0] bg-[#f9f9f9] p-4 text-sm text-[#7a7469]">执行任务后可查看最近进展和失败原因。</p> : null}
      </div>
      </div>
    </section>
  );
}


function FunnelRow({ label, value, tone, href }: { label: string; value: number; tone: "blue" | "amber" | "green" | "indigo"; href?: string }) {
  const content = (
    <>
      <span className="text-sm text-[#5f5a50]">{label}</span>
      <Badge tone={tone}>{value}</Badge>
    </>
  );
  if (href) {
    return (
      <Link href={href} className="flex items-center justify-between border-b border-[#f0eee8] py-3 transition hover:bg-[#f8fafc] last:border-b-0" aria-label={`${label}：${value}，查看详情`}>
        {content}
      </Link>
    );
  }
  return (
    <div className="flex items-center justify-between border-b border-[#f0eee8] py-3 last:border-b-0">
      {content}
    </div>
  );
}

function countOutreachReady(project: Pick<ProjectWorkspaceData, "riskLevel" | "domain" | "candidates">) {
  return project.candidates.filter((candidate) =>
    canApproveForOutreach({
      candidate,
      expert: candidate.expert,
      project: { riskLevel: project.riskLevel, domain: project.domain },
    }).ok,
  ).length;
}

function formatCandidateFilter(filter: CandidateFilter) {
  const labels: Record<CandidateFilter, string> = {
    all: "全部候选",
    external: "外部发现人力",
    highEvidence: "高证据候选",
    outreachReady: "可触达候选",
    review: "待复核候选",
    trial: "试标中候选",
    active: "已入池专家",
    screenedOut: "暂不推进候选",
  };
  return labels[filter];
}

function formatAction(action: string) {
  const labels: Record<string, string> = {
    "project.created": "创建项目",
    "agent.command.submitted": "提交招募指令",
    "agent.run.started": "开始候选发现",
    "agent.run.failed": "候选发现未完成",
    "agent.step.completed": "候选发现步骤完成",
    "agent.run.completed": "候选发现完成",
    "agent.run.cancelled": "候选发现已取消",
    "ai.analyze.completed": "专家画像已生成",
    "ai.analyze.failed": "专家画像未生成",
    "ai.extract_candidates.failed": "候选抽取未完成",
    "ai.score.completed": "候选评分完成",
    "ai.score.failed": "候选评分未完成",
    "ai.outreach.completed": "触达草稿已生成",
    "ai.outreach.failed": "触达草稿未生成",
    "ai.trial.completed": "试标任务已生成",
    "ai.trial.failed": "试标任务未生成",
    "ai.marketing.completed": "渠道内容已生成",
    "ai.marketing.failed": "渠道内容未生成",
    "search.completed": "候选搜索完成",
    "candidate.stage.updated": "候选阶段已更新",
    "candidate.stage.rejected": "候选阶段未更新",
    "candidate.review.updated": "复核结果已保存",
    "expert.contact.updated": "联系方式已保存",
    "outreach.status.updated": "触达状态已更新",
    "trial.stage.rejected": "试标阶段未更新",
    "trial.result.recorded": "试标结果已保存",
    "trial.result.rejected": "试标结果未保存",
    "marketing.post.status.updated": "渠道内容状态已更新",
    "marketing.post.status.rejected": "渠道内容状态未更新",
    "project.link.updated": "项目链接资料已更新",
    "supply.internal_match.completed": "内部召回完成",
    "supply.gap.completed": "供给缺口已更新",
    "supply.gap.completed_with_rules": "供给缺口已更新",
    "supply.external_research.completed": "外部深搜完成",
    "supply.external_research.failed": "外部深搜未完成",
    "supply.rank.completed": "候选排序完成",
    "supply.rank.completed_with_rules": "候选排序完成",
    "expert.quality_event.recorded": "专家回流已记录",
    "expert.merge_candidate.resolved": "合并建议已处理",
    "recruitment.retrospective.completed": "招募复盘已生成",
    "recruitment.retrospective.completed_with_rules": "招募复盘已生成",
  };
  if (action.endsWith("recruitment_link.updated")) return "项目链接资料已更新";
  return labels[action] ?? "任务进展";
}

function summarizePayload(payload: Record<string, unknown>) {
  if (typeof payload.error === "string") return publicErrorMessage(payload.error);

  const pieces = [
    typeof payload.searchResults === "number" ? `${payload.searchResults} 条搜索结果` : null,
    typeof payload.candidates === "number" ? `${payload.candidates} 候选` : null,
    typeof payload.sourcedCandidates === "number" ? `${payload.sourcedCandidates} 已发现` : null,
    typeof payload.scored === "number" ? `${payload.scored} 已评分` : null,
    typeof payload.failures === "number" ? `${payload.failures} 项未完成` : null,
    payload.providerStats && typeof payload.providerStats === "object"
      ? `来源 ${Object.entries(payload.providerStats as Record<string, unknown>)
          .map(([provider, count]) => `${formatProviderName(provider)} ${count}`)
          .join(", ")}`
      : null,
    typeof payload.cacheHits === "number" ? `${payload.cacheHits} 条复用结果` : null,
    typeof payload.gaps === "number" ? `${payload.gaps} 个缺口` : null,
    typeof payload.eligibleExperts === "number" ? `${payload.eligibleExperts} 位专家参与匹配` : null,
    typeof payload.hasUrl === "boolean" ? (payload.hasUrl ? "已更新项目链接资料" : "项目链接资料已清空") : null,
  ].filter(Boolean);

  if (pieces.length) return pieces.join(" · ");
  if (Array.isArray(payload.queries)) return `${payload.queries.length} 条搜索式`;
  return "任务进展已记录。";
}

function formatEntityType(entityType: string) {
  const labels: Record<string, string> = {
    project: "项目",
    candidate: "候选人",
    expert: "专家资料",
    marketing_post: "渠道内容",
    marketing_campaign: "渠道活动",
    outreach_draft: "触达草稿",
    trial_task: "试标任务",
    expert_merge_candidate: "合并建议",
  };
  return labels[entityType] ?? "任务";
}

function formatTaskStep(step: string) {
  const labels: Record<string, string> = {
    seed_data: "初始资料",
    analyze_project: "需求画像",
    analyze_project_demand: "需求画像",
    search_candidates: "候选搜索",
    source_candidates: "候选搜索",
    extract_candidates: "候选整理",
    score_candidates: "候选评分",
    score_candidate_fit: "候选评分",
    full_sourcing: "候选发现",
    internal_match: "内部召回",
    analyze_supply_gap: "供给缺口",
    external_research: "外部深搜",
    rank_supply: "统一排序",
    recruitment_retrospective: "招募复盘",
  };
  return labels[step] ?? step;
}

function formatProviderName(provider: string) {
  const labels: Record<string, string> = {
    serper: "搜索服务",
    openalex: "学术来源",
    github: "代码社区",
    cache: "已保存结果",
  };
  return labels[provider] ?? "公开来源";
}

function CandidateTable({
  project,
  projectId,
  candidates,
  selectedCandidateId,
  candidateFilter,
  candidateSourceRunId,
  screenedOutCount,
}: {
  project: { riskLevel: string; domain: string | null };
  projectId: string;
  candidates: Array<{
    id: string;
    stage: string;
    fitScore: number | null;
    sourceType: string;
    conversionProbability: number | null;
    humanReviewNeeded: boolean;
    risksJson: string;
    outreachDrafts: Array<{ id: string; status: string }>;
    expert: {
      name: string;
      title: string | null;
      affiliation: string | null;
      evidenceLevel: string;
      consentState: string;
      contactJson: string;
      sourceUrl: string | null;
    };
  }>;
  selectedCandidateId?: string;
  candidateFilter: CandidateFilter;
  candidateSourceRunId: string | null;
  screenedOutCount: number;
}) {
  const filterLabel = candidateSourceRunId ? `本次${formatCandidateFilter(candidateFilter)}` : formatCandidateFilter(candidateFilter);
  return (
    <section className="overflow-hidden rounded-lg border border-[#e7e7e2] bg-white shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
      <div className="flex items-center justify-between gap-3 border-b border-[#f0eee8] px-5 py-4">
        <div>
          <h3 className="font-semibold text-[#28251e]">候选管道</h3>
          <p className="text-sm text-[#7a7469]">{filterLabel} · 低证据或高风险候选会进入复核队列。</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {screenedOutCount > 0 ? (
            <Link
              href={`/?project=${projectId}&view=pipeline&candidateFilter=screenedOut`}
              className="inline-flex h-7 items-center rounded-lg border border-[#e7e7e2] bg-white px-2.5 text-xs font-semibold text-[#5f5a50] transition hover:border-[#d8d8d0] hover:bg-[#f9f9f9]"
            >
              暂不推进 {screenedOutCount}
            </Link>
          ) : null}
          <Badge>{candidates.length} 候选</Badge>
        </div>
      </div>
      <div className="max-h-[560px] overflow-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-[#f9f9f9] text-xs uppercase text-[#8c8578] shadow-[0_1px_0_#f0eee8]">
            <tr>
              <th className="px-5 py-3">候选人</th>
              <th className="px-3 py-3">证据</th>
              <th className="px-3 py-3">分数</th>
              <th className="px-3 py-3">来源</th>
              <th className="px-3 py-3">阶段</th>
              <th className="px-3 py-3">复核</th>
              <th className="px-5 py-3">动作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f0eee8]">
            {candidates.map((candidate) => (
              <tr key={candidate.id} className={selectedCandidateId === candidate.id ? "bg-[#2563eb0f]" : "hover:bg-[#f9f9f9]"}>
                <td className="px-5 py-3">
                  <a
                    href={getCandidatePipelineHref({ projectId, candidateId: candidate.id, candidateFilter, sourceRunId: candidateSourceRunId })}
                    className="font-medium text-[#28251e] hover:text-[#2563eb]"
                  >
                    {candidate.expert.name}
                  </a>
                  <p className="max-w-[280px] truncate text-xs text-[#7a7469]">
                    {[candidate.expert.title, candidate.expert.affiliation].filter(Boolean).join(" · ") || "-"}
                  </p>
                </td>
                <td className="px-3 py-3"><EvidenceBadge level={candidate.expert.evidenceLevel} /></td>
                <td className="px-3 py-3">
                  {candidate.fitScore ?? "-"}
                  {typeof candidate.conversionProbability === "number" ? (
                    <p className="mt-1 text-xs text-[#9a9388]">{Math.round(candidate.conversionProbability * 100)}%</p>
                  ) : null}
                </td>
                <td className="px-3 py-3"><Badge tone={candidate.sourceType === "internal" ? "blue" : candidate.sourceType === "referred" ? "indigo" : "zinc"}>{formatSourceType(candidate.sourceType)}</Badge></td>
                <td className="px-3 py-3"><Badge>{formatPipelineStage(candidate.stage)}</Badge></td>
                <td className="px-3 py-3">
                  {candidate.stage === "screened_out" ? (
                    <Badge tone="zinc">暂不推进</Badge>
                  ) : candidate.humanReviewNeeded ? (
                    <Badge tone="amber">待复核</Badge>
                  ) : (
                    <Badge tone="green">已通过</Badge>
                  )}
                </td>
                <td className="px-5 py-3">
                  <div className="flex gap-2">
                    <CandidateRowAction
                      project={project}
                      projectId={projectId}
                      candidate={candidate}
                      candidateFilter={candidateFilter}
                      candidateSourceRunId={candidateSourceRunId}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {!candidates.length ? (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-sm text-[#7a7469]">
                  {candidateFilter === "all" ? "先生成专家画像并搜索候选。" : `当前没有${filterLabel}。`}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CandidateRowAction({
  project,
  projectId,
  candidate,
  candidateFilter,
  candidateSourceRunId,
}: {
  project: { riskLevel: string; domain: string | null };
  projectId: string;
  candidate: {
    id: string;
    stage: string;
    fitScore: number | null;
    humanReviewNeeded: boolean;
    risksJson: string;
    outreachDrafts: Array<{ id: string; status: string }>;
    expert: {
      evidenceLevel: string;
      consentState: string;
      contactJson: string;
      sourceUrl: string | null;
    };
  };
  candidateFilter: CandidateFilter;
  candidateSourceRunId: string | null;
}) {
  const detailsHref = getCandidatePipelineHref({
    projectId,
    candidateId: candidate.id,
    candidateFilter,
    sourceRunId: candidateSourceRunId,
  });
  if (candidate.stage === "screened_out") {
    return (
      <Link href={detailsHref} className="inline-flex h-9 items-center justify-center rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm font-semibold text-[#5f5a50] transition hover:border-[#d8d8d0] hover:bg-[#f9f9f9]">
        查看筛选结论
      </Link>
    );
  }
  if (candidate.humanReviewNeeded || evidenceRankForUi(candidate.expert.evidenceLevel) < 2) {
    return (
      <Link href={detailsHref} className="inline-flex h-9 items-center justify-center rounded-lg border border-amber-200 bg-amber-50 px-3 text-sm font-semibold text-amber-800 transition hover:bg-amber-100">
        查看证据
      </Link>
    );
  }
  if (candidate.fitScore === null) {
    return <ApiButton label="补评分" endpoint={`/api/project-candidates/${candidate.id}/score`} icon="analyze" />;
  }
  if (candidate.outreachDrafts.some((draft) => draft.status === "draft")) {
    return (
      <Link href={detailsHref} className="inline-flex h-9 items-center justify-center rounded-lg border border-[#dbe4ee] bg-white px-3 text-sm font-semibold text-[#2563eb] transition hover:bg-[#f6f9fc]">
        复核触达草稿
      </Link>
    );
  }
  if (candidate.stage === "verified" || candidate.stage === "approved_for_outreach") {
    const outreachGate = canApproveForOutreach({ candidate, expert: candidate.expert, project });
    if (!outreachGate.ok) {
      return (
        <Link href={detailsHref} title={formatGateReason(outreachGate.reason)} className="inline-flex h-9 items-center justify-center rounded-lg border border-amber-200 bg-amber-50 px-3 text-sm font-semibold text-amber-800 transition hover:bg-amber-100">
          处理准入条件
        </Link>
      );
    }
    return <ApiButton label="生成触达" endpoint={`/api/project-candidates/${candidate.id}/outreach`} icon="outreach" />;
  }
  if (candidate.stage === "contacted" || candidate.stage === "replied" || candidate.stage === "screening") {
    return (
      <ApiButton
        label="设计试标任务"
        endpoint={`/api/project-candidates/${candidate.id}/trial`}
        icon="trial"
        disabled={!canTransitionCandidateStage(candidate.stage, "trial").ok}
        disabledReason={trialDisabledReason(candidate.stage)}
      />
    );
  }
  return (
    <Link href={detailsHref} className="inline-flex h-9 items-center justify-center rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm font-semibold text-[#28251e] transition hover:border-[#d8d8d0] hover:bg-[#f9f9f9]">
      查看详情
    </Link>
  );
}

function CandidatePanel({
  project,
  candidate,
}: {
  project: { riskLevel: string; domain: string | null };
  candidate: {
    id: string;
    stage: string;
    fitScore: number | null;
    humanReviewNeeded: boolean;
    scoringJson: string;
    risksJson: string;
    missingJson: string;
    nextAction: string | null;
    sourceType: string;
    conversionProbability: number | null;
    rankReasonJson: string;
    expert: {
      id: string;
      name: string;
      title: string | null;
      affiliation: string | null;
      sourceUrl: string | null;
      contactJson: string;
      evidenceLevel: string;
      consentState: string;
      qualitySummaryJson?: string;
    };
    evidenceItems: Array<{
      id: string;
      claim: string;
      sourceUrl: string;
      sourceTitle: string | null;
      snippet: string;
      evidenceLevel: string;
      confidence: number;
    }>;
    outreachDrafts: Array<{ id: string; subject: string; body: string; replyTemplatesJson: string; status: string }>;
    trialTasks: Array<{ id: string; instructions: string; rubricJson: string; score: number | null; outcome: string | null }>;
  } | null;
}) {
  if (!candidate) {
    return (
      <aside className="rounded-lg border border-[#e7e7e2] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)] xl:sticky xl:top-4 xl:max-h-[calc(100vh-32px)]">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9a9388]">候选人档案</p>
        <h3 className="mt-1 font-semibold text-[#28251e]">选择候选人</h3>
        <p className="mt-2 text-sm leading-6 text-[#7a7469]">搜索或选择候选后查看证据、评分、触达和试标。</p>
      </aside>
    );
  }

  const scoring = parseJson<{
    topReasons?: string[];
    evidenceLevel?: string;
    scoreBreakdown?: Array<{
      dimension: string;
      score: number;
      weight: number;
      evidence: string;
      reason: string;
    }>;
  }>(candidate.scoringJson, {});
  const risks = parseJson<string[]>(candidate.risksJson, []);
  const missing = parseJson<string[]>(candidate.missingJson, []);
  const rank = parseJson<{ reasons?: string[]; risks?: string[] }>(candidate.rankReasonJson, {});
  const quality = parseJson<{ averageScore?: number; metricCount?: number; eventCount?: number }>(candidate.expert.qualitySummaryJson, {});
  const outreachGate = canApproveForOutreach({ candidate, expert: candidate.expert, project });
  const sourceLabel = candidate.expert.sourceUrl ? formatSourceLabel(candidate.expert.sourceUrl) : null;
  const contact = parseJson<{
    email?: string;
    profileUrl?: string;
    contactPermissionBasis?: string;
    notes?: string;
  }>(candidate.expert.contactJson, {});
  const evidenceSources = groupEvidenceBySource(candidate.evidenceItems);

  return (
    <aside className="rounded-lg border border-[#e7e7e2] bg-white shadow-[0_1px_2px_rgba(17,17,17,0.04)] xl:sticky xl:top-4 xl:max-h-[calc(100vh-32px)] xl:overflow-y-auto">
      <div className="border-b border-[#f0eee8] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9a9388]">候选人档案</p>
            <h3 className="mt-1 text-lg font-semibold text-[#28251e]">{candidate.expert.name}</h3>
            <p className="mt-1 text-sm text-[#7a7469]">
              {[candidate.expert.title, candidate.expert.affiliation].filter(Boolean).join(" · ") || "-"}
            </p>
          </div>
          <EvidenceBadge level={candidate.expert.evidenceLevel} />
        </div>
        {candidate.expert.sourceUrl ? (
          <a
            href={candidate.expert.sourceUrl}
            target="_blank"
            rel="noreferrer"
            title={candidate.expert.sourceUrl}
            className="mt-3 inline-flex h-7 max-w-full items-center rounded-lg border border-[#2563eb33] bg-[#2563eb14] px-3 text-xs font-semibold text-[#1d4ed8] hover:border-[#9db7d3]"
          >
            <span className="truncate whitespace-nowrap">{sourceLabel}</span>
          </a>
        ) : null}
        <div className="mt-4 grid grid-cols-3 gap-2">
          <Info label="匹配" value={candidate.fitScore?.toString() ?? "-"} />
          <Info label="来源" value={formatSourceType(candidate.sourceType)} />
          <Info label="阶段" value={formatPipelineStage(candidate.stage)} />
          <Info label="转化" value={typeof candidate.conversionProbability === "number" ? `${Math.round(candidate.conversionProbability * 100)}%` : "-"} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {candidate.stage === "screened_out" ? (
            <Badge tone="zinc">当前项目暂不推进</Badge>
          ) : candidate.fitScore === null ? (
            <ApiButton label="评估匹配度" endpoint={`/api/project-candidates/${candidate.id}/score`} icon="analyze" />
          ) : candidate.outreachDrafts.some((draft) => draft.status === "draft") ? (
            <Badge tone="blue">触达草稿待复核</Badge>
          ) : (
            <ApiButton
              label="生成触达"
              endpoint={`/api/project-candidates/${candidate.id}/outreach`}
              icon="outreach"
              disabled={!outreachGate.ok}
              disabledReason={outreachGate.ok ? undefined : formatGateReason(outreachGate.reason)}
            />
          )}
        </div>
      </div>
      <div className="grid gap-4 p-5">
        <Panel title="联系方式与许可">
          <ContactPermissionForm
            expertId={candidate.expert.id}
            email={typeof contact.email === "string" ? contact.email : undefined}
            profileUrl={typeof contact.profileUrl === "string" ? contact.profileUrl : candidate.expert.sourceUrl ?? undefined}
            consentState={candidate.expert.consentState}
            permissionBasis={typeof contact.contactPermissionBasis === "string" ? contact.contactPermissionBasis : undefined}
            notes={typeof contact.notes === "string" ? contact.notes : undefined}
          />
        </Panel>
        <Panel title="复核处理">
          <CandidateReviewForm candidateId={candidate.id} disabled={candidate.stage === "do_not_contact"} />
        </Panel>
        <Panel title="不再联系">
          <DncForm candidateId={candidate.id} disabled={candidate.stage === "do_not_contact"} />
        </Panel>
        <Panel title="评分解释">
          <ScoreBreakdown items={scoring.scoreBreakdown ?? []} />
          <List label="排序理由" items={rank.reasons ?? []} />
          {typeof quality.averageScore === "number" && quality.averageScore > 0 ? (
            <div className="mb-3 grid grid-cols-3 gap-2">
              <Info label="质量均分" value={Math.round(quality.averageScore).toString()} />
              <Info label="质量记录" value={(quality.metricCount ?? 0).toString()} />
              <Info label="互动记录" value={(quality.eventCount ?? 0).toString()} />
            </div>
          ) : null}
          <List label="推荐理由" items={scoring.topReasons ?? []} />
          <List label="风险" items={risks} tone="red" />
          <List label="缺失证据" items={missing} tone="amber" />
          {candidate.nextAction ? <p className="mt-3 text-sm text-[#4d473e]">下一步：{candidate.nextAction}</p> : null}
        </Panel>
        <Panel title="证据">
          <div className="grid gap-3">
            {evidenceSources.map((source) => (
              <div key={source.sourceUrl} className="rounded-lg border border-[#f0eee8] p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-[#4d473e]">{source.sourceTitle || formatEvidenceSourceLabel(null, source.sourceUrl)}</p>
                  <EvidenceBadge level={source.evidenceLevel} />
                </div>
                <ul className="mt-2 grid gap-1">
                  {source.claims.map((claim) => (
                    <li key={claim} className="flex gap-2 text-xs leading-5 text-[#5f5a50]">
                      <span className="mt-2 size-1 shrink-0 rounded-full bg-[#9db7d3]" />
                      <span>{claim}</span>
                    </li>
                  ))}
                </ul>
                {source.snippets[0] ? <p className="mt-2 text-xs leading-5 text-[#7a7469]">{source.snippets[0]}</p> : null}
                <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 block truncate text-xs text-[#2563eb] hover:underline">
                  打开公开来源
                </a>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="触达草稿">
          {candidate.outreachDrafts.map((draft) => (
            <div key={draft.id} className="rounded-lg border border-[#f0eee8] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{draft.subject}</p>
                <Badge tone={draft.status === "sent" ? "green" : "zinc"}>{formatOutreachDraftStatus(draft.status)}</Badge>
              </div>
              <pre className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#5f5a50]">{draft.body}</pre>
              <DraftStatusButton draftId={draft.id} disabled={draft.status === "sent" || !outreachGate.ok} />
              <ReplyTemplates json={draft.replyTemplatesJson} />
            </div>
          ))}
          {!candidate.outreachDrafts.length ? <p className="text-sm text-[#7a7469]">尚未生成。</p> : null}
        </Panel>
        <Panel title="试标任务">
          {candidate.trialTasks.map((trial) => {
            const preparation = readTrialPreparation(trial.rubricJson);
            return (
              <div key={trial.id} className="rounded-lg border border-[#f0eee8] p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <Badge tone={candidate.stage === "trial" ? "green" : "amber"}>
                    {candidate.stage === "trial" ? "试标进行中" : "试标准备中"}
                  </Badge>
                  <span className="text-xs text-[#7a7469]">结果：{formatTrialOutcome(trial.outcome)} · 分数：{trial.score ?? "-"}</span>
                </div>
                <p className="text-sm leading-6 text-[#4d473e]">{trial.instructions}</p>
                <TrialRubric rubricJson={trial.rubricJson} />
                {candidate.stage === "trial" ? (
                  <TrialResultForm candidateId={candidate.id} />
                ) : preparation?.status === "preparing" && canTransitionCandidateStage(candidate.stage, "trial").ok ? (
                  <TrialStartForm candidateId={candidate.id} />
                ) : null}
              </div>
            );
          })}
          {!candidate.trialTasks.length ? <p className="text-sm text-[#7a7469]">尚未生成。</p> : null}
        </Panel>
        <Panel title="质量回流">
          <ExpertQualityEventForm expertId={candidate.expert.id} candidateId={candidate.id} />
        </Panel>
      </div>
    </aside>
  );
}

function TrialRubric({ rubricJson }: { rubricJson: string }) {
  const rubric = parseJson<{
    criteria?: Array<{ name?: string; weight?: number; description?: string }>;
    passThreshold?: number;
    reviewNotes?: string[];
    preparation?: {
      status?: string;
      readyToStart?: boolean;
      requiredMaterials?: string[];
      nextAction?: string;
    };
  }>(rubricJson, {});
  const criteria = rubric.criteria ?? [];
  if (!criteria.length) return null;

  return (
    <details className="mt-3 rounded-lg border border-[#e7eef7] bg-[#fbfdff] p-3">
      <summary className="cursor-pointer text-sm font-semibold text-[#28251e]">
        查看评分标准 · 通过线 {rubric.passThreshold ?? 75}
      </summary>
      <div className="mt-3 grid gap-2">
        {criteria.map((criterion) => (
          <div key={`${criterion.name}-${criterion.weight}`} className="grid gap-1 border-b border-[#e7eef7] pb-2 last:border-b-0 last:pb-0">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium text-[#4d473e]">{criterion.name || "评分维度"}</span>
              <Badge tone="blue">{criterion.weight ?? 0}%</Badge>
            </div>
            {criterion.description ? <p className="text-xs leading-5 text-[#7a7469]">{criterion.description}</p> : null}
          </div>
        ))}
      </div>
      {rubric.reviewNotes?.length ? <List label="使用前确认" items={rubric.reviewNotes} tone="amber" /> : null}
      {rubric.preparation?.requiredMaterials?.length ? (
        <List label="开始前必备" items={rubric.preparation.requiredMaterials} tone="amber" />
      ) : null}
    </details>
  );
}

function readTrialPreparation(rubricJson: string) {
  return parseJson<{
    preparation?: { status?: string; readyToStart?: boolean; requiredMaterials?: string[]; nextAction?: string };
  }>(rubricJson, {}).preparation;
}

function ScoreBreakdown({
  items,
}: {
  items: Array<{
    dimension: string;
    score: number;
    weight: number;
    evidence: string;
    reason: string;
  }>;
}) {
  if (!items.length) return null;

  return (
    <div className="mb-4 grid gap-2">
      {items.map((item) => (
        <div key={item.dimension} className="rounded-lg border border-[#f0eee8] bg-[#f9f9f9] p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[#28251e]">{item.dimension}</p>
              <p className="mt-0.5 text-xs text-[#7a7469]">权重 {item.weight}%</p>
            </div>
            <Badge tone={item.score >= 75 ? "green" : item.score >= 55 ? "amber" : "red"}>{item.score}</Badge>
          </div>
          <div className="h-1.5 overflow-hidden rounded-lg bg-[#e7e7e2]">
            <div className="h-full rounded-lg bg-[#2563eb]" style={{ width: `${Math.max(0, Math.min(100, item.score))}%` }} />
          </div>
          <p className="mt-2 text-xs leading-5 text-[#5f5a50]">{item.reason}</p>
          <p className="mt-1 text-xs leading-5 text-[#7a7469]">证据：{item.evidence}</p>
        </div>
      ))}
    </div>
  );
}

function ReplyTemplates({ json }: { json: string }) {
  const templates = parseJson<Record<string, string>>(json, {});
  const entries = Object.entries(templates).filter(([, value]) => value.trim().length > 0);
  if (!entries.length) return null;

  return (
    <details className="mt-3 rounded-lg border border-[#f0eee8] bg-[#f9f9f9] p-3">
      <summary className="cursor-pointer text-xs font-medium text-[#5f5a50]">回复模板</summary>
      <div className="mt-3 grid gap-3">
        {entries.map(([key, value]) => (
          <div key={key}>
            <p className="text-xs font-medium text-[#7a7469]">{key}</p>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[#4d473e]">{value}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function ReviewQueue({
  candidates,
  marketingPosts,
}: {
  candidates: Array<{
    id: string;
    projectId: string;
    stage: string;
    fitScore: number | null;
    humanReviewNeeded: boolean;
    project?: {
      title: string;
    } | null;
    expert?: {
      name: string;
      evidenceLevel: string;
      consentState: string;
      contactJson?: string;
      sourceUrl?: string | null;
    } | null;
  }>;
  marketingPosts: Array<{
    id: string;
    projectId: string;
    channel: string;
    title: string;
    body: string;
    riskNotesJson: string;
    status: string;
    project?: { title: string } | null;
  }>;
}) {
  const total = candidates.length + marketingPosts.length;
  return (
    <section className="rounded-lg border border-[#e7e7e2] bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-amber-600" />
          <h3 className="font-semibold text-[#28251e]">复核任务</h3>
        </div>
        <Badge>{total} 项</Badge>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="grid content-start gap-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-[#28251e]">候选准入</h4>
            <Badge>{candidates.length}</Badge>
          </div>
          <div className="grid max-h-[520px] gap-2 overflow-y-auto pr-1">
          {candidates.map((candidate) => {
            const reasons = reviewReasons(candidate);
            return (
              <div
                key={candidate.id}
                className="grid gap-2 rounded-lg border border-[#f0eee8] bg-[#f9f9f9] px-3 py-3 text-sm transition hover:border-[#2563eb33] hover:bg-[#fbfdff]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a
                      href={`/?project=${candidate.projectId}&view=pipeline&candidate=${candidate.id}`}
                      className="font-medium text-[#28251e] hover:text-[#2563eb]"
                    >
                      {candidate.expert?.name ?? candidate.id}
                    </a>
                    <p className="mt-1 truncate text-xs text-[#7a7469]">{candidate.project?.title ?? "当前项目"}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <EvidenceBadge level={candidate.expert?.evidenceLevel ?? "E0"} />
                    <Badge>{formatPipelineStage(candidate.stage)}</Badge>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {reasons.map((reason) => (
                    <Badge key={reason} tone={reason.includes("DNC") || reason.includes("退订") ? "red" : reason.includes("低证据") ? "amber" : "blue"}>
                      {reason}
                    </Badge>
                  ))}
                </div>
                <CandidateReviewForm candidateId={candidate.id} disabled={candidate.stage === "do_not_contact"} />
              </div>
            );
          })}
          {!candidates.length ? <p className="rounded-lg border border-dashed border-[#d8d8d0] bg-[#f9f9f9] p-4 text-sm text-[#7a7469]">暂无候选复核任务。</p> : null}
          </div>
        </div>

        <div className="grid content-start gap-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-[#28251e]">渠道内容</h4>
            <Badge>{marketingPosts.length}</Badge>
          </div>
          <div className="grid max-h-[520px] gap-2 overflow-y-auto pr-1">
          {marketingPosts.map((post) => {
            const riskNotes = parseJson<string[]>(post.riskNotesJson, []);
            return (
              <div key={post.id} className="grid gap-2 rounded-lg border border-[#f0eee8] bg-[#f9f9f9] px-3 py-3 text-sm transition hover:border-[#2563eb33] hover:bg-[#fbfdff]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a href={`/?project=${post.projectId}&view=growth&post=${post.id}`} className="font-medium text-[#28251e] hover:text-[#2563eb]">
                      {post.title}
                    </a>
                    <p className="mt-1 truncate text-xs text-[#7a7469]">{post.project?.title ?? "当前项目"}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Badge tone="indigo">{formatChannel(post.channel)}</Badge>
                    <Badge tone="amber">{formatMarketingStatus(post.status)}</Badge>
                  </div>
                </div>
                <p className="line-clamp-2 text-xs leading-5 text-[#7a7469]">{post.body}</p>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="amber">待发布审批</Badge>
                  {riskNotes.length ? <Badge tone="amber">{riskNotes.length} 复核项</Badge> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <ApiButton
                    label="审批通过"
                    endpoint={`/api/marketing-posts/${post.id}/status`}
                    method="PATCH"
                    body={{ status: "approved" }}
                    icon="analyze"
                    successLabel="已审批，正在刷新复核任务。"
                  />
                  <a
                    href={`/?project=${post.projectId}&view=growth&post=${post.id}`}
                    className="inline-flex h-9 items-center justify-center rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm font-semibold text-[#28251e] transition hover:border-[#d8d8d0] hover:bg-white"
                  >
                    打开发布稿
                  </a>
                </div>
              </div>
            );
          })}
          {!marketingPosts.length ? <p className="rounded-lg border border-dashed border-[#d8d8d0] bg-[#f9f9f9] p-4 text-sm text-[#7a7469]">暂无渠道内容复核任务。</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <section className="grid gap-4">
      <div className="mt-5 rounded-lg border border-[#e7e7e2] bg-white p-10 text-center shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
        <FileSearch className="mx-auto size-10 text-[#aaa398]" />
        <h2 className="mt-4 text-lg font-semibold text-[#28251e]">创建第一个专家招募项目</h2>
        <p className="mt-2 text-sm text-[#7a7469]">进入项目库创建需求后，运行画像、候选发现和渠道分发。</p>
        <Link href="/?view=projects#create-project" className="mt-4 inline-flex h-10 items-center justify-center rounded-lg bg-[#28251e] px-4 text-sm font-semibold text-white transition hover:bg-black">
          新建项目
        </Link>
      </div>
      <NewUserGuide
        title="推荐流程"
        steps={["创建项目需求", "补齐专家画像", "召回内部专家并补充公开候选", "复核候选和渠道内容"]}
      />
    </section>
  );
}

function NewUserGuide({ title, steps }: { title: string; steps: string[] }) {
  return (
    <section className="rounded-lg border border-[#dbe4ee] bg-[#fbfdff] p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-[#2563eb]" />
        <h3 className="text-sm font-semibold text-[#28251e]">{title}</h3>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-4">
        {steps.map((step, index) => (
          <div key={step} className="rounded-lg border border-[#e7eef7] bg-white px-3 py-2">
            <span className="text-xs font-semibold text-[#2563eb]">{index + 1}</span>
            <p className="mt-1 text-sm leading-5 text-[#4d473e]">{step}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Info({ label, value, href }: { label: string; value: string; href?: string }) {
  const content = (
    <>
      <p className="text-[11px] font-medium uppercase text-[#9a9388]">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-[#28251e]" title={value}>{value}</p>
    </>
  );
  if (href) {
    return (
      <Link href={href} className="block rounded-lg border border-[#f0eee8] bg-[#f9f9f9] px-3 py-2 transition hover:border-[#9db7d3] hover:bg-white" aria-label={`${label}：${value}，查看详情`}>
        {content}
      </Link>
    );
  }
  return (
    <div className="rounded-lg border border-[#f0eee8] bg-[#f9f9f9] px-3 py-2">
      {content}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#e7e7e2] bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
      <h4 className="mb-3 text-sm font-semibold text-[#28251e]">{title}</h4>
      {children}
    </div>
  );
}

function List({ label, items, tone = "zinc" }: { label: string; items: string[]; tone?: "zinc" | "red" | "amber" }) {
  if (!items.length) return null;
  const marker = tone === "red" ? "bg-rose-500" : tone === "amber" ? "bg-amber-500" : "bg-[#9a9388]";
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs font-medium text-[#7a7469]">{label}</p>
      <ul className="grid gap-1">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-sm leading-6 text-[#4d473e]">
            <span className={`mt-2 size-1.5 shrink-0 rounded-lg ${marker}`} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvidenceBadge({ level }: { level: string }) {
  const tone = level === "E4" || level === "E3" ? "green" : level === "E2" ? "blue" : level === "E1" ? "amber" : "red";
  return <Badge tone={tone}>{level}</Badge>;
}

function RiskBadge({ risk }: { risk: string }) {
  const tone = risk === "low" ? "green" : risk === "medium" ? "amber" : "red";
  return <Badge tone={tone}>{formatRiskLevel(risk)}</Badge>;
}

function formatSourceLabel(url: string) {
  try {
    const source = new URL(url);
    return source.hostname.replace(/^www\./, "");
  } catch {
    return "公开来源";
  }
}

function formatEvidenceSourceLabel(title: string | null, url: string) {
  const cleanTitle = title?.trim();
  if (!cleanTitle || cleanTitle.startsWith("http://") || cleanTitle.startsWith("https://")) {
    return formatSourceLabel(url);
  }
  return cleanTitle.length > 42 ? `${cleanTitle.slice(0, 39)}...` : cleanTitle;
}

function formatChannel(channel: string) {
  const labels: Record<string, string> = {
    linkedin: "LinkedIn",
    xiaohongshu: "小红书",
    wechat: "公众号",
    zhihu: "知乎",
    community: "社群/社区",
    email_newsletter: "邮件简报",
  };
  return labels[channel] ?? channel;
}

function formatMarketingStatus(status: string) {
  const labels: Record<string, string> = {
    draft: "草稿",
    needs_review: "待人工复核",
    approved: "已审批",
    scheduled: "待发布",
    published: "已确认发布进展",
    archived: "已归档",
  };
  return labels[status] ?? status;
}

function formatMarketingStatusCompact(status: string) {
  const labels: Record<string, string> = {
    draft: "草稿",
    needs_review: "待复核",
    approved: "已审批",
    scheduled: "待发布",
    published: "已确认进展",
    archived: "已归档",
  };
  return labels[status] ?? status;
}

function formatRiskLevel(risk: string) {
  const labels: Record<string, string> = {
    low: "低风险",
    medium: "中风险",
    high: "高风险",
    regulated: "强监管",
  };
  return labels[risk] ?? risk;
}

function formatTrialOutcome(outcome: string | null) {
  const labels: Record<string, string> = {
    passed: "通过",
    failed: "未通过",
    needs_review: "继续复核",
  };
  if (!outcome) return "待记录";
  return labels[outcome] ?? outcome;
}

function formatSourceType(sourceType: string) {
  const labels: Record<string, string> = {
    internal: "内部专家",
    external: "外部发现",
    referred: "推荐专家",
  };
  return labels[sourceType] ?? "公开来源";
}

function formatExpertType(expertType: string) {
  const labels: Record<string, string> = {
    internal: "内部专家",
    external: "外部候选",
    referred: "推荐专家",
  };
  return labels[expertType] ?? "专家";
}

function compareExpertAssets(a: ExpertLibraryData, b: ExpertLibraryData) {
  return (
    expertAssetPriority(a) - expertAssetPriority(b) ||
    expertQualityScore(b) - expertQualityScore(a) ||
    evidenceRankForUi(b.evidenceLevel) - evidenceRankForUi(a.evidenceLevel) ||
    (b.lastActiveAt?.getTime() ?? 0) - (a.lastActiveAt?.getTime() ?? 0) ||
    b.candidates.length - a.candidates.length
  );
}

function expertAssetPriority(expert: ExpertLibraryData) {
  if (expert.expertType === "internal") return 0;
  if (expert.expertType === "referred") return 1;
  if (expert.qualityMetrics.length > 0 || expert.lastActiveAt || expert.candidates.some((candidate) => ["trial", "onboarded", "active"].includes(candidate.stage))) return 2;
  if (evidenceRankForUi(expert.evidenceLevel) >= 2) return 3;
  return 4;
}

function expertQualityScore(expert: ExpertLibraryData) {
  const quality = parseJson<{ averageScore?: number }>(expert.qualitySummaryJson, {});
  return typeof quality.averageScore === "number" ? quality.averageScore : 0;
}

function formatGapSeverity(severity: string) {
  const labels: Record<string, string> = {
    low: "轻微",
    medium: "中等",
    high: "较高",
    critical: "紧急",
  };
  return labels[severity] ?? severity;
}

function formatRunType(runType: string) {
  const labels: Record<string, string> = {
    internal: "内部召回",
    external: "外部深搜",
    evidence_enrichment: "候选补证",
    hybrid: "混合匹配",
  };
  return labels[runType] ?? "供给运行";
}

function formatRunStatus(status: string) {
  const labels: Record<string, string> = {
    running: "运行中",
    completed: "已完成",
    quality_failed: "需继续补证",
    failed: "未完成",
  };
  return labels[status] ?? status;
}

function formatAgentRunStatus(status: string) {
  const labels: Record<string, string> = {
    planned: "计划已生成",
    preflight_failed: "前置条件不足",
    waiting_for_confirmation: "等待确认",
    running: "执行中",
    succeeded: "已完成",
    partially_succeeded: "部分完成",
    failed: "未完成",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}

function agentRunStatusTone(status: string): "blue" | "amber" | "green" | "red" | "indigo" | "zinc" {
  if (status === "succeeded") return "green";
  if (status === "waiting_for_confirmation" || status === "planned" || status === "running") return "amber";
  if (status === "failed" || status === "preflight_failed") return "red";
  if (status === "partially_succeeded") return "indigo";
  return "zinc";
}

function riskPriority(risk: string) {
  const priorities: Record<string, number> = { regulated: 4, high: 3, medium: 2, low: 1 };
  return priorities[risk] ?? 0;
}

function getWorkspaceProjectAction(
  project: {
    status: string;
    quantity: number | null;
    personaJson?: string;
  },
  counts: { reviewCount: number; activeCount: number; highEvidenceCount: number; internalCount: number },
) {
  const profileReady = Object.keys(parseJson<Record<string, unknown>>(project.personaJson ?? "{}", {})).length > 0 || project.status === "analyzed";
  if (!profileReady) return { label: "补画像", description: "补齐需求画像", tone: "amber" as const };
  if (!counts.internalCount) return { label: "召回内部", description: "先复用专家库", tone: "blue" as const };
  if (counts.reviewCount > 0) return { label: "待复核", description: "处理候选准入", tone: "amber" as const };
  if (counts.highEvidenceCount < Math.min(project.quantity ?? 5, 5)) return { label: "补供给", description: "确认外部深搜", tone: "indigo" as const };
  if (counts.activeCount < Math.min(project.quantity ?? 1, 1)) return { label: "推进触达", description: "生成触达或试标", tone: "green" as const };
  return { label: "稳定", description: "保持复盘和回流", tone: "green" as const };
}

function evidenceRankForUi(level: string) {
  const ranks: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };
  return ranks[level] ?? 0;
}

function formatProjectStatus(status: string) {
  const labels: Record<string, string> = {
    draft: "草稿",
    analyzed: "已画像",
    sourcing: "候选发现中",
    active: "进行中",
    paused: "已暂停",
    completed: "已完成",
    archived: "已归档",
  };
  return labels[status] ?? status;
}

function formatPipelineStage(stage: string) {
  const labels: Record<string, string> = {
    sourced: "已发现",
    enriched: "已补全",
    verified: "已核验",
    approved_for_outreach: "待触达",
    contacted: "已触达",
    replied: "已回复",
    screening: "筛选中",
    trial: "试标中",
    contracting: "签约中",
    onboarded: "已入池",
    active: "合作中",
    screened_out: "暂不推进",
    do_not_contact: "不再联系",
  };
  return labels[stage] ?? stage;
}

function trialDisabledReason(stage: string) {
  const transition = canTransitionCandidateStage(stage, "trial");
  return transition.ok ? undefined : formatGateReason(transition.reason);
}

function reviewReasons(candidate: {
  stage: string;
  fitScore: number | null;
  humanReviewNeeded: boolean;
  expert?: {
    evidenceLevel: string;
    consentState: string;
    contactJson?: string;
    sourceUrl?: string | null;
  } | null;
}) {
  const reasons: string[] = [];
  if (candidate.humanReviewNeeded) reasons.push("需人工复核");
  if (["E0", "E1"].includes(candidate.expert?.evidenceLevel ?? "E0")) reasons.push("低证据");
  if (candidate.stage === "approved_for_outreach") reasons.push("待触达审批确认");
  if (candidate.stage === "screened_out") reasons.push("本项目暂不推进");
  if (candidate.stage === "do_not_contact") reasons.push("DNC");
  if (["unsubscribed", "do_not_contact", "delete_requested"].includes(candidate.expert?.consentState ?? "")) {
    reasons.push("退订/删除请求");
  }
  if (candidate.fitScore === null) reasons.push("未评分");
  if (candidate.fitScore !== null && candidate.fitScore < 75) reasons.push("低匹配分");
  if (!reasons.length) reasons.push("待确认");
  return reasons;
}

function formatGateReason(reason: string) {
  const labels: Record<string, string> = {
    "Candidate is marked do not contact for this project.": "该候选已标记 DNC，不能触达。",
    "Candidate requires human review before outreach.": "需要人工复核后才能生成触达草稿。",
    "Regulated or high-risk project requires human review before outreach.": "高风险项目需要人工复核后才能生成触达草稿。",
    "Fit score must be 75 or higher before outreach.": "匹配分需达到 75 分以上。",
    "Evidence level must be E2 or higher before outreach.": "证据等级需达到 E2 以上。",
    "Candidate has opted out or requested no contact.": "候选已退订、DNC 或请求删除。",
    "No compliant contact path is recorded.": "缺少合规联系路径，公开主页不等于可触达许可。",
    "Risk list references protected or sensitive attributes.": "风险中包含受保护或敏感属性，需人工处理。",
  };
  if (labels[reason]) return labels[reason];
  if (reason.startsWith("Cannot transition candidate")) return "当前阶段不能直接执行该动作，请先完成前置步骤。";
  return reason;
}
