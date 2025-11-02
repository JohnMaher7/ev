/**
 * Alert generation and evaluation logic
 */

import { config } from './config';
import { 
  decimalToProbability, 
  applyExchangeCommission
} from './prob';
import { 
  calculateFairProbability,
  devigBookmakerMarket,
  trimmedMean,
  median
} from './consensus';
import { Logger } from './logger';
import { diagnoseAlertMiss, type AlertDiagnostic } from './alert-diagnostics';

export interface AlertCandidate {
  id?: string; // Optional for generation, required for database
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
}

export interface MarketSelection {
  sportsbooks: Array<{
    bookmaker: string;
    decimal_odds: number;
  }>;
  exchanges: Array<{
    bookmaker: string;
    decimal_odds: number;
  }>;
}

export interface MarketData {
  event_id: string;
  market_key: string;
  selections: Record<string, MarketSelection>;
}

/**
 * Determine whether there exists at least one exchange in the market whose
 * implied probabilities across outcomes sum to within the stability band.
 */
export function checkExchangeStability(marketData: MarketData): boolean {
  const selectionNames = Object.keys(marketData.selections);
  if (selectionNames.length < 2) return false;

  // Collect odds per exchange across selections
  const perExchangeOdds: Record<string, number[]> = {};
  for (const selection of selectionNames) {
    for (const ex of marketData.selections[selection].exchanges) {
      if (!perExchangeOdds[ex.bookmaker]) perExchangeOdds[ex.bookmaker] = [];
      perExchangeOdds[ex.bookmaker].push(ex.decimal_odds);
    }
  }

  const min = config.exchangeStabilityThreshold.min;
  const max = config.exchangeStabilityThreshold.max;
  for (const odds of Object.values(perExchangeOdds)) {
    const valid = odds.filter(o => o > 0);
    if (valid.length >= 2) {
      const sum = valid.map(decimalToProbability).reduce((a, b) => a + b, 0);
      if (sum >= min && sum <= max) return true;
    }
  }
  return false;
}

/**
 * Calculate edge and EV for sportsbook offers
 */
export function calculateSportsbookEdgeAndEV(
  fairProb: number,
  offeredPrice: number
): { edge_pp: number; ev: number } {
  const offeredProb = decimalToProbability(offeredPrice);
  const edge_pp = fairProb - offeredProb;
  const ev = fairProb * (offeredPrice - 1) - (1 - fairProb);
  
  return { edge_pp, ev };
}

/**
 * Calculate edge and EV for exchange offers (with commission)
 */
export function calculateExchangeEdgeAndEV(
  fairProb: number,
  offeredPrice: number,
  commission: number = config.exchangeCommissionDefault
): { edge_pp: number; ev: number } {
  const effectivePrice = applyExchangeCommission(offeredPrice, commission);
  const offeredProb = decimalToProbability(effectivePrice);
  const edge_pp = fairProb - offeredProb;
  const ev = fairProb * (effectivePrice - 1) - (1 - fairProb);
  
  return { edge_pp, ev };
}

/**
 * Check if market has stable exchanges
 */


/**
 * Generate alert candidates for a market
 * Returns both candidates and diagnostics for aggregation
 */
export function generateAlertCandidates(
  marketData: MarketData,
  sport_key: string
): { candidates: AlertCandidate[]; diagnostics: AlertDiagnostic[] } {
  const logger = new Logger('alerts');
  const candidates: AlertCandidate[] = [];
  const diagnostics: AlertDiagnostic[] = [];

  const solidThreshold = config.alertThresholds.solid;
  const scoutThreshold = config.alertThresholds.scout;
  const exchangeThreshold = config.alertThresholds.exchangeValue;
  const solidDisagreementThreshold = solidThreshold / 2;
  
  // Note: OddsAPI doesn't provide lay markets, so no need to skip them
  
  // Get all selections in this market
  const selections = Object.keys(marketData.selections);
  const selectionsArray = Object.values(marketData.selections);
  
  // Step 1: De-vig each bookmaker's market and store by outcome label
  const bookmakerProbsByOutcome = new Map<string, Map<string, number>>();
  const exchangeProbsByOutcome = new Map<string, Map<string, number>>();
  
  // Initialize outcome maps
  for (const selection of selections) {
    bookmakerProbsByOutcome.set(selection, new Map());
    exchangeProbsByOutcome.set(selection, new Map());
  }
  
  // Process each bookmaker's market
  for (const [bookmaker, odds] of Object.entries(
    selectionsArray.reduce((acc, selectionData, i) => {
      for (const sb of selectionData.sportsbooks) {
        if (!acc[sb.bookmaker]) acc[sb.bookmaker] = [];
        acc[sb.bookmaker][i] = sb.decimal_odds;
      }
      return acc;
    }, {} as Record<string, number[]>)
  )) {
    const validOdds = odds.filter(odd => odd > 0);
    if (validOdds.length >= 2) { // Need at least 2 outcomes for a market
      const deViggedProbs = devigBookmakerMarket(validOdds);
      let probIndex = 0;
      for (let i = 0; i < odds.length; i++) {
        if (odds[i] > 0) {
          bookmakerProbsByOutcome.get(selections[i])?.set(bookmaker, deViggedProbs[probIndex]);
          probIndex++;
        }
      }
    } else if (validOdds.length === 1 && selections.length === 1) {
      // Fallback: single-outcome data – approximate using implied prob 1/odds
      // This enables alert generation for tests/datasets that only provide one outcome
      const onlySelection = selections[0];
      const onlyOdd = validOdds[0];
      if (onlyOdd && onlyOdd > 0) {
        bookmakerProbsByOutcome.get(onlySelection)?.set(bookmaker, decimalToProbability(onlyOdd));
      }
    }
  }
  
  // Process each exchange's market
  for (const [exchange, odds] of Object.entries(
    selectionsArray.reduce((acc, selectionData, i) => {
      for (const ex of selectionData.exchanges) {
        if (!acc[ex.bookmaker]) acc[ex.bookmaker] = [];
        acc[ex.bookmaker][i] = ex.decimal_odds;
      }
      return acc;
    }, {} as Record<string, number[]>)
  )) {
    const validOdds = odds.filter(odd => odd > 0);
    if (validOdds.length >= 2) {
      const rawProbs = validOdds.map(decimalToProbability);
      const sum = rawProbs.reduce((a, b) => a + b, 0);
      
      // Check if exchange is stable
      if (sum >= 0.98 && sum <= 1.02) {
        const normalizedProbs = rawProbs.map(p => p / sum);
        let probIndex = 0;
        for (let i = 0; i < odds.length; i++) {
          if (odds[i] > 0) {
            exchangeProbsByOutcome.get(selections[i])?.set(exchange, normalizedProbs[probIndex]);
            probIndex++;
          }
        }
      }
    }
  }
  
  // Step 3: Global consensus (for logging only)
  const globalConsensus = new Map<string, { sb: number | null, ex: number | null, fair: number | null }>();
  
  for (const selection of selections) {
    // Global sportsbook consensus
    const sbProbs = Array.from(bookmakerProbsByOutcome.get(selection)?.values() || []);
    let sbConsensus: number | null = null;
    
    if (sbProbs.length >= 10) {
      sbConsensus = trimmedMean(sbProbs);
    } else if (sbProbs.length >= 3) {
      sbConsensus = median(sbProbs);
    }
    
    // Global exchange consensus
    const exProbs = Array.from(exchangeProbsByOutcome.get(selection)?.values() || []);
    let exConsensus: number | null = null;
    
    if (exProbs.length > 0) {
      exConsensus = exProbs.reduce((a, b) => a + b, 0) / exProbs.length;
    }
    
    // Global fair probability
    const fairGlobal = calculateFairProbability(sbConsensus, exConsensus);
    
    globalConsensus.set(selection, { sb: sbConsensus, ex: exConsensus, fair: fairGlobal });
    
    logger.debug(() => `Selection ${selection}: Global SB=${sbConsensus}, EX=${exConsensus}, Fair=${fairGlobal}`);
  }
  
  // Step 4: Choose best offers only
  const bestOffers = new Map<string, { source: string, price: number, isExchange: boolean }>();
  
  for (const selection of selections) {
    const selectionData = marketData.selections[selection];
    
    // Find best sportsbook offer
    let bestSB = { source: '', price: 0, isExchange: false };
    for (const sb of selectionData.sportsbooks) {
      if (sb.decimal_odds > bestSB.price) {
        bestSB = { source: sb.bookmaker, price: sb.decimal_odds, isExchange: false };
      }
    }
    
    // Find best exchange offer
    let bestEX = { source: '', price: 0, isExchange: true };
    for (const ex of selectionData.exchanges) {
      if (ex.decimal_odds > bestEX.price) {
        bestEX = { source: ex.bookmaker, price: ex.decimal_odds, isExchange: true };
      }
    }
    
    // Store best offers
    if (bestSB.price > 0) {
      bestOffers.set(`${selection}_sb`, bestSB);
    }
    if (bestEX.price > 0) {
      bestOffers.set(`${selection}_ex`, bestEX);
    }
  }
  
  // Step 5: Evaluate best offers with leave-one-out
  for (const [offerKey, offer] of bestOffers) {
    const [selection] = offerKey.split('_');
    const selectionData = marketData.selections[selection];
    const booksCount = selectionData.sportsbooks.length;
    const exchangesCount = selectionData.exchanges.length;
    
    // Step 5: Build decision fair (leave-one-out for sportsbooks)
    let decisionFair: number | null = null;
    
    if (offer.isExchange) {
      // For exchanges: use global books-only consensus
      const global = globalConsensus.get(selection);
      decisionFair = global?.sb || null;
    } else {
      // For sportsbooks: leave-one-out consensus
      const sbProbs = Array.from(bookmakerProbsByOutcome.get(selection)?.entries() || [])
        .filter(([bookmaker]) => bookmaker !== offer.source)
        .map(([, prob]) => prob);
      
      if (sbProbs.length >= 10) {
        decisionFair = trimmedMean(sbProbs);
      } else if (sbProbs.length >= 3) {
        decisionFair = median(sbProbs);
      } else if (sbProbs.length === 2) {
        // Fallback: mean of two
        decisionFair = (sbProbs[0] + sbProbs[1]) / 2;
      } else if (sbProbs.length === 1) {
        decisionFair = sbProbs[0];
      }
    }
    
    // Blend with exchange consensus if available
    const global = globalConsensus.get(selection);
    if (global?.ex && decisionFair) {
      decisionFair = (decisionFair + global.ex) / 2;
    } else if (global?.ex && !decisionFair) {
      decisionFair = global.ex;
    }
    
    if (!decisionFair) {
      logger.debug(() => `No decision fair for ${offer.source} @ ${selection}, skipping`);
      continue;
    }
    
    const hasStableExchanges = global?.ex !== null;
    
    // Step 6: Compute value for this offer
    const impliedChanceFromOfferedOdds = 1 / offer.price; // vigged
    const expectedValuePerPound = decisionFair * (offer.price - 1) - (1 - decisionFair); // payout uses odds
    const oddsEdge = decisionFair - impliedChanceFromOfferedOdds;
    
    // Get bookmaker true probability
    let bookmakerTrueProbability: number | null = null;
    if (offer.isExchange) {
      const stableExchangeProb = exchangeProbsByOutcome.get(selection)?.get(offer.source) || null;
      if (stableExchangeProb !== null) {
        bookmakerTrueProbability = stableExchangeProb;
      } else {
        const effectiveExchangePrice = applyExchangeCommission(
          offer.price,
          config.exchangeCommissionDefault
        );
        bookmakerTrueProbability = decimalToProbability(effectiveExchangePrice);
      }
    } else {
      bookmakerTrueProbability = bookmakerProbsByOutcome
        .get(selection)?.get(offer.source) || null;
    }
    
    if (!bookmakerTrueProbability) {
      logger.debug(() => `No bookmaker true prob for ${offer.source} @ ${selection}, skipping`);
      continue;
    }
    
    // Optional tiny guard
    const bookDisagreement = decisionFair - bookmakerTrueProbability;
    
    // Debug logging with lazy evaluation
    logger.debug(() => [
      `offer=${offer.source}@${offer.price}`,
      `fair(LOO)=${decisionFair.toFixed(6)}  fair(global)=${global?.fair?.toFixed(6) || 'null'}`,
      `1/odds=${impliedChanceFromOfferedOdds.toFixed(6)}  bookTrue=${bookmakerTrueProbability.toFixed(6)}`,
      `oddsEdge=${(oddsEdge * 100).toFixed(3)}%  EV=${expectedValuePerPound.toFixed(6)}  bookDisagree=${(bookDisagreement * 100).toFixed(3)}%`
    ].join('\n  '));
    
    // Step 7: When to fire an alert
    let alert_tier: 'SOLID' | 'SCOUT' | 'EXCHANGE_VALUE' | null = null;
    let notes: string | undefined;
    
    // SOLID: (books ≥ 3) OR (books = 2 AND ≥1 stable exchange) and (EV ≥ 0 OR odds_edge ≥ 0.002) and bookDisagreement ≥ 0.0005
    const solidEligible = (booksCount >= 3) || (booksCount === 2 && hasStableExchanges);
    const passesEV = expectedValuePerPound >= 0;
    const passesOddsEdge = oddsEdge >= solidThreshold;
    const passesDisagreement = bookDisagreement >= solidDisagreementThreshold;
    
    const willCreateSolid = solidEligible && passesEV && passesOddsEdge && passesDisagreement;
    
    if (willCreateSolid) {
      alert_tier = 'SOLID';
    }
    // SCOUT: (books ≥ 2) and odds_edge ≥ 0.03 and EV ≥ 0
    else if (booksCount >= 2 && oddsEdge >= scoutThreshold && expectedValuePerPound >= 0) {
      alert_tier = 'SCOUT';
    }
    // EXCHANGE_VALUE: (books ≥ 3 AND ≥1 stable exchange) and SB advantage ≥ 0.03 and EV ≥ 0
    else if (offer.isExchange && booksCount >= 3 && global?.sb) {
      const exchangePriceAfterCommission = applyExchangeCommission(
        offer.price,
        config.exchangeCommissionDefault
      );
      const exchangeProbFromOffer = decimalToProbability(exchangePriceAfterCommission);
      const sbConsensusAdvantage = global.sb - exchangeProbFromOffer;

      if (sbConsensusAdvantage >= exchangeThreshold && expectedValuePerPound >= 0) {
        alert_tier = 'EXCHANGE_VALUE';
        notes = `SB consensus advantage vs exchange: ${(sbConsensusAdvantage * 100).toFixed(2)}pp`;
      }
    }
    
    // Diagnostics for non-alerts
    if (!alert_tier) {
      const diagnostic = diagnoseAlertMiss(
        selection,
        offer.source,
        offer.price,
        decisionFair,
        bookmakerTrueProbability,
        booksCount,
        hasStableExchanges,
        solidEligible && oddsEdge >= 0 ? 'SOLID' : 'SCOUT'
      );
      diagnostics.push(diagnostic);
      
      // Log near misses
      if (diagnostic.nearMiss) {
        logger.nearMiss(
          selection,
          oddsEdge,
          solidEligible ? solidThreshold : scoutThreshold,
          diagnostic.thresholdMissReason
        );
      }
    }
    
    if (alert_tier) {
      // Log the alert
      const candidate: AlertCandidate = {
        event_id: marketData.event_id,
        sport_key,
        market_key: marketData.market_key,
        selection,
        alert_tier,
        best_source: offer.source,
        offered_price: offer.price,
        offered_prob: impliedChanceFromOfferedOdds,
        fair_price: 1 / decisionFair,
        fair_prob: decisionFair,
        edge_pp: oddsEdge,
        books_count: booksCount,
        exchanges_count: exchangesCount,
        notes,
      };
      
      logger.alert(alert_tier, candidate);
      candidates.push(candidate);
    }
  }
  
  // Return both candidates and diagnostics for aggregation
  return { candidates, diagnostics };
}