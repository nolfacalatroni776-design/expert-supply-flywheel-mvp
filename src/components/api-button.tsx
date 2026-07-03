"use client";

import { useState, useTransition } from "react";
import {
  ClipboardCheck,
  Loader2,
  Mail,
  Megaphone,
  Search,
  ShieldOff,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import clsx from "clsx";

const icons = {
  analyze: WandSparkles,
  run: Sparkles,
  search: Search,
  outreach: Mail,
  trial: ClipboardCheck,
  dnc: ShieldOff,
  marketing: Megaphone,
};

type ApiButtonProps = {
  label: string;
  endpoint: string;
  method?: "POST" | "PATCH";
  body?: unknown;
  icon?: keyof typeof icons;
  className?: string;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  disabledReason?: string;
  confirmMessage?: string;
  successLabel?: string;
  onDone?: () => void;
};

export function ApiButton({
  label,
  endpoint,
  method = "POST",
  body,
  icon,
  className,
  variant = "default",
  disabled,
  disabledReason,
  confirmMessage,
  successLabel,
  onDone,
}: ApiButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const Icon = icon ? icons[icon] : null;
  const helpText = error ?? success ?? (disabled ? disabledReason : null);

  return (
    <div className="min-w-0 max-w-full flex flex-col gap-1">
      <button
        type="button"
        disabled={disabled || isPending}
        onClick={() => {
          if (confirmMessage && !window.confirm(confirmMessage)) return;
          setError(null);
          setSuccess(null);
          startTransition(async () => {
            try {
              const response = await fetch(endpoint, {
                method,
                headers: { "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
              });
              const payload = (await response.json().catch(() => ({}))) as {
                error?: string;
              };
              if (!response.ok) {
                setError(payload.error ?? "操作未完成，请稍后重试。");
                return;
              }
              if (successLabel) setSuccess(successLabel);
              onDone?.();
              window.location.reload();
            } catch (fetchError) {
              setError(fetchError instanceof Error ? "网络连接异常，请稍后重试。" : "网络连接异常，请稍后重试。");
            }
          });
        }}
        className={clsx(
          "inline-flex h-9 max-w-full items-center justify-center gap-2 rounded-lg border px-3 text-sm font-semibold leading-none transition disabled:cursor-not-allowed disabled:opacity-50",
          variant === "primary"
            ? "border-[#28251e] bg-[#28251e] text-white shadow-sm hover:bg-black"
            : variant === "danger"
              ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
              : "border-[#e7e7e2] bg-white text-[#28251e] hover:border-[#d8d8d0] hover:bg-[#f9f9f9]",
          className,
        )}
      >
        {isPending ? <Loader2 className="size-4 shrink-0 animate-spin" /> : Icon ? <Icon className="size-4 shrink-0" /> : null}
        <span className="truncate whitespace-nowrap">{isPending ? "运行中" : label}</span>
      </button>
      {helpText ? (
        <p className={clsx("max-w-72 text-xs leading-5", error ? "text-red-600" : disabled ? "text-[#7a7469]" : "text-emerald-700")}>
          {helpText}
        </p>
      ) : null}
    </div>
  );
}
