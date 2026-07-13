import { createProjectAction, createProjectFromDemandAction } from "@/app/actions";
import clsx from "clsx";

export function CreateProjectForm({ variant = "spacious" }: { variant?: "spacious" | "compact" }) {
  const isSpacious = variant === "spacious";
  const inputClass =
    "h-10 rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm outline-none transition focus:border-[#2563eb]";

  return (
    <form action={createProjectAction} className={clsx("grid", isSpacious ? "gap-3" : "gap-2")}>
      <label className="grid gap-1">
        <span className="text-xs font-medium text-[#7a7469]">项目标题</span>
        <input
          name="title"
          required
          minLength={3}
          placeholder="肺结节 CT 标注专家招募"
          className={inputClass}
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
        />
      </label>
      <div className={clsx("grid gap-2", isSpacious ? "sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-2")}>
        <input name="domain" placeholder="领域" className={inputClass} />
        <input name="taskType" placeholder="任务" className={inputClass} />
        <input name="quantity" type="number" min="1" placeholder="数量" className={inputClass} />
        <input name="budgetMin" type="number" min="0" placeholder="低预算" className={inputClass} />
        <input name="budgetMax" type="number" min="0" placeholder="高预算" className={inputClass} />
        <input name="languages" placeholder="语言" className={inputClass} />
      </div>
      <input name="regions" placeholder="地区/时区，逗号分隔" className={inputClass} />
      <button
        type="submit"
        className={clsx(
          "h-10 rounded-lg bg-[#28251e] px-4 text-sm font-semibold text-white transition hover:bg-black",
          isSpacious ? "sm:w-fit" : "w-full",
        )}
      >
        创建项目
      </button>
    </form>
  );
}

export function QuickProjectStartForm() {
  return (
    <form action={createProjectFromDemandAction} className="grid gap-3">
      <label className="grid gap-1">
        <span className="text-xs font-medium text-[#7a7469]">项目名称</span>
        <input
          name="title"
          placeholder="可不填，系统会按需求生成"
          className="h-10 rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm outline-none transition focus:border-[#2563eb]"
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
        />
      </label>
      <button
        type="submit"
        className="inline-flex h-10 w-fit items-center justify-center rounded-lg bg-[#28251e] px-4 text-sm font-semibold text-white transition hover:bg-black"
      >
        创建并进入助手
      </button>
      <p className="text-xs leading-5 text-[#7a7469]">创建后先生成执行计划，不会自动搜索、触达或发布。</p>
    </form>
  );
}
