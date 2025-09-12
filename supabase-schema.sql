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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_events_sport_key ON events(sport_key);
CREATE INDEX IF NOT EXISTS idx_events_commence_time ON events(commence_time);
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_event_id ON odds_snapshots(event_id);
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_taken_at ON odds_snapshots(taken_at);
CREATE INDEX IF NOT EXISTS idx_candidates_created_at ON candidates(created_at);
CREATE INDEX IF NOT EXISTS idx_candidates_alert_tier ON candidates(alert_tier);
CREATE INDEX IF NOT EXISTS idx_candidates_edge_pp ON candidates(edge_pp);
CREATE INDEX IF NOT EXISTS idx_bets_created_at ON bets(created_at);
CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
CREATE INDEX IF NOT EXISTS idx_closing_consensus_event_id ON closing_consensus(event_id);
CREATE INDEX IF NOT EXISTS idx_metrics_daily_date ON metrics_daily(date);

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
