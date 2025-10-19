"use client";

import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SummaryCard } from "@/components/ui/summary-card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBasisPoints, formatCurrency, formatPercentage } from "@/lib/utils";

const ResponsiveContainer = dynamic(() => import("recharts").then((mod) => mod.ResponsiveContainer), {
  ssr: false,
  loading: () => <div className="h-[320px]" aria-busy="true" />,
});
const LineChart = dynamic(() => import("recharts").then((mod) => mod.LineChart), {
  ssr: false,
  loading: () => <div className="h-[320px]" aria-busy="true" />,
});
const Line = dynamic(() => import("recharts").then((mod) => mod.Line), { ssr: false });
const XAxis = dynamic(() => import("recharts").then((mod) => mod.XAxis), { ssr: false });
const YAxis = dynamic(() => import("recharts").then((mod) => mod.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import("recharts").then((mod) => mod.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import("recharts").then((mod) => mod.Tooltip), { ssr: false });
const BarChart = dynamic(() => import("recharts").then((mod) => mod.BarChart), {
  ssr: false,
  loading: () => <div className="h-[320px]" aria-busy="true" />,
});
const Bar = dynamic(() => import("recharts").then((mod) => mod.Bar), { ssr: false });

interface MetricsData {
  summary: {
    totalStaked: number;
    totalPnl: number;
    totalBets: number;
    winRate: number;
    expectedValue: number;
    actualMargin: number;
    expectedMargin: number;
    clvBps: number;
    pendingBets: number;
  };
  dailyMetrics: Array<{
    date: string;
    staked: number;
    pnl: number;
    expected_value: number;
    actual_margin: number;
    expected_margin: number;
    clv_bps: number;
    win_rate: number;
    num_bets: number;
    num_bets_scout: number;
    num_bets_solid: number;
    num_bets_exchange: number;
  }>;
}

export default function MetricsView() {
  const { data, isLoading, isError, error } = useQuery<MetricsData>({
    queryKey: ["metrics"],
    queryFn: async () => {
      const response = await fetch("/api/metrics");
      if (!response.ok) {
        throw new Error("Failed to fetch metrics");
      }
      const result = await response.json();
      return result.data as MetricsData;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading && !data) {
    return (
      <Card>
        <CardContent className="flex h-72 items-center justify-center text-sm text-[var(--color-text-muted)]">
          Loading metrics…
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="border border-[rgba(248,113,113,0.35)] bg-[var(--color-card)]/60">
        <CardContent className="space-y-3 py-10 text-center">
          <p className="text-lg font-semibold text-[var(--color-negative)]">Unable to load metrics</p>
          <p className="text-sm text-[var(--color-text-muted)]">{error?.message ?? "Something went wrong."}</p>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <EmptyState
        title="No metrics yet"
        description="Log bets and settle results to generate analytics."
      />
    );
  }

  const { summary, dailyMetrics } = data;

  const chartData = dailyMetrics.map((day) => ({
    date: new Date(day.date).toLocaleDateString("en-GB", { month: "short", day: "numeric" }),
    pnl: day.pnl,
    expectedValue: day.expected_value,
    actualMargin: day.actual_margin * 100,
    expectedMargin: day.expected_margin * 100,
    staked: day.staked,
    bets: day.num_bets,
  }));

  const tierData = [
    { tier: "SOLID", count: dailyMetrics.reduce((sum, day) => sum + day.num_bets_solid, 0) },
    { tier: "SCOUT", count: dailyMetrics.reduce((sum, day) => sum + day.num_bets_scout, 0) },
    { tier: "EXCHANGE", count: dailyMetrics.reduce((sum, day) => sum + day.num_bets_exchange, 0) },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Total Staked"
          value={formatCurrency(summary.totalStaked)}
          subtitle="Lifetime staked"
        />
        <SummaryCard
          title="Total P&L"
          value={formatCurrency(summary.totalPnl)}
          subtitle="Actual returns"
          intent={summary.totalPnl >= 0 ? "positive" : "negative"}
        />
        <SummaryCard
          title="Win Rate"
          value={formatPercentage(summary.winRate / 100)}
          subtitle="Overall hit rate"
        />
        <SummaryCard
          title="CLV"
          value={formatBasisPoints(summary.clvBps / 10000)}
          subtitle="Closing line value"
          intent={summary.clvBps >= 0 ? "positive" : "negative"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Expected Value"
          value={formatCurrency(summary.expectedValue)}
          subtitle="Modelled returns"
          intent={summary.expectedValue >= 0 ? "positive" : "negative"}
        />
        <SummaryCard
          title="Expected Margin"
          value={formatPercentage(summary.expectedMargin / 100)}
          subtitle="Model ROI"
        />
        <SummaryCard
          title="Actual Margin"
          value={formatPercentage(summary.actualMargin / 100)}
          subtitle="Observed ROI"
          intent={summary.actualMargin >= 0 ? "positive" : "negative"}
        />
        <SummaryCard
          title="Pending Bets"
          value={summary.pendingBets}
          subtitle="Awaiting settlement"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Daily Performance</CardTitle>
          <CardDescription>Actual P&amp;L vs expected value</CardDescription>
        </CardHeader>
        <CardContent className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-[var(--color-divider)]" />
              <XAxis dataKey="date" stroke="var(--color-text-faint)" tickLine={false} axisLine={false} />
              <YAxis stroke="var(--color-text-faint)" tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ background: "rgba(14,23,42,0.95)", borderRadius: "12px", border: "1px solid rgba(148,163,184,0.2)", color: "#e2e8f0" }}
                formatter={(value: number, name: string) => [formatCurrency(value), name === "pnl" ? "Actual P&L" : "Expected Value"]}
              />
              <Line type="monotone" dataKey="pnl" stroke="#f87171" strokeWidth={2} dot={false} name="Actual P&L" />
              <Line type="monotone" dataKey="expectedValue" stroke="#10b981" strokeWidth={2} dot={false} name="Expected Value" />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Daily Margins</CardTitle>
            <CardDescription>Actual vs expected margin (%)</CardDescription>
          </CardHeader>
          <CardContent className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-[var(--color-divider)]" />
                <XAxis dataKey="date" stroke="var(--color-text-faint)" tickLine={false} axisLine={false} />
                <YAxis stroke="var(--color-text-faint)" tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: "rgba(14,23,42,0.95)", borderRadius: "12px", border: "1px solid rgba(148,163,184,0.2)", color: "#e2e8f0" }}
                  formatter={(value: number, name: string) => [`${value.toFixed(2)}%`, name === "actualMargin" ? "Actual Margin" : "Expected Margin"]}
                />
                <Line type="monotone" dataKey="actualMargin" stroke="#38bdf8" strokeWidth={2} dot={false} name="Actual Margin" />
                <Line type="monotone" dataKey="expectedMargin" stroke="#facc15" strokeWidth={2} dot={false} name="Expected Margin" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Daily Staked</CardTitle>
            <CardDescription>Capital deployed per day</CardDescription>
          </CardHeader>
          <CardContent className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-[var(--color-divider)]" />
                <XAxis dataKey="date" stroke="var(--color-text-faint)" tickLine={false} axisLine={false} />
                <YAxis stroke="var(--color-text-faint)" tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: "rgba(14,23,42,0.95)", borderRadius: "12px", border: "1px solid rgba(148,163,184,0.2)", color: "#e2e8f0" }}
                  formatter={(value: number) => [formatCurrency(value), "Staked"]}
                />
                <Bar dataKey="staked" fill="#38bdf8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bets by Tier</CardTitle>
          <CardDescription>Volume split across alert tiers</CardDescription>
        </CardHeader>
        <CardContent className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={tierData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-[var(--color-divider)]" />
              <XAxis dataKey="tier" stroke="var(--color-text-faint)" tickLine={false} axisLine={false} />
              <YAxis stroke="var(--color-text-faint)" tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: "rgba(14,23,42,0.95)", borderRadius: "12px", border: "1px solid rgba(148,163,184,0.2)", color: "#e2e8f0" }}
                formatter={(value: number) => [value, "Bets"]}
              />
              <Bar dataKey="count" fill="#14b8a6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}


