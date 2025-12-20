-- EV Tennis & Soccer Scanner Database Schema

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Sports table
CREATE TABLE IF NOT EXISTS sports (
    sport_key TEXT PRIMARY KEY,
    sport_title TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    sport_key TEXT NOT NULL REFERENCES sports(sport_key),
    commence_time TIMESTAMP WITH TIME ZONE NOT NULL,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'upcoming',
    last_polled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Odds snapshots table
CREATE TABLE IF NOT EXISTS odds_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id TEXT NOT NULL REFERENCES events(event_id),
    taken_at TIMESTAMP WITH TIME ZONE NOT NULL,
    market_key TEXT NOT NULL,
    bookmaker TEXT NOT NULL,
    is_exchange BOOLEAN NOT NULL DEFAULT false,
    selection TEXT NOT NULL,
    decimal_odds DECIMAL(10,4) NOT NULL,
    point DECIMAL(5,2), -- Line value for totals markets (e.g., 2.5, 3.5, 4.5)
    raw JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Candidates table (alerts)
CREATE TABLE IF NOT EXISTS candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    event_id TEXT NOT NULL REFERENCES events(event_id),
    sport_key TEXT NOT NULL,
    market_key TEXT NOT NULL,
    selection TEXT NOT NULL,
    alert_tier TEXT NOT NULL CHECK (alert_tier IN ('SOLID', 'SCOUT', 'EXCHANGE_VALUE')),
    best_source TEXT NOT NULL,
    offered_price DECIMAL(10,4) NOT NULL,
    offered_prob DECIMAL(10,6) NOT NULL,
    fair_price DECIMAL(10,4) NOT NULL,
    fair_prob DECIMAL(10,6) NOT NULL,
    edge_pp DECIMAL(10,6) NOT NULL,
    books_count INTEGER NOT NULL,
    exchanges_count INTEGER NOT NULL,
    notes TEXT
);

-- Bets table
CREATE TABLE IF NOT EXISTS bets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    event_id TEXT NOT NULL REFERENCES events(event_id),
    sport_key TEXT NOT NULL,
    market_key TEXT NOT NULL,
    selection TEXT NOT NULL,
    source TEXT NOT NULL,
    odds DECIMAL(10,4) NOT NULL,
    stake DECIMAL(10,2) NOT NULL,
    accepted_fair_prob DECIMAL(10,6) NOT NULL,
    accepted_fair_price DECIMAL(10,4) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'void')),
    settled_at TIMESTAMP WITH TIME ZONE,
    returns DECIMAL(10,2),
    pnl DECIMAL(10,2)
);

-- Closing consensus table
CREATE TABLE IF NOT EXISTS closing_consensus (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id TEXT NOT NULL REFERENCES events(event_id),
    market_key TEXT NOT NULL,
    selection TEXT NOT NULL,
    close_time TIMESTAMP WITH TIME ZONE NOT NULL,
    fair_prob DECIMAL(10,6) NOT NULL,
    fair_price DECIMAL(10,4) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Daily metrics table
CREATE TABLE IF NOT EXISTS metrics_daily (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    date DATE NOT NULL UNIQUE,
    staked DECIMAL(10,2) NOT NULL DEFAULT 0,
    pnl DECIMAL(10,2) NOT NULL DEFAULT 0,
    expected_value DECIMAL(10,2) NOT NULL DEFAULT 0,
    actual_margin DECIMAL(10,6) NOT NULL DEFAULT 0,
    expected_margin DECIMAL(10,6) NOT NULL DEFAULT 0,
    clv_bps DECIMAL(10,2) NOT NULL DEFAULT 0,
    win_rate DECIMAL(10,6) NOT NULL DEFAULT 0,
    num_bets INTEGER NOT NULL DEFAULT 0,
    num_bets_scout INTEGER NOT NULL DEFAULT 0,
    num_bets_solid INTEGER NOT NULL DEFAULT 0,
    num_bets_exchange INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Strategy tables --------------------------------------------------------

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
    competition_name TEXT,
    event_name TEXT,
    kickoff_at TIMESTAMP WITH TIME ZONE,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN (
        'scheduled',
        'back_pending',
        'back_matched',
        'hedged',
        'settled',
        'cancelled',
        'failed'
    )),
    back_order_ref TEXT,
    back_price DECIMAL(10,4),
    back_price_snapshot DECIMAL(10,4),
    back_size DECIMAL(10,2),
    back_stake DECIMAL(10,2) NOT NULL DEFAULT 0,
    back_matched_size DECIMAL(10,2) DEFAULT 0,
    lay_order_ref TEXT,
    lay_price DECIMAL(10,4),
    lay_size DECIMAL(10,2),
    lay_matched_size DECIMAL(10,2) DEFAULT 0,
    hedge_target_price DECIMAL(10,4),
    target_stake DECIMAL(10,2),
    total_stake DECIMAL(10,2) NOT NULL DEFAULT 0,
    pnl DECIMAL(10,2),
    realised_pnl DECIMAL(10,2),
    margin DECIMAL(10,6),
    commission_paid DECIMAL(10,2),
    settled_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    state_data JSONB DEFAULT '{}'::jsonb,
    metadata JSONB
);

CREATE TABLE IF NOT EXISTS strategy_trade_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trade_id UUID NOT NULL REFERENCES strategy_trades(id) ON DELETE CASCADE,
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE TABLE IF NOT EXISTS strategy_settings (
    strategy_key TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    enabled BOOLEAN NOT NULL DEFAULT false,
    default_stake DECIMAL(10,2) NOT NULL DEFAULT 10,
    min_back_price DECIMAL(10,4) NOT NULL DEFAULT 2.0,
    min_profit_pct NUMERIC DEFAULT 10,
    lay_target_price DECIMAL(10,4) NOT NULL DEFAULT 1.9,
    back_lead_minutes INTEGER NOT NULL DEFAULT 30,
    fixture_lookahead_days INTEGER NOT NULL DEFAULT 7,
    commission_rate DECIMAL(10,6) NOT NULL DEFAULT 0.02,
    extra JSONB NOT NULL DEFAULT '{}'::JSONB
);

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

-- RLS (Row Level Security) policies
ALTER TABLE sports ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE odds_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE closing_consensus ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics_daily ENABLE ROW LEVEL SECURITY;

-- Allow all operations for authenticated users (adjust as needed for your auth setup)
CREATE POLICY "Allow all for authenticated users" ON sports FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all for authenticated users" ON events FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all for authenticated users" ON odds_snapshots FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all for authenticated users" ON candidates FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all for authenticated users" ON bets FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all for authenticated users" ON closing_consensus FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all for authenticated users" ON metrics_daily FOR ALL TO authenticated USING (true);

-- Functions for updating timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updating timestamps
CREATE TRIGGER update_sports_updated_at BEFORE UPDATE ON sports FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_events_updated_at BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Indexes for polling optimization
CREATE INDEX IF NOT EXISTS idx_events_last_polled_at ON events(last_polled_at);
CREATE INDEX IF NOT EXISTS idx_events_polling_filter ON events(status, commence_time, last_polled_at);

-- Column comments
COMMENT ON COLUMN events.last_polled_at IS 'Timestamp of last successful odds poll for this event. Used to implement smart polling that skips recently-polled events.';
COMMENT ON COLUMN strategy_trades.state_data IS 'JSONB field for state machine logic storage (e.g., prices, timestamps, thresholds)';
COMMENT ON COLUMN strategy_settings.min_profit_pct IS 'Minimum profit percentage to lock in (e.g. 10 for 10%)';
COMMENT ON COLUMN strategy_trades.competition_name IS 'Competition label snapshot for reporting (e.g., English Premier League)';
COMMENT ON COLUMN strategy_trades.event_name IS 'Human-readable event/fixture name snapshot, e.g., Home v Away';
COMMENT ON COLUMN strategy_trades.back_price_snapshot IS 'Original back price (odds) captured at placement time for reporting';
COMMENT ON COLUMN strategy_trades.back_stake IS 'Original back stake exposure (currency) placed on the market';
COMMENT ON COLUMN strategy_trades.total_stake IS 'Aggregate stake/exposure across all legs for the trade (back + hedges)';
COMMENT ON COLUMN strategy_trades.realised_pnl IS 'Final realised profit/loss after hedging and commission';
COMMENT ON COLUMN strategy_trades.settled_at IS 'Timestamp when the trade outcome was finalised (hedged/settled)';

-- =============================================================================
-- GOAL PRICE SNAPSHOT ANALYTICS (GoalReactive Strategy)
-- =============================================================================
-- View and indexes for analyzing price drift after goal detection.
-- Data is stored in strategy_trade_events with event_type='GOAL_PRICE_SNAPSHOT'.
-- This view extracts typed columns from the JSON payload for easy SQL queries.

-- View: Extracts goal price snapshots as typed columns for analytics
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

COMMENT ON VIEW goalreact_goal_price_snapshots IS 'Typed view for goal price snapshots (t+30/60/90/120s) for entry timing analysis';

-- Partial index: Speed up queries on GOAL_PRICE_SNAPSHOT events
CREATE INDEX IF NOT EXISTS idx_trade_events_goal_price_snapshot
    ON strategy_trade_events(trade_id, occurred_at)
    WHERE event_type = 'GOAL_PRICE_SNAPSHOT';

-- Expression index: Speed up grouping/filtering by snapshot timing (30/60/90/120)
CREATE INDEX IF NOT EXISTS idx_trade_events_snapshot_timing
    ON strategy_trade_events(((payload->>'seconds_after_goal_target')::int))
    WHERE event_type = 'GOAL_PRICE_SNAPSHOT';

-- =============================================================================
-- EXAMPLE QUERIES FOR GOAL PRICE SNAPSHOT ANALYSIS
-- =============================================================================
-- 
-- 1. Find which snapshot timing tends to have the highest price:
--
-- SELECT 
--     seconds_after_goal_target,
--     AVG(back_price) as avg_back_price,
--     MAX(back_price) as max_back_price,
--     COUNT(*) as snapshot_count
-- FROM goalreact_goal_price_snapshots
-- GROUP BY seconds_after_goal_target
-- ORDER BY seconds_after_goal_target;
--
-- 2. Per-trade analysis: which snapshot had the highest price for each goal?
--
-- SELECT DISTINCT ON (trade_id) 
--     trade_id, 
--     event_name,
--     seconds_after_goal_target as best_timing,
--     back_price as peak_back_price
-- FROM goalreact_goal_price_snapshots
-- ORDER BY trade_id, back_price DESC;
--
-- 3. Compare price at goal detection vs each snapshot:
--
-- SELECT
--     s.trade_id,
--     s.event_name,
--     s.spike_price as price_at_goal,
--     s.seconds_after_goal_target,
--     s.back_price,
--     ROUND(((s.back_price - s.spike_price) / s.spike_price * 100)::numeric, 1) as pct_change_from_spike
-- FROM goalreact_goal_price_snapshots s
-- ORDER BY s.trade_id, s.seconds_after_goal_target;

