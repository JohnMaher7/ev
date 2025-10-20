import { forwardRef } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  isLoading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-[var(--color-positive)] text-[#0f172a] hover:bg-[#0fd1be] focus-visible:ring-[rgba(20,184,166,0.45)]",
  secondary:
    "border border-[var(--color-border)] bg-[var(--color-card)] hover:bg-[var(--color-card-muted)] text-[var(--color-text-primary)]",
  ghost:
    "text-[var(--color-text-muted)] hover:bg-[var(--color-card-muted)]",
  danger:
    "bg-[var(--color-negative)] text-white hover:bg-[#fb7185] focus-visible:ring-[rgba(248,113,113,0.45)]",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-9 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", type = "button", isLoading = false, disabled, children, ...props },
  ref
) {
  const isDisabled = disabled || isLoading;

  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-sm)] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-app-bg)]",
        variantClasses[variant],
        sizeClasses[size],
        isDisabled && "pointer-events-none opacity-50",
        className
      )}
      disabled={isDisabled}
      {...props}
    >
      {isLoading && (
        <span className="mr-2 inline-flex h-3 w-3 animate-spin rounded-full border-2 border-transparent border-b-white border-l-white" aria-hidden="true" />
      )}
      {children}
    </button>
  );
});





