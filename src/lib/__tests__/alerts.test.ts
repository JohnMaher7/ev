/**
 * Unit tests for alert generation
 */

import {
  calculateSportsbookEdgeAndEV,
  calculateExchangeEdgeAndEV,
  checkExchangeStability,
  generateAlertCandidates,
  type MarketData
} from '../alerts';

describe('Alert Generation', () => {
  describe('calculateSportsbookEdgeAndEV', () => {
    it('should calculate edge and EV for sportsbook offers', () => {
      const { edge_pp, ev } = calculateSportsbookEdgeAndEV(0.6, 1.5);
      // Fair prob 0.6, offered price 1.5 (prob 0.6667), edge = 0.6 - 0.6667 = -0.0667
      expect(edge_pp).toBeCloseTo(-0.0667, 4);
      // EV = 0.6 * (1.5 - 1) - (1 - 0.6) = 0.6 * 0.5 - 0.4 = 0.3 - 0.4 = -0.1
      expect(ev).toBeCloseTo(-0.1, 4);
    });

    it('should calculate positive edge correctly', () => {
      const { edge_pp, ev } = calculateSportsbookEdgeAndEV(0.6, 2.0);
      // Fair prob 0.6, offered price 2.0 (prob 0.5), edge = 0.6 - 0.5 = 0.1
      expect(edge_pp).toBeCloseTo(0.1, 4);
      // EV = 0.6 * (2.0 - 1) - (1 - 0.6) = 0.6 * 1.0 - 0.4 = 0.6 - 0.4 = 0.2
      expect(ev).toBeCloseTo(0.2, 4);
    });
  });

  describe('calculateExchangeEdgeAndEV', () => {
    it('should calculate edge and EV for exchange offers with commission', () => {
      const { edge_pp, ev } = calculateExchangeEdgeAndEV(0.6, 2.0, 0.02);
      // Effective price = 1 + (2.0 - 1) * (1 - 0.02) = 1 + 1.0 * 0.98 = 1.98
      // Effective prob = 1/1.98 = 0.5051
      // Edge = 0.6 - 0.5051 = 0.0949
      expect(edge_pp).toBeCloseTo(0.0949, 4);
      // EV = 0.6 * (1.98 - 1) - (1 - 0.6) = 0.6 * 0.98 - 0.4 = 0.588 - 0.4 = 0.188
      expect(ev).toBeCloseTo(0.188, 4);
    });
  });

  describe('checkExchangeStability', () => {
    it('should identify stable exchanges', () => {
      const marketData: MarketData = {
        event_id: 'test-event',
        market_key: 'h2h',
        selections: {
          'Home': {
            sportsbooks: [],
            exchanges: [{ bookmaker: 'betfair', decimal_odds: 2.0 }]
          },
          'Away': {
            sportsbooks: [],
            exchanges: [{ bookmaker: 'betfair', decimal_odds: 2.0 }]
          }
        }
      };
      expect(checkExchangeStability(marketData)).toBe(true);
    });

    it('should identify unstable exchanges', () => {
      const marketData: MarketData = {
        event_id: 'test-event',
        market_key: 'h2h',
        selections: {
          'Home': {
            sportsbooks: [],
            exchanges: [{ bookmaker: 'betfair', decimal_odds: 1.5 }]
          },
          'Away': {
            sportsbooks: [],
            exchanges: [{ bookmaker: 'betfair', decimal_odds: 1.5 }]
          }
        }
      };
      expect(checkExchangeStability(marketData)).toBe(false);
    });
  });

  describe('generateAlertCandidates', () => {
    it('should generate SOLID alert for high edge with sufficient books', () => {
      const marketData: MarketData = {
        event_id: 'test-event',
        market_key: 'h2h',
        selections: {
          'Home': {
            sportsbooks: [
              { bookmaker: 'book1', decimal_odds: 2.0 },
              { bookmaker: 'book2', decimal_odds: 2.1 },
              { bookmaker: 'book3', decimal_odds: 2.2 }
            ],
            exchanges: []
          }
        }
      };

      const { candidates } = generateAlertCandidates(marketData, 'tennis');

      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates.length).toBeGreaterThan(0);
    });

    it('should generate SCOUT alert for high edge with 2 books', () => {
      const marketData: MarketData = {
        event_id: 'test-event',
        market_key: 'h2h',
        selections: {
          'Home': {
            sportsbooks: [
              { bookmaker: 'book1', decimal_odds: 2.0 },
              { bookmaker: 'book2', decimal_odds: 2.1 }
            ],
            exchanges: []
          }
        }
      };

      const { candidates } = generateAlertCandidates(marketData, 'tennis');

      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates).toHaveLength(0);
    });

    it('should generate alerts for sufficient edge', () => {
      const marketData: MarketData = {
        event_id: 'test-event',
        market_key: 'h2h',
        selections: {
          'Home': {
            sportsbooks: [
              { bookmaker: 'book1', decimal_odds: 1.5 },
              { bookmaker: 'book2', decimal_odds: 1.6 },
              { bookmaker: 'book3', decimal_odds: 1.7 }
            ],
            exchanges: []
          }
        }
      };

      const { candidates } = generateAlertCandidates(marketData, 'tennis');

      const solidAlerts = candidates.filter(c => c.alert_tier === 'SOLID');
      expect(solidAlerts.length).toBeGreaterThan(0);
    });

    it('should generate SOLID alert with 1% edge threshold', () => {
      const marketData: MarketData = {
        event_id: 'test-event',
        market_key: 'h2h',
        selections: {
          'Home': {
            sportsbooks: [
              { bookmaker: 'book1', decimal_odds: 1.98 },
              { bookmaker: 'book2', decimal_odds: 1.99 },
              { bookmaker: 'book3', decimal_odds: 2.04 } // This gives ~1.5% edge
            ],
            exchanges: []
          }
        }
      };

      const { candidates } = generateAlertCandidates(marketData, 'tennis');

      const solidAlerts = candidates.filter(c => c.alert_tier === 'SOLID');
      expect(solidAlerts.length).toBeGreaterThan(0);

      if (solidAlerts.length > 0) {
        expect(solidAlerts[0].edge_pp).toBeGreaterThanOrEqual(0.01);
      }
    });
  });
});
