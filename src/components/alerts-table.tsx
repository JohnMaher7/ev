'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatPercentage, getAlertTierColor, cn } from '@/lib/utils';
import { BetModal } from './bet-modal';

interface Candidate {
  id: string;
  created_at: string;
  event_id: string;
  sport_key: string;
  market_key: string;
  selection: string;
  alert_tier: 'SOLID' | 'SCOUT' | 'EXCHANGE_VALUE';
  best_source: string;
  offered_price: number;
  offered_prob: number;
  fair_price: number;
  fair_prob: number;
  edge_pp: number;
  books_count: number;
  exchanges_count: number;
  notes?: string;
  allBookmakerPrices?: Array<{
    bookmaker: string;
    price: number;
    isExchange: boolean;
  }>;
  events: {
    event_id: string;
    sport_key: string;
    commence_time: string;
    home: string;
    away: string;
  };
}

export function AlertsTable() {
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [filters, setFilters] = useState({
    minEdge: 0.001, // Lower threshold to show more alerts
    tier: '',
    marketType: '',
  });
  const [isClearing, setIsClearing] = useState(false);

  const queryClient = useQueryClient();

  const { data: candidates, isLoading, error } = useQuery({
    queryKey: ['candidates', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.minEdge > 0) {
        params.set('min_edge', filters.minEdge.toString());
      }
      if (filters.tier) {
        params.set('alert_tier', filters.tier);
      }

      const response = await fetch(`/api/candidates?${params}`);
      if (!response.ok) {
        throw new Error('Failed to fetch candidates');
      }
      const result = await response.json();
      return result.data as Candidate[];
    },
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  const handleClearAlert = async (alertId: string) => {
    try {
      const response = await fetch(`/api/candidates/${alertId}`, {
        method: 'DELETE',
      });
      
      if (response.ok) {
        // Remove the alert from the local state
        queryClient.setQueryData(['candidates', filters], (oldData: any) => {
          if (!oldData) return oldData;
          return oldData.filter((candidate: Candidate) => candidate.id !== alertId);
        });
      } else {
        console.error('Failed to clear alert');
      }
    } catch (error) {
      console.error('Error clearing alert:', error);
    }
  };

  const handleClearAllAlerts = async () => {
    if (!candidates || candidates.length === 0) return;
    
    setIsClearing(true);
    try {
      const response = await fetch('/api/candidates/clear-all', {
        method: 'DELETE',
      });
      
      if (response.ok) {
        // Clear all alerts from local state
        queryClient.setQueryData(['candidates', filters], []);
        queryClient.invalidateQueries({ queryKey: ['candidates'] });
      } else {
        console.error('Failed to clear all alerts');
      }
    } catch (error) {
      console.error('Error clearing all alerts:', error);
    } finally {
      setIsClearing(false);
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
        <p className="text-red-800">Error loading alerts: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Min Edge (pp)
            </label>
            <input
              type="number"
              step="0.01"
              value={filters.minEdge}
              onChange={(e) => setFilters(prev => ({ ...prev, minEdge: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Tier
            </label>
            <select
              value={filters.tier}
              onChange={(e) => setFilters(prev => ({ ...prev, tier: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All Tiers</option>
              <option value="SOLID">SOLID</option>
              <option value="SCOUT">SCOUT</option>
              <option value="EXCHANGE_VALUE">EXCHANGE VALUE</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Market Type
            </label>
            <select
              value={filters.marketType}
              onChange={(e) => setFilters(prev => ({ ...prev, marketType: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All Markets</option>
              <option value="h2h">H2H</option>
              <option value="totals">Totals</option>
            </select>
          </div>
        </div>
      </div>

      {/* Alerts Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
                 <div className="px-6 py-4 border-b border-gray-200">
           <div className="flex justify-between items-center">
             <h2 className="text-lg font-medium text-gray-900">
               Active Alerts ({candidates?.length || 0})
             </h2>
             {candidates && candidates.length > 0 && (
               <button
                 onClick={handleClearAllAlerts}
                 disabled={isClearing}
                 className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
               >
                 {isClearing ? 'Clearing...' : 'Clear All Alerts'}
               </button>
             )}
           </div>
         </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Event
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Market
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Selection
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tier
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Best Source
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Offered Price
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Fair Price
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Edge (pp)
                </th>
                                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    All Prices
                  </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Exchanges
                </th>
                                 <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                   Commence
                 </th>
                 <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                   Last Updated
                 </th>
                 <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                   Action
                 </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {candidates?.map((candidate) => (
                <tr key={candidate.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">
                      {candidate.events.home} vs {candidate.events.away}
                    </div>
                    <div className="text-sm text-gray-500">
                      {candidate.sport_key}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {candidate.market_key}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {candidate.selection}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={cn(
                      'inline-flex px-2 py-1 text-xs font-semibold rounded-full border',
                      getAlertTierColor(candidate.alert_tier)
                    )}>
                      {candidate.alert_tier}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {candidate.best_source}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {candidate.offered_price.toFixed(2)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {candidate.fair_price.toFixed(2)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    <span className={candidate.edge_pp > 0 ? 'text-green-600' : 'text-red-600'}>
                      {(candidate.edge_pp * 100).toFixed(2)}pp
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {candidate.allBookmakerPrices && candidate.allBookmakerPrices.length > 0 ? (
                      <div className="relative group">
                        <button className="text-blue-600 hover:text-blue-800 font-medium">
                          {candidate.books_count} books
                        </button>
                        <div className="absolute left-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-10">
                          <div className="p-3">
                            <div className="text-xs font-semibold text-gray-700 mb-2">All Bookmaker Prices</div>
                            <div className="space-y-1 max-h-32 overflow-y-auto">
                              {candidate.allBookmakerPrices.map((price, index) => (
                                <div key={index} className="flex justify-between items-center text-xs">
                                  <span className={`font-medium ${price.isExchange ? 'text-purple-600' : 'text-gray-600'}`}>
                                    {price.bookmaker}
                                  </span>
                                  <span className="font-mono text-gray-900">
                                    {price.price.toFixed(2)}
                                  </span>
                                  {price.isExchange && (
                                    <span className="text-purple-500 text-xs">EX</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <span className="text-gray-500">{candidate.books_count}</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {candidate.exchanges_count}
                  </td>
                                     <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                     {formatDateTime(candidate.events.commence_time)}
                   </td>
                   <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                     {formatDateTime(candidate.created_at)}
                   </td>
                   <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                     <div className="flex space-x-2">
                       <button
                         onClick={() => setSelectedCandidate(candidate)}
                         className="text-blue-600 hover:text-blue-900"
                       >
                         Bet
                       </button>
                       <button
                         onClick={() => handleClearAlert(candidate.id)}
                         className="text-red-600 hover:text-red-900 text-xs"
                       >
                         Clear
                       </button>
                     </div>
                   </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {candidates?.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500">No alerts found matching your criteria.</p>
          </div>
        )}
      </div>

      {/* Bet Modal */}
      {selectedCandidate && (
        <BetModal
          candidate={selectedCandidate}
          onClose={() => setSelectedCandidate(null)}
        />
      )}
    </div>
  );
}
