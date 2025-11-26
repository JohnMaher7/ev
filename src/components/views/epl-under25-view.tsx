"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  const [expandedTrades, setExpandedTrades] = useState<Set<string>>(new Set());

  const tradesQuery = useQuery({
    queryKey: ["strategy-trades", "epl-under25", statusFilter, strategyFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (strategyFilter) params.set("strategy_key", strategyFilter);
      const res = await fetch(`/api/strategies/epl-under25/trades?${params}`);
      if (!res.ok) throw new Error("Failed to load trades");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to load trades");
      return json.data as StrategyTrade[];
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

  const trades = useMemo(() => tradesQuery.data ?? [], [tradesQuery.data]);

  const summary = useMemo(() => {
    return trades.reduce(
      (acc, trade) => {
        acc.totalTrades += 1;
        acc.totalStaked += getTotalStake(trade);
        acc.pnl += getRealisedPnl(trade);
        return acc;
      },
      { totalStaked: 0, totalTrades: 0, pnl: 0 },
    );
  }, [trades]);

  const error = tradesQuery.error;

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
          <SummaryBar summary={summary} />

          <Filters
            status={statusFilter}
            onStatusChange={setStatusFilter}
            strategy={strategyFilter}
            onStrategyChange={setStrategyFilter}
            onRefresh={() => queryClient.invalidateQueries({ queryKey: ["strategy-trades", "epl-under25"] })}
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
          />
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryBar({
  summary,
}: {
  summary: { totalStaked: number; totalTrades: number; pnl: number };
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <SummaryCard label="Overall P&L" value={formatCurrency(summary.pnl)} intent={summary.pnl >= 0 ? "positive" : "negative"} />
      <SummaryCard label="Total Staked" value={formatCurrency(summary.totalStaked)} />
      <SummaryCard label="Number of Trades" value={summary.totalTrades} />
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

function Filters({
  status,
  onStatusChange,
  strategy,
  onStrategyChange,
  onRefresh,
  disabled,
}: {
  status: string;
  onStatusChange: (value: string) => void;
  strategy: string;
  onStrategyChange: (value: string) => void;
  onRefresh: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-3">
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
      <Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={disabled}>
        Refresh
      </Button>
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
}: {
  trades: StrategyTrade[];
  isLoading: boolean;
  error: string | null;
  onCancel: (ids: string[]) => void;
  cancelling: boolean;
  expandedTrades: Set<string>;
  onToggleExpand: (id: string) => void;
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
            <th className="px-4 py-3 text-right font-medium">Total Stake</th>
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
            const totalStakeValue = getTotalStake(trade);
            const backPriceValue = trade.back_price_snapshot ?? trade.back_price;
            const pnlValue = getRealisedPnl(trade);
            const hasPnl = trade.realised_pnl !== null && trade.realised_pnl !== undefined
              ? true
              : trade.pnl !== null && trade.pnl !== undefined;
            const displayDate = getDisplayDate(trade);
            const isFinalStatus = ['hedged', 'completed', 'cancelled', 'skipped', 'failed'].includes(trade.status);

            return (
              <>
                <tr key={trade.id} className="bg-[var(--color-card)]/40 cursor-pointer hover:bg-[var(--color-card)]/60" onClick={() => onToggleExpand(trade.id)}>
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
                    {formatCurrency(totalStakeValue)}
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
              </>
            );
          })}
        </tbody>
      </table>
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
        {events.map((event) => (
          <div
            key={event.id}
            className="flex items-start gap-3 text-xs bg-[var(--color-card)]/40 rounded px-3 py-2"
          >
            <span className="text-[var(--color-text-muted)] whitespace-nowrap">
              {formatDateTime(event.occurred_at)}
            </span>
            <span className="font-mono font-medium text-[var(--color-accent)]">
              {event.event_type}
            </span>
            <span className="text-[var(--color-text-secondary)] truncate flex-1">
              {formatEventPayload(event.payload)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatEventPayload(payload: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) return '';
  
  // Extract key fields for display
  const parts: string[] = [];
  
  if (payload.price) parts.push(`price: ${payload.price}`);
  if (payload.stake) parts.push(`stake: ${payload.stake}`);
  if (payload.entry_price) parts.push(`entry: ${payload.entry_price}`);
  if (payload.exit_price) parts.push(`exit: ${payload.exit_price}`);
  if (payload.spike_price) parts.push(`spike: ${payload.spike_price}`);
  if (payload.baseline_price) parts.push(`baseline: ${payload.baseline_price}`);
  if (payload.price_change_pct) parts.push(`change: ${Number(payload.price_change_pct).toFixed(1)}%`);
  if (payload.profit_pct) parts.push(`profit: ${Number(payload.profit_pct).toFixed(1)}%`);
  if (payload.mins_from_kickoff) parts.push(`min: ${Number(payload.mins_from_kickoff).toFixed(0)}`);
  if (payload.bet_id) parts.push(`betId: ${String(payload.bet_id).slice(0, 8)}...`);
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

function getTotalStake(trade: StrategyTrade) {
  if (typeof trade.total_stake === "number") {
    return trade.total_stake;
  }
  const layExposure = trade.lay_size ?? trade.lay_matched_size ?? 0;
  return getBackStake(trade) + layExposure;
}

function getRealisedPnl(trade: StrategyTrade) {
  return trade.realised_pnl ?? trade.pnl ?? 0;
}

function getDisplayDate(trade: StrategyTrade) {
  return trade.settled_at || trade.kickoff_at || trade.updated_at || trade.created_at;
}
