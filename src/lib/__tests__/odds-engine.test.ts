import { 
  decimalToProbability, 
  probabilityToDecimal, 
  applyExchangeCommission,
  devigTwoWay,
  devigThreeWay,
  trimmedMean,
  median,
  isExchangeStable,
  calculateSportsbookEdgeAndEV,
  groupSnapshotsIntoMarkets
} from '../odds-engine';

describe('Odds Engine', () => {
  describe('decimalToProbability', () => {
    it('should convert decimal odds to probability', () => {
      expect(decimalToProbability(2.0)).toBe(0.5);
      expect(decimalToProbability(1.5)).toBeCloseTo(0.6667, 4);
      expect(decimalToProbability(3.0)).toBeCloseTo(0.3333, 4);
    });
  });

  describe('probabilityToDecimal', () => {
    it('should convert probability to decimal odds', () => {
      expect(probabilityToDecimal(0.5)).toBe(2.0);
      expect(probabilityToDecimal(0.6667)).toBeCloseTo(1.5, 1);
      expect(probabilityToDecimal(0.3333)).toBeCloseTo(3.0, 1);
    });
  });

  describe('applyExchangeCommission', () => {
    it('should apply commission to exchange odds', () => {
      expect(applyExchangeCommission(2.0, 0.02)).toBeCloseTo(1.98, 2);
      expect(applyExchangeCommission(1.5, 0.05)).toBeCloseTo(1.475, 3);
    });
  });

  describe('devigTwoWay', () => {
    it('should de-vig two-way probabilities', () => {
      const [prob1, prob2] = devigTwoWay(0.55, 0.5);
      expect(prob1 + prob2).toBeCloseTo(1.0, 5);
      expect(prob1).toBeCloseTo(0.5238, 4);
      expect(prob2).toBeCloseTo(0.4762, 4);
    });
  });

  describe('devigThreeWay', () => {
    it('should de-vig three-way probabilities', () => {
      const [prob1, probX, prob2] = devigThreeWay(0.4, 0.3, 0.35);
      expect(prob1 + probX + prob2).toBeCloseTo(1.0, 5);
      expect(prob1).toBeCloseTo(0.3810, 4);
      expect(probX).toBeCloseTo(0.2857, 4);
      expect(prob2).toBeCloseTo(0.3333, 4);
    });
  });

  describe('trimmedMean', () => {
    it('should calculate trimmed mean for 5+ values', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      expect(trimmedMean(values)).toBe(5.5);
    });

    it('should calculate regular mean for <5 values', () => {
      const values = [1, 2, 3, 4];
      expect(trimmedMean(values)).toBe(2.5);
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
  });

  describe('isExchangeStable', () => {
    it('should identify stable exchanges', () => {
      expect(isExchangeStable([0.5, 0.5])).toBe(true);
      expect(isExchangeStable([0.33, 0.33, 0.34])).toBe(true);
      expect(isExchangeStable([0.4, 0.3, 0.2])).toBe(false);
    });
  });

  describe('calculateEdgeAndEV', () => {
    it('should calculate edge and EV correctly', () => {
      const { edge_pp, ev } = calculateSportsbookEdgeAndEV(0.6, 1.5);
      // Fair prob 0.6, offered price 1.5 (prob 0.6667), edge = 0.6 - 0.6667 = -0.0667
      expect(edge_pp).toBeCloseTo(-0.0667, 4);
      // EV = 0.6 * (1.5 - 1) - (1 - 0.6) = 0.6 * 0.5 - 0.4 = 0.3 - 0.4 = -0.1
      expect(ev).toBeCloseTo(-0.1, 4);
    });
  });

  describe('groupSnapshotsIntoMarkets', () => {
    it('should group snapshots into market data', () => {
      const snapshots = [
        {
          event_id: '1',
          taken_at: '2024-01-01T10:00:00Z',
          market_key: 'h2h',
          bookmaker: 'bet365',
          is_exchange: false,
          selection: 'Home',
          decimal_odds: 2.0,
          raw: {}
        },
        {
          event_id: '1',
          taken_at: '2024-01-01T10:00:00Z',
          market_key: 'h2h',
          bookmaker: 'betfair',
          is_exchange: true,
          selection: 'Home',
          decimal_odds: 1.98,
          raw: {}
        }
      ];

      const markets = groupSnapshotsIntoMarkets(snapshots);
      expect(markets).toHaveLength(1);
      expect(markets[0].event_id).toBe('1');
      expect(markets[0].market_key).toBe('h2h');
      expect(markets[0].selections['Home'].sportsbooks).toHaveLength(1);
      expect(markets[0].selections['Home'].exchanges).toHaveLength(1);
    });
  });
});
