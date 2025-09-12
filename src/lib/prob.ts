/**
 * Probability calculation and normalization utilities
 */

import { config } from './config';

/**
 * Convert decimal odds to probability
 */
export function decimalToProbability(decimal: number): number {
  return 1 / decimal;
}

/**
 * Convert probability to decimal odds
 */
export function probabilityToDecimal(probability: number): number {
  return 1 / probability;
}

/**
 * Apply exchange commission to decimal odds
 */
export function applyExchangeCommission(
  decimal: number, 
  commission: number = config.exchangeCommissionDefault
): number {
  return 1 + (decimal - 1) * (1 - commission);
}

/**
 * De-vig probabilities for 2-way market
 */
export function devigTwoWay(prob1: number, prob2: number): [number, number] {
  const total = prob1 + prob2;
  return [prob1 / total, prob2 / total];
}

/**
 * De-vig probabilities for 3-way market
 */
export function devigThreeWay(prob1: number, probX: number, prob2: number): [number, number, number] {
  const total = prob1 + probX + prob2;
  return [prob1 / total, probX / total, prob2 / total];
}

/**
 * Normalize probabilities to sum to 1.0
 */
export function normalizeProbabilities(probabilities: number[]): number[] {
  const sum = probabilities.reduce((a, b) => a + b, 0);
  return probabilities.map(p => p / sum);
}

/**
 * Check if probabilities sum to approximately 1.0 (within tolerance)
 */
export function isNormalized(probabilities: number[], tolerance: number = 1e-6): boolean {
  const sum = probabilities.reduce((a, b) => a + b, 0);
  return Math.abs(sum - 1.0) <= tolerance;
}

/**
 * De-vig bookmaker odds for a market
 * Returns normalized probabilities that sum to 1.0
 */
export function devigBookmakerOdds(odds: number[]): number[] {
  const rawProbs = odds.map(decimalToProbability);
  return normalizeProbabilities(rawProbs);
}

/**
 * Check if exchange is stable (sum of implied probabilities within 98-102%)
 */
export function isExchangeStable(exchangeProbs: number[]): boolean {
  const sum = exchangeProbs.reduce((a, b) => a + b, 0);
  return sum >= config.exchangeStabilityThreshold.min && 
         sum <= config.exchangeStabilityThreshold.max;
}

/**
 * Normalize exchange probabilities to sum to 1.0
 * Only call this if exchange is stable
 */
export function normalizeExchangeProbs(exchangeProbs: number[]): number[] {
  return normalizeProbabilities(exchangeProbs);
}
