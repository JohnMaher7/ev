import { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const intentClasses: Record<"neutral" | "positive" | "negative" | "info", string> = {
  neutral: "border-[var(--color-border)]",
  positive: "border-[rgba(20,184,166,0.35)]",
  negative: "border-[rgba(248,113,113,0.35)]",
  info: "border-[rgba(56,189,248,0.35)]",
};

interface SummaryCardProps {
  title: string;
  value: ReactNode;
  subtitle?: string;
  intent?: keyof typeof intentClasses;
  icon?: ReactNode;
}

export function SummaryCard({ title, value, subtitle, intent = "neutral", icon }: SummaryCardProps) {
  return (
    <Card className={cn("shadow-card/60", intentClasses[intent])}>
      <CardContent className="flex items-start gap-3">
        {icon ? (
          <div className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-card-muted)] text-[var(--color-text-muted)]">
            {icon}
          </div>
        ) : null}
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">{title}</p>
          <div className="text-2xl font-semibold leading-tight text-[var(--color-text-primary)]">{value}</div>
          {subtitle ? <p className="text-xs text-[var(--color-text-muted)]">{subtitle}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}






