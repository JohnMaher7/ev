-- Migration: Add exposure_time_seconds and back_price_at_kickoff columns to strategy_trades
-- Date: 2024-12-27
-- Purpose: Track trade exposure time and market price at kickoff for analytics

-- Add exposure_time_seconds column
-- Records the time in seconds between back matched and lay matched (IN-PLAY ONLY)
-- For prematch: only counts time AFTER kickoff (not pre-match waiting time)
-- For goalreact: back matched to lay matched (both are in-play)
-- Examples:
--   Prematch: Back matched 17:45, kickoff 18:00, lay matched 18:02 => exposure = 2 mins (120s)
--   Goalreact: Back matched 18:10, lay matched 18:14 => exposure = 4 mins (240s)
-- Value cannot be negative (enforced in application code)
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS exposure_time_seconds INTEGER;

-- Add back_price_at_kickoff column
-- Records the market back price captured 1 MINUTE BEFORE kickoff
-- Used by epl_under25 (prematch) strategy only
-- Logged for ALL prematch games for future analysis
ALTER TABLE strategy_trades 
ADD COLUMN IF NOT EXISTS back_price_at_kickoff DECIMAL(10,4);

-- Add column comments for documentation
COMMENT ON COLUMN strategy_trades.exposure_time_seconds IS 'Time in seconds between back matched and lay matched (in-play only). For prematch: only counts time after kickoff. For goalreact: back to lay matched. Cannot be negative.';
COMMENT ON COLUMN strategy_trades.back_price_at_kickoff IS 'Market back price captured 1 minute before kickoff. Prematch strategy only. Logged for all games for future analysis.';

-- Optional: Create index for exposure time analytics (uncomment if needed)
-- CREATE INDEX IF NOT EXISTS idx_strategy_trades_exposure_time 
--     ON strategy_trades(exposure_time_seconds) 
--     WHERE exposure_time_seconds IS NOT NULL;

