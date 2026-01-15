-- Migration: Add 2nd goal recovery telemetry columns
-- Purpose: Track market behavior after 2nd goal to optimize stop-loss percentage
-- Strategy: epl_under25_goalreact only
-- Date: 2026-01-02

-- Add columns for 2nd goal recovery analysis
ALTER TABLE strategy_trades
ADD COLUMN IF NOT EXISTS second_goal_settled_price DECIMAL(10,4),
ADD COLUMN IF NOT EXISTS min_price_after_2nd_goal DECIMAL(10,4);

-- Add comments for documentation
COMMENT ON COLUMN strategy_trades.second_goal_settled_price IS 
  'Back price after 90s verification wait following 2nd goal (goalreact only). Used for stop-loss optimization analysis. Maps to state.stop_loss_baseline.';

COMMENT ON COLUMN strategy_trades.min_price_after_2nd_goal IS 
  'Lowest back price observed from 2nd goal detection until trade completion (goalreact only). Measures best potential recovery. Tracked in-memory during STOP_LOSS_WAIT and STOP_LOSS_ACTIVE phases.';

-- Optional: Create index for analytics queries (if you'll be running frequent queries on these columns)
-- CREATE INDEX IF NOT EXISTS idx_strategy_trades_2nd_goal_recovery 
--     ON strategy_trades(second_goal_settled_price, min_price_after_2nd_goal) 
--     WHERE second_goal_settled_price IS NOT NULL;

