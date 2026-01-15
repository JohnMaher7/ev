-- Migration: Over 2.5 Breakout Strategy Telemetry Columns
-- Date: 2026-01-14
-- Updated: 2026-01-15 (added Over 3.5 price columns and match_minute_at_entry)
-- Strategy: epl_over25_breakout

-- Over 2.5 specific metrics (prefix: over_)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS over_price_before_1st_goal NUMERIC;

ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS over_max_price_reached_post_entry NUMERIC;

ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS over_price_after_2nd_goal_settled NUMERIC;

ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS max_price_over_reached_after_2nd_goal NUMERIC;

ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS seconds_till_next_goal INTEGER;

-- Over 3.5 price tracking (for correlation analysis)
-- Captures Over 3.5 market price at each goal event to analyze relationship with Over 2.5

-- Over 3.5 price captured when 1st goal is detected (in WATCHING phase, before GOAL_WAIT)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS over35_price_before_1st_goal NUMERIC;

-- Over 3.5 price captured after 1st goal settles (at entry, in GOAL_WAIT phase)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS over35_price_after_1st_goal NUMERIC;

-- Over 3.5 price captured when 2nd goal is detected (in LIVE phase)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS over35_price_before_2nd_goal NUMERIC;

-- Over 3.5 price captured after 2nd goal settles (at green up or settlement)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS over35_price_after_2nd_goal NUMERIC;

-- Match minute tracking (accurate timing based on Betfair's inplay flag)
-- This is the match minute when we entered the position (not scheduled kickoff time)
-- Calculated as: (entry_time - actual_kickoff_time) / 60000
-- Where actual_kickoff_time is when book.inplay first becomes true
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS match_minute_at_entry INTEGER;

-- Store the actual kickoff timestamp for auditing (when market first went in-play)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS actual_kickoff_time TIMESTAMPTZ;

-- Note: seconds_to_10_pct through seconds_to_30_pct already exist from Under 2.5 strategy
-- For Over 2.5, these track UPWARD drift (against the position)

-- Create index for strategy-specific queries (if not exists)
CREATE INDEX IF NOT EXISTS idx_strategy_trades_over25_breakout 
ON strategy_trades(strategy_key, status, kickoff_at) 
WHERE strategy_key = 'epl_over25_breakout';
