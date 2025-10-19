/**
 * Odds engine - main entry point for odds processing
 * Uses the new modular approach with prob.ts, consensus.ts, and alerts.ts
 */

import type { MarketData } from './alerts';

export interface OddsSnapshot {
  event_id: string;
  taken_at: string;
  market_key: string;
  bookmaker: string;
  is_exchange: boolean;
  selection: string;
  decimal_odds: number;
  point?: number; // Line value for totals markets (e.g., 2.5, 3.5, 4.5)
  raw: unknown;
}

// Re-export types and functions from the new modules for backward compatibility
export type { AlertCandidate, MarketData } from './alerts';
export { 
  decimalToProbability, 
  probabilityToDecimal, 
  applyExchangeCommission,
  devigTwoWay,
  devigThreeWay,
  isExchangeStable
} from './prob';
export { 
  trimmedMean, 
  median, 
  calculateSportsbookConsensus,
  calculateExchangeConsensus,
  calculateFairProbability
} from './consensus';
export { 
  generateAlertCandidates,
  calculateSportsbookEdgeAndEV
} from './alerts';


/**
 * Group odds snapshots into market data
 */
export function groupSnapshotsIntoMarkets(snapshots: OddsSnapshot[]): MarketData[] {
  const marketMap = new Map<string, MarketData>();
  
  for (const snapshot of snapshots) {
    // For totals markets, include the line value in the key to separate different lines
    let key: string;
    
    if (snapshot.market_key === 'totals') {
      // Use the actual line value from The Odds API point field
      const lineValue = snapshot.point !== undefined ? snapshot.point.toString() : 'unknown';
      key = `${snapshot.event_id}-${snapshot.market_key}-${lineValue}`;
    } else {
      key = `${snapshot.event_id}-${snapshot.market_key}`;
    }
    
    if (!marketMap.has(key)) {
      const marketKey = snapshot.market_key === 'totals' ? 
        `${snapshot.market_key} (line: ${snapshot.point !== undefined ? snapshot.point : 'unknown'})` : 
        snapshot.market_key;
        
      marketMap.set(key, {
        event_id: snapshot.event_id,
        market_key: marketKey,
        selections: {},
      });
    }
    
    const market = marketMap.get(key)!;
    
    if (!market.selections[snapshot.selection]) {
      market.selections[snapshot.selection] = {
        sportsbooks: [],
        exchanges: [],
      };
    }
    
    const selection = market.selections[snapshot.selection];
    
    if (snapshot.is_exchange) {
      selection.exchanges.push({
        bookmaker: snapshot.bookmaker,
        decimal_odds: snapshot.decimal_odds,
      });
    } else {
      selection.sportsbooks.push({
        bookmaker: snapshot.bookmaker,
        decimal_odds: snapshot.decimal_odds,
      });
    }
  }
  
  return Array.from(marketMap.values());
}

