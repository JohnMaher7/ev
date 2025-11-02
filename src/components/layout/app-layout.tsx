"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Clock3, LineChart, ListChecks, PanelLeft, Rows4, Settings2, FileText, Goal } from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  description?: string;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/alerts", label: "Alerts", icon: <Rows4 className="h-4 w-4" /> },
  { href: "/bets", label: "Bets", icon: <ListChecks className="h-4 w-4" /> },
  { href: "/metrics", label: "Performance", icon: <LineChart className="h-4 w-4" /> },
  { href: "/logs", label: "System Logs", icon: <FileText className="h-4 w-4" /> },
  { href: "/admin", label: "Operations", icon: <Settings2 className="h-4 w-4" /> },
  { href: "/strategies/epl-under25", label: "EPL Under 2.5", icon: <Goal className="h-4 w-4" /> },
];

interface AppLayoutProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function AppLayout({ title, description, actions, children }: AppLayoutProps) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-[var(--color-app-bg)] text-[var(--color-text-primary)]">
      <div className="grid min-h-screen lg:grid-cols-[260px_1fr]">
        <aside className="hidden border-r border-[var(--color-border)] bg-[var(--color-sidebar-bg)] lg:flex lg:flex-col">
          <div className="flex h-16 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-6">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-positive-soft)] text-[var(--color-positive)]">
              <Rows4 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-wide uppercase text-[var(--color-text-muted)]">
                EV Scanner
              </p>
              <p className="text-xs text-[var(--color-text-faint)]">Tennis &amp; Soccer</p>
            </div>
          </div>

          <nav className="flex flex-1 flex-col gap-1 p-4">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "group flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-sm transition",
                    isActive
                      ? "bg-[var(--color-card)] text-[var(--color-text-primary)] shadow-card"
                      : "text-[var(--color-text-muted)] hover:bg-[var(--color-card-muted)] hover:text-[var(--color-text-primary)]"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]",
                      isActive && "border-[var(--color-positive)] text-[var(--color-positive)]"
                    )}
                  >
                    {item.icon}
                  </span>
                  <div className="flex flex-col">
                    <span className="font-medium">{item.label}</span>
                    {item.description ? (
                      <span className="text-xs text-[var(--color-text-faint)]">{item.description}</span>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-[var(--color-border)] p-4 text-xs text-[var(--color-text-faint)]">
            <p className="font-medium text-[var(--color-text-muted)]">System Clock</p>
            <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-card)]/60 px-3 py-2">
              <Clock3 className="h-4 w-4 text-[var(--color-info)]" />
              <div>
                <p>Europe/London</p>
                <p className="text-[11px] text-[var(--color-text-faint)]">Localised timestamps</p>
              </div>
            </div>
          </div>
        </aside>

        <div className="flex min-h-screen flex-col">
          <header className="blur-panel sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-app-bg)]/85">
            <div className="flex h-16 items-center justify-between px-4 sm:px-6">
              <div>
                <p className="text-xs uppercase tracking-wider text-[var(--color-text-faint)]">Dashboard</p>
                <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">{title}</h1>
                {description ? (
                  <p className="text-xs text-[var(--color-text-muted)]">{description}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-app-bg)] focus-visible:ring-[var(--color-focus)] lg:hidden"
                  aria-label="Toggle navigation"
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
                {actions ? <div className="hidden items-center gap-3 sm:flex">{actions}</div> : null}
              </div>
            </div>
          </header>

          <main className="flex-1 px-4 py-8 sm:px-6">
            <div className="mx-auto max-w-6xl space-y-6">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}


