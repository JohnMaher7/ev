# Alerts Engine Guide

This document explains how alert candidates are generated, the meaning of the key metrics (edge, expected value, bookmaker disagreement), and where to configure thresholds.

## Overview

Polling retrieves odds snapshots for enabled sports and processes them via `src/lib/odds-engine.ts`, which groups snapshots per event/market and calls `generateAlertCandidates` in `src/lib/alerts.ts`. Generated candidates are stored in Supabase (`candidates` table) and surfaced in the UI (`src/components/views/alerts-view.tsx`).

## Key Concepts

- **Fair probability**: consensus estimate of an outcome’s true chance. Built using leave-one-out sportsbook data and blended with stable exchange consensus if available.
- **Edge (probability advantage)**: `fairProb − impliedProb(offeredPrice)`. Expressed in probability points (percentage points). Positive edge indicates the market believes the outcome is more likely than the bookmaker price implies.
- **Expected Value (EV)**: profit per unit stake using the fair probability. `EV = fairProb × (odds − 1) − (1 − fairProb)`. Both edge and EV must be positive for high-confidence alerts.
- **Bookmaker disagreement**: difference between the decision fair probability and the bookmaker’s own de-vigged probability. Measures how far the targeted book deviates from consensus.
- **Stable exchange**: an exchange whose implied probabilities sum within `config.exchangeStabilityThreshold` (default 0.98–1.02). Required for certain tiers.

## Thresholds & Criteria

Thresholds live in `src/lib/config.ts` under `alertThresholds`:

```ts
alertThresholds: {
  solid: 0.02,
  scout: 0.05,
  exchangeValue: 0.03,
},
```

The alert engine consumes these values:

- **SOLID**: edge ≥ `solid`, EV ≥ 0, and bookmaker disagreement ≥ `solid / 2`. Requires either ≥3 sportsbooks or 2 plus a stable exchange.
- **SCOUT**: edge ≥ `scout`, EV ≥ 0, and ≥2 sportsbooks. Used for early looks with less coverage.
- **EXCHANGE_VALUE**: sportsbook consensus probability exceeds an available exchange offer (after commission) by ≥ `exchangeValue` and EV ≥ 0. The exchange can be unstable; we rely on consensus to detect stale exchange prices.

If you change the values in `config.ts`, redeploy; the backend and UI will both use the new thresholds automatically.

## UI Defaults

The alerts view defaults `minEdge` to `config.alertThresholds.solid`, ensuring filters align with the engine. Users can lower/raise the slider per preference.

## Where to Change Things

- Threshold values: `src/lib/config.ts` (`alertThresholds`).
- Alert logic and calculations: `src/lib/alerts.ts`.
- UI defaults and filters: `src/components/views/alerts-view.tsx`.
- Admin exposure: `/api/admin/config` and `/admin` view.

## Testing

1. Run polling (manual or cron) and inspect `/api/candidates` to confirm generated alerts.
2. Verify UI reflects the same candidates when filters allow them.
3. Adjust thresholds in `config.ts`, rerun poll, confirm behaviour changes accordingly.

