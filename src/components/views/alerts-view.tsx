"use client";

import { useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";

import { SummaryCard } from "@/components/ui/summary-card";
import { MinEdgeInput } from "@/components/ui/min-edge-input";
import { Dropdown } from "@/components/ui/dropdown";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatDateTime, formatPercentage } from "@/lib/utils";
import { config } from "@/lib/config";
import { BetModal } from "@/components/bet-modal";
import type { Candidate } from "@/types/candidate";

type FiltersState = {
  minEdge: number;
  tier: "" | "SOLID" | "SCOUT" | "EXCHANGE_VALUE";
  marketType: string;
};

const tierOptions = [
  { value: "", label: "All tiers" },
  { value: "SOLID", label: "Solid" },
  { value: "SCOUT", label: "Scout" },
  { value: "EXCHANGE_VALUE", label: "Exchange value" },
];

const marketOptions = [
  { value: "", label: "All markets" },
  { value: "h2h", label: "Head to head" },
  { value: "totals", label: "Totals" },
];

const tierIntentMap: Record<Candidate["alert_tier"], "neutral" | "positive" | "negative" | "info"> = {
  SOLID: "positive",
  SCOUT: "info",
  EXCHANGE_VALUE: "neutral",
};

function formatTier(tier: Candidate["alert_tier"]) {
  return tier.replace("_", " ");
}

export default function AlertsView() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<FiltersState>({
    minEdge: config.alertThresholds.solid,
    tier: "",
    marketType: "",
  });
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [isClearing, setIsClearing] = useState(false);

  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
    fetchStatus,
  } = useQuery<Candidate[]>({
    queryKey: ["candidates", filters.minEdge, filters.tier],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.minEdge > 0) {
        params.set("min_edge", filters.minEdge.toString());
      }
      if (filters.tier) {
        params.set("alert_tier", filters.tier);
      }

      const response = await fetch(`/api/candidates?${params.toString()}`);
      if (!response.ok) {
        throw new Error("Failed to fetch candidates");
      }
      const result = await response.json();
      return result.data as Candidate[];
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });

  const candidates = useMemo(() => {
    if (!data) return [];
    if (!filters.marketType) return data;
    return data.filter((candidate) => candidate.market_key === filters.marketType);
  }, [data, filters.marketType]);

  const summary = useMemo(() => {
    if (!candidates.length) {
      return {
        count: 0,
        avgEdge: 0,
        topEdge: 0,
        solidCount: 0,
        scoutCount: 0,
        exchangeCount: 0,
      };
    }

    const totals = candidates.reduce(
      (acc, candidate) => {
        acc.sumEdge += candidate.edge_pp;
        acc.topEdge = Math.max(acc.topEdge, candidate.edge_pp);
        switch (candidate.alert_tier) {
          case "SOLID":
            acc.solidCount += 1;
            break;
          case "SCOUT":
            acc.scoutCount += 1;
            break;
          case "EXCHANGE_VALUE":
            acc.exchangeCount += 1;
            break;
        }
        return acc;
      },
      {
        sumEdge: 0,
        topEdge: 0,
        solidCount: 0,
        scoutCount: 0,
        exchangeCount: 0,
      }
    );

    return {
      count: candidates.length,
      avgEdge: totals.sumEdge / candidates.length,
      topEdge: totals.topEdge,
      solidCount: totals.solidCount,
      scoutCount: totals.scoutCount,
      exchangeCount: totals.exchangeCount,
    };
  }, [candidates]);

  const handleApplyMinEdge = (nextMinEdge: number) => {
    setFilters((prev) => ({ ...prev, minEdge: nextMinEdge }));
  };

  const handleTierChange = (value: string) => {
    setFilters((prev) => ({ ...prev, tier: value as FiltersState["tier"] }));
  };

  const handleMarketChange = (value: string) => {
    setFilters((prev) => ({ ...prev, marketType: value }));
  };

  const handleResetFilters = () => {
    setFilters({ minEdge: config.alertThresholds.solid, tier: "", marketType: "" });
  };

  const handleClearAlert = async (alertId: string) => {
    try {
      const response = await fetch(`/api/candidates/${alertId}`, { method: "DELETE" });
      if (response.ok) {
        queryClient.setQueryData<Candidate[]>(["candidates", filters.minEdge, filters.tier], (previous) => {
          if (!previous) return previous;
          return previous.filter((candidate) => candidate.id !== alertId);
        });
      }
    } catch (err) {
      console.error("Error clearing alert", err);
    }
  };

  const handleClearAll = async () => {
    if (!candidates.length) return;
    setIsClearing(true);
    try {
      const response = await fetch("/api/candidates/clear-all", { method: "DELETE" });
      if (response.ok) {
        queryClient.setQueryData<Candidate[]>(["candidates", filters.minEdge, filters.tier], []);
        queryClient.invalidateQueries({ queryKey: ["candidates"] });
      }
    } catch (err) {
      console.error("Error clearing alerts", err);
    } finally {
      setIsClearing(false);
    }
  };

  if (isLoading && !data) {
    return (
      <Card className="border-dashed border-[rgba(148,163,184,0.35)] bg-[var(--color-card)]/40">
        <CardContent className="flex h-72 items-center justify-center gap-3 text-sm text-[var(--color-text-muted)]">
          <span className="inline-flex h-4 w-4 animate-spin rounded-full border-2 border-transparent border-b-[var(--color-info)] border-l-[var(--color-info)]" />
          Loading alerts…
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="border border-[rgba(248,113,113,0.35)] bg-[var(--color-card)]/60">
        <CardContent className="space-y-3 py-10 text-center">
          <p className="text-lg font-semibold text-[var(--color-negative)]">Unable to load alerts</p>
          <p className="text-sm text-[var(--color-text-muted)]">{error?.message ?? "Something went wrong."}</p>
          <Button variant="secondary" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Active Alerts"
          value={summary.count}
          subtitle={
            isFetching || fetchStatus === "fetching"
              ? "Refreshing…"
              : `Last sync ${new Date().toLocaleTimeString("en-GB")}`
          }
          intent="info"
        />
        <SummaryCard
          title="Average Edge"
          value={formatPercentage(summary.avgEdge)}
          subtitle={`Filtered ≥ ${formatPercentage(filters.minEdge)}`}
          intent="positive"
        />
        <SummaryCard
          title="Top Opportunity"
          value={formatPercentage(summary.topEdge)}
          subtitle="Highest edge available"
          intent="positive"
        />
        <SummaryCard
          title="Tier Mix"
          value={
            <span className="flex gap-2 text-sm text-[var(--color-text-muted)]">
              <span>Solid {summary.solidCount}</span>
              <span>Scout {summary.scoutCount}</span>
              <span>EX {summary.exchangeCount}</span>
            </span>
          }
          subtitle="Distribution across tiers"
        />
      </div>

      <Card className="relative z-40 overflow-visible">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Filters</CardTitle>
            <CardDescription>Dial in the opportunities you care about</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn("mr-2 h-4 w-4", isFetching && "animate-spin")}
              />
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={handleResetFilters}>
              <SlidersHorizontal className="mr-2 h-4 w-4" />
              Reset
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 overflow-visible lg:grid-cols-3">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
              Min Edge (pp)
            </p>
            <MinEdgeInput value={filters.minEdge} onApply={handleApplyMinEdge} precision={3} />
          </div>
          <div className="relative">
            <Dropdown
              label="Tier"
              value={filters.tier}
              onChange={handleTierChange}
              options={tierOptions}
              placeholder="All tiers"
            />
          </div>
          <div className="relative">
            <Dropdown
              label="Market"
              value={filters.marketType}
              onChange={handleMarketChange}
              options={marketOptions}
              placeholder="All markets"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle>Active Opportunities</CardTitle>
            <CardDescription>{`Sorted by latest update • ${summary.count} results`}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn("mr-2 h-4 w-4", isFetching && "animate-spin")}
              />
              Sync
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleClearAll}
              disabled={!candidates.length || isClearing}
              isLoading={isClearing}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Clear All
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-visible p-0">
          {candidates.length ? (
            <div className="w-full overflow-x-auto">
              <div className="min-w-[1100px]">
                <div className="grid grid-cols-[1.7fr_1fr_1.3fr_0.8fr_0.9fr_0.8fr_0.8fr_0.9fr_1.1fr_1fr] border-b border-[var(--color-divider)] bg-[var(--color-card)]/65 text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
                  <div className="px-5 py-3">Event</div>
                  <div className="px-5 py-3">Market</div>
                  <div className="px-5 py-3">Selection</div>
                  <div className="px-5 py-3">Tier</div>
                  <div className="px-5 py-3">Best Source</div>
                  <div className="px-5 py-3">Offered</div>
                  <div className="px-5 py-3">Fair</div>
                  <div className="px-5 py-3">Edge</div>
                  <div className="px-5 py-3">Prices</div>
                  <div className="px-5 py-3">Triggered</div>
                  <div className="px-5 py-3">Actions</div>
                </div>
                <div className="divide-y divide-[var(--color-divider)]">
                  {candidates.map((candidate) => (
                    <div
                      key={candidate.id}
                      className="grid grid-cols-[1.7fr_1fr_1.3fr_0.8fr_0.9fr_0.8fr_0.8fr_0.9fr_1.1fr_1fr] bg-[var(--color-card)]/40 px-5 py-4 text-sm text-[var(--color-text-primary)] transition hover:bg-[var(--color-card-muted)]/70"
                    >
                      <div className="space-y-1 pr-3">
                        <p className="font-medium text-[var(--color-text-primary)]">
                          {candidate.events.home} vs {candidate.events.away}
                        </p>
                        <p className="text-xs text-[var(--color-text-faint)]">
                          {candidate.sport_key} • {formatDateTime(candidate.events.commence_time)}
                        </p>
                      </div>
                      <div className="text-[var(--color-text-muted)]">{candidate.market_key}</div>
                      <div className="space-y-1">
                        <p>{candidate.selection}</p>
                        <p className="text-xs text-[var(--color-text-faint)]">
                          {candidate.books_count} books • {candidate.exchanges_count} exchanges
                        </p>
                      </div>
                      <div>
                        <Badge intent={tierIntentMap[candidate.alert_tier]} className="capitalize">
                          {formatTier(candidate.alert_tier)}
                        </Badge>
                      </div>
                      <div className="text-[var(--color-text-muted)]">{candidate.best_source}</div>
                      <div className="font-mono text-[var(--color-text-primary)]">
                        {candidate.offered_price.toFixed(2)}
                      </div>
                      <div className="font-mono text-[var(--color-text-muted)]">
                        {candidate.fair_price.toFixed(2)}
                      </div>
                      <div className="font-semibold text-[var(--color-positive)]">
                        {formatPercentage(candidate.edge_pp)}
                      </div>
                      <div className="flex items-center">
                        {candidate.allBookmakerPrices && candidate.allBookmakerPrices.length ? (
                          <div className="popover-trigger relative inline-flex">
                            <button
                              type="button"
                              className="text-sm font-medium text-[var(--color-info)] underline decoration-dotted decoration-[var(--color-info)]/60 underline-offset-4"
                            >
                              {candidate.books_count} books
                            </button>
                            <div className="popover-content pointer-events-none absolute right-0 top-[calc(100%+8px)] z-[80] w-72 sm:w-80 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-card)]/95 p-3 text-left text-xs text-[var(--color-text-muted)] opacity-0 shadow-menu transition-opacity duration-150">
                              <p className="mb-2 text-[var(--color-text-primary)]">All bookmaker prices</p>
                              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                                {candidate.allBookmakerPrices.map((price, index) => (
                                  <div key={`${candidate.id}-price-${index}`} className="flex items-center justify-between gap-2">
                                    <span className={cn("font-medium", price.isExchange ? "text-[var(--color-info)]" : "text-[var(--color-text-muted)]")}>
                                      {price.bookmaker}
                                    </span>
                                    <span className="font-mono text-[var(--color-text-primary)]">
                                      {price.price.toFixed(2)}
                                    </span>
                                    {price.isExchange ? <span className="text-[var(--color-warning)]">EX</span> : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <span className="text-[var(--color-text-muted)]">{candidate.books_count} books</span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--color-text-faint)]">
                        {formatDateTime(candidate.created_at)}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => setSelectedCandidate(candidate)}
                        >
                          Bet
                          <ArrowUpRight className="ml-1 h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleClearAlert(candidate.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              title="No alerts match your filters"
              description="Adjust the minimum edge or tier filters to widen your search."
              action={
                <Button variant="secondary" onClick={handleResetFilters}>
                  Reset Filters
                </Button>
              }
            />
          )}
        </CardContent>
      </Card>

      {selectedCandidate ? (
        <BetModal candidate={selectedCandidate} onClose={() => setSelectedCandidate(null)} />
      ) : null}
    </div>
  );
}


