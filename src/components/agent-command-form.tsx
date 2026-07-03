"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Circle, Clock3, Loader2, Play, RotateCw, SendHorizontal, XCircle } from "lucide-react";
import clsx from "clsx";

const intents = [
  { id: "full_sourcing", label: "完整发现候选", helper: "画像、内部召回、缺口和排序" },
  { id: "internal_match", label: "召回内部专家", helper: "优先复用专家库" },
  { id: "analyze_supply_gap", label: "分析供给缺口", helper: "判断缺什么、缺多少" },
  { id: "external_research", label: "补充公开候选", helper: "确认后查找公开来源" },
  { id: "rank_supply", label: "更新候选排序", helper: "整理候选优先级" },
  { id: "recruitment_retrospective", label: "生成项目复盘", helper: "沉淀来源和下一步" },
  { id: "analyze_project", label: "补齐需求画像", helper: "完善要求和搜索方向" },
  { id: "search_candidates", label: "搜索候选", helper: "按搜索式发现专家" },
  { id: "generate_marketing", label: "生成分发内容", helper: "生成渠道发布稿" },
] as const;

type IntentId = (typeof intents)[number]["id"];

type AgentCommandFormProps = {
  projectId: string;
  projectTitle: string;
};

type AgentStep = {
  id: string;
  stepKey: string;
  label: string;
  status: string;
  requiresConfirmation: boolean;
  errorMessage?: string | null;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  checks?: Record<string, unknown>;
};

type AgentRun = {
  id: string;
  label: string;
  intent: string;
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

export function AgentCommandForm({ projectId, projectTitle }: AgentCommandFormProps) {
  const [intent, setIntent] = useState<IntentId>("full_sourcing");
  const [instruction, setInstruction] = useState(
    `请推进「${projectTitle}」的专家招募，优先保证证据可信、合规复核和后续可触达性。`,
  );
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const callRunAction = (endpoint: string, options?: { reloadOnTerminal?: boolean }) => {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" } });
        const payload = (await response.json().catch(() => ({}))) as AgentRunResponse;
        if (!response.ok || !payload.data?.run) {
          setError(payload.error ?? "任务未完成，请稍后重试。");
          return;
        }
        setRun(payload.data.run);
        if (options?.reloadOnTerminal && isTerminalStatus(payload.data.run.status)) {
          window.location.reload();
        }
      } catch {
        setError("网络连接异常，请稍后重试。");
      }
    });
  };

  return (
    <div className="grid gap-4">
      <form
        className="grid gap-3"
        method="post"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          startTransition(async () => {
            try {
              const response = await fetch(`/api/projects/${projectId}/agent-command`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ intent, instruction }),
              });
              const payload = (await response.json().catch(() => ({}))) as AgentRunResponse;
              if (!response.ok || !payload.data?.run) {
                setError(payload.error ?? "任务未提交成功，请检查内容后重试。");
                return;
              }
              setRun(payload.data.run);
            } catch {
              setError("网络连接异常，请稍后重试。");
            }
          });
        }}
      >
        <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-5">
          {intents.map((item) => (
            <label
              key={item.id}
              className={clsx(
                "grid cursor-pointer gap-1 rounded-lg border px-3 py-2 transition",
                intent === item.id ? "border-[#9db7d3] bg-[#eef5ff]" : "border-[#f0eee8] bg-white hover:border-[#d8d8d0]",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-[#28251e]">
                <input
                  type="radio"
                  name="intent"
                  value={item.id}
                  checked={intent === item.id}
                  onChange={() => setIntent(item.id)}
                  className="size-3 accent-[#2563eb]"
                />
                {item.label}
              </span>
              <span className="text-xs leading-5 text-[#7a7469]">{item.helper}</span>
            </label>
          ))}
        </div>
        <label className="grid gap-1">
          <span className="text-xs font-semibold text-[#7a7469]">工作指令</span>
          <textarea
            required
            minLength={8}
            maxLength={1200}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            className="min-h-[104px] resize-y rounded-lg border border-[#e7e7e2] bg-[#f9f9f9] px-4 py-3 text-sm leading-6 text-[#4d473e] outline-none transition focus:border-[#2563eb]"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#28251e] px-4 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
            {run ? "重新生成计划" : "生成执行计划"}
          </button>
          {error ? <p className="text-xs leading-5 text-red-600">{error}</p> : <p className="text-xs leading-5 text-[#7a7469]">先生成计划，再开始执行。</p>}
        </div>
      </form>

      {run ? (
        <section className="grid gap-3 rounded-lg border border-[#e7e7e2] bg-[#fbfdff] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-[#28251e]">{run.label}</h3>
                <StatusPill status={run.status} />
              </div>
              <p className="mt-1 text-sm leading-6 text-[#5f5a50]">{run.plan?.objective ?? run.report?.summary ?? "任务计划已生成。"}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {run.status === "waiting_for_confirmation" ? (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => callRunAction(`/api/agent-runs/${run.id}/confirm`, { reloadOnTerminal: true })}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#2563eb] px-3 text-sm font-semibold text-white transition hover:bg-[#1d4ed8] disabled:opacity-50"
                >
                  {isPending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  确认并继续
                </button>
              ) : null}
              {run.status === "planned" ? (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => callRunAction(`/api/agent-runs/${run.id}/start`, { reloadOnTerminal: true })}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#28251e] px-3 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-50"
                >
                  {isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  开始执行
                </button>
              ) : null}
              {run.status === "failed" || run.status === "partially_succeeded" ? (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => callRunAction(`/api/agent-runs/${run.id}/retry`, { reloadOnTerminal: true })}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[#dbe4ee] bg-white px-3 text-sm font-semibold text-[#28251e] transition hover:bg-[#f8fafc] disabled:opacity-50"
                >
                  {isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                  重试未完成
                </button>
              ) : null}
              {!isTerminalStatus(run.status) ? (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => callRunAction(`/api/agent-runs/${run.id}/cancel`)}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[#f1d3d3] bg-white px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
                >
                  <XCircle className="size-4" />
                  取消
                </button>
              ) : null}
            </div>
          </div>

          <div className="grid max-h-[320px] gap-2 overflow-y-auto pr-1">
            {run.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </div>

          <RunReport run={run} />
        </section>
      ) : null}
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
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-2 rounded-lg border border-[#edf0f3] bg-white px-3 py-2">
      <Icon className={clsx("mt-0.5 size-4", step.status === "running" ? "animate-spin" : null, tone)} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-[#28251e]">{step.label}</p>
          {step.requiresConfirmation ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">需确认</span> : null}
          <span className="text-xs text-[#8c8578]">{formatStepStatus(step.status)}</span>
        </div>
        {step.errorMessage ? <p className="mt-1 text-xs leading-5 text-rose-600">{step.errorMessage}</p> : null}
        {step.status === "blocked" && step.checks ? (
          <p className="mt-1 text-xs leading-5 text-[#7a7469]">
            预计 {numberText(step.checks.queries)} 个搜索方向，已保存 {numberText(step.checks.cached)} 个，需新查 {numberText(step.checks.uncached)} 个。
          </p>
        ) : null}
      </div>
    </div>
  );
}

function RunReport({ run }: { run: AgentRun }) {
  const report = run.report ?? {};
  const items = [
    { title: "已完成", values: report.completed ?? [] },
    { title: "写入结果", values: report.written ?? [] },
    { title: "需复核", values: report.needsReview ?? [] },
    { title: "下一步", values: report.nextActions ?? [] },
    { title: "未完成", values: [...(report.failed ?? []), ...(report.skipped ?? [])] },
  ].filter((item) => item.values.length);

  if (!items.length) return null;
  return (
    <div className="grid gap-2 border-t border-[#e7e7e2] pt-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.title} className="rounded-lg bg-white px-3 py-2">
          <p className="text-xs font-semibold text-[#7a7469]">{item.title}</p>
          <ul className="mt-1 grid gap-1">
            {item.values.slice(0, 4).map((value) => (
              <li key={`${item.title}-${value}`} className="text-xs leading-5 text-[#4d473e]">
                {value}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "succeeded"
      ? "bg-emerald-50 text-emerald-700"
      : status === "failed" || status === "preflight_failed"
        ? "bg-rose-50 text-rose-700"
        : status === "waiting_for_confirmation" || status === "partially_succeeded"
          ? "bg-amber-50 text-amber-700"
          : "bg-[#eef5ff] text-[#2563eb]";
  return <span className={clsx("rounded-full px-2 py-0.5 text-xs font-semibold", tone)}>{formatRunStatus(status)}</span>;
}

function formatRunStatus(status: string) {
  const labels: Record<string, string> = {
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
