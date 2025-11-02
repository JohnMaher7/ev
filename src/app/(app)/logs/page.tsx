'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/app-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { format } from 'date-fns';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogEntry = {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
};

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  debug: 'bg-gray-500',
  info: 'bg-blue-500',
  warn: 'bg-yellow-500',
  error: 'bg-red-500',
};

export default function LogsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<{
    level: LogLevel | '';
    module: string;
    search: string;
  }>({
    level: '',
    module: '',
    search: '',
  });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Fetch logs
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['logs', filter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filter.level) params.append('level', filter.level);
      if (filter.module) params.append('module', filter.module);
      if (filter.search) params.append('search', filter.search);
      params.append('limit', '500');

      const response = await fetch(`/api/logs?${params}`);
      if (!response.ok) throw new Error('Failed to fetch logs');
      return response.json();
    },
    refetchInterval: autoRefresh ? 2000 : false,
  });

  // Clear logs mutation
  const clearLogsMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/logs', { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to clear logs');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['logs'] });
    },
  });

  // Export logs
  const exportLogs = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.level) params.append('level', filter.level);
    if (filter.module) params.append('module', filter.module);
    if (filter.search) params.append('search', filter.search);
    params.append('format', 'csv');

    const response = await fetch(`/api/logs?${params}`);
    if (response.ok) {
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `logs-${format(new Date(), 'yyyy-MM-dd-HHmmss')}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [filter]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoRefresh && data?.data?.logs?.length > 0) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [data?.data?.logs?.length, autoRefresh]);

  const logs = data?.data?.logs || [];

  return (
    <AppLayout
      title="System Logs"
      description="Real-time view of application logs and events"
    >
      <div className="space-y-6">

      {/* Controls */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-4 items-end">
          {/* Level filter */}
          <div className="flex-1 min-w-[150px]">
            <label className="block text-sm font-medium mb-1">Log Level</label>
            <select
              value={filter.level}
              onChange={(e) => setFilter({ ...filter, level: e.target.value as LogLevel | '' })}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All Levels</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </select>
          </div>

          {/* Module filter */}
          <div className="flex-1 min-w-[150px]">
            <label className="block text-sm font-medium mb-1">Module</label>
            <Input
              value={filter.module}
              onChange={(e) => setFilter({ ...filter, module: e.target.value })}
              placeholder="e.g., poll, alerts"
            />
          </div>

          {/* Search */}
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium mb-1">Search</label>
            <Input
              value={filter.search}
              onChange={(e) => setFilter({ ...filter, search: e.target.value })}
              placeholder="Search logs..."
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              onClick={() => setAutoRefresh(!autoRefresh)}
              variant={autoRefresh ? 'primary' : 'secondary'}
            >
              {autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
            </Button>
            <Button onClick={() => refetch()} variant="secondary">
              Refresh
            </Button>
            <Button onClick={exportLogs} variant="secondary">
              Export CSV
            </Button>
            <Button
              onClick={() => clearLogsMutation.mutate()}
              variant="danger"
              disabled={clearLogsMutation.isPending}
            >
              Clear Logs
            </Button>
          </div>
        </div>
      </Card>

      {/* Logs display */}
      <Card className="p-4">
        <div className="space-y-1 max-h-[600px] overflow-y-auto font-mono text-sm">
          {isLoading && <div className="text-gray-500">Loading logs...</div>}
          {error && <div className="text-red-500">Error loading logs: {error.message}</div>}
          {logs.length === 0 && !isLoading && (
            <div className="text-gray-500">No logs found</div>
          )}
          
          {logs.map((log: LogEntry, index: number) => {
            const dataStr = typeof log.data === 'string' 
              ? log.data 
              : (JSON.stringify(log.data, null, 2) || 'null');
            
            // Check if this is a section header or formatted message
            const isSection = log.message.includes('═══');
            const isMultiline = log.message.includes('\n');
            
            return (
              <div key={index} className={`flex items-start gap-2 py-1 ${isSection ? 'mt-2' : ''} hover:bg-gray-50`}>
                <span className="text-gray-500 whitespace-nowrap text-xs">
                  {format(new Date(log.timestamp), 'HH:mm:ss')}
                </span>
                
                <Badge className={`${LOG_LEVEL_COLORS[log.level]} text-white text-xs flex-shrink-0`}>
                  {log.level.substring(0, 4).toUpperCase()}
                </Badge>
                
                <span className="text-gray-600 text-xs">[{log.module}]</span>
                
                <span className={`flex-1 whitespace-pre-wrap break-all font-mono text-sm ${isSection ? 'font-bold text-blue-600' : ''}`}>
                  {log.message}
                </span>
                
                {log.data && !isMultiline ? (
                  <details className="cursor-pointer flex-shrink-0">
                    <summary className="text-blue-500 hover:underline text-xs">data</summary>
                    <pre className="mt-1 p-2 bg-gray-100 rounded text-xs overflow-auto max-w-md">
                      {dataStr}
                    </pre>
                  </details>
                ) : null}
              </div>
            );
          })}
          
          <div ref={logsEndRef} />
        </div>
        
        {/* Summary */}
        {data?.data && (
          <div className="mt-4 pt-4 border-t text-sm text-gray-600">
            Showing {logs.length} of {data.data.total} logs
            {data.data.hasMore && ' (more available)'}
          </div>
        )}
      </Card>
      </div>
    </AppLayout>
  );
}
