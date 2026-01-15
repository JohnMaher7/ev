# Supabase Schema (EPL Under 2.5 Strategies)

Supports two strategies:
- `epl_under25` - Pre-match hedge strategy (back at lay price, immediate lay 2 ticks below)
- `epl_under25_goalreact` - Goal-reactive strategy (enter after 1st goal, exit on profit/stop-loss)

```
CREATE TABLE IF NOT EXISTS strategy_trades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    strategy_key TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    event_id TEXT,
    betfair_event_id TEXT,
    betfair_market_id TEXT,
    selection_id BIGINT,
    runner_name TEXT,
    kickoff_at TIMESTAMP WITH TIME ZONE,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN (
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
        'post_trade_monitor'  -- Shadow monitoring phase (tracks potential profit after exit/skip)
    )),
    back_order_ref TEXT,
    back_price DECIMAL(10,4),
    back_size DECIMAL(10,2),
    back_matched_size DECIMAL(10,2) DEFAULT 0,
    lay_order_ref TEXT,
    lay_price DECIMAL(10,4),
    lay_size DECIMAL(10,2),
    lay_matched_size DECIMAL(10,2) DEFAULT 0,
    hedge_target_price DECIMAL(10,4),
    target_stake DECIMAL(10,2),
    pnl DECIMAL(10,2),
    margin DECIMAL(10,6),
    commission_paid DECIMAL(10,2),
    last_error TEXT,
    metadata JSONB,
    -- Extended columns for strategies
    competition_name TEXT,
    event_name TEXT,
    back_stake DECIMAL(10,2),
    back_price_snapshot DECIMAL(10,4),
    total_stake DECIMAL(10,2),
    realised_pnl DECIMAL(10,2),
    settled_at TIMESTAMP WITH TIME ZONE,
    back_placed_at TIMESTAMP WITH TIME ZONE,
    lay_placed_at TIMESTAMP WITH TIME ZONE,
    needs_check_at TIMESTAMP WITH TIME ZONE,
    state_data JSONB DEFAULT '{}'::JSONB,
    -- New columns for exposure tracking
    exposure_time_seconds INTEGER,  -- Time in seconds between back matched and lay matched (in-play only). For prematch: only counts time after kickoff. Cannot be negative.
    back_price_at_kickoff DECIMAL(10,4),  -- Market back price captured 1 minute before kickoff (prematch strategy only, used for future analysis)
    
    -- Second goal recovery telemetry (goalreact strategy only)
    second_goal_settled_price DECIMAL(10,4),  -- Back price after 90s verification wait following 2nd goal (goalreact only, used for stop-loss optimization analysis)
    min_price_after_2nd_goal DECIMAL(10,4),   -- Lowest back price observed from 2nd goal detection until trade completion (goalreact only, measures best potential recovery)
    
    -- Shadow monitoring / post-trade analytics columns
    theoretical_entry_price DECIMAL(10,4),  -- Entry price for skipped/shadow trades (used for "what-if" analytics)
    min_post_entry_price DECIMAL(10,4),     -- Lowest price observed during post-trade monitoring (best potential profit point)
    max_potential_profit_pct DECIMAL(10,2), -- Maximum profit % achievable based on min_post_entry_price vs entry price
    seconds_to_max_profit INTEGER,          -- Seconds from entry to reaching max_potential_profit_pct
    seconds_to_10_pct INTEGER,              -- Seconds from entry to first reaching 10% profit threshold
    seconds_to_15_pct INTEGER,              -- Seconds from entry to first reaching 15% profit threshold
    seconds_to_20_pct INTEGER,              -- Seconds from entry to first reaching 20% profit threshold
    seconds_to_25_pct INTEGER,              -- Seconds from entry to first reaching 25% profit threshold
    seconds_to_30_pct INTEGER               -- Seconds from entry to first reaching 30% profit threshold
);

CREATE TABLE IF NOT EXISTS strategy_trade_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trade_id UUID NOT NULL REFERENCES strategy_trades(id) ON DELETE CASCADE,
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB
);

-- Event types for epl_under25:
-- TRADE_CREATED, TRADE_REACTIVATED, TRADE_PRUNED, BACK_PLACED, BACK_FAILED,
-- BACK_MATCHED, BACK_PARTIALLY_MATCHED, BACK_ASSUMED_MATCHED, BACK_CANCELLED,
-- MISSED_WINDOW

-- Event types for epl_under25_goalreact:
-- TRADE_CREATED, WATCHING_STARTED, GOAL_DETECTED, GOAL_AFTER_CUTOFF,
-- GOAL_DISALLOWED, PRICE_OUT_OF_RANGE, POSITION_ENTERED, ENTRY_FAILED,
-- SECOND_GOAL_DETECTED, STOP_LOSS_BASELINE_SET, PROFIT_TARGET_HIT, STOP_LOSS_EXIT,
-- SHADOW_MONITORING_STARTED, SHADOW_MILESTONE_REACHED, SHADOW_MONITORING_COMPLETED

CREATE TABLE IF NOT EXISTS strategy_settings (
    strategy_key TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    enabled BOOLEAN NOT NULL DEFAULT false,
    default_stake DECIMAL(10,2) NOT NULL DEFAULT 10,
    fixture_lookahead_days INTEGER NOT NULL DEFAULT 7,
    commission_rate DECIMAL(10,6) NOT NULL DEFAULT 0.02,
    extra JSONB NOT NULL DEFAULT '{}'::JSONB
);

-- Settings Structure:
-- Common fields (top-level): enabled, default_stake, fixture_lookahead_days, commission_rate
-- Strategy-specific fields (in extra JSONB):
--
-- For epl_under25:
--   min_back_price: DECIMAL (default: 1.8)
--   min_profit_pct: NUMERIC (default: 10) - used to compute lay target price
--   back_lead_minutes: INTEGER (default: 30)
--   lay_ticks_below_back: INTEGER (default: 2)
--   lay_persistence: TEXT (default: 'PERSIST')
--
-- For epl_under25_goalreact:
--   min_entry_price: DECIMAL (default: 2.5)
--   max_entry_price: DECIMAL (default: 5.0)
--   wait_after_goal_seconds: INTEGER (default: 90)
--   goal_cutoff_minutes: INTEGER (default: 45)
--   goal_detection_pct: NUMERIC (default: 30)
--   profit_target_pct: NUMERIC (default: 10)
--   stop_loss_pct: NUMERIC (default: 15)
--   in_play_poll_interval_seconds: INTEGER (default: 30)

CREATE TABLE IF NOT EXISTS strategy_fixtures (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    strategy_key TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    event_id TEXT,
    betfair_event_id TEXT,
    competition TEXT,
    home TEXT,
    away TEXT,
    kickoff_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    UNIQUE(strategy_key, betfair_event_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_trades_strategy_key
    ON strategy_trades(strategy_key);

CREATE INDEX IF NOT EXISTS idx_strategy_trades_status
    ON strategy_trades(status);

CREATE INDEX IF NOT EXISTS idx_strategy_trades_kickoff
    ON strategy_trades(kickoff_at);

CREATE INDEX IF NOT EXISTS idx_strategy_trade_events_trade_id
    ON strategy_trade_events(trade_id);

CREATE INDEX IF NOT EXISTS idx_strategy_fixtures_strategy_key
    ON strategy_fixtures(strategy_key);

CREATE INDEX IF NOT EXISTS idx_strategy_fixtures_kickoff
    ON strategy_fixtures(kickoff_at);

ALTER TABLE strategy_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_trade_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_fixtures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON strategy_trades FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all for authenticated users" ON strategy_trade_events FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all for authenticated users" ON strategy_settings FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all for authenticated users" ON strategy_fixtures FOR ALL TO authenticated USING (true);

CREATE TRIGGER update_strategy_trades_updated_at
    BEFORE UPDATE ON strategy_trades
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_strategy_settings_updated_at
    BEFORE UPDATE ON strategy_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_strategy_fixtures_updated_at
    BEFORE UPDATE ON strategy_fixtures
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- GOAL PRICE SNAPSHOT ANALYTICS VIEW (GoalReactive)
-- Extracts typed columns from GOAL_PRICE_SNAPSHOT events for easy analysis
CREATE OR REPLACE VIEW goalreact_goal_price_snapshots AS
SELECT
    e.id,
    e.trade_id,
    e.occurred_at,
    t.event_name,
    t.competition_name,
    t.kickoff_at,
    (e.payload->>'goal_number')::int AS goal_number,
    (e.payload->>'seconds_after_goal_target')::int AS seconds_after_goal_target,
    (e.payload->>'seconds_after_goal_actual')::int AS seconds_after_goal_actual,
    (e.payload->>'back_price')::numeric AS back_price,
    (e.payload->>'lay_price')::numeric AS lay_price,
    (e.payload->>'spread')::numeric AS spread,
    (e.payload->>'baseline_price')::numeric AS baseline_price,
    (e.payload->>'spike_price')::numeric AS spike_price,
    (e.payload->>'mins_from_kickoff')::numeric AS mins_from_kickoff,
    e.payload->>'timestamp' AS snapshot_timestamp
FROM strategy_trade_events e
JOIN strategy_trades t ON t.id = e.trade_id
WHERE e.event_type = 'GOAL_PRICE_SNAPSHOT';

-- Partial indexes for efficient GOAL_PRICE_SNAPSHOT queries
CREATE INDEX IF NOT EXISTS idx_trade_events_goal_price_snapshot
    ON strategy_trade_events(trade_id, occurred_at)
    WHERE event_type = 'GOAL_PRICE_SNAPSHOT';

CREATE INDEX IF NOT EXISTS idx_trade_events_snapshot_timing
    ON strategy_trade_events(((payload->>'seconds_after_goal_target')::int))
    WHERE event_type = 'GOAL_PRICE_SNAPSHOT';

-- SHADOW MONITORING ANALYTICS VIEW (GoalReactive)
-- Provides easy access to shadow monitoring results for completed/skipped trades
CREATE OR REPLACE VIEW goalreact_shadow_monitoring AS
SELECT
    t.id,
    t.event_name,
    t.competition_name,
    t.kickoff_at,
    t.status,
    t.back_price,
    t.theoretical_entry_price,
    COALESCE(t.back_price, t.theoretical_entry_price) AS effective_entry_price,
    t.min_post_entry_price,
    t.max_potential_profit_pct,
    t.seconds_to_max_profit,
    t.seconds_to_10_pct,
    t.seconds_to_15_pct,
    t.seconds_to_20_pct,
    t.seconds_to_25_pct,
    t.seconds_to_30_pct,
    t.realised_pnl,
    (t.state_data->>'is_shadow_trade')::boolean AS is_shadow_trade,
    t.state_data->>'skip_reason' AS skip_reason,
    t.state_data->>'monitor_end_reason' AS monitor_end_reason
FROM strategy_trades t
WHERE t.strategy_key = 'epl_under25_goalreact'
  AND (t.max_potential_profit_pct IS NOT NULL OR t.theoretical_entry_price IS NOT NULL);

-- Indexes for shadow monitoring analytics
CREATE INDEX IF NOT EXISTS idx_strategy_trades_max_profit 
    ON strategy_trades(max_potential_profit_pct) 
    WHERE max_potential_profit_pct IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_strategy_trades_shadow_analysis 
    ON strategy_trades(strategy_key, theoretical_entry_price, max_potential_profit_pct) 
    WHERE theoretical_entry_price IS NOT NULL;
```

