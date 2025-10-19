import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface FilterPillProps {
  label: string;
  value: string;
  onClick?: () => void;
  active?: boolean;
  children?: React.ReactNode;
}

export function FilterPill({ label, value, onClick, active = false, children }: FilterPillProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleToggle = () => {
    setIsOpen((prev) => !prev);
    onClick?.();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition",
          active && "border-[var(--color-info)] bg-[rgba(56,189,248,0.15)] text-[var(--color-text-primary)]"
        )}
      >
        <span className="uppercase tracking-wide">{label}</span>
        <span className="rounded-full bg-[var(--color-card-muted)] px-2 py-0.5 text-[11px] text-[var(--color-text-primary)]">
          {value || "Any"}
        </span>
        {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {isOpen && children ? (
        <div className="absolute right-0 z-50 mt-2 w-56 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 shadow-menu">
          {children}
        </div>
      ) : null}
    </div>
  );
}




