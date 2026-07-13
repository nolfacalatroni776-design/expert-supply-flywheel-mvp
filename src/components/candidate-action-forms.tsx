"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Loader2, MailCheck, Save, ShieldOff } from "lucide-react";
import clsx from "clsx";

type ContactPermissionFormProps = {
  expertId: string;
  email?: string;
  profileUrl?: string;
  consentState: string;
  permissionBasis?: string;
  notes?: string;
};

type CandidateReviewFormProps = {
  candidateId: string;
  disabled?: boolean;
};

type DncFormProps = {
  candidateId: string;
  disabled?: boolean;
};

type TrialResultFormProps = {
  candidateId: string;
  disabled?: boolean;
};

type DraftStatusButtonProps = {
  draftId: string;
  disabled?: boolean;
};

type ApiPayload = {
  ok?: boolean;
  error?: string;
};

const inputClass =
  "h-10 rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm outline-none transition focus:border-[#2563eb]";
const textareaClass =
  "min-h-[76px] resize-y rounded-lg border border-[#e7e7e2] bg-white px-3 py-2 text-sm leading-5 outline-none transition focus:border-[#2563eb]";

export function ContactPermissionForm({
  expertId,
  email,
  profileUrl,
  consentState,
  permissionBasis,
  notes,
}: ContactPermissionFormProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(null);
        const formData = new FormData(event.currentTarget);
        startTransition(async () => {
          await submitJson({
            endpoint: `/api/experts/${expertId}/contact`,
            method: "PATCH",
            body: {
              email: formData.get("email"),
              profileUrl: formData.get("profileUrl"),
              consentState: formData.get("consentState"),
              contactPermissionBasis: formData.get("contactPermissionBasis"),
              notes: formData.get("notes"),
            },
            onMessage: setMessage,
            success: "联系方式已保存。",
          });
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <input name="email" type="email" placeholder="邮箱" defaultValue={email ?? ""} className={inputClass} />
        <select name="consentState" defaultValue={consentState} className={inputClass}>
          <option value="unknown">未确认</option>
          <option value="legitimate_interest">合理业务联系</option>
          <option value="consented">已同意</option>
          <option value="unsubscribed">已退订</option>
          <option value="do_not_contact">不再联系</option>
          <option value="delete_requested">请求删除</option>
        </select>
      </div>
      <input name="profileUrl" type="url" placeholder="公开主页 URL" defaultValue={profileUrl ?? ""} className={inputClass} />
      <select name="contactPermissionBasis" defaultValue={permissionBasis ?? ""} className={inputClass}>
        <option value="">选择联系依据</option>
        <option value="public_outreach_allowed">公开主页允许业务联系</option>
        <option value="direct_consent">候选人已同意联系</option>
        <option value="referral_consent">推荐人确认可联系</option>
        <option value="manual_review_required">需继续确认</option>
      </select>
      <textarea name="notes" placeholder="联系备注" defaultValue={notes ?? ""} className={textareaClass} />
      <SubmitRow
        icon={Save}
        label="保存联系方式"
        pending={isPending}
        message={message}
      />
    </form>
  );
}

export function CandidateReviewForm({ candidateId, disabled }: CandidateReviewFormProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [decision, setDecision] = useState("");

  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(null);
        const formData = new FormData(event.currentTarget);
        const selectedDecision = String(formData.get("decision") ?? "");
        const note = String(formData.get("note") ?? "").trim();
        if (!selectedDecision) {
          setMessage({ type: "error", text: "请选择复核结论。" });
          return;
        }
        if (selectedDecision === "needs_more_evidence" && note.length < 3) {
          setMessage({ type: "error", text: "请补充需要哪些证据。" });
          return;
        }
        startTransition(async () => {
          await submitJson({
            endpoint: `/api/project-candidates/${candidateId}/review`,
            method: "PATCH",
            body: {
              decision: selectedDecision,
              note,
            },
            onMessage: setMessage,
            success: "复核结果已保存。",
          });
        });
      }}
    >
      <select name="decision" value={decision} onChange={(event) => setDecision(event.target.value)} disabled={disabled || isPending} className={inputClass} required>
        <option value="">选择复核结论</option>
        <option value="approved">通过复核</option>
        <option value="needs_more_evidence">需要补证据</option>
      </select>
      <textarea name="note" placeholder={decision === "needs_more_evidence" ? "说明需要补充哪些证据" : "复核备注"} disabled={disabled || isPending} className={textareaClass} />
      <SubmitRow icon={CheckCircle2} label="保存复核" pending={isPending} disabled={disabled} message={message} />
    </form>
  );
}

export function DncForm({ candidateId, disabled }: DncFormProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(null);
        const formData = new FormData(event.currentTarget);
        startTransition(async () => {
          await submitJson({
            endpoint: `/api/project-candidates/${candidateId}/stage`,
            method: "PATCH",
            body: {
              stage: "do_not_contact",
              scope: formData.get("scope"),
              reason: formData.get("reason"),
            },
            onMessage: setMessage,
            success: "不再联系状态已保存。",
          });
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[0.9fr_1.1fr]">
        <select name="scope" defaultValue="project" disabled={disabled || isPending} className={inputClass}>
          <option value="project">仅当前项目</option>
          <option value="global">全部项目</option>
        </select>
        <input
          name="reason"
          required
          minLength={3}
          placeholder="原因"
          disabled={disabled || isPending}
          className={inputClass}
        />
      </div>
      <SubmitRow icon={ShieldOff} label="保存不再联系" pending={isPending} disabled={disabled} variant="danger" message={message} />
    </form>
  );
}

export function TrialResultForm({ candidateId, disabled }: TrialResultFormProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  return (
    <form
      className="mt-3 grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(null);
        const formData = new FormData(event.currentTarget);
        startTransition(async () => {
          await submitJson({
            endpoint: `/api/project-candidates/${candidateId}/trial-result`,
            method: "POST",
            body: {
              score: formData.get("score"),
              outcome: formData.get("outcome"),
              notes: formData.get("notes"),
            },
            onMessage: setMessage,
            success: "试标结果已保存。",
          });
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[0.8fr_1fr]">
        <input name="score" type="number" min="0" max="100" step="1" placeholder="分数" disabled={disabled || isPending} className={inputClass} />
        <select name="outcome" defaultValue="needs_review" disabled={disabled || isPending} className={inputClass}>
          <option value="passed">通过</option>
          <option value="failed">未通过</option>
          <option value="needs_review">继续复核</option>
        </select>
      </div>
      <textarea name="notes" placeholder="试标备注" disabled={disabled || isPending} className={textareaClass} />
      <SubmitRow icon={Save} label="保存试标结果" pending={isPending} disabled={disabled} message={message} />
    </form>
  );
}

export function DraftStatusButton({ draftId, disabled }: DraftStatusButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={disabled || isPending}
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            await submitJson({
              endpoint: `/api/outreach-drafts/${draftId}/status`,
              method: "PATCH",
              body: { status: "sent" },
              onMessage: setMessage,
              success: "已记录发送状态。",
            });
          });
        }}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#e7e7e2] bg-white px-3 text-sm font-semibold text-[#28251e] transition hover:bg-[#f9f9f9] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? <Loader2 className="size-4 animate-spin" /> : <MailCheck className="size-4" />}
        {isPending ? "保存中" : "记录已发送"}
      </button>
      {message ? <Message message={message} /> : null}
    </div>
  );
}

async function submitJson({
  endpoint,
  method,
  body,
  success,
  onMessage,
}: {
  endpoint: string;
  method: "POST" | "PATCH";
  body: unknown;
  success: string;
  onMessage: (message: { type: "error" | "success"; text: string }) => void;
}) {
  try {
    const response = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as ApiPayload;
    if (!response.ok) {
      onMessage({ type: "error", text: payload.error ?? "操作未完成，请稍后重试。" });
      return;
    }
    onMessage({ type: "success", text: success });
    window.location.reload();
  } catch (error) {
    onMessage({ type: "error", text: error instanceof Error ? "网络连接异常，请稍后重试。" : "网络连接异常，请稍后重试。" });
  }
}

function SubmitRow({
  icon: Icon,
  label,
  pending,
  disabled,
  variant = "default",
  message,
}: {
  icon: typeof Save;
  label: string;
  pending: boolean;
  disabled?: boolean;
  variant?: "default" | "danger";
  message: { type: "error" | "success"; text: string } | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="submit"
        disabled={disabled || pending}
        className={clsx(
          "inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
          variant === "danger" ? "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100" : "bg-[#28251e] text-white hover:bg-black",
        )}
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
        {pending ? "保存中" : label}
      </button>
      {message ? <Message message={message} /> : null}
    </div>
  );
}

function Message({ message }: { message: { type: "error" | "success"; text: string } }) {
  return (
    <p className={clsx("text-xs leading-5", message.type === "error" ? "text-red-600" : "text-emerald-700")}>
      {message.text}
    </p>
  );
}
