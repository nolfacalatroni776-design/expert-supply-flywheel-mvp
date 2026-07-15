"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  FileSearch,
  ExternalLink,
  Gauge,
  Library,
  ListChecks,
  Loader2,
  Megaphone,
  Play,
  RotateCw,
  Search,
  SendHorizontal,
  Sparkles,
  Workflow,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";
import {
  describeAgentToolReceipts,
  getAgentCandidatePreview,
  getAgentConfirmationBrief,
  getAgentConversationAction,
  getAgentConversationMessages,
  getAgentSourceRunId,
  getAgentSearchResultPreview,
  getAgentStepConfirmationBadge,
  shouldContinuePollingAgentRun,
  shouldRefreshWorkspaceData,
  type AgentToolReceiptView,
} from "@/lib/agent-conversation";
import { normalizeAgentUserFacingText } from "@/lib/agent-quality";

type IntentId =
  | "internal_match"
  | "analyze_supply_gap"
  | "external_research"
  | "enrich_candidate_evidence"
  | "rank_supply"
  | "full_sourcing"
  | "recruitment_retrospective"
  | "analyze_project"
  | "search_candidates"
  | "generate_marketing";

type AgentTaskOption = {
  id: IntentId;
  title: string;
  when: string;
  result: string;
  prompt: (projectTitle: string) => string;
  icon: LucideIcon;
  badge?: string;
};

type AgentTaskGroup = {
  title: string;
  tasks: AgentTaskOption[];
};

const taskGroups: AgentTaskGroup[] = [
  {
    title: "启动项目",
    tasks: [
      {
        id: "analyze_project",
        title: "补齐需求画像",
        when: "需求还没拆成专家画像时",
        result: "生成专家要求、证据要求和搜索方向",
        prompt: (projectTitle) => `请补齐「${projectTitle}」的专家画像、硬性要求、证据要求、风险复核点和搜索方向。`,
        icon: FileSearch,
      },
      {
        id: "internal_match",
        title: "召回内部专家",
        when: "刚接到项目时优先做",
        result: "从专家库找候选并说明召回原因",
        prompt: (projectTitle) => `请为「${projectTitle}」优先召回内部专家，保留证据、风险和下一步动作。`,
        icon: Library,
        badge: "优先",
      },
      {
        id: "full_sourcing",
        title: "完整发现候选",
        when: "希望按标准流程推进时",
        result: "画像、内部召回、缺口、搜索确认和排序",
        prompt: (projectTitle) => `请按标准流程推进「${projectTitle}」的候选发现，先内部召回，再分析缺口，必要时等待我确认公开搜索。`,
        icon: Workflow,
      },
    ],
  },
  {
    title: "补充供给",
    tasks: [
      {
        id: "analyze_supply_gap",
        title: "分析供给缺口",
        when: "已有一批候选后",
        result: "说明缺什么、缺多少、怎么补",
        prompt: (projectTitle) => `请分析「${projectTitle}」当前供给缺口，说明缺口数量、缺失画像和推荐补充方向。`,
        icon: Gauge,
      },
      {
        id: "external_research",
        title: "补充公开候选",
        when: "内部供给不足时",
        result: "先确认，再查找公开来源候选",
        prompt: (projectTitle) => `请为「${projectTitle}」补充公开来源候选。先展示计划和预计搜索方向，等待我确认后再调用外部搜索。`,
        icon: Search,
        badge: "需确认",
      },
      {
        id: "enrich_candidate_evidence",
        title: "补齐候选证据",
        when: "高证据候选缺少机构主页时",
        result: "按候选姓名补查主页并生成同人合并建议",
        prompt: (projectTitle) =>
          `请为「${projectTitle}」现有高证据候选补齐机构主页证据。按候选姓名和已知机构生成查询，先让我确认；只生成同人合并建议，不自动合并。`,
        icon: FileSearch,
        badge: "需确认",
      },
      {
        id: "rank_supply",
        title: "整理候选优先级",
        when: "候选较多或证据不齐时",
        result: "得到排序、原因和下一步动作",
        prompt: (projectTitle) => `请整理「${projectTitle}」候选优先级，说明推荐理由、阻断原因和下一步动作。`,
        icon: ListChecks,
      },
      {
        id: "search_candidates",
        title: "按搜索式找候选",
        when: "已经有明确搜索方向时",
        result: "按现有搜索式补充公开候选",
        prompt: (projectTitle) => `请按「${projectTitle}」已有搜索方向补充公开候选。调用外部搜索前需要我确认。`,
        icon: Sparkles,
        badge: "需确认",
      },
    ],
  },
  {
    title: "推动转化",
    tasks: [
      {
        id: "generate_marketing",
        title: "生成分发内容",
        when: "需要渠道招募时",
        result: "生成待复核渠道草稿，不自动发布",
        prompt: (projectTitle) => `请为「${projectTitle}」生成适合不同渠道的招募内容，状态保持待复核，不自动发布。`,
        icon: Megaphone,
      },
      {
        id: "recruitment_retrospective",
        title: "生成项目复盘",
        when: "已有推进结果后",
        result: "总结来源效果和下一轮动作",
        prompt: (projectTitle) => `请复盘「${projectTitle}」当前招募进展，说明来源效果、漏斗问题和下一轮动作。`,
        icon: BarChart3,
      },
    ],
  },
];

const taskOptions = taskGroups.flatMap((group) => group.tasks);

type AgentCommandFormProps = {
  projectId: string;
  projectTitle: string;
  initialRun?: AgentRun | null;
  initialRuns?: AgentRun[];
};

type AgentStep = {
  id?: string;
  stepKey: string;
  label?: string;
  status: string;
  requiresConfirmation?: boolean;
  confirmedAt?: string | Date | null;
  confirmationDecision?: string | null;
  confirmationReason?: string | null;
  errorMessage?: string | null;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  checks?: Record<string, unknown>;
  toolReceipts?: AgentToolReceiptView[];
};

type AgentRun = {
  id: string;
  createdAt?: string | Date;
  label?: string;
  intent: string;
  instruction?: string;
  status: string;
  report?: {
    summary?: string;
    completed?: string[];
    skipped?: string[];
    failed?: string[];
    written?: string[];
    needsReview?: string[];
    nextActions?: string[];
  };
  plan?: {
    objective?: string;
  };
  steps: AgentStep[];
};

type AgentRunResponse = {
  ok?: boolean;
  data?: {
    run: AgentRun;
  };
  error?: string;
};

type RunAction = "start" | "confirm" | "reject" | "retry" | "cancel" | "revise" | "enrich";

export function AgentCommandForm({ projectId, projectTitle, initialRun = null, initialRuns = [] }: AgentCommandFormProps) {
  const router = useRouter();
  const [intent, setIntent] = useState<IntentId>(() => (isIntentId(initialRun?.intent) ? initialRun.intent : "internal_match"));
  const selectedTask = taskOptions.find((task) => task.id === intent) ?? taskOptions[0];
  const [instruction, setInstruction] = useState(() => initialRun?.instruction?.trim() || selectedTask.prompt(projectTitle));
  const [run, setRun] = useState<AgentRun | null>(initialRun ?? null);
  const [runHistory, setRunHistory] = useState<AgentRun[]>(() => uniqueRuns(initialRun ? [initialRun, ...initialRuns] : initialRuns));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const runAction = useMemo<ReturnType<typeof getAgentConversationAction>>(
    () => (run ? getAgentConversationAction(run) : { kind: "none", label: "" }),
    [run],
  );
  const resultMessages = useMemo(() => (run ? getAgentConversationMessages(run) : []), [run]);
  const confirmationBrief = useMemo(() => (run ? getAgentConfirmationBrief(run) : null), [run]);
  const candidatePreview = useMemo(() => (run ? getAgentCandidatePreview(run) : []), [run]);
  const searchResultPreview = useMemo(() => (run ? getAgentSearchResultPreview(run) : []), [run]);
  const sourceRunId = useMemo(() => (run ? getAgentSourceRunId(run) : null), [run]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [error, run?.status, run?.steps]);

  const chooseTask = (task: AgentTaskOption) => {
    setIntent(task.id);
    setInstruction(task.prompt(projectTitle));
    setError(null);
  };

  const rememberRun = (nextRun: AgentRun) => {
    setRun(nextRun);
    setRunHistory((current) => uniqueRuns([nextRun, ...current]).slice(0, 8));
  };

  const restoreRun = (runId: string) => {
    const restored = runHistory.find((item) => item.id === runId);
    if (!restored) return;
    setRun(restored);
    if (isIntentId(restored.intent)) setIntent(restored.intent);
    if (restored.instruction?.trim()) setInstruction(restored.instruction);
    setError(null);
  };

  const submitPlan = () => {
    const trimmed = instruction.trim();
    if (trimmed.length < 8) {
      setError("请补充本次要推进的具体要求。");
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/agent-command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent, instruction: trimmed }),
        });
        const payload = (await response.json().catch(() => ({}))) as AgentRunResponse;
        if (!response.ok || !payload.data?.run) {
          setError(payload.error ?? "任务未提交成功，请检查内容后重试。");
          return;
        }
        rememberRun(payload.data.run);
        if (shouldRefreshWorkspaceData(payload.data.run.status)) router.refresh();
      } catch {
        setError("网络连接异常，请稍后重试。");
      }
    });
  };

  const callRunAction = (action: RunAction, reason?: string) => {
    if (action === "enrich") {
      setIntent("enrich_candidate_evidence");
      setInstruction(
        `请为「${projectTitle}」现有高证据候选补齐机构主页证据。按候选姓名和已知机构生成查询，先让我确认；只生成同人合并建议，不自动合并。`,
      );
      setError(null);
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    if (action === "revise") {
      setIntent("external_research");
      setInstruction(
        `请重新规划「${projectTitle}」的公开候选搜索。优先查找明确的个人主页、机构团队成员、会议讲者、论文作者或开源维护者，避免泛行业文章，并先展示新的搜索方向等待我确认。`,
      );
      setError(null);
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }

    const runId = run?.id;
    if (!runId) return;
    const confirmationStep = run.steps.find(
      (step) => step.requiresConfirmation && !step.confirmedAt && step.status === "blocked",
    );
    if ((action === "confirm" || action === "reject") && !confirmationStep?.id) {
      setError("待确认步骤已经变化，请刷新后重新核对。");
      return;
    }
    if (action === "reject" && !reason?.trim()) {
      setError("请说明暂不执行的原因。");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const requestBody =
          action === "confirm" || action === "reject"
            ? JSON.stringify({ stepId: confirmationStep?.id, ...(reason?.trim() ? { reason: reason.trim() } : {}) })
            : undefined;
        const response = await fetch(`/api/agent-runs/${runId}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        });
        const payload = (await response.json().catch(() => ({}))) as AgentRunResponse;
        if (!response.ok || !payload.data?.run) {
          setError(payload.error ?? "任务未完成，请稍后重试。");
          return;
        }
        rememberRun(payload.data.run);
        let latestRun = payload.data.run;
        if (action !== "cancel" && ["start", "confirm", "reject", "retry"].includes(action)) {
          latestRun =
            (await pollAgentRunUntilBoundary(
              runId,
              action as "start" | "confirm" | "reject" | "retry",
              confirmationStep?.id,
              (nextRun) => rememberRun(nextRun),
            )) ?? latestRun;
        }
        if (shouldRefreshWorkspaceData(latestRun.status)) router.refresh();
      } catch {
        setError("网络连接异常，请稍后重试。");
      }
    });
  };

  return (
    <section className="grid h-[clamp(560px,calc(100vh-120px),820px)] overflow-hidden rounded-xl border border-[#e5e7eb] bg-white shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#edf0f3] bg-white px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex size-8 items-center justify-center rounded-lg bg-[#eef5ff] text-[#2563eb]">
              <Sparkles className="size-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-[#1f2933]">招募助手</h2>
              <p className="mt-0.5 text-xs leading-5 text-[#6b7280]">选择一个动作，说清要求，助手会先给计划；敏感动作会单独确认。</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {runHistory.length > 1 ? (
            <select
              aria-label="查看最近任务"
              value={run?.id ?? ""}
              onChange={(event) => restoreRun(event.target.value)}
              className="h-8 max-w-[220px] rounded-lg border border-[#dfe4ea] bg-white px-2 text-xs font-medium text-[#4b5563] outline-none focus:border-[#2563eb]"
            >
              {runHistory.map((item, index) => (
                <option key={item.id} value={item.id}>
                  {index === 0 ? "最近 · " : ""}{item.label || taskOptions.find((task) => task.id === item.intent)?.title || "招募任务"} · {formatRunTime(item.createdAt)} · {formatRunStatus(item.status)}
                </option>
              ))}
            </select>
          ) : null}
          <StatusPill status={run?.status ?? "idle"} />
        </div>
      </header>

      <div className="min-h-0 overflow-y-auto bg-[#f8fafc] px-3 py-4 sm:px-5">
        <div className="mx-auto grid max-w-5xl gap-4">
          <AssistantIntro projectTitle={projectTitle} />

          {run ? (
            <RunConversation
              run={run}
              selectedTask={selectedTask}
              instruction={instruction}
              projectId={projectId}
              confirmationBrief={confirmationBrief}
              candidatePreview={candidatePreview}
              sourceRunId={sourceRunId}
              searchResultPreview={searchResultPreview}
              resultMessages={resultMessages}
              runAction={runAction}
              isPending={isPending}
              onRunAction={callRunAction}
            />
          ) : null}

          {error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700">
              {error}
            </div>
          ) : null}
          <div ref={conversationEndRef} />
        </div>
      </div>

      <form
        className="border-t border-[#e5e7eb] bg-white/95 px-3 py-3 backdrop-blur sm:px-5"
        onSubmit={(event) => {
          event.preventDefault();
          submitPlan();
        }}
      >
        <div className="mx-auto grid max-w-5xl gap-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {taskOptions.map((task) => {
              const Icon = task.icon;
              const selected = task.id === intent;
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => chooseTask(task)}
                  className={clsx(
                    "inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-sm font-medium transition",
                    selected
                      ? "border-[#2563eb] bg-[#eef5ff] text-[#1d4ed8]"
                      : "border-[#e5e7eb] bg-white text-[#4b5563] hover:border-[#b8c3d1] hover:bg-[#f8fafc]",
                  )}
                >
                  <Icon className="size-4" />
                  {task.title}
                </button>
              );
            })}
          </div>

          <div className="overflow-hidden rounded-2xl border border-[#dfe4ea] bg-white shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
            <textarea
              ref={composerRef}
              required
              minLength={8}
              maxLength={1200}
              rows={2}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              className="block min-h-[72px] w-full resize-y border-0 bg-white px-4 py-3 text-sm leading-6 text-[#1f2933] outline-none placeholder:text-[#9ca3af]"
              placeholder="直接描述你希望助手推进的事，例如：先召回内部专家，低证据候选只进入复核。"
              suppressHydrationWarning
            />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#edf0f3] px-3 py-2">
              <div className="min-w-0 text-xs leading-5 text-[#6b7280]">
                <span className="font-semibold text-[#374151]">{selectedTask.title}</span>
                <span className="mx-2 text-[#c4c9d0]">/</span>
                <span>{selectedTask.result}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  disabled={isPending}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[#dbe4ee] bg-white px-3 text-sm font-semibold text-[#1f2933] transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPending ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
                  {run ? "生成新计划" : "生成计划"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}

function isIntentId(value: unknown): value is IntentId {
  return typeof value === "string" && taskOptions.some((task) => task.id === value);
}

function uniqueRuns(runs: AgentRun[]) {
  const seen = new Set<string>();
  return runs.filter((run) => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  });
}

function AssistantIntro({ projectTitle }: { projectTitle: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-white text-[#2563eb] shadow-sm">
        <Sparkles className="size-4" />
      </div>
      <div className="max-w-3xl rounded-2xl rounded-tl-sm border border-[#e5e7eb] bg-white px-4 py-3 text-sm leading-6 text-[#374151] shadow-sm">
        <p className="font-medium text-[#1f2933]">我会围绕「{projectTitle}」推进招募任务。</p>
        <p className="mt-1 text-[#6b7280]">每次先给执行计划，再由你开始执行；公开搜索、批量写入和发布进展都会保留人工确认。</p>
      </div>
    </div>
  );
}

function RunConversation({
  run,
  selectedTask,
  instruction,
  projectId,
  confirmationBrief,
  candidatePreview,
  sourceRunId,
  searchResultPreview,
  resultMessages,
  runAction,
  isPending,
  onRunAction,
}: {
  run: AgentRun;
  selectedTask: AgentTaskOption;
  instruction: string;
  projectId: string;
  confirmationBrief: ReturnType<typeof getAgentConfirmationBrief>;
  candidatePreview: ReturnType<typeof getAgentCandidatePreview>;
  sourceRunId: string | null;
  searchResultPreview: ReturnType<typeof getAgentSearchResultPreview>;
  resultMessages: ReturnType<typeof getAgentConversationMessages>;
  runAction: ReturnType<typeof getAgentConversationAction>;
  isPending: boolean;
  onRunAction: (action: RunAction, reason?: string) => void;
}) {
  const [showRejection, setShowRejection] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const hasExternalCandidates = candidatePreview.some((candidate) => candidate.sourceType === "external");
  const externalCandidates = candidatePreview.filter((candidate) => candidate.sourceType === "external");
  const internalCandidates = candidatePreview.filter(
    (candidate) => candidate.sourceType === "internal" || candidate.sourceType === "referred",
  );
  const otherCandidates = candidatePreview.filter(
    (candidate) => !["external", "internal", "referred"].includes(candidate.sourceType ?? ""),
  );
  const candidateListHref = hasExternalCandidates
    ? `?project=${encodeURIComponent(projectId)}&view=pipeline&candidateFilter=external${sourceRunId ? `&sourceRun=${encodeURIComponent(sourceRunId)}` : ""}`
    : `?project=${encodeURIComponent(projectId)}&view=pipeline&candidateFilter=review`;
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <div className="max-w-3xl rounded-2xl rounded-tr-sm bg-[#1f2933] px-4 py-3 text-sm leading-6 text-white shadow-sm">
          <p className="text-xs font-semibold text-white/70">{selectedTask.title}</p>
          <p className="mt-1">{instruction}</p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-white text-[#2563eb] shadow-sm">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-[#e5e7eb] bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-[#1f2933]">{run.label ?? selectedTask.title}</h3>
                <StatusPill status={run.status} />
              </div>
              <p className="mt-1 text-sm leading-6 text-[#4b5563]">{run.plan?.objective ?? run.report?.summary ?? "计划已生成。"}</p>
            </div>
          </div>

          <div className="mt-4 grid max-h-[360px] gap-2 overflow-y-auto pr-1">
            {run.steps.map((step) => (
              <StepRow key={step.id ?? step.stepKey} step={step} />
            ))}
          </div>
        </div>
      </div>

      {confirmationBrief ? (
        <div className="sm:ml-11">
          <ConfirmationBriefCard brief={confirmationBrief} />
        </div>
      ) : null}

      {internalCandidates.length ? (
        <div className="sm:ml-11">
          <CandidatePreviewList projectId={projectId} candidates={internalCandidates} sourceRunId={sourceRunId} />
        </div>
      ) : null}

      {externalCandidates.length ? (
        <div className="sm:ml-11">
          <CandidatePreviewList
            projectId={projectId}
            candidates={externalCandidates}
            sourceRunId={sourceRunId}
            mode={run.intent === "enrich_candidate_evidence" ? "enrichment" : "discovery"}
          />
        </div>
      ) : null}

      {otherCandidates.length ? (
        <div className="sm:ml-11">
          <CandidatePreviewList projectId={projectId} candidates={otherCandidates} sourceRunId={sourceRunId} />
        </div>
      ) : null}

      {searchResultPreview.length ? (
        <div className="sm:ml-11">
          <SearchResultPreviewList projectId={projectId} results={searchResultPreview} />
        </div>
      ) : null}

      {resultMessages.length ? (
        <div className="grid gap-2 sm:ml-11">
          {resultMessages.map((message) => (
            <ResultMessage key={`${message.title}-${message.items.join("|")}`} message={message} />
          ))}
        </div>
      ) : null}

      {runAction.kind !== "none" || (!isTerminalStatus(run.status) && run.status !== "running") ? (
        <div className="flex flex-wrap items-center gap-2 sm:ml-11">
          {runAction.kind !== "none" ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => onRunAction(runAction.kind)}
              className={clsx(
                "inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50",
                runAction.kind === "confirm" || runAction.kind === "revise" || runAction.kind === "enrich"
                  ? "bg-[#2563eb] hover:bg-[#1d4ed8]"
                  : "bg-[#1f2933] hover:bg-black",
              )}
            >
              {isPending ? <Loader2 className="size-4 animate-spin" /> : actionIcon(runAction.kind)}
              {runAction.label}
            </button>
          ) : null}
          {run.status === "waiting_for_confirmation" ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => setShowRejection((current) => !current)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#dbe4ee] bg-white px-3 text-sm font-semibold text-[#4b5563] transition hover:bg-[#f8fafc] disabled:opacity-50"
            >
              不执行，调整方案
            </button>
          ) : null}
          {!isTerminalStatus(run.status) && run.status !== "running" ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => onRunAction("cancel")}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#f1d3d3] bg-white px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
            >
              <XCircle className="size-4" />
              取消任务
            </button>
          ) : null}
        </div>
      ) : null}

      {run.status === "waiting_for_confirmation" && showRejection ? (
        <form
          className="grid gap-2 rounded-xl border border-[#dbe4ee] bg-white p-3 sm:ml-11"
          onSubmit={(event) => {
            event.preventDefault();
            onRunAction("reject", rejectionReason);
          }}
        >
          <label htmlFor={`reject-reason-${run.id}`} className="text-sm font-semibold text-[#1f2933]">
            需要调整什么
          </label>
          <textarea
            id={`reject-reason-${run.id}`}
            value={rejectionReason}
            onChange={(event) => setRejectionReason(event.target.value)}
            minLength={2}
            maxLength={500}
            rows={2}
            required
            placeholder="例如：机构范围太宽，请只搜索肿瘤免疫方向的医院或研究机构人员页。"
            className="min-h-[72px] resize-y rounded-lg border border-[#dfe4ea] px-3 py-2 text-sm leading-6 text-[#1f2933] outline-none focus:border-[#2563eb]"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => setShowRejection(false)}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-[#dbe4ee] bg-white px-3 text-sm font-semibold text-[#4b5563] hover:bg-[#f8fafc]"
            >
              返回核对
            </button>
            <button
              type="submit"
              disabled={isPending || rejectionReason.trim().length < 2}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-[#1f2933] px-3 text-sm font-semibold text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
            >
              按意见重新规划
            </button>
          </div>
        </form>
      ) : null}

      {isTerminalStatus(run.status) ? (
        <div className="flex flex-wrap gap-2 sm:ml-11">
          {candidatePreview.length === 0 ? (
            <a
              href={candidateListHref}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-[#dbe4ee] bg-white px-3 text-sm font-semibold text-[#1f2933] transition hover:bg-[#f8fafc]"
            >
              {hasExternalCandidates ? "查看外部发现人力" : "查看候选推进列表"}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SearchResultPreviewList({
  projectId,
  results,
}: {
  projectId: string;
  results: ReturnType<typeof getAgentSearchResultPreview>;
}) {
  return (
    <div className="rounded-xl border border-amber-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-[#1f2933]">本次找到的公开结果</p>
          <p className="mt-0.5 text-xs leading-5 text-[#6b7280]">先查看这些页面是否包含明确的人名、个人主页、作者或讲者，再决定是否调整方向。</p>
        </div>
        <a
          href={`/?project=${encodeURIComponent(projectId)}&view=supply#search-results`}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[#dbe4ee] bg-[#f8fafc] px-3 text-xs font-semibold text-[#1f2933] transition hover:bg-white"
        >
          查看全部结果
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      <div className="mt-3 grid max-h-[320px] gap-2 overflow-y-auto pr-1">
        {results.map((result) => (
          <a
            key={result.searchResultId}
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="group rounded-lg border border-[#edf0f3] bg-[#fbfcfd] px-3 py-2 transition hover:border-[#bfd0e3] hover:bg-white"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm font-semibold leading-5 text-[#1f2933] group-hover:text-[#1d4ed8]">{result.title}</p>
              <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-[#9ca3af]" />
            </div>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#6b7280]">{result.snippet || "公开页面摘要待查看。"}</p>
            <p className="mt-1 truncate text-[11px] text-[#8b95a1]">{result.domain || result.query || "公开网页"}</p>
          </a>
        ))}
      </div>
    </div>
  );
}

async function pollAgentRunUntilBoundary(
  runId: string,
  action: "start" | "confirm" | "reject" | "retry",
  previousApprovalStepId: string | undefined,
  onUpdate: (run: AgentRun) => void,
) {
  let latestRun: AgentRun | null = null;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const response = await fetch(`/api/agent-runs/${runId}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as AgentRunResponse;
      if (!response.ok || !payload.data?.run) continue;
      latestRun = payload.data.run;
      onUpdate(latestRun);
      if (!shouldContinuePollingAgentRun(action, latestRun, previousApprovalStepId)) return latestRun;
    } catch {
      // A missed progress read is harmless; the durable workflow continues in the background.
    }
  }
  return latestRun;
}

function ConfirmationBriefCard({ brief }: { brief: NonNullable<ReturnType<typeof getAgentConfirmationBrief>> }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
      <p className="font-semibold">{brief.title}</p>
      <ul className="mt-1 grid gap-1">
        {brief.items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-[0.55em] size-1.5 shrink-0 rounded-full bg-current opacity-60" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {brief.queries.length ? (
        <div className="mt-2 rounded-lg bg-white/70 px-3 py-2">
          <p className="text-xs font-semibold text-amber-950">本次搜索方向</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {brief.queries.map((query) => (
              <span key={query} className="rounded-full bg-white px-2 py-1 text-xs text-amber-900 shadow-sm">
                {query}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CandidatePreviewList({
  projectId,
  candidates,
  sourceRunId,
  mode = "discovery",
}: {
  projectId: string;
  candidates: ReturnType<typeof getAgentCandidatePreview>;
  sourceRunId: string | null;
  mode?: "discovery" | "enrichment";
}) {
  const hasExternal = candidates.some((candidate) => candidate.sourceType === "external");
  const hasInternal = candidates.some((candidate) => candidate.sourceType === "internal" || candidate.sourceType === "referred");
  const title = mode === "enrichment" ? "候选证据补查线索" : hasExternal ? "当次外部搜索人力" : hasInternal ? "内部召回候选" : "首批候选";
  const description = mode === "enrichment"
    ? "这些页面可能对应现有候选。请核对姓名、机构和来源，确认是同一人后再合并证据。"
    : hasExternal
    ? "这是当次任务写入的候选记录；当前复核状态和筛选结论以候选推进列表为准。"
    : "先看证据等级和下一步动作，低证据候选继续留在复核中。";
  const href = mode === "enrichment"
    ? `?project=${encodeURIComponent(projectId)}&view=supply#merge-suggestions`
    : hasExternal
    ? `?project=${encodeURIComponent(projectId)}&view=pipeline&candidateFilter=external${sourceRunId ? `&sourceRun=${encodeURIComponent(sourceRunId)}` : ""}`
    : `?project=${encodeURIComponent(projectId)}&view=pipeline&candidateFilter=review`;
  return (
    <div className="rounded-xl border border-[#dbe4ee] bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-[#1f2933]">{title}</p>
          <p className="mt-0.5 text-xs leading-5 text-[#6b7280]">{description}</p>
        </div>
        <a
          href={href}
          className="inline-flex h-8 items-center justify-center rounded-lg border border-[#dbe4ee] bg-[#f8fafc] px-3 text-xs font-semibold text-[#1f2933] transition hover:bg-white"
        >
          {mode === "enrichment" ? "处理合并建议" : hasExternal ? "查看外部发现人力" : "打开候选推进"}
        </a>
      </div>
      <div className="mt-3 grid gap-2">
        {candidates.map((candidate) => (
          <div key={candidate.candidateId} className="rounded-lg border border-[#edf0f3] bg-[#fbfcfd] px-3 py-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[#1f2933]">{candidate.name}</p>
                <p className="mt-0.5 text-xs leading-5 text-[#6b7280]">
                  {[candidate.title, candidate.affiliation].filter(Boolean).join(" · ") || "公开来源待复核"}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                {candidate.sourceType ? <StatusTag>{formatCandidateSourceLabel(candidate.sourceType)}</StatusTag> : null}
                {candidate.evidenceLevel ? <StatusTag>{candidate.evidenceLevel}</StatusTag> : null}
                {candidate.humanReviewNeeded ? <StatusTag tone="warning">当次待复核</StatusTag> : <StatusTag tone="success">当次可继续</StatusTag>}
              </div>
            </div>
            <p className="mt-1 text-xs leading-5 text-[#4b5563]">
              {candidate.nextAction
                ? normalizeAgentUserFacingText(candidate.nextAction)
                : "先核验证据，再决定是否触达。"}
            </p>
            {candidate.sourceUrl ? (
              <a
                href={candidate.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex text-xs font-medium text-[#2563eb] hover:text-[#1d4ed8]"
              >
                查看公开来源
              </a>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusTag({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" | "success" }) {
  const toneClass =
    tone === "warning"
      ? "bg-amber-50 text-amber-700"
      : tone === "success"
        ? "bg-emerald-50 text-emerald-700"
        : "bg-[#eef5ff] text-[#2563eb]";
  return <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-semibold", toneClass)}>{children}</span>;
}

function ResultMessage({ message }: { message: ReturnType<typeof getAgentConversationMessages>[number] }) {
  const toneClass = {
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    info: "border-blue-200 bg-blue-50 text-blue-800",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    danger: "border-rose-200 bg-rose-50 text-rose-800",
  }[message.tone];
  return (
    <div className={clsx("rounded-xl border px-4 py-3 text-sm leading-6", toneClass)}>
      <p className="font-semibold">{message.title}</p>
      <ul className="mt-1 grid gap-1">
        {message.items.slice(0, 6).map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-[0.55em] size-1.5 shrink-0 rounded-full bg-current opacity-60" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StepRow({ step }: { step: AgentStep }) {
  const Icon =
    step.status === "succeeded"
      ? CheckCircle2
      : step.status === "failed"
        ? AlertTriangle
        : step.status === "blocked"
          ? Clock3
          : step.status === "running"
            ? Loader2
            : Circle;
  const tone =
    step.status === "succeeded"
      ? "text-emerald-600"
      : step.status === "failed"
        ? "text-rose-600"
        : step.status === "blocked"
          ? "text-amber-600"
          : "text-[#9a9388]";
  const summary = summarizeStep(step);
  const detailSections = buildStepDetailSections(step);
  const confirmationBadge = getAgentStepConfirmationBadge(step);
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-2 rounded-lg border border-[#edf0f3] bg-[#fbfcfd] px-3 py-2">
      <Icon className={clsx("mt-0.5 size-4", step.status === "running" ? "animate-spin" : null, tone)} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-[#1f2933]">{step.label ?? step.stepKey}</p>
          {confirmationBadge ? (
            <span
              className={clsx(
                "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                confirmationBadge.tone === "success"
                  ? "bg-emerald-50 text-emerald-700"
                  : confirmationBadge.tone === "danger"
                    ? "bg-rose-50 text-rose-700"
                    : "bg-amber-50 text-amber-700",
              )}
            >
              {confirmationBadge.label}
            </span>
          ) : null}
          <span className="text-xs text-[#8c8578]">{formatStepStatus(step.status)}</span>
        </div>
        {summary ? <p className="mt-1 text-xs leading-5 text-[#6b7280]">{summary}</p> : null}
        {step.errorMessage ? (
          <p className="mt-1 text-xs leading-5 text-rose-600">
            {normalizeAgentUserFacingText(step.errorMessage)}
          </p>
        ) : null}
        <details
          className="group mt-2 overflow-hidden rounded-lg border border-[#e5eaf0] bg-white"
          open={step.status === "blocked" || step.status === "failed"}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-semibold text-[#374151] transition hover:bg-[#f8fafc] [&::-webkit-details-marker]:hidden">
            <span>{step.status === "pending" ? "查看执行说明" : "查看输出"}</span>
            <ChevronDown className="size-4 shrink-0 text-[#9ca3af] transition group-open:rotate-180" />
          </summary>
          <div className="grid gap-3 border-t border-[#edf0f3] px-3 py-3">
            {detailSections.map((section) => (
              <div key={section.title} className="grid gap-1.5">
                <p className="text-[11px] font-semibold text-[#6b7280]">{section.title}</p>
                <ul className="grid gap-1">
                  {section.items.map((item, index) => (
                    <li key={`${section.title}-${index}`} className="flex gap-2 text-xs leading-5 text-[#4b5563]">
                      <span className="mt-[0.55em] size-1.5 shrink-0 rounded-full bg-[#c7d2de]" />
                      <span className="min-w-0 break-words">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

type StepDetailSection = {
  title: string;
  items: string[];
};

function buildStepDetailSections(step: AgentStep): StepDetailSection[] {
  const sections: StepDetailSection[] = [];
  const inputItems = describeStepInput(step.input ?? {});
  const checkItems = describeStepChecks(step.checks ?? {});
  const outputItems = describeStepOutput(step.output ?? {}, step);
  const receiptItems = describeAgentToolReceipts(step.toolReceipts ?? []);

  if (inputItems.length) sections.push({ title: "执行说明", items: inputItems });
  if (checkItems.length) sections.push({ title: "检查结果", items: checkItems });
  if (receiptItems.length) sections.push({ title: "调用记录", items: receiptItems });
  sections.push({ title: "产出结果", items: outputItems.length ? outputItems : defaultStepOutput(step) });

  return sections;
}

function describeStepInput(input: Record<string, unknown>) {
  const items: string[] = [];
  if (typeof input.description === "string" && input.description.trim()) {
    items.push(normalizeAgentUserFacingText(input.description));
  }
  return items;
}

function describeStepChecks(checks: Record<string, unknown>) {
  const items: string[] = [];

  addStringArrayDetails(items, checks.missing, "缺少资料");
  addStringArrayDetails(items, checks.warnings, "提醒");
  addStringArrayDetails(items, checks.needsReview, "需人工复核");
  addNumberDetail(items, checks.internalExperts, "可召回内部专家");
  addNumberDetail(items, checks.candidateCount, "当前候选");
  addNumberDetail(items, checks.searchQueries, "已有搜索方向");
  addNumberDetail(items, checks.channelPostCount, "已有渠道内容");

  if (typeof checks.queries === "number") {
    items.push(`预计搜索方向 ${checks.queries} 个，已保存 ${numberText(checks.cached)} 个，需新查 ${numberText(checks.uncached)} 个。`);
  }
  addStringArrayDetails(items, checks.queryPreview, "搜索方向");
  addStringArrayDetails(items, checks.coverageLabels, "覆盖来源");
  addStringArrayDetails(items, checks.acceptanceChecks, "通过标准");

  return items;
}

function describeStepOutput(output: Record<string, unknown>, step: AgentStep) {
  const items: string[] = [];

  if (output.projectUpdated === true) items.push("项目画像、证据要求和搜索方向已更新。");
  if (output.confirmed === true) items.push("已确认，可以继续执行后续步骤。");
  if (output.skipped === true) {
    const reason = typeof output.reason === "string"
      ? normalizeAgentUserFacingText(output.reason)
      : "当前没有可执行内容。";
    items.push(`已跳过：${reason}`);
  }
  if (typeof output.summary === "string" && output.summary.trim()) {
    items.push(normalizeAgentUserFacingText(output.summary));
  }
  if (typeof output.reason === "string" && output.reason.trim() && output.skipped !== true) {
    items.push(normalizeAgentUserFacingText(output.reason));
  }

  addNumberDetail(items, output.searchQueries, "生成搜索方向");
  addNumberDetail(items, output.searchDirections, "补充搜索方向");
  addNumberDetail(items, output.candidates, "写入候选");
  addNumberDetail(items, output.searchResults, "保存搜索结果");
  addNumberDetail(items, output.gaps, "识别供给缺口");
  addNumberDetail(items, output.posts, "生成渠道内容");
  addNumberDetail(items, output.ranked, "更新候选排序");
  addNumberDetail(items, output.cacheHits, "复用已保存搜索");
  addNumberDetail(items, output.autoScreenedOut, "更新暂不推进候选");
  addNumberDetail(items, output.mergeSuggestions, "生成同人合并建议");
  addNumberDetail(items, output.readyCandidates, "证据已齐候选");

  if (output.usedFallback === true) items.push("本步使用保守规则生成结果。");
  if (output.usedFallback === false) items.push("本步使用当前可用数据完成分析。");

  addProviderStats(items, output.providerStats);
  addAcceptanceDetails(items, output.acceptance);
  addAttractionReadinessDetails(items, output.attractionReadiness);
  addCandidatePreviewDetails(items, output.candidatePreview);
  addMergeSuggestionPreviewDetails(items, output.mergeSuggestionPreview);
  addStringArrayDetails(items, output.needsReview, "需人工复核");
  addStringArrayDetails(items, output.nextActions, "下一步");
  addStringArrayDetails(items, output.blockers, "阻断原因");

  if (step.errorMessage) items.push(`未完成原因：${normalizeAgentUserFacingText(step.errorMessage)}`);
  return uniqueDetails(items);
}

function addMergeSuggestionPreviewDetails(items: string[], value: unknown) {
  if (!Array.isArray(value)) return;
  value.slice(0, 6).forEach((item) => {
    if (!isRecord(item)) return;
    const primaryName = typeof item.primaryName === "string" ? item.primaryName.trim() : "";
    const duplicateName = typeof item.duplicateName === "string" ? item.duplicateName.trim() : "";
    if (!primaryName || !duplicateName) return;
    const primaryAffiliation = typeof item.primaryAffiliation === "string" ? item.primaryAffiliation.trim() : "";
    const duplicateAffiliation = typeof item.duplicateAffiliation === "string" ? item.duplicateAffiliation.trim() : "";
    const affiliations = Array.from(new Set([primaryAffiliation, duplicateAffiliation].filter(Boolean))).join(" / ");
    items.push(`同人建议：${primaryName} ↔ ${duplicateName}${affiliations ? `（${affiliations}）` : ""}，等待人工确认。`);
  });
}

function defaultStepOutput(step: AgentStep) {
  if (step.status === "pending") return ["等待前置步骤完成，执行后会显示本步结果。"];
  if (step.status === "running") return ["正在执行，本步结果会在完成后显示。"];
  if (step.status === "blocked") return ["需要你确认后，才会继续执行并写入结果。"];
  if (step.status === "skipped") return ["当前步骤已跳过，没有写入新结果。"];
  if (step.status === "failed") return ["本步未完成，没有写入业务结果。"];
  return ["本步没有额外产出。"];
}

function addNumberDetail(items: string[], value: unknown, label: string) {
  if (typeof value === "number") items.push(`${label} ${value} 项。`);
}

function addStringArrayDetails(items: string[], value: unknown, label: string) {
  const values = readStringArray(value);
  const normalizedValues = values.map(normalizeAgentUserFacingText).filter(Boolean);
  normalizedValues.slice(0, 8).forEach((item) => items.push(`${label}：${item}`));
  if (normalizedValues.length > 8) items.push(`${label}：还有 ${normalizedValues.length - 8} 项未展开。`);
}

function addProviderStats(items: string[], value: unknown) {
  if (!isRecord(value)) return;
  const details = Object.entries(value)
    .filter(([, count]) => typeof count === "number")
    .map(([provider, count]) => `${formatProviderName(provider)} ${count} 条`);
  if (details.length) items.push(`公开来源返回：${details.join("，")}。`);
}

function addAcceptanceDetails(items: string[], value: unknown) {
  if (!isRecord(value)) return;
  if (typeof value.passed === "boolean") items.push(value.passed ? "公开搜索结果通过基础检查。" : "公开搜索结果需要继续复核。");
  addNumberDetail(items, value.queryCount, "实际搜索方向");
  addNumberDetail(items, value.resultCount, "有效搜索结果");
  addNumberDetail(items, value.candidateCount, "抽取候选");
  addNumberDetail(items, value.e2PlusCandidates, "高证据候选");
  addNumberDetail(items, value.hardRequirementReadyCandidates, "同时满足硬条件的高证据候选");
  addStringArrayDetails(items, value.candidateHardRequirements, "逐人硬条件");
  addNumberDetail(items, value.reviewRequiredCandidates, "需复核候选");
  addNumberDetail(items, value.outreachReadyCandidates, "可触达候选");
  addStringArrayDetails(items, value.coverageLabels, "覆盖来源");
  addStringArrayDetails(items, value.blockers, "阻断原因");
}

function addAttractionReadinessDetails(items: string[], value: unknown) {
  if (!isRecord(value)) return;
  if (typeof value.passed === "boolean") items.push(value.passed ? "渠道内容通过基础吸引力检查。" : "渠道内容需要继续打磨。");
  addStringArrayDetails(items, value.blockers, "内容问题");
  addStringArrayDetails(items, value.needsReview, "需人工复核");
  addStringArrayDetails(items, value.nextActions, "下一步");
}

function addCandidatePreviewDetails(items: string[], value: unknown) {
  if (!Array.isArray(value)) return;
  value.slice(0, 6).forEach((item, index) => {
    if (!isRecord(item)) return;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : `候选 ${index + 1}`;
    const evidence = typeof item.evidenceLevel === "string" && item.evidenceLevel.trim() ? item.evidenceLevel.trim() : "证据待补";
    const review = item.humanReviewNeeded ? "需复核" : "可继续";
    const source = typeof item.sourceType === "string" && item.sourceType.trim() ? `${formatCandidateSourceLabel(item.sourceType)}，` : "";
    const sourceUrl = typeof item.sourceUrl === "string" && item.sourceUrl.trim() ? "，有公开来源" : "";
    const action = typeof item.nextAction === "string" && item.nextAction.trim()
      ? `，${normalizeAgentUserFacingText(item.nextAction)}`
      : "";
    items.push(`候选：${name}（${source}${evidence}，${review}${sourceUrl}${action}）`);
  });
  if (value.length > 6) items.push(`候选：还有 ${value.length - 6} 位可在候选推进中查看。`);
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueDetails(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)));
}

function formatProviderName(provider: string) {
  const labels: Record<string, string> = {
    cache: "已保存结果",
    serper: "公开网页搜索",
    github: "GitHub",
    openalex: "论文检索",
  };
  return labels[provider] ?? provider;
}

function formatCandidateSourceLabel(sourceType: string) {
  const labels: Record<string, string> = {
    internal: "内部库",
    external: "外部发现",
    referred: "推荐",
  };
  return labels[sourceType] ?? "公开来源";
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "succeeded"
      ? "bg-emerald-50 text-emerald-700"
      : status === "failed" || status === "preflight_failed"
        ? "bg-rose-50 text-rose-700"
        : status === "waiting_for_confirmation" || status === "partially_succeeded"
          ? "bg-amber-50 text-amber-700"
          : status === "idle"
            ? "bg-[#f3f4f6] text-[#6b7280]"
            : "bg-[#eef5ff] text-[#2563eb]";
  return <span className={clsx("rounded-full px-2.5 py-1 text-xs font-semibold", tone)}>{formatRunStatus(status)}</span>;
}

function actionIcon(kind: "start" | "confirm" | "retry" | "revise" | "enrich" | "cancel" | "none") {
  if (kind === "retry") return <RotateCw className="size-4" />;
  if (kind === "confirm") return <CheckCircle2 className="size-4" />;
  if (kind === "revise" || kind === "enrich") return <Search className="size-4" />;
  return <Play className="size-4" />;
}

function summarizeStep(step: AgentStep) {
  const output = step.output ?? {};
  const checks = step.checks ?? {};
  const pieces: string[] = [];

  if (output.projectUpdated) pieces.push("项目画像已更新");
  addCount(pieces, output.searchQueries, "搜索方向");
  addCount(pieces, output.candidates, "候选");
  addCount(pieces, output.searchResults, "搜索结果");
  addCount(pieces, output.gaps, "缺口");
  addCount(pieces, output.posts, "渠道草稿");
  addCount(pieces, output.ranked, "已排序候选");
  addCount(pieces, output.cacheHits, "缓存命中");
  addCount(pieces, output.autoScreenedOut, "暂不推进");

  if (typeof checks.queries === "number") {
    pieces.push(`预计 ${checks.queries} 个搜索方向，已保存 ${numberText(checks.cached)} 个，需新查 ${numberText(checks.uncached)} 个`);
  }
  if (output.skipped && typeof output.reason === "string") {
    pieces.push(normalizeAgentUserFacingText(output.reason));
  }
  if (step.status === "pending") pieces.push("等待前置步骤完成");

  return pieces.slice(0, 3).join(" · ");
}

function addCount(pieces: string[], value: unknown, label: string) {
  if (typeof value === "number") pieces.push(`${label} ${value}`);
}

function formatRunStatus(status: string) {
  const labels: Record<string, string> = {
    idle: "待指令",
    planned: "待开始",
    preflight_failed: "需补充资料",
    waiting_for_confirmation: "等待确认",
    running: "执行中",
    succeeded: "已完成",
    partially_succeeded: "部分完成",
    failed: "未完成",
    cancelled: "已取消",
  };
  return labels[status] ?? "任务中";
}

function formatRunTime(value?: string | Date) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatStepStatus(status: string) {
  const labels: Record<string, string> = {
    pending: "待执行",
    running: "执行中",
    succeeded: "已完成",
    skipped: "已跳过",
    blocked: "等待确认",
    failed: "未完成",
  };
  return labels[status] ?? "待处理";
}

function isTerminalStatus(status: string) {
  return ["succeeded", "partially_succeeded", "failed", "cancelled", "preflight_failed"].includes(status);
}

function numberText(value: unknown) {
  return typeof value === "number" ? value : 0;
}
