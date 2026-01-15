export const config = {
  // The Odds API Configuration
  oddsApiKey: process.env.ODDS_API_KEY || '',

  // App Configuration
  appTimezone: process.env.NEXT_PUBLIC_APP_TIMEZONE || 'Europe/London',
  // DEPRECATED: bookmakerAllowlist no longer filters API requests (we now fetch ALL bookmakers for better consensus)
  // Kept for backward compatibility but not used in polling
  bookmakerAllowlist: (process.env.BOOKMAKER_ALLOWLIST || 'betfair,betfair_sportsbook,smarkets,matchbook,bet365,williamhill,skybet').split(','),
  exchangeCommissionDefault: parseFloat(process.env.EXCHANGE_COMMISSION_DEFAULT || '0.02'),
  pollMinutes: parseInt(process.env.POLL_MINUTES || '60'),
  demoMode: process.env.DEMO_MODE === 'true',

  // Supabase Configuration
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  // Vercel Configuration
  vercelUrl: process.env.VERCEL_URL || '',

  // Alert thresholds
  alertThresholds: {
    solid: 0.01, // 1 percentage point (lowered from 2%)
    scout: 0.03, // 3 percentage points (lowered from 5%)
    exchangeValue: 0.02, // 2 percentage points (lowered from 3%)
  },

  // Near-miss tracking
  nearMissThreshold: 0.5, // 50% of threshold counts as near-miss

  // Exchange stability threshold
  exchangeStabilityThreshold: {
    min: 0.98,
    max: 1.02,
  },

  // Stake limits
  stakeLimits: {
    solid: {
      kellyFraction: 0.25,
      bankCap: 0.02, // 2% of bank
    },
    scout: {
      fixedCap: 0.005, // 0.5% of bank
    },
  },

  // Auto-betting configuration
  autoBet: {
    enabled: process.env.AUTO_BET_ENABLED === 'true',
    exchangeKey: 'betfair_ex_uk' as const,
    minEdge: parseFloat(process.env.AUTO_BET_MIN_EDGE || '0.02'), // 3 percentage points (higher than alert threshold)
    minStake: parseFloat(process.env.AUTO_BET_MIN_STAKE || '2'), // currency units
    bankroll: parseFloat(process.env.AUTO_BET_BANKROLL || '1000'), // currency units
  },

  strategies: {
    eplUnder25: {
      key: 'epl_under25',
      name: 'Pre-Match Hedge',
      enabled: process.env.ENABLE_EPL_UNDER25_STRATEGY === 'true',
      defaultStake: parseFloat(process.env.EPL_UNDER25_DEFAULT_STAKE || '10'),
      minBackPrice: parseFloat(process.env.EPL_UNDER25_MIN_BACK_PRICE || '2.0'),
      layTargetPrice: parseFloat(process.env.EPL_UNDER25_LAY_TARGET_PRICE || '1.9'),
      backLeadMinutes: parseInt(process.env.EPL_UNDER25_BACK_LEAD_MINUTES || '30', 10),
      fixtureLookaheadDays: parseInt(process.env.EPL_UNDER25_FIXTURE_LOOKAHEAD_DAYS || '7', 10),
      commissionRate: parseFloat(process.env.EPL_UNDER25_COMMISSION_RATE || '0.02'),
    },
    eplUnder25GoalReact: {
      key: 'epl_under25_goalreact',
      name: 'Goal Reactive',
      enabled: process.env.ENABLE_EPL_UNDER25_GOALREACT_STRATEGY === 'true',
      defaultStake: parseFloat(process.env.GOALREACT_DEFAULT_STAKE || '100'),
      waitAfterGoalSeconds: parseInt(process.env.GOALREACT_WAIT_AFTER_GOAL || '90', 10),
      goalCutoffMinutes: parseInt(process.env.GOALREACT_GOAL_CUTOFF || '45', 10),
      minEntryPrice: parseFloat(process.env.GOALREACT_MIN_ENTRY_PRICE || '2.5'),
      maxEntryPrice: parseFloat(process.env.GOALREACT_MAX_ENTRY_PRICE || '5.0'),
      goalDetectionPct: parseFloat(process.env.GOALREACT_GOAL_DETECTION_PCT || '30'),
      profitTargetPct: parseFloat(process.env.GOALREACT_PROFIT_TARGET_PCT || '10'),
      stopLossPct: parseFloat(process.env.GOALREACT_STOP_LOSS_PCT || '15'),
    },
    eplOver25Breakout: {
      key: 'epl_over25_breakout',
      name: 'Over 2.5 Breakout',
      enabled: process.env.ENABLE_EPL_OVER25_BREAKOUT_STRATEGY === 'true',
      defaultStake: parseFloat(process.env.OVER25_DEFAULT_STAKE || '10'),
      waitAfterGoalSeconds: parseInt(process.env.OVER25_WAIT_AFTER_GOAL || '60', 10),
      goalCutoffMinutes: parseInt(process.env.OVER25_GOAL_CUTOFF || '75', 10),
      minEntryPrice: parseFloat(process.env.OVER25_MIN_ENTRY_PRICE || '1.5'),
      maxEntryPrice: parseFloat(process.env.OVER25_MAX_ENTRY_PRICE || '5.0'),
      goalDetectionPct: parseFloat(process.env.OVER25_GOAL_DETECTION_PCT || '30'),
      entryBufferPct: parseFloat(process.env.OVER25_ENTRY_BUFFER_PCT || '2'),
      stopLossDriftPct: parseFloat(process.env.OVER25_STOP_LOSS_DRIFT_PCT || '10'),
    },
  },
} as const;
