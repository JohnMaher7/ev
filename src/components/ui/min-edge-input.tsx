import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MinEdgeInputProps {
  value: number;
  onApply: (value: number) => void;
  precision?: number;
}

export function MinEdgeInput({ value, onApply, precision = 3 }: MinEdgeInputProps) {
  const [draft, setDraft] = useState<string>(() => value.toFixed(precision));
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (!isDirty) {
      setDraft(value.toFixed(precision));
    }
  }, [value, precision, isDirty]);

  const parsedDraft = useMemo(() => {
    const next = Number(draft);
    return Number.isNaN(next) ? null : next;
  }, [draft]);

  const handleApply = () => {
    if (parsedDraft === null) return;
    setIsDirty(false);
    onApply(Number(parsedDraft.toFixed(precision)));
  };

  const handleChange = (next: string) => {
    setDraft(next);
    setIsDirty(true);
  };

  const showWarning = draft.trim().length > 0 && parsedDraft === null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleApply();
            }
            if (event.key === "Escape") {
              setDraft(value.toFixed(precision));
              setIsDirty(false);
            }
          }}
          onBlur={handleApply}
          placeholder="0.000"
          aria-label="Minimum edge in percentage points"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={handleApply}
          disabled={parsedDraft === null || parsedDraft === value}
        >
          Apply
        </Button>
      </div>
      <div className="flex items-center justify-between text-[11px] text-[var(--color-text-faint)]">
        <span>Press Enter to update table</span>
        <span className={cn("text-[11px] uppercase tracking-wide", showWarning && "text-[var(--color-negative)]")}
        >
          {showWarning ? "Invalid number" : `${precision} decimal precision`}
        </span>
      </div>
    </div>
  );
}





