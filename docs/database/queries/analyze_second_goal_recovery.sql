-- Analysis Query: 2nd Goal Recovery Behavior
-- Purpose: Determine optimal stop-loss percentage by analyzing actual market recovery
-- Strategy: epl_under25_goalreact only

-- =============================================================================
-- QUERY 1: Recovery Statistics Summary
-- Shows how often the market recovered and by how much after 2nd goal
-- =============================================================================
SELECT
    COUNT(*) as total_2nd_goal_trades,
    COUNT(CASE WHEN min_price_after_2nd_goal < second_goal_settled_price THEN 1 END) as trades_with_recovery,
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal < second_goal_settled_price THEN 1 END) / COUNT(*), 2) as recovery_pct,
    
    -- Recovery depth statistics
    ROUND(AVG((second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100), 2) as avg_recovery_pct,
    ROUND(MIN((second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100), 2) as min_recovery_pct,
    ROUND(MAX((second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100), 2) as max_recovery_pct,
    
    -- Percentile analysis (what % recovery can we expect?)
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY (second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100) as p25_recovery_pct,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY (second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100) as median_recovery_pct,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY (second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100) as p75_recovery_pct,
    PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY (second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100) as p90_recovery_pct,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100) as p95_recovery_pct
FROM strategy_trades
WHERE strategy_key = 'epl_under25_goalreact'
  AND second_goal_settled_price IS NOT NULL
  AND min_price_after_2nd_goal IS NOT NULL;

-- =============================================================================
-- QUERY 2: Stop-Loss Optimization Analysis
-- Shows P&L outcomes at different hypothetical stop-loss percentages
-- =============================================================================
WITH recovery_data AS (
    SELECT
        id,
        event_name,
        back_price as entry_price,
        back_stake,
        second_goal_settled_price,
        min_price_after_2nd_goal,
        realised_pnl as actual_pnl,
        -- Calculate recovery percentage
        (second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100 as recovery_pct,
        -- Calculate what price each stop-loss % would trigger at
        second_goal_settled_price * (1 - 0.10) as sl_10_price,
        second_goal_settled_price * (1 - 0.15) as sl_15_price,
        second_goal_settled_price * (1 - 0.20) as sl_20_price,
        second_goal_settled_price * (1 - 0.25) as sl_25_price,
        second_goal_settled_price * (1 - 0.30) as sl_30_price
    FROM strategy_trades
    WHERE strategy_key = 'epl_under25_goalreact'
      AND second_goal_settled_price IS NOT NULL
      AND min_price_after_2nd_goal IS NOT NULL
      AND back_price IS NOT NULL
      AND back_stake IS NOT NULL
)
SELECT
    'Current (20%)' as stop_loss_setting,
    COUNT(*) as total_trades,
    COUNT(CASE WHEN min_price_after_2nd_goal <= sl_20_price THEN 1 END) as would_trigger,
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal <= sl_20_price THEN 1 END) / COUNT(*), 2) as trigger_rate_pct,
    COUNT(CASE WHEN min_price_after_2nd_goal > sl_20_price THEN 1 END) as would_save,
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal > sl_20_price THEN 1 END) / COUNT(*), 2) as save_rate_pct
FROM recovery_data

UNION ALL

SELECT '10% SL', COUNT(*), 
    COUNT(CASE WHEN min_price_after_2nd_goal <= sl_10_price THEN 1 END),
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal <= sl_10_price THEN 1 END) / COUNT(*), 2),
    COUNT(CASE WHEN min_price_after_2nd_goal > sl_10_price THEN 1 END),
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal > sl_10_price THEN 1 END) / COUNT(*), 2)
FROM recovery_data

UNION ALL

SELECT '15% SL', COUNT(*),
    COUNT(CASE WHEN min_price_after_2nd_goal <= sl_15_price THEN 1 END),
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal <= sl_15_price THEN 1 END) / COUNT(*), 2),
    COUNT(CASE WHEN min_price_after_2nd_goal > sl_15_price THEN 1 END),
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal > sl_15_price THEN 1 END) / COUNT(*), 2)
FROM recovery_data

UNION ALL

SELECT '25% SL', COUNT(*),
    COUNT(CASE WHEN min_price_after_2nd_goal <= sl_25_price THEN 1 END),
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal <= sl_25_price THEN 1 END) / COUNT(*), 2),
    COUNT(CASE WHEN min_price_after_2nd_goal > sl_25_price THEN 1 END),
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal > sl_25_price THEN 1 END) / COUNT(*), 2)
FROM recovery_data

UNION ALL

SELECT '30% SL', COUNT(*),
    COUNT(CASE WHEN min_price_after_2nd_goal <= sl_30_price THEN 1 END),
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal <= sl_30_price THEN 1 END) / COUNT(*), 2),
    COUNT(CASE WHEN min_price_after_2nd_goal > sl_30_price THEN 1 END),
    ROUND(100.0 * COUNT(CASE WHEN min_price_after_2nd_goal > sl_30_price THEN 1 END) / COUNT(*), 2)
FROM recovery_data

ORDER BY stop_loss_setting;

-- =============================================================================
-- QUERY 3: Individual Trade Details (for deep dive)
-- Shows specific trades with recovery metrics
-- =============================================================================
SELECT
    event_name,
    kickoff_at,
    back_price as entry_price,
    second_goal_settled_price,
    min_price_after_2nd_goal,
    ROUND((second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100, 2) as recovery_pct,
    realised_pnl,
    status,
    CASE 
        WHEN min_price_after_2nd_goal <= second_goal_settled_price * 0.8 THEN '20% SL would have triggered'
        ELSE '20% SL avoided'
    END as current_sl_outcome
FROM strategy_trades
WHERE strategy_key = 'epl_under25_goalreact'
  AND second_goal_settled_price IS NOT NULL
  AND min_price_after_2nd_goal IS NOT NULL
ORDER BY kickoff_at DESC
LIMIT 50;

-- =============================================================================
-- QUERY 4: Recovery by Competition (identify league-specific patterns)
-- =============================================================================
SELECT
    competition_name,
    COUNT(*) as trades_with_2nd_goal,
    ROUND(AVG((second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100), 2) as avg_recovery_pct,
    ROUND(MIN((second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100), 2) as min_recovery_pct,
    ROUND(MAX((second_goal_settled_price - min_price_after_2nd_goal) / min_price_after_2nd_goal * 100), 2) as max_recovery_pct,
    COUNT(CASE WHEN min_price_after_2nd_goal < second_goal_settled_price THEN 1 END) as recovery_count
FROM strategy_trades
WHERE strategy_key = 'epl_under25_goalreact'
  AND second_goal_settled_price IS NOT NULL
  AND min_price_after_2nd_goal IS NOT NULL
GROUP BY competition_name
HAVING COUNT(*) >= 3  -- Only show leagues with sufficient data
ORDER BY avg_recovery_pct DESC;

