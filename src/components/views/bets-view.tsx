"use client";

import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SummaryCard } from "@/components/ui/summary-card";
import { Dropdown } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatCurrency, formatDateTime } from "@/lib/utils";

interface Bet {
  id: string;
  created_at: string;
  event_id: string;
  sport_key: string;
  market_key: string;
  selection: string;
  source: string;
  odds: number;
  stake: number;
  accepted_fair_prob: number;
  accepted_fair_price: number;
  status: "pending" | "won" | "lost" | "void";
  settled_at: string | null;
  returns: number | null;
  pnl: number | null;
  events: {
    event_id: string;
    sport_key: string;
    commence_time: string;
    home: string;
    away: string;
  };
}

const statusOptions = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "void", label: "Void" },
];

export default function BetsView() {
  const [statusFilter, setStatusFilter] = useState("");
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery<Bet[]>({
    queryKey: ["bets", statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter) {
        params.set("status", statusFilter);
      }

      const response = await fetch(`/api/bets?${params}`);
      if (!response.ok) {
        throw new Error("Failed to fetch bets");
      }
      const result = await response.json();
      return result.data as Bet[];
    },
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });

  const settleBetMutation = useMutation({
    mutationFn: async ({
      betId,
      status,
      returns,
      pnl,
    }: {
      betId: string;
      status: string;
      returns?: number;
      pnl?: number;
    }) => {
      const response = await fetch(`/api/bets/${betId}/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status, returns, pnl }),
      });

      if (!response.ok) {
        throw new Error("Failed to settle bet");
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bets"] });
      queryClient.invalidateQueries({ queryKey: ["metrics"] });
    },
  });

  const handleSettleBet = (bet: Bet, status: "won" | "lost" | "void") => {
    if (status === "won") {
      const returns = bet.stake * bet.odds;
      const pnl = returns - bet.stake;
      settleBetMutation.mutate({ betId: bet.id, status, returns, pnl });
    } else {
      settleBetMutation.mutate({ betId: bet.id, status });
    }
  };

  const stats = useMemo(() => {
    if (!data || !data.length) {
      return {
        totalStaked: 0,
        totalPnl: 0,
        pendingBets: 0,
        avgOdds: 0,
      };
    }

    const totals = data.reduce(
      (acc, bet) => {
        acc.totalStaked += bet.stake;
        acc.totalPnl += bet.pnl ?? 0;
        if (bet.status === "pending") {
          acc.pendingBets += 1;
        }
        acc.oddsSum += bet.odds;
        return acc;
      },
      { totalStaked: 0, totalPnl: 0, pendingBets: 0, oddsSum: 0 }
    );

    return {
      totalStaked: totals.totalStaked,
      totalPnl: totals.totalPnl,
      pendingBets: totals.pendingBets,
      avgOdds: totals.oddsSum / data.length,
    };
  }, [data]);

  if (isLoading && !data) {
    return (
      <Card>
        <CardContent className="flex h-72 items-center justify-center text-sm text-[var(--color-text-muted)]">
          Loading bets…
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="border border-[rgba(248,113,113,0.35)] bg-[var(--color-card)]/60">
        <CardContent className="space-y-3 py-10 text-center">
          <p className="text-lg font-semibold text-[var(--color-negative)]">Unable to load bets</p>
          <p className="text-sm text-[var(--color-text-muted)]">{error?.message ?? "Something went wrong."}</p>
        </CardContent>
      </Card>
    );
  }

  const BetsTable = () => {
    if (!data || data.length === 0) {
      return (
        <EmptyState
          title="No bets found"
          description="Log bets from alerts to build your track record."
        />
      );
    }

    return (
      <div className="w-full overflow-x-auto">
        <div className="min-w-[1080px]">
          <div className="grid grid-cols-[1.8fr_1.2fr_0.9fr_0.8fr_0.8fr_0.9fr_0.9fr_0.9fr_1fr] border-b border-[var(--color-divider)] bg-[var(--color-card)]/65 text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
            <div className="px-5 py-3">Event</div>
            <div className="px-5 py-3">Selection</div>
            <div className="px-5 py-3">Source</div>
            <div className="px-5 py-3">Odds</div>
            <div className="px-5 py-3">Stake</div>
            <div className="px-5 py-3">Status</div>
            <div className="px-5 py-3">Returns</div>
            <div className="px-5 py-3">P&L</div>
            <div className="px-5 py-3">Actions</div>
          </div>
          <div className="divide-y divide-[var(--color-divider)]">
            {data.map((bet) => (
              <div
                key={bet.id}
                className="grid grid-cols-[1.8fr_1.2fr_0.9fr_0.8fr_0.8fr_0.9fr_0.9fr_0.9fr_1fr] bg-[var(--color-card)]/40 px-5 py-4 text-sm text-[var(--color-text-primary)] transition hover:bg-[var(--color-card-muted)]/70"
              >
                <div className="space-y-1 pr-3">
                  <p className="font-medium text-[var(--color-text-primary)]">
                    {bet.events.home} vs {bet.events.away}
                  </p>
                  <p className="text-xs text-[var(--color-text-faint)]">
                    {bet.sport_key} • {formatDateTime(bet.events.commence_time)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p>{bet.selection}</p>
                  <p className="text-xs text-[var(--color-text-faint)]">{bet.market_key}</p>
                </div>
                <div className="text-[var(--color-text-muted)]">{bet.source}</div>
                <div className="font-mono">{bet.odds.toFixed(2)}</div>
                <div className="font-mono">{formatCurrency(bet.stake)}</div>
                <div>
                  <span
                    className={cn(
                      "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize",
                      bet.status === "won" && "bg-[var(--color-positive-soft)] text-[var(--color-positive)]",
                      bet.status === "lost" && "bg-[var(--color-negative-soft)] text-[var(--color-negative)]",
                      bet.status === "pending" && "bg-[rgba(250,204,21,0.12)] text-[#facc15]",
                      bet.status === "void" && "bg-[var(--color-card-muted)] text-[var(--color-text-muted)]"
                    )}
                  >
                    {bet.status}
                  </span>
                </div>
                <div className="font-mono">
                  {bet.returns ? formatCurrency(bet.returns) : "-"}
                </div>
                <div className="font-mono">
                  {bet.pnl !== null ? (
                    <span className={bet.pnl >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}>
                      {formatCurrency(bet.pnl)}
                    </span>
                  ) : (
                    "-"
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {bet.status === "pending" ? (
                    <>
                      <Button size="sm" variant="primary" onClick={() => handleSettleBet(bet, "won")}>
                        Win
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleSettleBet(bet, "lost")}>
                        Loss
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleSettleBet(bet, "void")}>
                        Void
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-[var(--color-text-faint)]">Settled {formatDateTime(bet.settled_at ?? bet.created_at)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard title="Total Staked" value={formatCurrency(stats.totalStaked)} subtitle="Lifetime staked" />
        <SummaryCard
          title="Total P&L"
          value={formatCurrency(stats.totalPnl)}
          subtitle="After settled bets"
          intent={stats.totalPnl >= 0 ? "positive" : "negative"}
        />
        <SummaryCard
          title="Pending Bets"
          value={stats.pendingBets}
          subtitle="Awaiting settlement"
        />
        <SummaryCard
          title="Average Odds"
          value={stats.avgOdds ? stats.avgOdds.toFixed(2) : "-"}
          subtitle="Across logged bets"
        />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Filters</CardTitle>
            <CardDescription>Segment bet history by state</CardDescription>
          </div>
          <div className="w-full max-w-xs">
            <Dropdown
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={statusOptions}
            />
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bet History</CardTitle>
          <CardDescription>{data ? `${data.length} records` : ""}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <BetsTable />
        </CardContent>
      </Card>
    </div>
  );
}


