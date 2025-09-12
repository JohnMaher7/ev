'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@/lib/utils';

interface AdminStats {
  sports: Array<{
    sport_key: string;
    sport_title: string;
    enabled: boolean;
  }>;
  lastDiscovery: string | null;
  lastPoll: string | null;
  totalSnapshots: number;
  totalCandidates: number;
  apiCallsToday: number;
  errorsToday: number;
}

export function AdminPanel() {
  const [isRunningDiscovery, setIsRunningDiscovery] = useState(false);
  const [isRunningPoll, setIsRunningPoll] = useState(false);
  const queryClient = useQueryClient();

  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: async () => {
      // This would typically fetch from an admin API endpoint
      // For now, we'll return mock data
      return {
        sports: [
          { sport_key: 'tennis', sport_title: 'Tennis', enabled: true },
          { sport_key: 'soccer_epl', sport_title: 'Soccer EPL', enabled: true },
        ],
        lastDiscovery: new Date().toISOString(),
        lastPoll: new Date().toISOString(),
        totalSnapshots: 1250,
        totalCandidates: 45,
        apiCallsToday: 120,
        errorsToday: 2,
      } as AdminStats;
    },
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  const discoveryMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/discovery', {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error('Discovery failed');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-stats'] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
    },
  });

  const pollMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/poll', {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error('Polling failed');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-stats'] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
    },
  });

  const handleDiscovery = async () => {
    setIsRunningDiscovery(true);
    try {
      await discoveryMutation.mutateAsync();
    } finally {
      setIsRunningDiscovery(false);
    }
  };

  const handlePoll = async () => {
    setIsRunningPoll(true);
    try {
      await pollMutation.mutateAsync();
    } finally {
      setIsRunningPoll(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* System Status */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-lg font-medium text-gray-900 mb-4">System Status</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-green-50 p-4 rounded-lg">
            <h3 className="text-sm font-medium text-green-800">API Status</h3>
            <p className="text-2xl font-semibold text-green-600">Online</p>
          </div>
          <div className="bg-blue-50 p-4 rounded-lg">
            <h3 className="text-sm font-medium text-blue-800">Snapshots</h3>
            <p className="text-2xl font-semibold text-blue-600">{stats?.totalSnapshots || 0}</p>
          </div>
          <div className="bg-purple-50 p-4 rounded-lg">
            <h3 className="text-sm font-medium text-purple-800">Candidates</h3>
            <p className="text-2xl font-semibold text-purple-600">{stats?.totalCandidates || 0}</p>
          </div>
          <div className="bg-yellow-50 p-4 rounded-lg">
            <h3 className="text-sm font-medium text-yellow-800">API Calls Today</h3>
            <p className="text-2xl font-semibold text-yellow-600">{stats?.apiCallsToday || 0}</p>
          </div>
        </div>
      </div>

      {/* Manual Operations */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Manual Operations</h2>
        <div className="flex space-x-4">
          <button
            onClick={handleDiscovery}
            disabled={isRunningDiscovery}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunningDiscovery ? 'Running Discovery...' : 'Run Discovery'}
          </button>
          <button
            onClick={handlePoll}
            disabled={isRunningPoll}
            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunningPoll ? 'Polling...' : 'Run Poll'}
          </button>
        </div>
      </div>

      {/* Sports Configuration */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Sports Configuration</h2>
        <div className="space-y-4">
          {stats?.sports.map((sport) => (
            <div key={sport.sport_key} className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <h3 className="font-medium text-gray-900">{sport.sport_title}</h3>
                <p className="text-sm text-gray-500">{sport.sport_key}</p>
              </div>
              <div className="flex items-center space-x-2">
                <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                  sport.enabled 
                    ? 'bg-green-100 text-green-800' 
                    : 'bg-red-100 text-red-800'
                }`}>
                  {sport.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* System Information */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-lg font-medium text-gray-900 mb-4">System Information</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-2">Last Operations</h3>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Last Discovery:</span>
                <span className="text-sm text-gray-900">
                  {stats?.lastDiscovery ? formatDateTime(stats.lastDiscovery) : 'Never'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Last Poll:</span>
                <span className="text-sm text-gray-900">
                  {stats?.lastPoll ? formatDateTime(stats.lastPoll) : 'Never'}
                </span>
              </div>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-2">Error Tracking</h3>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Errors Today:</span>
                <span className={`text-sm font-medium ${(stats?.errorsToday || 0) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {stats?.errorsToday || 0}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Success Rate:</span>
                <span className="text-sm text-gray-900">
                  {stats?.apiCallsToday ? 
                    `${(((stats.apiCallsToday - (stats.errorsToday || 0)) / stats.apiCallsToday) * 100).toFixed(1)}%` : 
                    '100%'
                  }
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Configuration */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-2">API Settings</h3>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Poll Interval:</span>
                <span className="text-sm text-gray-900">60 minutes</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Timezone:</span>
                <span className="text-sm text-gray-900">Europe/London</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Demo Mode:</span>
                <span className="text-sm text-gray-900">Enabled</span>
              </div>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-2">Alert Thresholds</h3>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">SOLID:</span>
                <span className="text-sm text-gray-900">≥ 2.0pp</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">SCOUT:</span>
                <span className="text-sm text-gray-900">≥ 5.0pp</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">EXCHANGE VALUE:</span>
                <span className="text-sm text-gray-900">≥ 3.0pp</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Recent Activity</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div>
              <p className="text-sm font-medium text-gray-900">Discovery completed</p>
              <p className="text-xs text-gray-500">Found 12 tennis events, 8 soccer events</p>
            </div>
            <span className="text-xs text-gray-500">2 minutes ago</span>
          </div>
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div>
              <p className="text-sm font-medium text-gray-900">Poll completed</p>
              <p className="text-xs text-gray-500">Collected 45 odds snapshots, generated 3 alerts</p>
            </div>
            <span className="text-xs text-gray-500">5 minutes ago</span>
          </div>
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div>
              <p className="text-sm font-medium text-gray-900">New SOLID alert</p>
              <p className="text-xs text-gray-500">Tennis: Djokovic vs Nadal - 2.5pp edge</p>
            </div>
            <span className="text-xs text-gray-500">8 minutes ago</span>
          </div>
        </div>
      </div>
    </div>
  );
}
