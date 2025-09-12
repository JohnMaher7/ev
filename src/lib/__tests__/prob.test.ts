/**
 * Unit tests for probability calculations
 */

import {
  decimalToProbability,
  probabilityToDecimal,
  applyExchangeCommission,
  devigTwoWay,
  devigThreeWay,
  normalizeProbabilities,
  isNormalized,
  devigBookmakerOdds,
  isExchangeStable,
  normalizeExchangeProbs
} from '../prob';

describe('Probability Calculations', () => {
  describe('decimalToProbability', () => {
    it('should convert decimal odds to probability', () => {
      expect(decimalToProbability(2.0)).toBe(0.5);
      expect(decimalToProbability(3.0)).toBeCloseTo(0.3333, 4);
      expect(decimalToProbability(1.5)).toBeCloseTo(0.6667, 4);
    });
  });

  describe('probabilityToDecimal', () => {
    it('should convert probability to decimal odds', () => {
      expect(probabilityToDecimal(0.5)).toBe(2.0);
      expect(probabilityToDecimal(0.3333)).toBeCloseTo(3.0, 1);
      expect(probabilityToDecimal(0.6667)).toBeCloseTo(1.5, 1);
    });
  });

  describe('applyExchangeCommission', () => {
    it('should apply commission to exchange odds', () => {
      expect(applyExchangeCommission(2.0, 0.02)).toBe(1.98);
      expect(applyExchangeCommission(3.0, 0.05)).toBe(2.9);
      expect(applyExchangeCommission(1.5, 0.0)).toBe(1.5);
    });
  });

  describe('devigTwoWay', () => {
    it('should de-vig 2-way probabilities', () => {
      const [prob1, prob2] = devigTwoWay(0.6, 0.5);
      expect(prob1 + prob2).toBeCloseTo(1.0, 6);
      expect(prob1).toBeCloseTo(0.5455, 4);
      expect(prob2).toBeCloseTo(0.4545, 4);
    });
  });

  describe('devigThreeWay', () => {
    it('should de-vig 3-way probabilities', () => {
      const [prob1, probX, prob2] = devigThreeWay(0.4, 0.3, 0.4);
      expect(prob1 + probX + prob2).toBeCloseTo(1.0, 6);
      expect(prob1).toBeCloseTo(0.3636, 4);
      expect(probX).toBeCloseTo(0.2727, 4);
      expect(prob2).toBeCloseTo(0.3636, 4);
    });
  });

  describe('normalizeProbabilities', () => {
    it('should normalize probabilities to sum to 1.0', () => {
      const probs = [0.6, 0.5, 0.4];
      const normalized = normalizeProbabilities(probs);
      expect(normalized.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 6);
      expect(normalized[0]).toBeCloseTo(0.4, 4);
      expect(normalized[1]).toBeCloseTo(0.3333, 4);
      expect(normalized[2]).toBeCloseTo(0.2667, 4);
    });
  });

  describe('isNormalized', () => {
    it('should check if probabilities sum to 1.0', () => {
      expect(isNormalized([0.5, 0.5])).toBe(true);
      expect(isNormalized([0.4, 0.3, 0.3])).toBe(true);
      expect(isNormalized([0.6, 0.5])).toBe(false);
      expect(isNormalized([0.5, 0.5, 0.1])).toBe(false);
    });
  });

  describe('devigBookmakerOdds', () => {
    it('should de-vig bookmaker odds and normalize', () => {
      const odds = [2.0, 2.1, 1.9];
      const deVigged = devigBookmakerOdds(odds);
      expect(deVigged.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 6);
      expect(deVigged.length).toBe(3);
    });
  });

  describe('isExchangeStable', () => {
    it('should identify stable exchanges', () => {
      expect(isExchangeStable([0.5, 0.5])).toBe(true);
      expect(isExchangeStable([0.33, 0.33, 0.34])).toBe(true);
      expect(isExchangeStable([0.4, 0.3, 0.2])).toBe(false);
      expect(isExchangeStable([0.6, 0.5])).toBe(false);
    });
  });

  describe('normalizeExchangeProbs', () => {
    it('should normalize exchange probabilities', () => {
      const probs = [0.6, 0.5];
      const normalized = normalizeExchangeProbs(probs);
      expect(normalized.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 6);
      expect(normalized[0]).toBeCloseTo(0.5455, 4);
      expect(normalized[1]).toBeCloseTo(0.4545, 4);
    });
  });
});
