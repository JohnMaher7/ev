"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SummaryCard } from "@/components/ui/summary-card";
import { cn, formatDateTime } from "@/lib/utils";

interface AdminStats {
  sports: Array<{ sport_key: string; sport_title: string; enabled: boolean }>;
  lastDiscovery: string | null;
  lastPoll: string | null;
  totalSnapshots: number;
  totalCandidates: number;
  apiCallsToday: number;
  errorsToday: number;
  recentActivity: Array<{ title: string; detail: string; at: string }>;
}

interface AdminConfig {
  pollMinutes: number;
  timezone: string;
  demoMode: boolean;
  thresholds: { solid: number; scout: number; exchangeValue: number };
}

export default function AdminView() {
  const [isRunningDiscovery, setIsRunningDiscovery] = useState(false);
  const [isRunningPoll, setIsRunningPoll] = useState(false);
  const queryClient = useQueryClient();

  const { data: stats, isLoading } = useQuery<AdminStats>({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const res = await fetch("/api/admin/stats");
      if (!res.ok) throw new Error("Failed to load stats");
      const json = await res.json();
      return json.data as AdminStats;
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });

  const { data: config } = useQuery<AdminConfig>({
    queryKey: ["admin-config"],
    queryFn: async () => {
      const res = await fetch("/api/admin/config");
      if (!res.ok) throw new Error("Failed to load config");
      const json = await res.json();
      return json.data as AdminConfig;
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const discoveryMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/discovery", { method: "POST" });
      if (!response.ok) {
        throw new Error("Discovery failed");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
    },
  });

  const pollMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/poll", { method: "POST" });
      if (!response.ok) {
        throw new Error("Polling failed");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
    },
  });

  const handleRunDiscovery = async () => {
    setIsRunningDiscovery(true);
    try {
      await discoveryMutation.mutateAsync();
    } finally {
      setIsRunningDiscovery(false);
    }
  };

  const handleRunPoll = async () => {
    setIsRunningPoll(true);
    try {
      await pollMutation.mutateAsync();
    } finally {
      setIsRunningPoll(false);
    }
  };

  if (isLoading && !stats) {
    return (
      <Card>
        <CardContent className="flex h-72 items-center justify-center text-sm text-[var(--color-text-muted)]">
          Loading system status…
        </CardContent>
      </Card>
    );
  }

  if (!stats) {
    return (
      <EmptyState
        title="No admin data"
        description="Connect Supabase and configure API credentials to see system status."
      />
    );
  }

  const successRate = stats.apiCallsToday
    ? (((stats.apiCallsToday - (stats.errorsToday || 0)) / stats.apiCallsToday) * 100).toFixed(1)
    : "100";

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Snapshots"
          value={stats.totalSnapshots.toLocaleString()}
          subtitle="Historical odds captured"
          intent="info"
        />
        <SummaryCard
          title="Active Candidates"
          value={stats.totalCandidates.toLocaleString()}
          subtitle="Alerts currently live"
          intent="positive"
        />
        <SummaryCard
          title="API Calls Today"
          value={stats.apiCallsToday.toLocaleString()}
          subtitle="Across all cron tasks"
        />
        <SummaryCard
          title="Error Rate"
          value={`${stats.errorsToday} (${successRate}% success)`}
          subtitle="Last 24h"
          intent={stats.errorsToday === 0 ? "positive" : "negative"}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Manual Operations</CardTitle>
            <CardDescription>Trigger key workflows on demand</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleRunDiscovery} isLoading={isRunningDiscovery}>
              Run Discovery
            </Button>
            <Button variant="secondary" onClick={handleRunPoll} isLoading={isRunningPoll}>
              Run Poll Cycle
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sports Configuration</CardTitle>
          <CardDescription>Manage enabled sports and marketplaces</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {stats.sports.map((sport) => (
            <div
              key={sport.sport_key}
              className={cn(
                "rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-card)]/60 px-4 py-3",
                sport.enabled ? "shadow-card" : "opacity-70"
              )}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-[var(--color-text-primary)]">{sport.sport_title}</p>
                  <p className="text-xs text-[var(--color-text-faint)]">{sport.sport_key}</p>
                </div>
                <span
                  className={cn(
                    "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold",
                    sport.enabled
                      ? "bg-[var(--color-positive-soft)] text-[var(--color-positive)]"
                      : "bg-[var(--color-card-muted)] text-[var(--color-text-muted)]"
                  )}
                >
                  {sport.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>System Information</CardTitle>
            <CardDescription>Last successful operations</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-[var(--color-text-muted)]">
            <div className="flex items-center justify-between">
              <span>Last Discovery</span>
              <span className="text-[var(--color-text-primary)]">
                {stats.lastDiscovery ? formatDateTime(stats.lastDiscovery) : "Never"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Last Poll</span>
              <span className="text-[var(--color-text-primary)]">
                {stats.lastPoll ? formatDateTime(stats.lastPoll) : "Never"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Timezone</span>
              <span className="text-[var(--color-text-primary)]">{config?.timezone ?? "Europe/London"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Poll Interval</span>
              <span className="text-[var(--color-text-primary)]">{config?.pollMinutes ?? 60} minutes</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Demo Mode</span>
              <span className="text-[var(--color-text-primary)]">{config?.demoMode ? "Enabled" : "Disabled"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Alert Thresholds</CardTitle>
            <CardDescription>Current EV requirements per tier</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-[var(--color-text-muted)]">
            <div className="flex items-center justify-between">
              <span>Solid</span>
              <span className="text-[var(--color-text-primary)]">
                ≥ {(config?.thresholds.solid ?? 0.02) * 100}pp
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Scout</span>
              <span className="text-[var(--color-text-primary)]">
                ≥ {(config?.thresholds.scout ?? 0.05) * 100}pp
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Exchange Value</span>
              <span className="text-[var(--color-text-primary)]">
                ≥ {(config?.thresholds.exchangeValue ?? 0.03) * 100}pp
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest system events</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {stats.recentActivity?.length ? (
            stats.recentActivity.map((activity, index) => (
              <div
                key={`${activity.title}-${index}`}
                className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-divider)] bg-[var(--color-card)]/50 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">{activity.title}</p>
                  <p className="text-xs text-[var(--color-text-muted)]">{activity.detail}</p>
                </div>
                <span className="text-xs text-[var(--color-text-faint)]">
                  {formatDateTime(activity.at)}
                </span>
              </div>
            ))
          ) : (
            <EmptyState
              title="No recent activity"
              description="Manual or automated operations will appear here."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}


