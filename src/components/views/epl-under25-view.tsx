"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatCurrency, formatDateTime } from "@/lib/utils";

interface StrategySettings {
  strategy_key: string;
  enabled: boolean;
  default_stake: number;
  min_back_price: number;
  lay_target_price: number;
  back_lead_minutes: number;
  fixture_lookahead_days: number;
  commission_rate: number;
  extra: Record<string, unknown> | null;
}

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

  const [settingsQuery, tradesQuery] = useQueries({
    queries: [
      {
        queryKey: ["strategy-settings", "epl-under25"],
        queryFn: async () => {
          const res = await fetch("/api/strategies/epl-under25/settings");
          if (!res.ok) throw new Error("Failed to load settings");
          const json = await res.json();
          if (!json.success) throw new Error(json.error || "Failed to load settings");
          return json.data as StrategySettings;
        },
      },
      {
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
      },
    ],
  });

  const settingsMutation = useMutation({
    mutationFn: async (payload: Partial<StrategySettings>) => {
      const res = await fetch("/api/strategies/epl-under25/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to update settings");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to update settings");
      return json.data as StrategySettings;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["strategy-settings", "epl-under25"], data);
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

  const settings = settingsQuery.data;
  const trades = useMemo(() => tradesQuery.data ?? [], [tradesQuery.data]);

  const summary = useMemo(() => {
    if (!trades.length) {
      return {
        scheduled: 0,
        open: 0,
        hedged: 0,
        pnl: 0,
      };
    }
    return trades.reduce(
      (acc, trade) => {
        if (trade.status === "scheduled") acc.scheduled += 1;
        if (trade.status === "back_pending" || trade.status === "back_matched" || trade.status === "hedge_pending") {
          acc.open += 1;
        }
        if (trade.status === "hedged") acc.hedged += 1;
        acc.pnl += trade.pnl ?? 0;
        return acc;
      },
      { scheduled: 0, open: 0, hedged: 0, pnl: 0 },
    );
  }, [trades]);

  const error = settingsQuery.error || tradesQuery.error;

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
          <SettingsForm
            settings={settings}
            isLoading={settingsQuery.isLoading || settingsMutation.isLoading}
            onUpdate={(partial) => settingsMutation.mutate(partial)}
          />

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
            cancelling={cancelTradesMutation.isLoading}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function SettingsForm({
  settings,
  isLoading,
  onUpdate,
}: {
  settings?: StrategySettings;
  isLoading: boolean;
  onUpdate: (payload: Partial<StrategySettings>) => void;
}) {
  const [draft, setDraft] = useState<StrategySettings | null>(settings ?? null);

  const dirty = settings && draft ? JSON.stringify(settings) !== JSON.stringify(draft) : false;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Runtime Settings</CardTitle>
          <CardDescription>Values persisted in Supabase settings table.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field
            label="Default Stake"
            suffix="€"
            value={draft?.default_stake}
            onChange={(value) => setDraft((prev) => prev ? { ...prev, default_stake: value } : prev)}
          />
          <Field
            label="Minimum Back Price"
            value={draft?.min_back_price}
            onChange={(value) => setDraft((prev) => prev ? { ...prev, min_back_price: value } : prev)}
          />
          <Field
            label="Lay Target Price"
            value={draft?.lay_target_price}
            onChange={(value) => setDraft((prev) => prev ? { ...prev, lay_target_price: value } : prev)}
          />
          <Field
            label="Back Lead Minutes"
            value={draft?.back_lead_minutes}
            onChange={(value) => setDraft((prev) => prev ? { ...prev, back_lead_minutes: value } : prev)}
          />
          <Field
            label="Fixture Lookahead Days"
            value={draft?.fixture_lookahead_days}
            onChange={(value) => setDraft((prev) => prev ? { ...prev, fixture_lookahead_days: value } : prev)}
          />
          <Field
            label="Commission Rate"
            suffix="%"
            value={draft?.commission_rate ? draft.commission_rate * 100 : undefined}
            onChange={(value) => setDraft((prev) => prev ? { ...prev, commission_rate: value / 100 } : prev)}
          />
        </CardContent>
      </Card>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          disabled={!dirty || isLoading || !draft}
          onClick={() => draft && onUpdate(draft)}
        >
          {isLoading ? "Saving..." : "Save settings"}
        </Button>
        {!settings && <span className="text-xs text-[var(--color-text-muted)]">Settings row will be created automatically if missing.</span>}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-1">
      <span className="text-xs font-medium text-[var(--color-text-muted)]">{label}</span>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="w-full"
          value={value ?? ""}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {suffix ? <span className="text-xs text-[var(--color-text-muted)]">{suffix}</span> : null}
      </div>
    </label>
  );
}

function SummaryBar({
  summary,
}: {
  summary: { scheduled: number; open: number; hedged: number; pnl: number };
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryCard label="Scheduled" value={summary.scheduled} />
      <SummaryCard label="Open" value={summary.open} />
      <SummaryCard label="Hedged" value={summary.hedged} />
      <SummaryCard label="Realised P&L" value={formatCurrency(summary.pnl)} intent={summary.pnl >= 0 ? "positive" : "negative"} />
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
            <th className="px-4 py-3 text-left font-medium">Event</th>
            <th className="px-4 py-3 text-right font-medium">Status</th>
            <th className="px-4 py-3 text-right font-medium">Back</th>
            <th className="px-4 py-3 text-right font-medium">Lay</th>
            <th className="px-4 py-3 text-right font-medium">Hedge Target</th>
            <th className="px-4 py-3 text-right font-medium">PnL</th>
            <th className="px-4 py-3 text-right font-medium">Updated</th>
            <th className="px-4 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-divider)]">
          {trades.map((trade) => (
            <tr key={trade.id} className="bg-[var(--color-card)]/40">
              <td className="px-4 py-3">
                <div className="font-medium text-[var(--color-text-primary)]">{trade.runner_name ?? 'Under 2.5 Goals'}</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {trade.kickoff_at ? formatDateTime(trade.kickoff_at) : 'Unknown kickoff'}
                </div>
              </td>
              <td className="px-4 py-3 text-right">
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-semibold capitalize",
                    trade.status === 'scheduled' && "bg-[rgba(14,165,233,0.12)] text-[#38bdf8]",
                    trade.status === 'back_pending' && "bg-[rgba(250,204,21,0.12)] text-[#facc15]",
                    trade.status === 'back_matched' && "bg-[rgba(147,197,114,0.12)] text-[#86efac]",
                    trade.status === 'hedge_pending' && "bg-[rgba(245,158,11,0.12)] text-[#fb923c]",
                    trade.status === 'hedged' && "bg-[rgba(22,163,74,0.12)] text-[#4ade80]",
                    trade.status === 'failed' && "bg-[rgba(248,113,113,0.14)] text-[#f87171]",
                    trade.status === 'cancelled' && "bg-[var(--color-card-muted)] text-[var(--color-text-muted)]",
                  )}
                >
                  {trade.status}
                </span>
              </td>
              <td className="px-4 py-3 text-right font-mono">
                {trade.back_price ? `${trade.back_price.toFixed(2)} @ ${trade.back_size?.toFixed(2)}` : '—'}
              </td>
              <td className="px-4 py-3 text-right font-mono">
                {trade.lay_price ? `${trade.lay_price.toFixed(2)} @ ${trade.lay_size?.toFixed(2)}` : '—'}
              </td>
              <td className="px-4 py-3 text-right font-mono">
                {trade.hedge_target_price ? trade.hedge_target_price.toFixed(2) : '—'}
              </td>
              <td className="px-4 py-3 text-right font-mono">
                {trade.pnl !== null ? (
                  <span className={trade.pnl >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}>
                    {formatCurrency(trade.pnl)}
                  </span>
                ) : '—'}
              </td>
              <td className="px-4 py-3 text-right text-xs text-[var(--color-text-muted)]">
                {formatDateTime(trade.updated_at)}
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
          ))}
        </tbody>
      </table>
    </div>
  );
}


