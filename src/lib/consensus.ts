/**
 * Consensus calculation utilities - Correct implementation per specification
 */

import { decimalToProbability } from './prob';

/**
 * Calculate trimmed mean (drop top/bottom 10%)
 */
export function trimmedMean(values: number[]): number {
  if (values.length < 5) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  
  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(values.length * 0.1);
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

/**
 * Calculate median
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  
  return sorted[mid];
}

/**
 * Step 1: De-vig a single bookmaker's market
 * Convert odds → raw probabilities → normalize to sum to 1.00
 */
export function devigBookmakerMarket(bookmakerOdds: number[]): number[] {
  // Convert each outcome: p_raw = 1 / odds
  const rawProbs = bookmakerOdds.map(decimalToProbability);
  
  // Sum across outcomes: S = sum(p_raw)
  const sum = rawProbs.reduce((a, b) => a + b, 0);
  
  // Normalize: p_book = p_raw / S for each outcome
  return rawProbs.map(p => p / sum);
}

/**
 * Step 2: Build sportsbook consensus for a specific selection
 * Each bookmaker's market is de-vigged individually, then we take consensus of that selection
 */
export function calculateSportsbookConsensus(
  bookmakerOddsByBook: Array<{ bookmaker: string; odds: number[] }>,
  selectionIndex: number
): number | null {
  const booksCount = bookmakerOddsByBook.length;
  console.log(`    🔍 SB Consensus: ${booksCount} books, selectionIndex ${selectionIndex}`);
  
  if (booksCount < 3) {
    console.log(`    ❌ SB Consensus: Not enough books (${booksCount} < 3)`);
    return null; // No consensus with < 3 books
  }
  
  // De-vig each bookmaker's market individually
  const selectionProbs: number[] = [];
  
  for (const { bookmaker, odds } of bookmakerOddsByBook) {
    console.log(`    🔍 Book ${bookmaker}: odds = [${odds.join(', ')}]`);
    // Only process if this bookmaker has odds for this selection
    if (selectionIndex < odds.length && odds[selectionIndex] > 0) {
      const validOdds = odds.filter(odd => odd > 0);
      console.log(`    🔍 Book ${bookmaker}: valid odds = [${validOdds.join(', ')}]`);
      const deViggedProbs = devigBookmakerMarket(validOdds);
      console.log(`    🔍 Book ${bookmaker}: de-vigged probs = [${deViggedProbs.join(', ')}]`);
      if (selectionIndex < deViggedProbs.length) {
        selectionProbs.push(deViggedProbs[selectionIndex]);
        console.log(`    ✅ Book ${bookmaker}: added prob ${deViggedProbs[selectionIndex]} for selection ${selectionIndex}`);
      }
    } else {
      console.log(`    ❌ Book ${bookmaker}: no odds for selection ${selectionIndex}`);
    }
  }
  
  console.log(`    🔍 Final selection probs: [${selectionProbs.join(', ')}]`);
  
  if (selectionProbs.length < 3) {
    console.log(`    ❌ SB Consensus: Not enough valid probs (${selectionProbs.length} < 3)`);
    return null;
  }
  
  // Apply consensus method per specification
  if (selectionProbs.length >= 5) {
    return trimmedMean(selectionProbs); // Drop top & bottom 10%
  } else if (selectionProbs.length >= 3) {
    return median(selectionProbs);
  }
  
  return null;
}

/**
 * Calculate exchange consensus for a specific selection
 * Each exchange's market is checked for stability and normalized individually
 */
export function calculateExchangeConsensus(
  exchangeOddsByExchange: Array<{ exchange: string; odds: number[] }>,
  selectionIndex: number
): number | null {
  const stableExchanges: number[] = [];
  
  for (const { odds } of exchangeOddsByExchange) {
    if (selectionIndex < odds.length && odds[selectionIndex] > 0) {
      // Convert each outcome: p_raw = 1 / odds
      const rawProbs = odds.map(decimalToProbability);
      
      // Sum across outcomes: S_ex = sum(p_raw)
      const sum = rawProbs.reduce((a, b) => a + b, 0);
      
      // If 0.98 ≤ S_ex ≤ 1.02, mark stable and normalize: p_ex = p_raw / S_ex
      if (sum >= 0.98 && sum <= 1.02) {
        const normalizedProbs = rawProbs.map(p => p / sum);
        stableExchanges.push(normalizedProbs[selectionIndex]);
      }
    }
  }
  
  if (stableExchanges.length === 0) {
    return null; // No stable exchanges
  }
  
  // Average across all stable exchanges
  return stableExchanges.reduce((a, b) => a + b, 0) / stableExchanges.length;
}

/**
 * Step 4: Final fair probability
 * If both p_sb_consensus and p_ex_consensus exist: p_fair = mean(p_sb_consensus, p_ex_consensus)
 * If only one exists: use it.
 */
export function calculateFairProbability(
  sportsbookConsensus: number | null,
  exchangeConsensus: number | null
): number | null {
  const values: number[] = [];
  
  if (sportsbookConsensus !== null) {
    values.push(sportsbookConsensus);
  }
  
  if (exchangeConsensus !== null) {
    values.push(exchangeConsensus);
  }
  
  if (values.length === 0) {
    return null;
  }
  
  if (values.length === 1) {
    return values[0];
  }
  
  // Average of sportsbook consensus and exchange consensus
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Step 5: Edge & EV calculations
 */

/**
 * Calculate edge for any offered odds
 * edge_pp = p_fair - p_offer
 */
export function calculateEdge(pFair: number, offeredOdds: number): number {
  const pOffer = decimalToProbability(offeredOdds);
  return pFair - pOffer;
}

/**
 * Calculate sportsbook EV
 * EV = p_fair * (d_offer - 1) - (1 - p_fair)
 */
export function calculateSportsbookEV(pFair: number, offeredOdds: number): number {
  return pFair * (offeredOdds - 1) - (1 - pFair);
}

/**
 * Calculate exchange EV with commission
 * d_eff = 1 + (d_ex - 1) * (1 - commission)
 * EV_ex = p_fair * (d_eff - 1) - (1 - p_fair)
 */
export function calculateExchangeEV(pFair: number, offeredOdds: number, commission: number): number {
  const dEff = 1 + (offeredOdds - 1) * (1 - commission);
  return pFair * (dEff - 1) - (1 - pFair);
}