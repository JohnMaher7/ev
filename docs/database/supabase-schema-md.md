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
        'stop_loss_active'
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
    state_data JSONB DEFAULT '{}'::JSONB
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
-- SECOND_GOAL_DETECTED, STOP_LOSS_BASELINE_SET, PROFIT_TARGET_HIT, STOP_LOSS_EXIT

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
```

