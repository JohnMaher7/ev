-- Trade Debugging SQL Queries
-- Run these in Supabase SQL Editor to investigate issues

-- 1. Recent trades with errors
SELECT 
  id,
  event_name,
  status,
  last_error,
  back_price,
  back_size,
  lay_price,
  lay_size,
  realised_pnl,
  created_at,
  kickoff_at
FROM strategy_trades
WHERE strategy_key = 'epl_under25'
  AND created_at >= NOW() - INTERVAL '24 hours'
  AND (last_error IS NOT NULL OR status IN ('failed', 'cancelled'))
ORDER BY created_at DESC
LIMIT 20;

-- 2. Failed bet placements (from events)
SELECT 
  t.id,
  t.event_name,
  t.status,
  e.event_type,
  e.occurred_at,
  e.payload->>'errorCode' as error_code,
  e.payload
FROM strategy_trade_events e
JOIN strategy_trades t ON t.id = e.trade_id
WHERE t.strategy_key = 'epl_under25'
  AND e.event_type IN ('BACK_FAILED', 'LAY_FAILED', 'TRADE_CANCELLED')
  AND e.occurred_at >= NOW() - INTERVAL '24 hours'
ORDER BY e.occurred_at DESC
LIMIT 20;

-- 3. Trades with suspicious calculations
SELECT 
  id,
  event_name,
  status,
  back_price,
  back_size,
  lay_price,
  lay_size,
  total_stake,
  realised_pnl,
  CASE 
    WHEN back_price < lay_price THEN 'INVERTED_SPREAD'
    WHEN back_matched_size > 0 AND lay_price IS NULL THEN 'EXPOSED_NO_LAY'
    WHEN total_stake > (back_stake * 3) THEN 'HIGH_STAKE'
    WHEN back_price < 1.5 THEN 'LOW_BACK_PRICE'
    ELSE 'OK'
  END as issue_type
FROM strategy_trades
WHERE strategy_key = 'epl_under25'
  AND created_at >= NOW() - INTERVAL '24 hours'
  AND (
    back_price < lay_price OR
    (back_matched_size > 0 AND lay_price IS NULL) OR
    total_stake > (back_stake * 3) OR
    back_price < 1.5
  )
ORDER BY created_at DESC;

-- 4. Event timeline for a specific trade (replace <trade_id>)
SELECT 
  occurred_at,
  event_type,
  payload
FROM strategy_trade_events
WHERE trade_id = '<trade_id>'  -- Replace with actual trade ID
ORDER BY occurred_at ASC;

-- 5. Summary statistics
SELECT 
  status,
  COUNT(*) as count,
  COUNT(CASE WHEN last_error IS NOT NULL THEN 1 END) as with_errors,
  AVG(realised_pnl) as avg_pnl,
  SUM(CASE WHEN realised_pnl > 0 THEN 1 ELSE 0 END) as profitable,
  SUM(CASE WHEN realised_pnl < 0 THEN 1 ELSE 0 END) as losing
FROM strategy_trades
WHERE strategy_key = 'epl_under25'
  AND created_at >= NOW() - INTERVAL '24 hours'
GROUP BY status
ORDER BY count DESC;

-- 6. Recent back orders that didn't match
SELECT 
  t.id,
  t.event_name,
  t.status,
  t.back_order_ref,
  t.back_price,
  t.back_size,
  t.kickoff_at,
  t.last_error,
  COUNT(e.id) as event_count
FROM strategy_trades t
LEFT JOIN strategy_trade_events e ON e.trade_id = t.id
WHERE t.strategy_key = 'epl_under25'
  AND t.status = 'back_pending'
  AND t.created_at >= NOW() - INTERVAL '24 hours'
GROUP BY t.id, t.event_name, t.status, t.back_order_ref, t.back_price, t.back_size, t.kickoff_at, t.last_error
ORDER BY t.kickoff_at DESC;

-- 7. Trades stuck in back_matched without lay
SELECT 
  id,
  event_name,
  status,
  back_matched_size,
  back_price,
  lay_price,
  lay_size,
  kickoff_at,
  last_error,
  created_at
FROM strategy_trades
WHERE strategy_key = 'epl_under25'
  AND status = 'back_matched'
  AND (lay_price IS NULL OR lay_size IS NULL)
  AND created_at >= NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;

