'use client';

import { useState } from 'react';
import { formatPercentage, formatCurrency } from '@/lib/utils';

interface Candidate {
  id: string;
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
  events: {
    event_id: string;
    sport_key: string;
    commence_time: string;
    home: string;
    away: string;
  };
}

interface BetModalProps {
  candidate: Candidate;
  onClose: () => void;
}

export function BetModal({ candidate, onClose }: BetModalProps) {
  const [stake, setStake] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/bets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_id: candidate.event_id,
          sport_key: candidate.sport_key,
          market_key: candidate.market_key,
          selection: candidate.selection,
          source: candidate.best_source,
          odds: candidate.offered_price,
          stake: parseFloat(stake),
          accepted_fair_prob: candidate.fair_prob,
          accepted_fair_price: candidate.fair_price,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to place bet');
      }

      onClose();
    } catch (error) {
      console.error('Error placing bet:', error);
      alert('Failed to place bet. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const calculateKellyStake = (bankroll: number = 1000) => {
    const edge = candidate.edge_pp;
    const odds = candidate.offered_price;
    const kellyFraction = 0.25; // 25% Kelly
    const bankCap = 0.02; // 2% bank cap
    
    const kellyStake = (edge * odds - (1 - candidate.fair_prob)) / (odds - 1) * bankroll * kellyFraction;
    const cappedStake = Math.min(kellyStake, bankroll * bankCap);
    
    return Math.max(0, cappedStake);
  };

  const kellyStake = calculateKellyStake();

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
        <div className="mt-3">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">
              Place Bet
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <span className="sr-only">Close</span>
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Bet Details */}
          <div className="mb-6 space-y-3">
            <div>
              <span className="text-sm font-medium text-gray-500">Event:</span>
              <p className="text-sm text-gray-900">
                {candidate.events.home} vs {candidate.events.away}
              </p>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-500">Selection:</span>
              <p className="text-sm text-gray-900">{candidate.selection}</p>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-500">Source:</span>
              <p className="text-sm text-gray-900">{candidate.best_source}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-sm font-medium text-gray-500">Offered Price:</span>
                <p className="text-sm text-gray-900">{candidate.offered_price.toFixed(2)}</p>
              </div>
              <div>
                <span className="text-sm font-medium text-gray-500">Fair Price:</span>
                <p className="text-sm text-gray-900">{candidate.fair_price.toFixed(2)}</p>
              </div>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-500">Edge:</span>
              <p className="text-sm text-gray-900">
                {(candidate.edge_pp * 100).toFixed(2)}pp
              </p>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-500">Tier:</span>
              <p className="text-sm text-gray-900">{candidate.alert_tier}</p>
            </div>
          </div>

          {/* Bet Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Stake (£)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
              {kellyStake > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  Suggested Kelly stake: {formatCurrency(kellyStake)}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes (optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Add any notes about this bet..."
              />
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !stake}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? 'Placing...' : 'Place Bet'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
