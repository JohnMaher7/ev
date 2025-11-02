/**
 * Alert diagnostics system for analyzing why alerts fire or don't fire
 */

import { config } from './config';
import { type AlertCandidate } from './alerts';

export interface AlertDiagnostic {
  selection: string;
  bookmaker: string;
  offeredPrice: number;
  edge: number;
  ev: number;
  fairProb: number;
  bookDisagreement: number;
  thresholdMissReason: string;
  nearMiss: boolean;
  missedThresholds: {
    edge: boolean;
    ev: boolean;
    disagreement: boolean;
    eligibility: boolean;
  };
  percentOfThreshold: number;
  recommendation?: string;
}

export interface MarketDiagnosticSummary {
  totalCandidatesEvaluated: number;
  alertsGenerated: number;
  nearMisses: number;
  marketEfficiency: 'high' | 'medium' | 'low';
  diagnostics: AlertDiagnostic[];
  recommendations: string[];
}

/**
 * Analyze why an alert didn't fire
 */
export function diagnoseAlertMiss(
  selection: string,
  bookmaker: string,
  offeredPrice: number,
  fairProb: number,
  bookmakerTrueProb: number,
  booksCount: number,
  hasStableExchanges: boolean,
  alertTier: 'SOLID' | 'SCOUT' | 'EXCHANGE_VALUE'
): AlertDiagnostic {
  const impliedProb = 1 / offeredPrice;
  const edge = fairProb - impliedProb;
  const ev = fairProb * (offeredPrice - 1) - (1 - fairProb);
  const bookDisagreement = fairProb - bookmakerTrueProb;

  const thresholds = config.alertThresholds;
  const missedThresholds = {
    edge: false,
    ev: false,
    disagreement: false,
    eligibility: false,
  };

  let thresholdMissReason = '';
  let nearMiss = false;
  let percentOfThreshold = 0;

  // Check SOLID alert criteria
  if (alertTier === 'SOLID') {
    const threshold = thresholds.solid;
    const disagreementThreshold = threshold / 2;
    
    // Check eligibility
    const eligible = (booksCount >= 3) || (booksCount === 2 && hasStableExchanges);
    if (!eligible) {
      missedThresholds.eligibility = true;
      thresholdMissReason = `Insufficient data: ${booksCount} books${hasStableExchanges ? ' with exchange' : ''}`;
    }

    // Check edge
    if (edge < threshold) {
      missedThresholds.edge = true;
      percentOfThreshold = Math.max(percentOfThreshold, (edge / threshold) * 100);
      
      if (!thresholdMissReason) {
        thresholdMissReason = `Edge ${(edge * 100).toFixed(2)}% < ${(threshold * 100).toFixed(2)}% required`;
      }
    } else {
      percentOfThreshold = 100;
    }

    // Check EV
    if (ev < 0) {
      missedThresholds.ev = true;
      if (!thresholdMissReason) {
        thresholdMissReason = `Negative EV: ${ev.toFixed(4)}`;
      }
    }

    // Check disagreement
    if (bookDisagreement < disagreementThreshold) {
      missedThresholds.disagreement = true;
      if (!thresholdMissReason) {
        thresholdMissReason = `Low disagreement: ${(bookDisagreement * 100).toFixed(2)}% < ${(disagreementThreshold * 100).toFixed(2)}%`;
      }
    }

    // Near miss if close to threshold
    nearMiss = edge >= threshold * config.nearMissThreshold && ev >= -0.01 && eligible;
  }

  // Check SCOUT alert criteria  
  else if (alertTier === 'SCOUT') {
    const threshold = thresholds.scout;

    if (booksCount < 2) {
      missedThresholds.eligibility = true;
      thresholdMissReason = `Only ${booksCount} book(s), need at least 2`;
    }

    if (edge < threshold) {
      missedThresholds.edge = true;
      percentOfThreshold = (edge / threshold) * 100;
      
      if (!thresholdMissReason) {
        thresholdMissReason = `Edge ${(edge * 100).toFixed(2)}% < ${(threshold * 100).toFixed(2)}% required`;
      }
    } else {
      percentOfThreshold = 100;
    }

    if (ev < 0) {
      missedThresholds.ev = true;
      if (!thresholdMissReason) {
        thresholdMissReason = `Negative EV: ${ev.toFixed(4)}`;
      }
    }

    nearMiss = edge >= threshold * config.nearMissThreshold && ev >= -0.01 && booksCount >= 2;
  }

  // Generate recommendation
  let recommendation: string | undefined;
  if (nearMiss) {
    recommendation = 'Close to alert threshold - monitor for improvements';
  } else if (missedThresholds.eligibility) {
    recommendation = 'Need more bookmaker data for reliable alerts';
  } else if (edge < 0) {
    recommendation = 'Market appears efficient - no edge available';
  } else if (ev < 0 && edge > 0) {
    recommendation = 'Positive edge but negative EV - price may be too low';
  }

  return {
    selection,
    bookmaker,
    offeredPrice,
    edge,
    ev,
    fairProb,
    bookDisagreement,
    thresholdMissReason,
    nearMiss,
    missedThresholds,
    percentOfThreshold,
    recommendation,
  };
}

/**
 * Generate market-wide diagnostic summary
 */
export function generateMarketDiagnostics(
  diagnostics: AlertDiagnostic[],
  alertsGenerated: AlertCandidate[]
): MarketDiagnosticSummary {
  const nearMisses = diagnostics.filter(d => d.nearMiss).length;
  const negativeEdges = diagnostics.filter(d => d.edge < 0).length;
  const positiveEdges = diagnostics.filter(d => d.edge > 0).length;
  
  // Determine market efficiency
  let marketEfficiency: 'high' | 'medium' | 'low';
  const negativeEdgeRatio = negativeEdges / diagnostics.length;
  
  if (negativeEdgeRatio > 0.8) {
    marketEfficiency = 'high';
  } else if (negativeEdgeRatio > 0.5) {
    marketEfficiency = 'medium';
  } else {
    marketEfficiency = 'low';
  }

  // Generate recommendations
  const recommendations: string[] = [];
  
  if (marketEfficiency === 'high') {
    recommendations.push('Market is highly efficient - consider waiting for better opportunities');
  }
  
  if (nearMisses > 0) {
    recommendations.push(`${nearMisses} near-miss opportunities detected - small market movements could create alerts`);
  }
  
  if (alertsGenerated.length === 0 && positiveEdges > 3) {
    recommendations.push('Multiple positive edges found but no alerts - consider reviewing threshold settings');
  }
  
  const avgBooksCount = diagnostics.reduce(
    (sum, d) => sum + (d.missedThresholds?.eligibility ? 1 : 0),
    0
  );
  if (avgBooksCount > diagnostics.length * 0.5) {
    recommendations.push('Limited bookmaker coverage - consider expanding bookmaker list');
  }

  return {
    totalCandidatesEvaluated: diagnostics.length,
    alertsGenerated: alertsGenerated.length,
    nearMisses,
    marketEfficiency,
    diagnostics,
    recommendations,
  };
}

/**
 * Format diagnostic summary for logging
 */
export function formatDiagnosticSummary(summary: MarketDiagnosticSummary): string {
  const lines: string[] = [];
  
  lines.push('🔍 ALERT DIAGNOSTICS');
  lines.push('═══════════════════════════════════');
  lines.push(`Candidates Evaluated: ${summary.totalCandidatesEvaluated}`);
  lines.push(`Alerts Generated: ${summary.alertsGenerated}`);
  lines.push(`Near Misses: ${summary.nearMisses}`);
  lines.push(`Market Efficiency: ${summary.marketEfficiency.toUpperCase()}`);
  
  if (summary.nearMisses > 0) {
    lines.push('\n📊 Near Misses:');
    summary.diagnostics
      .filter(d => d.nearMiss)
      .forEach(d => {
        lines.push(`  • ${d.selection} @ ${d.bookmaker}: ${(d.edge * 100).toFixed(2)}% edge (${d.percentOfThreshold.toFixed(0)}% of threshold)`);
      });
  }
  
  if (summary.recommendations.length > 0) {
    lines.push('\n💡 Recommendations:');
    summary.recommendations.forEach(rec => {
      lines.push(`  • ${rec}`);
    });
  }
  
  return lines.join('\n');
}
