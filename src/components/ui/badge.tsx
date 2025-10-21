import { forwardRef } from "react";
import { cn } from "@/lib/utils";

const intentToClasses: Record<string, string> = {
  default: "bg-[var(--color-card-muted)] text-[var(--color-text-muted)] border-[var(--color-border)]",
  success: "bg-[var(--color-positive-soft)] text-[var(--color-positive)] border-transparent",
  danger: "bg-[var(--color-negative-soft)] text-[var(--color-negative)] border-transparent",
  warning: "bg-[rgba(250,204,21,0.12)] text-[#facc15] border-transparent",
  info: "bg-[rgba(56,189,248,0.15)] text-[var(--color-info)] border-transparent",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  intent?: keyof typeof intentToClasses;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, intent = "default", ...props },
  ref
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide",
        intentToClasses[intent] ?? intentToClasses.default,
        className
      )}
      {...props}
    />
  );
});






