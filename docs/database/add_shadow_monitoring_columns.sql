-- Shadow Monitoring Columns Migration
-- Adds columns to track post-trade price analytics and milestone timing
-- Run this in Supabase SQL Editor

-- 1. Add new status value to the CHECK constraint
-- First, drop the existing constraint
ALTER TABLE strategy_trades DROP CONSTRAINT IF EXISTS strategy_trades_status_check;

-- Recreate with the new status value
ALTER TABLE strategy_trades ADD CONSTRAINT strategy_trades_status_check CHECK (status IN (
    -- Common statuses
    'scheduled',
    'back_pending',
    'back_matched',
    'hedged',
    'settled',
    'cancelled',
    'failed',
    'completed',
    'skipped',
    -- Goal-reactive specific statuses
    'watching',
    'goal_wait',
    'live',
    'stop_loss_wait',
    'stop_loss_active',
    'post_trade_monitor'  -- NEW: Shadow monitoring phase
));

-- 2. Add shadow monitoring analytics columns
-- These flat columns enable efficient querying without parsing JSONB

-- Theoretical entry price (for skipped/cancelled trades)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS theoretical_entry_price DECIMAL(10,4);

COMMENT ON COLUMN strategy_trades.theoretical_entry_price IS 
    'Entry price for skipped/shadow trades (used for "what-if" analytics)';

-- Minimum price observed after entry (best potential profit point)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS min_post_entry_price DECIMAL(10,4);

COMMENT ON COLUMN strategy_trades.min_post_entry_price IS 
    'Lowest price observed during post-trade monitoring (best potential profit point)';

-- Maximum potential profit percentage
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS max_potential_profit_pct DECIMAL(10,2);

COMMENT ON COLUMN strategy_trades.max_potential_profit_pct IS 
    'Maximum profit % achievable based on min_post_entry_price vs entry price';

-- Time to reach max profit (seconds)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS seconds_to_max_profit INTEGER;

COMMENT ON COLUMN strategy_trades.seconds_to_max_profit IS 
    'Seconds from entry to reaching max_potential_profit_pct';

-- Milestone timing columns (seconds to reach each threshold)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS seconds_to_10_pct INTEGER;

COMMENT ON COLUMN strategy_trades.seconds_to_10_pct IS 
    'Seconds from entry to first reaching 10% profit threshold';

ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS seconds_to_15_pct INTEGER;

COMMENT ON COLUMN strategy_trades.seconds_to_15_pct IS 
    'Seconds from entry to first reaching 15% profit threshold';

ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS seconds_to_20_pct INTEGER;

COMMENT ON COLUMN strategy_trades.seconds_to_20_pct IS 
    'Seconds from entry to first reaching 20% profit threshold';

ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS seconds_to_25_pct INTEGER;

COMMENT ON COLUMN strategy_trades.seconds_to_25_pct IS 
    'Seconds from entry to first reaching 25% profit threshold';

ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS seconds_to_30_pct INTEGER;

COMMENT ON COLUMN strategy_trades.seconds_to_30_pct IS 
    'Seconds from entry to first reaching 30% profit threshold';

-- 3. Create indexes for efficient analytics queries

-- Index for querying trades by shadow monitoring data
CREATE INDEX IF NOT EXISTS idx_strategy_trades_max_profit 
    ON strategy_trades(max_potential_profit_pct) 
    WHERE max_potential_profit_pct IS NOT NULL;

-- Index for querying milestone timing
CREATE INDEX IF NOT EXISTS idx_strategy_trades_milestone_15 
    ON strategy_trades(seconds_to_15_pct) 
    WHERE seconds_to_15_pct IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_strategy_trades_milestone_20 
    ON strategy_trades(seconds_to_20_pct) 
    WHERE seconds_to_20_pct IS NOT NULL;

-- Composite index for shadow trade analysis
CREATE INDEX IF NOT EXISTS idx_strategy_trades_shadow_analysis 
    ON strategy_trades(strategy_key, theoretical_entry_price, max_potential_profit_pct) 
    WHERE theoretical_entry_price IS NOT NULL;

