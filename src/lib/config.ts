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
      enabled: process.env.ENABLE_EPL_UNDER25_STRATEGY === 'true',
      defaultStake: parseFloat(process.env.EPL_UNDER25_DEFAULT_STAKE || '10'),
      minBackPrice: parseFloat(process.env.EPL_UNDER25_MIN_BACK_PRICE || '2.0'),
      layTargetPrice: parseFloat(process.env.EPL_UNDER25_LAY_TARGET_PRICE || '1.9'),
      backLeadMinutes: parseInt(process.env.EPL_UNDER25_BACK_LEAD_MINUTES || '30', 10),
      fixtureLookaheadDays: parseInt(process.env.EPL_UNDER25_FIXTURE_LOOKAHEAD_DAYS || '7', 10),
      commissionRate: parseFloat(process.env.EPL_UNDER25_COMMISSION_RATE || '0.02'),
    },
  },
} as const;
