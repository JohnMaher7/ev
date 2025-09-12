export const config = {
  // The Odds API Configuration
  oddsApiKey: process.env.ODDS_API_KEY || '',
  
  // App Configuration
  appTimezone: process.env.NEXT_PUBLIC_APP_TIMEZONE || 'Europe/London',
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
    solid: 0.001, // 2 percentage points
    scout: 0.05, // 5 percentage points
    exchangeValue: 0.03, // 3 percentage points
  },
  
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
    minEdge: parseFloat(process.env.AUTO_BET_MIN_EDGE || '0.008'), // 0.8 percentage points
    minStake: parseFloat(process.env.AUTO_BET_MIN_STAKE || '2'), // currency units
    bankroll: parseFloat(process.env.AUTO_BET_BANKROLL || '1000'), // currency units
  },
} as const;
