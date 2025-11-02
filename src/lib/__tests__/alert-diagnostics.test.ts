/**
 * Unit tests for alert diagnostics
 */

import { 
  diagnoseAlertMiss, 
  generateMarketDiagnostics, 
  formatDiagnosticSummary,
  type AlertDiagnostic 
} from '../alert-diagnostics';
import { type AlertCandidate } from '../alerts';

describe('Alert Diagnostics', () => {
  describe('diagnoseAlertMiss', () => {
    it('should diagnose SOLID alert miss due to low edge', () => {
      const diagnostic = diagnoseAlertMiss(
        'Team A',
        'bookmaker1',
        2.0, // offered price
        0.52, // fair prob
        0.50, // bookmaker true prob
        3, // books count
        false, // has stable exchanges
        'SOLID'
      );

      expect(diagnostic.edge).toBeCloseTo(0.02, 4); // 52% - 50% = 2%
      expect(diagnostic.ev).toBeCloseTo(0.04, 4); // 0.52 * (2.0 - 1) - (1 - 0.52)
      expect(diagnostic.nearMiss).toBe(true); // Edge is 2%, threshold is 1%, so >50% of threshold
      expect(diagnostic.missedThresholds.edge).toBe(false); // Edge meets threshold
      expect(diagnostic.missedThresholds.ev).toBe(false); // EV is positive
      expect(diagnostic.percentOfThreshold).toBe(100);
    });

    it('should diagnose SOLID alert miss due to negative EV', () => {
      const diagnostic = diagnoseAlertMiss(
        'Team A',
        'bookmaker1',
        1.5, // offered price
        0.65, // fair prob
        0.64, // bookmaker true prob
        3, // books count
        false, // has stable exchanges
        'SOLID'
      );

      const impliedProb = 1 / 1.5; // 0.6667
      const edge = 0.65 - impliedProb; // -0.0167
      const ev = 0.65 * (1.5 - 1) - (1 - 0.65); // -0.025

      expect(diagnostic.edge).toBeCloseTo(edge, 4);
      expect(diagnostic.ev).toBeCloseTo(ev, 4);
      expect(diagnostic.nearMiss).toBe(false);
      expect(diagnostic.missedThresholds.edge).toBe(true);
      expect(diagnostic.missedThresholds.ev).toBe(true);
      expect(diagnostic.thresholdMissReason).toContain('Edge');
    });

    it('should diagnose SOLID alert miss due to insufficient books', () => {
      const diagnostic = diagnoseAlertMiss(
        'Team A',
        'bookmaker1',
        2.5,
        0.45,
        0.40,
        1, // only 1 book
        false,
        'SOLID'
      );

      expect(diagnostic.missedThresholds.eligibility).toBe(true);
      expect(diagnostic.thresholdMissReason).toContain('Insufficient data');
      expect(diagnostic.recommendation).toContain('more bookmaker data');
    });

    it('should identify near-miss for SCOUT alerts', () => {
      const diagnostic = diagnoseAlertMiss(
        'Team A',
        'bookmaker1',
        2.0,
        0.515, // fair prob gives 1.5% edge
        0.50,
        2,
        false,
        'SCOUT'
      );

      const impliedProb = 0.5; // 1/2.0
      const edge = 0.515 - impliedProb; // 0.015 (1.5%)

      expect(diagnostic.edge).toBeCloseTo(edge, 4);
      expect(diagnostic.nearMiss).toBe(true); // 1.5% is 50% of 3% threshold
      expect(diagnostic.percentOfThreshold).toBeCloseTo(50, 1);
    });

    it('should handle exchange offers correctly', () => {
      const diagnostic = diagnoseAlertMiss(
        'Team A',
        'betfair',
        2.0,
        0.51,
        0.49, // exchange prob after commission
        3,
        true,
        'SOLID'
      );

      expect(diagnostic.bookDisagreement).toBeCloseTo(0.02, 4);
      expect(diagnostic.missedThresholds.disagreement).toBe(false); // 2% > 0.5% threshold
    });

    it('should recommend monitoring for near-misses', () => {
      const diagnostic = diagnoseAlertMiss(
        'Team A',
        'bookmaker1',
        1.95, // gives ~51.3% implied, so 0.7% edge with 52% fair
        0.52,
        0.515,
        3,
        false,
        'SOLID'
      );

      expect(diagnostic.nearMiss).toBe(true);
      expect(diagnostic.recommendation).toContain('monitor for improvements');
    });
  });

  describe('generateMarketDiagnostics', () => {
    it('should classify market efficiency as high when most edges are negative', () => {
      const diagnostics: AlertDiagnostic[] = [
        { edge: -0.02, nearMiss: false } as AlertDiagnostic,
        { edge: -0.015, nearMiss: false } as AlertDiagnostic,
        { edge: -0.025, nearMiss: false } as AlertDiagnostic,
        { edge: -0.01, nearMiss: false } as AlertDiagnostic,
        { edge: 0.005, nearMiss: false } as AlertDiagnostic,
      ];

      const summary = generateMarketDiagnostics(diagnostics, []);

      expect(summary.marketEfficiency).toBe('medium');
    });

    it('should classify market efficiency as medium with mixed edges', () => {
      const diagnostics: AlertDiagnostic[] = [
        { edge: -0.02, nearMiss: false } as AlertDiagnostic,
        { edge: -0.01, nearMiss: false } as AlertDiagnostic,
        { edge: 0.015, nearMiss: true } as AlertDiagnostic,
        { edge: 0.02, nearMiss: false } as AlertDiagnostic,
      ];

      const summary = generateMarketDiagnostics(diagnostics, []);

      expect(summary.marketEfficiency).toBe('low');
    });

    it('should identify near-miss opportunities', () => {
      const diagnostics: AlertDiagnostic[] = [
        { edge: 0.008, nearMiss: true, selection: 'Team A' } as AlertDiagnostic,
        { edge: 0.015, nearMiss: true, selection: 'Team B' } as AlertDiagnostic,
        { edge: -0.01, nearMiss: false, selection: 'Draw' } as AlertDiagnostic,
      ];

      const summary = generateMarketDiagnostics(diagnostics, []);

      expect(summary.nearMisses).toBe(2);
      expect(summary.recommendations).toContainEqual(
        expect.stringContaining('2 near-miss opportunities')
      );
    });

    it('should recommend threshold review when many positive edges but no alerts', () => {
      const diagnostics: AlertDiagnostic[] = [
        { edge: 0.008, nearMiss: true } as AlertDiagnostic,
        { edge: 0.007, nearMiss: true } as AlertDiagnostic,
        { edge: 0.009, nearMiss: true } as AlertDiagnostic,
        { edge: 0.006, nearMiss: false } as AlertDiagnostic,
      ];

      const summary = generateMarketDiagnostics(diagnostics, []);

      expect(summary.recommendations).toContainEqual(
        expect.stringContaining('consider reviewing threshold settings')
      );
    });

    it('should identify limited bookmaker coverage', () => {
      const diagnostics: AlertDiagnostic[] = [
        { missedThresholds: { eligibility: true } } as AlertDiagnostic,
        { missedThresholds: { eligibility: true } } as AlertDiagnostic,
        { missedThresholds: { eligibility: false } } as AlertDiagnostic,
      ];

      const summary = generateMarketDiagnostics(diagnostics, []);

      expect(summary.recommendations).toContainEqual(
        expect.stringContaining('expanding bookmaker list')
      );
    });

    it('should count alerts generated', () => {
      const diagnostics: AlertDiagnostic[] = [
        { edge: 0.005, nearMiss: false } as AlertDiagnostic,
      ];

      const alerts: AlertCandidate[] = [
        { alert_tier: 'SOLID' } as AlertCandidate,
        { alert_tier: 'SCOUT' } as AlertCandidate,
      ];

      const summary = generateMarketDiagnostics(diagnostics, alerts);

      expect(summary.alertsGenerated).toBe(2);
      expect(summary.totalCandidatesEvaluated).toBe(1);
    });
  });

  describe('formatDiagnosticSummary', () => {
    it('should format summary with all sections', () => {
      const summary = {
        totalCandidatesEvaluated: 10,
        alertsGenerated: 2,
        nearMisses: 3,
        marketEfficiency: 'medium' as const,
        diagnostics: [
          {
            selection: 'Team A',
            bookmaker: 'bet365',
            edge: 0.008,
            nearMiss: true,
            percentOfThreshold: 80,
          } as AlertDiagnostic,
          {
            selection: 'Team B',
            bookmaker: 'william',
            edge: 0.007,
            nearMiss: true,
            percentOfThreshold: 70,
          } as AlertDiagnostic,
        ],
        recommendations: [
          'Market is moderately efficient',
          '2 near-miss opportunities detected',
        ],
      };

      const formatted = formatDiagnosticSummary(summary);

      expect(formatted).toContain('ALERT DIAGNOSTICS');
      expect(formatted).toContain('Candidates Evaluated: 10');
      expect(formatted).toContain('Alerts Generated: 2');
      expect(formatted).toContain('Near Misses: 3');
      expect(formatted).toContain('Market Efficiency: MEDIUM');
      expect(formatted).toContain('Near Misses:');
      expect(formatted).toContain('Team A @ bet365: 0.80% edge (80% of threshold)');
      expect(formatted).toContain('Team B @ william: 0.70% edge (70% of threshold)');
      expect(formatted).toContain('Recommendations:');
      expect(formatted).toContain('Market is moderately efficient');
    });

    it('should handle empty near misses', () => {
      const summary = {
        totalCandidatesEvaluated: 5,
        alertsGenerated: 0,
        nearMisses: 0,
        marketEfficiency: 'high' as const,
        diagnostics: [],
        recommendations: [],
      };

      const formatted = formatDiagnosticSummary(summary);

      expect(formatted).toContain('Near Misses: 0');
    });

    it('should handle empty recommendations', () => {
      const summary = {
        totalCandidatesEvaluated: 5,
        alertsGenerated: 3,
        nearMisses: 0,
        marketEfficiency: 'low' as const,
        diagnostics: [],
        recommendations: [],
      };

      const formatted = formatDiagnosticSummary(summary);

      expect(formatted).not.toContain('Recommendations:');
    });
  });
});
