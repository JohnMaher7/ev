/**
 * Unit tests for consensus calculations
 */

import {
  trimmedMean,
  median,
  calculateSportsbookConsensus,
  calculateExchangeConsensus,
  calculateFairProbability
} from '../consensus';

describe('Consensus Calculations', () => {
  describe('trimmedMean', () => {
    it('should calculate trimmed mean for 5+ values', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      expect(trimmedMean(values)).toBe(5.5);
    });

    it('should calculate regular mean for <5 values', () => {
      const values = [1, 2, 3, 4];
      expect(trimmedMean(values)).toBe(2.5);
    });

    it('should handle edge cases', () => {
      expect(trimmedMean([1])).toBe(1);
      expect(trimmedMean([1, 2])).toBe(1.5);
    });
  });

  describe('median', () => {
    it('should calculate median for odd number of values', () => {
      const values = [1, 2, 3, 4, 5];
      expect(median(values)).toBe(3);
    });

    it('should calculate median for even number of values', () => {
      const values = [1, 2, 3, 4];
      expect(median(values)).toBe(2.5);
    });

    it('should handle single value', () => {
      expect(median([5])).toBe(5);
    });
  });

  describe('calculateSportsbookConsensus', () => {
    it('should return null for <3 books', () => {
      const bookmakerOddsByBook = [
        { bookmaker: 'book1', odds: [2.0, 1.5] },
        { bookmaker: 'book2', odds: [2.1, 1.4] }
      ];
      expect(calculateSportsbookConsensus(bookmakerOddsByBook, 0)).toBeNull();
    });

    it('should use median for 3-4 books', () => {
      const bookmakerOddsByBook = [
        { bookmaker: 'book1', odds: [2.0, 1.5] },
        { bookmaker: 'book2', odds: [2.1, 1.4] },
        { bookmaker: 'book3', odds: [2.2, 1.3] }
      ];
      const consensus = calculateSportsbookConsensus(bookmakerOddsByBook, 0);
      expect(consensus).not.toBeNull();
      expect(consensus).toBeGreaterThan(0);
      expect(consensus).toBeLessThan(1);
    });

    it('should use trimmed mean for 5+ books', () => {
      const bookmakerOddsByBook = [
        { bookmaker: 'book1', odds: [2.0, 1.5] },
        { bookmaker: 'book2', odds: [2.1, 1.4] },
        { bookmaker: 'book3', odds: [2.2, 1.3] },
        { bookmaker: 'book4', odds: [2.3, 1.2] },
        { bookmaker: 'book5', odds: [2.4, 1.1] },
        { bookmaker: 'book6', odds: [2.5, 1.0] }
      ];
      const consensus = calculateSportsbookConsensus(bookmakerOddsByBook, 0);
      expect(consensus).not.toBeNull();
      expect(consensus).toBeGreaterThan(0);
      expect(consensus).toBeLessThan(1);
    });
  });

  describe('calculateExchangeConsensus', () => {
    it('should return null for unstable exchanges', () => {
      const exchangeOddsByExchange = [
        { exchange: 'betfair', odds: [2.0, 1.5] } // Unstable: sum = 0.5 + 0.667 = 1.167
      ];
      expect(calculateExchangeConsensus(exchangeOddsByExchange, 0)).toBeNull();
    });

    it('should return null for no exchanges', () => {
      expect(calculateExchangeConsensus([], 0)).toBeNull();
    });

    it('should return average for stable exchanges', () => {
      const exchangeOddsByExchange = [
        { exchange: 'betfair', odds: [2.0, 2.0] }, // Stable: sum = 0.5 + 0.5 = 1.0
        { exchange: 'smarkets', odds: [2.1, 1.9] } // Stable: sum = 0.476 + 0.526 = 1.002
      ];
      const consensus = calculateExchangeConsensus(exchangeOddsByExchange, 0);
      expect(consensus).not.toBeNull();
      expect(consensus).toBeGreaterThan(0);
      expect(consensus).toBeLessThan(1);
    });
  });

  describe('calculateFairProbability', () => {
    it('should return null when no consensus available', () => {
      expect(calculateFairProbability(null, null)).toBeNull();
    });

    it('should return books consensus when exchange not available', () => {
      const booksConsensus = 0.4;
      expect(calculateFairProbability(booksConsensus, null)).toBe(0.4);
    });

    it('should return exchange consensus when books not available', () => {
      const exchangeConsensus = 0.45;
      expect(calculateFairProbability(null, exchangeConsensus)).toBe(0.45);
    });

    it('should average both consensuses when both available', () => {
      const booksConsensus = 0.4;
      const exchangeConsensus = 0.45;
      const fair = calculateFairProbability(booksConsensus, exchangeConsensus);
      expect(fair).toBeCloseTo(0.425, 4);
    });
  });
});
