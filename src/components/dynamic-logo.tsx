import clsx from "clsx";

type DynamicLogoProps = {
  size?: "sm" | "md";
  label?: string;
};

const sizes = {
  sm: "size-9",
  md: "size-10",
};

export function DynamicLogo({ size = "sm", label = "专家供给增长" }: DynamicLogoProps) {
  return (
    <span
      aria-label={label}
      className={clsx(
        "expert-logo relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg",
        "bg-[#111827] text-white shadow-[0_1px_2px_rgba(17,17,17,0.08)]",
        sizes[size],
      )}
      role="img"
    >
      <span className="expert-logo__orbit expert-logo__orbit--outer" />
      <span className="expert-logo__orbit expert-logo__orbit--inner" />
      <span className="expert-logo__node expert-logo__node--one" />
      <span className="expert-logo__node expert-logo__node--two" />
      <span className="expert-logo__node expert-logo__node--three" />
      <span className="expert-logo__core">
        <span className="expert-logo__glyph">E</span>
      </span>
    </span>
  );
}
