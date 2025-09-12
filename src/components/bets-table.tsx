'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatCurrency, getStatusColor, cn } from '@/lib/utils';

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
  status: 'pending' | 'won' | 'lost' | 'void';
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

export function BetsTable() {
  const [statusFilter, setStatusFilter] = useState('');
  const queryClient = useQueryClient();

  const { data: bets, isLoading, error } = useQuery({
    queryKey: ['bets', statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter) {
        params.set('status', statusFilter);
      }

      const response = await fetch(`/api/bets?${params}`);
      if (!response.ok) {
        throw new Error('Failed to fetch bets');
      }
      const result = await response.json();
      return result.data as Bet[];
    },
  });

  const settleBetMutation = useMutation({
    mutationFn: async ({ betId, status, returns, pnl }: { betId: string; status: string; returns?: number; pnl?: number }) => {
      const response = await fetch(`/api/bets/${betId}/settle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status, returns, pnl }),
      });

      if (!response.ok) {
        throw new Error('Failed to settle bet');
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bets'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
    },
  });

  const handleSettleBet = (bet: Bet, status: 'won' | 'lost' | 'void') => {
    if (status === 'won') {
      const returns = bet.stake * bet.odds;
      const pnl = returns - bet.stake;
      settleBetMutation.mutate({ betId: bet.id, status, returns, pnl });
    } else if (status === 'lost') {
      settleBetMutation.mutate({ betId: bet.id, status });
    } else {
      settleBetMutation.mutate({ betId: bet.id, status });
    }
  };

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
        <p className="text-red-800">Error loading bets: {error.message}</p>
      </div>
    );
  }

  const totalStaked = bets?.reduce((sum, bet) => sum + bet.stake, 0) || 0;
  const totalPnl = bets?.reduce((sum, bet) => sum + (bet.pnl || 0), 0) || 0;
  const pendingBets = bets?.filter(bet => bet.status === 'pending').length || 0;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Total Staked</h3>
          <p className="text-2xl font-semibold text-gray-900">{formatCurrency(totalStaked)}</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Total P&L</h3>
          <p className={cn(
            "text-2xl font-semibold",
            totalPnl >= 0 ? "text-green-600" : "text-red-600"
          )}>
            {formatCurrency(totalPnl)}
          </p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Total Bets</h3>
          <p className="text-2xl font-semibold text-gray-900">{bets?.length || 0}</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <h3 className="text-sm font-medium text-gray-500">Pending</h3>
          <p className="text-2xl font-semibold text-gray-900">{pendingBets}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow">
        <div className="flex items-center space-x-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="void">Void</option>
            </select>
          </div>
        </div>
      </div>

      {/* Bets Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-medium text-gray-900">
            Bet History ({bets?.length || 0})
          </h2>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Event
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Selection
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Source
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Odds
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Stake
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Returns
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  P&L
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Placed
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {bets?.map((bet) => (
                <tr key={bet.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">
                      {bet.events.home} vs {bet.events.away}
                    </div>
                    <div className="text-sm text-gray-500">
                      {bet.sport_key}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {bet.selection}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {bet.source}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {bet.odds.toFixed(2)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {formatCurrency(bet.stake)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={cn(
                      'inline-flex px-2 py-1 text-xs font-semibold rounded-full',
                      getStatusColor(bet.status)
                    )}>
                      {bet.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {bet.returns ? formatCurrency(bet.returns) : '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    {bet.pnl !== null ? (
                      <span className={bet.pnl >= 0 ? 'text-green-600' : 'text-red-600'}>
                        {formatCurrency(bet.pnl)}
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {formatDateTime(bet.created_at)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    {bet.status === 'pending' && (
                      <div className="flex space-x-2">
                        <button
                          onClick={() => handleSettleBet(bet, 'won')}
                          className="text-green-600 hover:text-green-900"
                        >
                          Win
                        </button>
                        <button
                          onClick={() => handleSettleBet(bet, 'lost')}
                          className="text-red-600 hover:text-red-900"
                        >
                          Loss
                        </button>
                        <button
                          onClick={() => handleSettleBet(bet, 'void')}
                          className="text-gray-600 hover:text-gray-900"
                        >
                          Void
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {bets?.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500">No bets found.</p>
          </div>
        )}
      </div>
    </div>
  );
}
