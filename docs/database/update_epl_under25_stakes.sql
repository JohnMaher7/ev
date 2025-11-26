-- Update target_stake for existing epl_under25 trades from 10 to 150
-- Only updates trades that are not yet completed/cancelled

UPDATE strategy_trades
SET target_stake = 150
WHERE strategy_key = 'epl_under25'
  AND target_stake = 10
  AND status NOT IN ('hedged', 'completed', 'cancelled');

-- Optional: Show affected rows before running
-- SELECT id, event_name, status, target_stake 
-- FROM strategy_trades 
-- WHERE strategy_key = 'epl_under25' 
--   AND target_stake = 10 
--   AND status NOT IN ('hedged', 'completed', 'cancelled');

