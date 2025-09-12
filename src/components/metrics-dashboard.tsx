'use client';

import { useQuery } from '@tanstack/react-query';
import { formatCurrency, formatPercentage, formatBasisPoints } from '@/lib/utils';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';

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

export function MetricsDashboard() {
  const { data: metrics, isLoading, error } = useQuery({
    queryKey: ['metrics'],
    queryFn: async () => {
      const response = await fetch('/api/metrics');
      if (!response.ok) {
        throw new Error('Failed to fetch metrics');
      }
      const result = await response.json();
      return result.data as MetricsData;
    },
    refetchInterval: 60000, // Refetch every minute
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4">
        <p className="text-red-800">Error loading metrics: {error.message}</p>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">No metrics data available.</p>
      </div>
    );
  }

  const { summary, dailyMetrics } = metrics;

  // Prepare chart data
  const chartData = dailyMetrics.map(day => ({
    date: new Date(day.date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }),
    pnl: day.pnl,
    expectedValue: day.expected_value,
    actualMargin: day.actual_margin * 100,
    expectedMargin: day.expected_margin * 100,
    staked: day.staked,
    bets: day.num_bets,
  }));

  const tierData = [
    { tier: 'SOLID', count: dailyMetrics.reduce((sum, day) => sum + day.num_bets_solid, 0) },
    { tier: 'SCOUT', count: dailyMetrics.reduce((sum, day) => sum + day.num_bets_scout, 0) },
    { tier: 'EXCHANGE', count: dailyMetrics.reduce((sum, day) => sum + day.num_bets_exchange, 0) },
  ];

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Total Staked</h3>
          <p className="text-2xl font-semibold text-gray-900">{formatCurrency(summary.totalStaked)}</p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Total P&L</h3>
          <p className={`text-2xl font-semibold ${summary.totalPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatCurrency(summary.totalPnl)}
          </p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Win Rate</h3>
          <p className="text-2xl font-semibold text-gray-900">{formatPercentage(summary.winRate / 100)}</p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Actual Margin</h3>
          <p className={`text-2xl font-semibold ${summary.actualMargin >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatPercentage(summary.actualMargin / 100)}
          </p>
        </div>
      </div>

      {/* Performance Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Expected Value</h3>
          <p className={`text-2xl font-semibold ${summary.expectedValue >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatCurrency(summary.expectedValue)}
          </p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Expected Margin</h3>
          <p className={`text-2xl font-semibold ${summary.expectedMargin >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatPercentage(summary.expectedMargin / 100)}
          </p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">CLV (bps)</h3>
          <p className={`text-2xl font-semibold ${summary.clvBps >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatBasisPoints(summary.clvBps / 10000)}
          </p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Pending Bets</h3>
          <p className="text-2xl font-semibold text-gray-900">{summary.pendingBets}</p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* P&L Chart */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Daily P&L vs Expected Value</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip 
                formatter={(value: number, name: string) => [
                  formatCurrency(value), 
                  name === 'pnl' ? 'Actual P&L' : 'Expected Value'
                ]}
              />
              <Line 
                type="monotone" 
                dataKey="pnl" 
                stroke="#ef4444" 
                strokeWidth={2}
                name="Actual P&L"
              />
              <Line 
                type="monotone" 
                dataKey="expectedValue" 
                stroke="#10b981" 
                strokeWidth={2}
                name="Expected Value"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Margin Chart */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Daily Margins</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip 
                formatter={(value: number, name: string) => [
                  `${value.toFixed(2)}%`, 
                  name === 'actualMargin' ? 'Actual Margin' : 'Expected Margin'
                ]}
              />
              <Line 
                type="monotone" 
                dataKey="actualMargin" 
                stroke="#ef4444" 
                strokeWidth={2}
                name="Actual Margin"
              />
              <Line 
                type="monotone" 
                dataKey="expectedMargin" 
                stroke="#10b981" 
                strokeWidth={2}
                name="Expected Margin"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Staked Amount Chart */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Daily Staked Amount</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip 
                formatter={(value: number) => [formatCurrency(value), 'Staked']}
              />
              <Bar dataKey="staked" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Bet Count by Tier */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Bets by Tier</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={tierData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="tier" />
              <YAxis />
              <Tooltip 
                formatter={(value: number) => [value, 'Bets']}
              />
              <Bar dataKey="count" fill="#8b5cf6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Performance Summary */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Performance Summary</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <h4 className="text-sm font-medium text-gray-500 mb-2">ROI Analysis</h4>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Actual ROI:</span>
                <span className={`text-sm font-medium ${summary.actualMargin >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatPercentage(summary.actualMargin / 100)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Expected ROI:</span>
                <span className={`text-sm font-medium ${summary.expectedMargin >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatPercentage(summary.expectedMargin / 100)}
                </span>
              </div>
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium text-gray-500 mb-2">Betting Activity</h4>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Total Bets:</span>
                <span className="text-sm font-medium">{summary.totalBets}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Win Rate:</span>
                <span className="text-sm font-medium">{formatPercentage(summary.winRate / 100)}</span>
              </div>
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium text-gray-500 mb-2">Value Tracking</h4>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">CLV:</span>
                <span className={`text-sm font-medium ${summary.clvBps >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatBasisPoints(summary.clvBps / 10000)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Pending:</span>
                <span className="text-sm font-medium">{summary.pendingBets}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
