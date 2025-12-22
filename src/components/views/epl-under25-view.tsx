"use client";

import React, { useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatCurrency, formatDateTime } from "@/lib/utils";

interface StrategyTrade {
  id: string;
  strategy_key: string;
  event_id: string | null;
  betfair_event_id: string | null;
  betfair_market_id: string | null;
  selection_id: number | null;
  runner_name: string | null;
  kickoff_at: string | null;
  status: string;
  back_order_ref: string | null;
  back_price: number | null;
  back_size: number | null;
  back_matched_size: number | null;
  lay_order_ref: string | null;
  lay_price: number | null;
  lay_size: number | null;
  lay_matched_size: number | null;
  hedge_target_price: number | null;
  target_stake: number | null;
  pnl: number | null;
  margin: number | null;
  commission_paid: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  competition_name: string | null;
  event_name: string | null;
  total_stake: number | null;
  back_stake: number | null;
  back_price_snapshot: number | null;
  realised_pnl: number | null;
  settled_at: string | null;
  home?: string | null;
  away?: string | null;
  competition?: string | null;
  state_data?: Record<string, unknown> | null;
}

interface TradeEvent {
  id: string;
  trade_id: string;
  occurred_at: string;
  event_type: string;
  payload: Record<string, unknown>;
}

interface ExposureStat {
  strategy_key: string;
  setting_key: 'lay_ticks_below_back' | 'profit_target_pct';
  setting_value: number;
  average_exposure_seconds: number;
  total_trades: number;
  losing_trades_excluded: number;
  net_pnl: number;
}

interface StrategyStatsResponse {
  summary: { totalStaked: number; totalTrades: number; pnl: number };
  competitions: Array<{ name: string; pnl: number; trades: number; staked: number }>;
}

interface TradesPage {
  data: StrategyTrade[];
  cursor: string | null;
}

// Strategy display names
const STRATEGY_NAMES: Record<string, string> = {
  epl_under25: 'Pre-Match Hedge',
  epl_under25_goalreact: 'Goal Reactive',
};

const statusFilters = [
  { value: "", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "back_pending", label: "Back Pending" },
  { value: "back_matched", label: "Back Matched" },
  { value: "hedge_pending", label: "Hedge Pending" },
  { value: "hedged", label: "Hedged" },
  { value: "cancelled", label: "Cancelled" },
  { value: "failed", label: "Failed" },
  // Goal-reactive statuses
  { value: "watching", label: "Watching" },
  { value: "goal_wait", label: "Goal Wait" },
  { value: "live", label: "Live" },
  { value: "stop_loss_wait", label: "Stop Loss Wait" },
  { value: "stop_loss_active", label: "Stop Loss Active" },
  { value: "completed", label: "Completed" },
  { value: "skipped", label: "Skipped" },
];

const strategyFilters = [
  { value: "", label: "All Strategies" },
  { value: "epl_under25", label: "Pre-Match Hedge" },
  { value: "epl_under25_goalreact", label: "Goal Reactive" },
];

export default function EplUnder25View() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [strategyFilter, setStrategyFilter] = useState("");
  const [competitionFilter, setCompetitionFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [expandedTrades, setExpandedTrades] = useState<Set<string>>(new Set());
  const [activeExposureBox, setActiveExposureBox] = useState<{
    strategy_key: string;
    setting_key: ExposureStat["setting_key"];
    setting_value: number;
  } | null>(null);
  const [activeExposureBoxLoading, setActiveExposureBoxLoading] = useState(false);
  const [savedStatusFilter, setSavedStatusFilter] = useState<string | null>(null);

  // Fetch competition names separately
  const competitionNamesQuery = useQuery({
    queryKey: ["strategy-trades", "epl-under25", "competition-names"],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("get_competition_names", "true");
      params.set("limit", "1"); // Minimal data needed
      const res = await fetch(`/api/strategies/epl-under25/trades?${params}`);
      if (!res.ok) throw new Error("Failed to load competition names");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to load competition names");
      return (json.competitionNames || []) as string[];
    },
  });

  const activeExposureBoxKey = activeExposureBox
    ? `${activeExposureBox.strategy_key}|${activeExposureBox.setting_key}|${activeExposureBox.setting_value}`
    : "";

  const tradesQuery = useInfiniteQuery({
    queryKey: ["strategy-trades", "epl-under25", "trades", statusFilter, strategyFilter, competitionFilter, dateFilter, activeExposureBoxKey],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (activeExposureBoxKey === "" && statusFilter) params.set("status", statusFilter);

      if (activeExposureBoxKey !== "" && activeExposureBox) {
        params.set("strategy_key", activeExposureBox.strategy_key);
        params.set("box_setting_key", activeExposureBox.setting_key);
        params.set("box_setting_value", String(activeExposureBox.setting_value));
      } else if (strategyFilter) {
        params.set("strategy_key", strategyFilter);
      }

      if (competitionFilter) params.set("competition_name", competitionFilter);
      if (dateFilter) {
        // Set date_from to the selected date (start of day)
        params.set("date_from", new Date(dateFilter).toISOString().split('T')[0] + 'T00:00:00.000Z');
        // Set date_to to end of the selected day
        params.set("date_to", new Date(dateFilter).toISOString().split('T')[0] + 'T23:59:59.999Z');
      }
      params.set("limit", "200");

      if (pageParam) {
        params.set("cursor", pageParam);
      }

      const res = await fetch(`/api/strategies/epl-under25/trades?${params}`);
      if (!res.ok) throw new Error("Failed to load trades");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to load trades");
      return { data: (json.data as StrategyTrade[]) ?? [], cursor: (json.cursor as string | null) ?? null } satisfies TradesPage;
    },
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
  });

  const statsQuery = useQuery({
    queryKey: ["strategy-trades", "epl-under25", "stats", strategyFilter, competitionFilter, dateFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      // NOTE: statusFilter must not impact totals.
      if (strategyFilter) params.set("strategy_key", strategyFilter);
      if (competitionFilter) params.set("competition_name", competitionFilter);
      if (dateFilter) {
        params.set("date_from", new Date(dateFilter).toISOString().split('T')[0] + 'T00:00:00.000Z');
        params.set("date_to", new Date(dateFilter).toISOString().split('T')[0] + 'T23:59:59.999Z');
      }
      const res = await fetch(`/api/strategies/epl-under25/stats?${params}`);
      if (!res.ok) throw new Error("Failed to load totals");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to load totals");
      return json.data as StrategyStatsResponse;
    },
  });

  const exposureStatsQuery = useQuery({
    queryKey: ["strategy-trades", "epl-under25", "exposure-stats", strategyFilter, competitionFilter, dateFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      // NOTE: exposure stats are meaningful only for settled trades; we intentionally
      // do not apply statusFilter here.
      if (strategyFilter) params.set("strategy_key", strategyFilter);
      if (competitionFilter) params.set("competition_name", competitionFilter);
      if (dateFilter) {
        params.set("date_from", new Date(dateFilter).toISOString().split('T')[0] + 'T00:00:00.000Z');
        params.set("date_to", new Date(dateFilter).toISOString().split('T')[0] + 'T23:59:59.999Z');
      }
      const res = await fetch(`/api/strategies/epl-under25/exposure-stats?${params}`);
      if (!res.ok) throw new Error("Failed to load exposure stats");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to load exposure stats");
      return json.data as ExposureStat[];
    },
  });

  const toggleExpanded = (tradeId: string) => {
    setExpandedTrades((prev) => {
      const next = new Set(prev);
      if (next.has(tradeId)) {
        next.delete(tradeId);
      } else {
        next.add(tradeId);
      }
      return next;
    });
  };

  const cancelTradesMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const res = await fetch("/api/strategies/epl-under25/trades", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("Failed to cancel trades");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to cancel trades");
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["strategy-trades", "epl-under25"] });
    },
  });

  const trades = useMemo(() => {
    return (tradesQuery.data?.pages ?? []).flatMap((p) => p.data);
  }, [tradesQuery.data]);

  // Use competition names from the separate query (all competitions, not just loaded trades)
  const competitionNames = useMemo(() => {
    return competitionNamesQuery.data ?? [];
  }, [competitionNamesQuery.data]);

  const summary = useMemo(() => {
    return statsQuery.data?.summary ?? { totalStaked: 0, totalTrades: 0, pnl: 0 };
  }, [statsQuery.data]);

  const competitionProfits = useMemo(() => {
    return statsQuery.data?.competitions ?? [];
  }, [statsQuery.data]);

  const error = tradesQuery.error;

  const toggleExposureBoxTrades = async (row: ExposureStat) => {
    const nextKey = `${row.strategy_key}|${row.setting_key}|${row.setting_value}`;
    if (activeExposureBoxKey === nextKey) {
      // Clear
      setActiveExposureBox(null);
      setActiveExposureBoxLoading(false);
      if (savedStatusFilter !== null) {
        setStatusFilter(savedStatusFilter);
      }
      setSavedStatusFilter(null);
      return;
    }

    // Activate
    setExpandedTrades(new Set());
    setActiveExposureBox({ strategy_key: row.strategy_key, setting_key: row.setting_key, setting_value: row.setting_value });
    setActiveExposureBoxLoading(false);

    // Ensure status doesn't interfere (table-only anyway, but this avoids showing nothing).
    setSavedStatusFilter(statusFilter);
    setStatusFilter("");
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>EPL Under 2.5 Strategy</CardTitle>
          <CardDescription>
            Monitor automated back/lay trades and adjust runtime parameters. Toggle the strategy using environment variable `ENABLE_EPL_UNDER25_STRATEGY`.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <SummaryBar
            summary={summary}
            isLoading={statsQuery.isLoading}
            error={statsQuery.error instanceof Error ? statsQuery.error.message : null}
          />

          <ExposureStatsSection
            isLoading={exposureStatsQuery.isLoading}
            error={exposureStatsQuery.error instanceof Error ? exposureStatsQuery.error.message : null}
            stats={exposureStatsQuery.data ?? []}
            activeExposureBoxKey={activeExposureBoxKey}
            onToggleExposureBoxTrades={toggleExposureBoxTrades}
            toggling={activeExposureBoxLoading}
          />

          {/* Profit by Competition */}
          <CompetitionProfitSummary
            competitions={competitionProfits}
            isLoading={statsQuery.isLoading}
            error={statsQuery.error instanceof Error ? statsQuery.error.message : null}
          />

          <Filters
            status={statusFilter}
            onStatusChange={setStatusFilter}
            strategy={strategyFilter}
            onStrategyChange={setStrategyFilter}
            competition={competitionFilter}
            onCompetitionChange={setCompetitionFilter}
            date={dateFilter}
            onDateChange={setDateFilter}
            competitionNames={competitionNames}
            onRefresh={() => {
              queryClient.invalidateQueries({ queryKey: ["strategy-trades", "epl-under25"] });
              queryClient.invalidateQueries({ queryKey: ["strategy-trades", "epl-under25", "competition-names"] });
              queryClient.invalidateQueries({ queryKey: ["strategy-trades", "epl-under25", "stats"] });
              queryClient.invalidateQueries({ queryKey: ["strategy-trades", "epl-under25", "exposure-stats"] });
            }}
            disabled={tradesQuery.isFetching}
          />

          <TradesTable
            trades={trades}
            isLoading={tradesQuery.isLoading}
            error={error instanceof Error ? error.message : null}
            onCancel={(ids) => cancelTradesMutation.mutate(ids)}
            cancelling={cancelTradesMutation.isPending}
            expandedTrades={expandedTrades}
            onToggleExpand={toggleExpanded}
            onLoadMore={() => tradesQuery.fetchNextPage()}
            hasMore={!!tradesQuery.hasNextPage}
            loadingMore={tradesQuery.isFetchingNextPage}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryBar({
  summary,
  isLoading,
  error,
}: {
  summary: { totalStaked: number; totalTrades: number; pnl: number };
  isLoading: boolean;
  error: string | null;
}) {
  const isError = !!error;
  const pnlValue = isLoading ? "Loading..." : isError ? "—" : formatCurrency(summary.pnl);
  const stakedValue = isLoading ? "Loading..." : isError ? "—" : formatCurrency(summary.totalStaked);
  const tradesValue = isLoading ? "Loading..." : isError ? "—" : summary.totalTrades;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <SummaryCard
        label="Overall P&L"
        value={pnlValue}
        intent={!isLoading && !isError && summary.pnl < 0 ? "negative" : "positive"}
      />
      <SummaryCard label="Total Back Staked" value={stakedValue} />
      <SummaryCard label="Number of Trades" value={tradesValue} />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  intent,
}: {
  label: string;
  value: number | string;
  intent?: "positive" | "negative";
}) {
  return (
    <div className={cn(
      "rounded-xl border border-[var(--color-divider)] bg-[var(--color-card)]/70 p-4",
      intent === "positive" && "border-[rgba(16,185,129,0.4)]",
      intent === "negative" && "border-[rgba(239,68,68,0.4)]",
    )}>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className="text-xl font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  );
}

function ExposureStatsSection({
  isLoading,
  error,
  stats,
  activeExposureBoxKey,
  onToggleExposureBoxTrades,
  toggling,
}: {
  isLoading: boolean;
  error: string | null;
  stats: ExposureStat[];
  activeExposureBoxKey: string;
  onToggleExposureBoxTrades: (row: ExposureStat) => void;
  toggling: boolean;
}) {
  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-[var(--color-divider)] bg-[var(--color-card)]/70 p-4">
          <div className="text-xs text-[var(--color-text-muted)]">Exposure (in-play)</div>
          <div className="text-sm text-[var(--color-text-muted)] mt-1">Loading...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-[rgba(248,113,113,0.35)] bg-[var(--color-card)]/60 p-4">
        <div className="text-xs text-[var(--color-text-muted)]">Exposure (in-play)</div>
        <div className="text-sm text-[var(--color-negative)] mt-1">Failed to load exposure stats</div>
      </div>
    );
  }

  if (!stats.length) {
    return (
      <div className="rounded-xl border border-[var(--color-divider)] bg-[var(--color-card)]/60 p-4">
        <div className="text-xs text-[var(--color-text-muted)]">Exposure (in-play)</div>
        <div className="text-sm text-[var(--color-text-muted)] mt-1">No settled exposure data found.</div>
      </div>
    );
  }

  const byStrategy = new Map<string, ExposureStat[]>();
  stats.forEach((row) => {
    const arr = byStrategy.get(row.strategy_key) || [];
    arr.push(row);
    byStrategy.set(row.strategy_key, arr);
  });

  const orderedKeys = Array.from(byStrategy.keys()).sort((a, b) => a.localeCompare(b));

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
        Exposure (in-play)
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {orderedKeys.flatMap((strategyKey) => {
          const rows = (byStrategy.get(strategyKey) || []).slice().sort((a, b) => a.setting_value - b.setting_value);
          return rows.map((row) => {
            const title = STRATEGY_NAMES[strategyKey] || strategyKey;
            const settingLabel =
              row.setting_key === 'lay_ticks_below_back'
                ? `${row.setting_value} ticks below`
                : `${row.setting_value}% profit target`;
            const avg = formatDurationSeconds(row.average_exposure_seconds);
            const subtitle = `${row.total_trades} counted • ${row.losing_trades_excluded} losers excluded`;
            const pnlIntent = row.net_pnl >= 0 ? "positive" : "negative";
            const boxKey = `${row.strategy_key}|${row.setting_key}|${row.setting_value}`;
            const isActive = activeExposureBoxKey === boxKey;

            return (
              <div
                key={`${row.strategy_key}-${row.setting_key}-${row.setting_value}`}
                className={cn(
                  "rounded-xl border border-[var(--color-divider)] bg-[var(--color-card)]/70 p-4",
                  pnlIntent === "positive" && "border-[rgba(16,185,129,0.35)]",
                  pnlIntent === "negative" && "border-[rgba(239,68,68,0.35)]",
                )}
              >
                <div className="text-xs text-[var(--color-text-muted)]">{title}</div>
                <div className="text-xs text-[var(--color-text-muted)] mt-1">{settingLabel}</div>
                <div className="text-xl font-semibold text-[var(--color-text-primary)] mt-2">{avg}</div>
                <div className="text-xs text-[var(--color-text-muted)] mt-1">{subtitle}</div>
                <div className={cn(
                  "text-sm font-semibold mt-2",
                  pnlIntent === "positive" ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"
                )}>
                  {formatCurrency(row.net_pnl)}
                </div>
                <div className="mt-3">
                  <Button
                    type="button"
                    variant={isActive ? "secondary" : "ghost"}
                    size="sm"
                    disabled={toggling}
                    onClick={() => onToggleExposureBoxTrades(row)}
                  >
                    {isActive ? "Clear trades filter" : "Show trades"}
                  </Button>
                </div>
              </div>
            );
          });
        })}
      </div>
    </div>
  );
}

function formatDurationSeconds(totalSeconds: number) {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins <= 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function CompetitionProfitSummary({
  competitions,
  isLoading,
  error,
}: {
  competitions: Array<{ name: string; pnl: number; trades: number; staked: number }>;
  isLoading: boolean;
  error: string | null;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-[var(--color-text-muted)]">Profit by Competition</h3>
        <div className="text-sm text-[var(--color-text-muted)]">Loading...</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-[var(--color-text-muted)]">Profit by Competition</h3>
        <div className="text-sm text-[var(--color-negative)]">Failed to load totals</div>
      </div>
    );
  }
  if (competitions.length === 0) return null;
  
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-[var(--color-text-muted)]">Profit by Competition</h3>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {competitions.map((comp) => (
          <div
            key={comp.name}
            className={cn(
              "rounded-lg border p-3",
              comp.pnl >= 0
                ? "border-[rgba(16,185,129,0.3)] bg-[rgba(16,185,129,0.05)]"
                : "border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.05)]"
            )}
          >
            <div className="text-xs text-[var(--color-text-muted)] truncate" title={comp.name}>
              {comp.name}
            </div>
            <div className={cn(
              "text-lg font-semibold",
              comp.pnl >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"
            )}>
              {formatCurrency(comp.pnl)}
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {comp.trades} trades • {formatCurrency(comp.staked)} staked
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Filters({
  status,
  onStatusChange,
  strategy,
  onStrategyChange,
  competition,
  onCompetitionChange,
  date,
  onDateChange,
  competitionNames,
  onRefresh,
  disabled,
}: {
  status: string;
  onStatusChange: (value: string) => void;
  strategy: string;
  onStrategyChange: (value: string) => void;
  competition: string;
  onCompetitionChange: (value: string) => void;
  date: string;
  onDateChange: (value: string) => void;
  competitionNames: string[];
  onRefresh: () => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-3">
      {/* Row 1: Strategy and Status */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-[var(--color-text-muted)]">Strategy</label>
        <select
          className="rounded-md border border-[var(--color-divider)] bg-transparent px-3 py-2 text-sm"
          value={strategy}
          onChange={(event) => onStrategyChange(event.target.value)}
        >
          {strategyFilters.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <label className="text-xs text-[var(--color-text-muted)]">Status</label>
        <select
          className="rounded-md border border-[var(--color-divider)] bg-transparent px-3 py-2 text-sm"
          value={status}
          onChange={(event) => onStatusChange(event.target.value)}
        >
          {statusFilters.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      
      {/* Row 2: Competition and Date filters */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-[var(--color-text-muted)]">Competition</label>
        <select
          className="rounded-md border border-[var(--color-divider)] bg-transparent px-3 py-2 text-sm min-w-[200px]"
          value={competition}
          onChange={(event) => onCompetitionChange(event.target.value)}
        >
          <option value="">All Competitions</option>
          {competitionNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label className="text-xs text-[var(--color-text-muted)]">Date</label>
        <input
          type="date"
          value={date}
          onChange={(event) => onDateChange(event.target.value)}
          className="rounded-md border border-[var(--color-divider)] bg-transparent px-3 py-2 text-sm w-[160px]"
        />
        <Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={disabled}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

function TradesTable({
  trades,
  isLoading,
  error,
  onCancel,
  cancelling,
  expandedTrades,
  onToggleExpand,
  onLoadMore,
  hasMore,
  loadingMore,
}: {
  trades: StrategyTrade[];
  isLoading: boolean;
  error: string | null;
  onCancel: (ids: string[]) => void;
  cancelling: boolean;
  expandedTrades: Set<string>;
  onToggleExpand: (id: string) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex h-40 items-center justify-center text-sm text-[var(--color-text-muted)]">
          Loading trades...
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border border-[rgba(248,113,113,0.35)] bg-[var(--color-card)]/60">
        <CardContent className="space-y-3 py-10 text-center">
          <p className="text-lg font-semibold text-[var(--color-negative)]">Unable to load trades</p>
          <p className="text-sm text-[var(--color-text-muted)]">{error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!trades.length) {
    return (
      <EmptyState
        title="No trades yet"
        description="Once the strategy runs, newly created trades will appear here."
      />
    );
  }

  return (
    <div className="rounded-lg border border-[var(--color-divider)]">
      <table className="min-w-full text-sm">
        <thead className="border-b border-[var(--color-divider)] bg-[var(--color-card)]/60 text-xs uppercase text-[var(--color-text-muted)]">
          <tr>
            <th className="w-8 px-2 py-3"></th>
            <th className="px-4 py-3 text-left font-medium">Strategy</th>
            <th className="px-4 py-3 text-left font-medium">Event</th>
            <th className="px-4 py-3 text-right font-medium">Back Stake</th>
            <th className="px-4 py-3 text-right font-medium">Back Price</th>
            <th className="px-4 py-3 text-right font-medium">P&L</th>
            <th className="px-4 py-3 text-right font-medium">Date</th>
            <th className="px-4 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-divider)]">
          {trades.map((trade) => {
            const isExpanded = expandedTrades.has(trade.id);
            const competitionName = trade.competition_name || trade.competition || 'English Premier League';
            const eventLabel =
              trade.event_name ||
              (trade.home && trade.away ? `${trade.home} v ${trade.away}` : trade.runner_name || 'Under 2.5 Goals');
            const backStakeValue = getBackStake(trade);
            const backPriceValue = trade.back_price_snapshot ?? trade.back_price;
            const pnlValue = getRealisedPnl(trade);
            const hasPnl = trade.realised_pnl !== null && trade.realised_pnl !== undefined
              ? true
              : trade.pnl !== null && trade.pnl !== undefined;
            const displayDate = getDisplayDate(trade);
            const isFinalStatus = ['hedged', 'completed', 'cancelled', 'skipped', 'failed'].includes(trade.status);

            return (
              <React.Fragment key={trade.id}>
                <tr className="bg-[var(--color-card)]/40 cursor-pointer hover:bg-[var(--color-card)]/60" onClick={() => onToggleExpand(trade.id)}>
                  <td className="px-2 py-3 text-center">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-[var(--color-text-muted)]" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-[var(--color-text-muted)]" />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StrategyBadge strategyKey={trade.strategy_key} />
                    <div className="text-xs text-[var(--color-text-muted)] mt-1">{competitionName}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-[var(--color-text-primary)]">{eventLabel}</div>
                    <StatusBadge status={trade.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {formatCurrency(backStakeValue)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {backPriceValue ? backPriceValue.toFixed(2) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {hasPnl ? (
                      <span className={pnlValue >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}>
                        {formatCurrency(pnlValue)}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-[var(--color-text-muted)]">
                    {formatDateTime(displayDate)}
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={cancelling || isFinalStatus}
                      onClick={() => onCancel([trade.id])}
                    >
                      Cancel
                    </Button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr key={`${trade.id}-logs`} className="bg-[var(--color-card)]/20">
                    <td colSpan={8} className="px-4 py-3">
                      <TradeLogsPanel tradeId={trade.id} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="flex items-center justify-between gap-3 border-t border-[var(--color-divider)] bg-[var(--color-card)]/40 px-4 py-3">
        <div className="text-xs text-[var(--color-text-muted)]">
          Status filters the table only. Totals count settled trades.
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!hasMore || loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? "Loading..." : hasMore ? "Load older trades" : "No more trades"}
        </Button>
      </div>
    </div>
  );
}

function StrategyBadge({ strategyKey }: { strategyKey: string }) {
  const isGoalReact = strategyKey === 'epl_under25_goalreact';
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        isGoalReact
          ? "bg-[rgba(168,85,247,0.15)] text-[#c084fc]"
          : "bg-[rgba(59,130,246,0.15)] text-[#60a5fa]"
      )}
    >
      {STRATEGY_NAMES[strategyKey] || strategyKey}
    </span>
  );
}

function TradeLogsPanel({ tradeId }: { tradeId: string }) {
  const eventsQuery = useQuery({
    queryKey: ["trade-events", tradeId],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/epl-under25/trades/${tradeId}/events`);
      if (!res.ok) throw new Error("Failed to load events");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to load events");
      return json.data as TradeEvent[];
    },
  });

  if (eventsQuery.isLoading) {
    return (
      <div className="text-xs text-[var(--color-text-muted)] py-2">
        Loading logs...
      </div>
    );
  }

  if (eventsQuery.error) {
    return (
      <div className="text-xs text-[var(--color-negative)] py-2">
        Failed to load logs
      </div>
    );
  }

  const events = eventsQuery.data || [];
  if (events.length === 0) {
    return (
      <div className="text-xs text-[var(--color-text-muted)] py-2">
        No events recorded yet
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-64 overflow-y-auto">
      <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
        Event Log
      </div>
      <div className="space-y-1">
        {events.map((event) => {
          // Use payload timestamp if available (more accurate), fallback to occurred_at
          const displayTime = event.payload?.timestamp 
            ? String(event.payload.timestamp)
            : event.occurred_at;
          
          return (
            <div
              key={event.id}
              className="flex items-start gap-3 text-xs bg-[var(--color-card)]/40 rounded px-3 py-2"
            >
              <span className="text-[var(--color-text-muted)] whitespace-nowrap">
                {formatDateTime(displayTime)}
              </span>
              <span className="font-mono font-medium text-[var(--color-accent)]">
                {event.event_type}
              </span>
              <span className="text-[var(--color-text-secondary)] truncate flex-1">
                {formatEventPayload(event.payload)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatEventPayload(payload: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) return '';
  
  // Extract key fields for display
  const parts: string[] = [];
  
  // --- Goal price snapshot (special formatting for t+30/60/90/120 snapshots) ---
  if (payload.seconds_after_goal_target !== undefined) {
    const target = payload.seconds_after_goal_target;
    const backPrice = payload.back_price;
    const layPrice = payload.lay_price;
    const spread = payload.spread;
    parts.push(`t+${target}s`);
    if (backPrice !== undefined) parts.push(`back: ${backPrice}`);
    if (layPrice !== undefined) parts.push(`lay: ${layPrice}`);
    if (spread !== undefined) parts.push(`spread: ${spread}`);
    if (payload.goal_number) parts.push(`goal: #${payload.goal_number}`);
    return parts.join(' | ');
  }
  
  // --- Pre-match hedge fields ---
  if (payload.price) parts.push(`price: ${payload.price}`);
  if (payload.stake) parts.push(`stake: ${payload.stake}`);
  if (payload.lay_price) parts.push(`lay_price: ${payload.lay_price}`);
  if (payload.lay_stake) parts.push(`lay_stake: ${payload.lay_stake}`);
  if (payload.matched_price) parts.push(`matched: ${payload.matched_price}`);
  if (payload.matched_size) parts.push(`size: ${payload.matched_size}`);
  if (payload.persistence) parts.push(`persist: ${payload.persistence}`);
  if (payload.realised_pnl !== undefined) {
    const pnl = Number(payload.realised_pnl);
    parts.push(`P&L: ${pnl >= 0 ? '+' : ''}£${pnl.toFixed(2)}`);
  }
  if (payload.outcome) parts.push(`outcome: ${payload.outcome}`);
  
  // --- Goal reactive fields ---
  if (payload.price_after_goal) parts.push(`price_after_goal: ${payload.price_after_goal}`);
  if (payload.price_entered) parts.push(`price_entered: ${payload.price_entered}`);
  if (payload.price_exited) parts.push(`price_exited: ${payload.price_exited}`);
  if (payload.entry_price && !payload.price_entered) parts.push(`entry: ${payload.entry_price}`);
  if (payload.exit_price && !payload.price_exited) parts.push(`exit: ${payload.exit_price}`);
  if (payload.spike_price && !payload.price_after_goal) parts.push(`spike: ${payload.spike_price}`);
  if (payload.baseline_price) parts.push(`baseline: ${payload.baseline_price}`);
  if (payload.stop_loss_baseline) parts.push(`SL_baseline: ${payload.stop_loss_baseline}`);
  if (payload.goal_number) parts.push(`goal: #${payload.goal_number}`);
  
  // --- Percentage fields ---
  if (payload.price_change_pct) parts.push(`change: ${Number(payload.price_change_pct).toFixed(1)}%`);
  if (payload.profit_pct) parts.push(`profit: ${Number(payload.profit_pct).toFixed(1)}%`);
  if (payload.drop_pct) parts.push(`drop: ${Number(payload.drop_pct).toFixed(1)}%`);
  if (payload.stop_loss_pct) parts.push(`SL_target: ${payload.stop_loss_pct}%`);
  
  // --- Time/context fields ---
  if (payload.mins_from_kickoff !== undefined) parts.push(`min: ${Number(payload.mins_from_kickoff).toFixed(0)}`);
  
  // --- Bet ID (handle both cases) ---
  const betId = payload.betId || payload.bet_id || payload.lay_bet_id;
  if (betId) parts.push(`betId: ${String(betId).slice(0, 8)}...`);
  
  // --- Error/status fields ---
  if (payload.errorCode) parts.push(`error: ${payload.errorCode}`);
  if (payload.reason) parts.push(`reason: ${payload.reason}`);
  
  return parts.join(' | ');
}

function StatusBadge({ status }: { status: string }) {
  if (!status) {
    return null;
  }
  return (
    <span
      className={cn(
        "mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize",
        status === 'scheduled' && "bg-[rgba(14,165,233,0.12)] text-[#38bdf8]",
        status === 'back_pending' && "bg-[rgba(250,204,21,0.12)] text-[#facc15]",
        status === 'back_matched' && "bg-[rgba(147,197,114,0.12)] text-[#86efac]",
        status === 'hedge_pending' && "bg-[rgba(245,158,11,0.12)] text-[#fb923c]",
        status === 'hedged' && "bg-[rgba(22,163,74,0.12)] text-[#4ade80]",
        status === 'completed' && "bg-[rgba(22,163,74,0.12)] text-[#4ade80]",
        status === 'failed' && "bg-[rgba(248,113,113,0.14)] text-[#f87171]",
        status === 'cancelled' && "bg-[var(--color-card-muted)] text-[var(--color-text-muted)]",
        status === 'skipped' && "bg-[var(--color-card-muted)] text-[var(--color-text-muted)]",
        // Goal-reactive statuses
        status === 'watching' && "bg-[rgba(168,85,247,0.12)] text-[#c084fc]",
        status === 'goal_wait' && "bg-[rgba(251,146,60,0.12)] text-[#fb923c]",
        status === 'live' && "bg-[rgba(34,197,94,0.15)] text-[#22c55e]",
        status === 'stop_loss_wait' && "bg-[rgba(239,68,68,0.12)] text-[#f87171]",
        status === 'stop_loss_active' && "bg-[rgba(239,68,68,0.18)] text-[#ef4444]",
      )}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function getBackStake(trade: StrategyTrade) {
  return trade.back_stake ?? trade.back_matched_size ?? trade.back_size ?? trade.target_stake ?? 0;
}

/**
 * A trade is "taken" if we have evidence of a placed/matched back bet.
 * This excludes scheduled placeholders and GoalReactive watching/goal_wait pre-entry rows.
 */
function getRealisedPnl(trade: StrategyTrade) {
  return trade.realised_pnl ?? trade.pnl ?? 0;
}

function getDisplayDate(trade: StrategyTrade) {
  return trade.settled_at || trade.kickoff_at || trade.updated_at || trade.created_at;
}
