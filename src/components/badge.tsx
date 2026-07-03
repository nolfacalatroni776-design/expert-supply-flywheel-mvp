import clsx from "clsx";

const variants: Record<string, string> = {
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  amber: "border-[#f5c35b] bg-[#ffbb171a] text-[#8f4300]",
  red: "border-rose-200 bg-rose-50 text-rose-700",
  blue: "border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8]",
  indigo: "border-indigo-200 bg-indigo-50 text-indigo-700",
  zinc: "border-[#e7e7e2] bg-[#f9f9f9] text-[#5f5a50]",
};

export function Badge({ children, tone = "zinc" }: { children: React.ReactNode; tone?: keyof typeof variants }) {
  return (
    <span className={clsx("inline-flex h-6 max-w-full items-center rounded-lg border px-2.5 text-xs font-semibold leading-none", variants[tone])}>
      <span className="truncate whitespace-nowrap">{children}</span>
    </span>
  );
}
