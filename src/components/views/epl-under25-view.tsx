"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
}

const statusFilters = [
  { value: "", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "back_pending", label: "Back Pending" },
  { value: "back_matched", label: "Back Matched" },
  { value: "hedge_pending", label: "Hedge Pending" },
  { value: "hedged", label: "Hedged" },
  { value: "cancelled", label: "Cancelled" },
  { value: "failed", label: "Failed" },
];

export default function EplUnder25View() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");

  const tradesQuery = useQuery({
    queryKey: ["strategy-trades", "epl-under25", statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/strategies/epl-under25/trades?${params}`);
      if (!res.ok) throw new Error("Failed to load trades");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to load trades");
      return json.data as StrategyTrade[];
    },
  });

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
            onRefresh={() => queryClient.invalidateQueries({ queryKey: ["strategy-trades", "epl-under25"] })}
            disabled={tradesQuery.isFetching}
          />

          <TradesTable
            trades={trades}
            isLoading={tradesQuery.isLoading}
            error={error instanceof Error ? error.message : null}
            onCancel={(ids) => cancelTradesMutation.mutate(ids)}
            cancelling={cancelTradesMutation.isPending}
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
  onRefresh,
  disabled,
}: {
  status: string;
  onStatusChange: (value: string) => void;
  onRefresh: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-3">
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
}: {
  trades: StrategyTrade[];
  isLoading: boolean;
  error: string | null;
  onCancel: (ids: string[]) => void;
  cancelling: boolean;
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
            <th className="px-4 py-3 text-left font-medium">Competition</th>
            <th className="px-4 py-3 text-left font-medium">Event</th>
            <th className="px-4 py-3 text-right font-medium">Total Stake</th>
            <th className="px-4 py-3 text-right font-medium">Back Stake</th>
            <th className="px-4 py-3 text-right font-medium">Back Price</th>
            <th className="px-4 py-3 text-right font-medium">P&L</th>
            <th className="px-4 py-3 text-right font-medium">Date</th>
            <th className="px-4 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-divider)]">
          {trades.map((trade) => {
            const competitionName = trade.competition_name || trade.competition || 'English Premier League';
            const eventLabel =
              trade.event_name ||
              (trade.home && trade.away ? `${trade.home} v ${trade.away}` : trade.runner_name || 'Under 2.5 Goals');
            const totalStakeValue = getTotalStake(trade);
            const backStakeValue = getBackStake(trade);
            const backPriceValue = trade.back_price_snapshot ?? trade.back_price;
            const pnlValue = getRealisedPnl(trade);
            const hasPnl = trade.realised_pnl !== null && trade.realised_pnl !== undefined
              ? true
              : trade.pnl !== null && trade.pnl !== undefined;
            const displayDate = getDisplayDate(trade);

            return (
              <tr key={trade.id} className="bg-[var(--color-card)]/40">
                <td className="px-4 py-3">
                  <div className="text-[var(--color-text-primary)]">{competitionName}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-[var(--color-text-primary)]">{eventLabel}</div>
                  <StatusBadge status={trade.status} />
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {formatCurrency(totalStakeValue)}
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
                <td className="px-4 py-3 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={cancelling || trade.status === 'hedged' || trade.status === 'cancelled'}
                    onClick={() => onCancel([trade.id])}
                  >
                    Cancel
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
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
        status === 'failed' && "bg-[rgba(248,113,113,0.14)] text-[#f87171]",
        status === 'cancelled' && "bg-[var(--color-card-muted)] text-[var(--color-text-muted)]",
      )}
    >
      {status}
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
