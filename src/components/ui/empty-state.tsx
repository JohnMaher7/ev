import { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <Card className={cn("border-dashed border-[rgba(148,163,184,0.3)] bg-transparent text-center", className)}>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-[var(--color-text-muted)]">
        {icon ? <div className="rounded-full border border-[var(--color-border)] bg-[var(--color-card-muted)] p-3 text-[var(--color-info)]">{icon}</div> : null}
        <div>
          <h3 className="text-lg font-medium text-[var(--color-text-primary)]">{title}</h3>
          {description ? <p className="mt-1 text-sm text-[var(--color-text-muted)]">{description}</p> : null}
        </div>
        {action ? <div className="mt-2">{action}</div> : null}
      </CardContent>
    </Card>
  );
}





