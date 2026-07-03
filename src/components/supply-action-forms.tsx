"use client";

import { useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";
import clsx from "clsx";

const inputClass =
  "h-10 rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm outline-none transition focus:border-[#2563eb]";
const textareaClass =
  "min-h-[76px] resize-y rounded-lg border border-[#e7e7e2] bg-white px-3 py-2 text-sm leading-5 outline-none transition focus:border-[#2563eb]";

type Message = { type: "error" | "success"; text: string } | null;

export function ExpertQualityEventForm({
  expertId,
  projectId,
  candidateId,
}: {
  expertId: string;
  projectId?: string;
  candidateId?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);

  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(null);
        const formData = new FormData(event.currentTarget);
        startTransition(async () => {
          await submitJson({
            endpoint: `/api/experts/${expertId}/quality-event`,
            body: {
              projectId,
              candidateId,
              eventType: formData.get("eventType"),
              channel: formData.get("channel"),
              score: formData.get("score"),
              notes: formData.get("notes"),
            },
            onMessage: setMessage,
            success: "专家回流已记录。",
          });
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[1fr_0.8fr]">
        <select name="eventType" defaultValue="activated" className={inputClass} disabled={isPending}>
          <option value="activated">状态更新</option>
          <option value="replied">已回复</option>
          <option value="declined">暂不参与</option>
          <option value="trial_passed">试标通过</option>
          <option value="trial_failed">试标未通过</option>
          <option value="onboarded">已入池</option>
          <option value="unsubscribed">不再联系</option>
        </select>
        <input name="score" type="number" min="0" max="100" step="1" placeholder="质量分" className={inputClass} disabled={isPending} />
      </div>
      <input name="channel" placeholder="来源/渠道" defaultValue="manual" className={inputClass} disabled={isPending} />
      <textarea name="notes" placeholder="回流备注" className={textareaClass} disabled={isPending} />
      <SubmitRow icon={Save} label="记录回流" pending={isPending} message={message} />
    </form>
  );
}

async function submitJson({
  endpoint,
  body,
  success,
  onMessage,
}: {
  endpoint: string;
  body: unknown;
  success: string;
  onMessage: (message: Exclude<Message, null>) => void;
}) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      onMessage({ type: "error", text: payload.error ?? "操作未完成，请稍后重试。" });
      return;
    }
    onMessage({ type: "success", text: success });
    window.location.reload();
  } catch {
    onMessage({ type: "error", text: "网络连接异常，请稍后重试。" });
  }
}

function SubmitRow({
  icon: Icon,
  label,
  pending,
  message,
}: {
  icon: typeof Save;
  label: string;
  pending: boolean;
  message: Message;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#28251e] px-3 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
        {pending ? "保存中" : label}
      </button>
      {message ? (
        <p className={clsx("text-xs leading-5", message.type === "error" ? "text-red-600" : "text-emerald-700")}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
