"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";

export function CreateProjectForm({ variant = "spacious" }: { variant?: "spacious" | "compact" }) {
  const isSpacious = variant === "spacious";
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputClass =
    "h-10 rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm outline-none transition focus:border-[#2563eb]";

  return (
    <form
      className={clsx("grid", isSpacious ? "gap-3" : "gap-2")}
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const title = String(formData.get("title") ?? "").trim();
        const rawDemand = String(formData.get("rawDemand") ?? "").trim();
        const payload: Record<string, unknown> = {
          title,
          rawDemand,
          languages: splitList(formData.get("languages")),
          regions: splitList(formData.get("regions")),
        };

        addText(payload, "domain", formData.get("domain"));
        addText(payload, "taskType", formData.get("taskType"));
        addNumber(payload, "quantity", formData.get("quantity"));
        addNumber(payload, "budgetMin", formData.get("budgetMin"));
        addNumber(payload, "budgetMax", formData.get("budgetMax"));

        createProject(payload, "demand", setError, startTransition);
      }}
    >
      <label className="grid gap-1">
        <span className="text-xs font-medium text-[#7a7469]">项目标题</span>
        <input
          name="title"
          required
          minLength={3}
          placeholder="肺结节 CT 标注专家招募"
          className={inputClass}
          suppressHydrationWarning
        />
      </label>
      <label className="grid gap-1">
        <span className="text-xs font-medium text-[#7a7469]">项目需求</span>
        <textarea
          name="rawDemand"
          required
          minLength={20}
          rows={isSpacious ? 5 : 4}
          placeholder="为肺结节 CT 标注项目招募 50 位放射科医生，要求..."
          className="resize-none rounded-lg border border-[#e7e7e2] bg-white px-3 py-2 text-sm leading-5 outline-none transition focus:border-[#2563eb]"
          suppressHydrationWarning
        />
      </label>
      <div className={clsx("grid gap-2", isSpacious ? "sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-2")}>
        <input name="domain" placeholder="领域" className={inputClass} suppressHydrationWarning />
        <input name="taskType" placeholder="任务" className={inputClass} suppressHydrationWarning />
        <input name="quantity" type="number" min="1" placeholder="数量" className={inputClass} suppressHydrationWarning />
        <input name="budgetMin" type="number" min="0" placeholder="最低预算" aria-label="最低预算" className={inputClass} suppressHydrationWarning />
        <input name="budgetMax" type="number" min="0" placeholder="最高预算" aria-label="最高预算" className={inputClass} suppressHydrationWarning />
        <input name="languages" placeholder="语言" className={inputClass} suppressHydrationWarning />
      </div>
      <input name="regions" placeholder="地区/时区，逗号分隔" className={inputClass} suppressHydrationWarning />
      <p className="text-xs leading-5 text-[#7a7469]">填写预算时，请在项目需求中注明币种和计价单位，例如“200-300 元/小时”。</p>
      <button
        type="submit"
        disabled={isPending}
        className={clsx(
          "h-10 rounded-lg bg-[#28251e] px-4 text-sm font-semibold text-white transition hover:bg-black",
          "disabled:cursor-not-allowed disabled:opacity-50",
          isSpacious ? "sm:w-fit" : "w-full",
        )}
      >
        {isPending ? "创建中..." : "创建项目"}
      </button>
      {error ? <p className="text-xs leading-5 text-rose-600">{error}</p> : null}
    </form>
  );
}

export function QuickProjectStartForm() {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const rawDemand = String(formData.get("rawDemand") ?? "").trim();
        const explicitTitle = String(formData.get("title") ?? "").trim();
        const title = explicitTitle.length >= 3 ? explicitTitle : makeProjectTitle(rawDemand);

        createProject({ title, rawDemand, languages: [], regions: [] }, "agent", setError, startTransition);
      }}
    >
      <label className="grid gap-1">
        <span className="text-xs font-medium text-[#7a7469]">项目名称</span>
        <input
          name="title"
          placeholder="可不填，系统会按需求生成"
          className="h-10 rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm outline-none transition focus:border-[#2563eb]"
          suppressHydrationWarning
        />
      </label>
      <label className="grid gap-1">
        <span className="text-xs font-medium text-[#7a7469]">招募需求</span>
        <textarea
          name="rawDemand"
          required
          minLength={20}
          rows={5}
          placeholder="例如：为肺结节 CT 标注招募 50 位放射科医生，要求有胸部 CT 或肺结节诊断经验。"
          className="resize-none rounded-lg border border-[#e7e7e2] bg-white px-3 py-2 text-sm leading-6 outline-none transition focus:border-[#2563eb]"
          suppressHydrationWarning
        />
      </label>
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex h-10 w-fit items-center justify-center rounded-lg bg-[#28251e] px-4 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "创建中..." : "创建并进入助手"}
      </button>
      {error ? <p className="text-xs leading-5 text-rose-600">{error}</p> : null}
      <p className="text-xs leading-5 text-[#7a7469]">创建后先生成执行计划，不会自动搜索、触达或发布。</p>
    </form>
  );
}

type ProjectResponse = {
  ok?: boolean;
  data?: {
    project?: {
      id?: string;
    };
  };
  error?: string;
};

function createProject(
  payload: Record<string, unknown>,
  nextView: "agent" | "demand",
  setError: (message: string | null) => void,
  startTransition: (callback: () => void) => void,
) {
  setError(null);
  startTransition(async () => {
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json().catch(() => ({}))) as ProjectResponse;
      const projectId = result.data?.project?.id;

      if (!response.ok || !projectId) {
        setError(result.error ?? "项目未创建成功，请检查需求内容后重试。");
        return;
      }

      window.location.assign(`/?project=${encodeURIComponent(projectId)}&view=${nextView}`);
    } catch {
      setError("网络连接异常，项目未创建成功，请稍后重试。");
    }
  });
}

function splitList(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function addText(payload: Record<string, unknown>, key: string, value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (text) payload[key] = text;
}

function addNumber(payload: Record<string, unknown>, key: string, value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (text) payload[key] = Number(text);
}

function makeProjectTitle(rawDemand: string) {
  const cleaned = rawDemand.replace(/\s+/g, " ").trim();
  if (!cleaned) return "专家招募项目";
  const short = cleaned.length > 22 ? `${cleaned.slice(0, 22)}...` : cleaned;
  return short.includes("招募") ? short : `${short}专家招募`;
}
