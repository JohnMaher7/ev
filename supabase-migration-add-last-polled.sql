-- Migration: Add last_polled_at to events table for smart polling optimization
-- This allows us to skip events that were recently polled, saving API credits

ALTER TABLE events ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMP WITH TIME ZONE;

-- Create index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_events_last_polled_at ON events(last_polled_at);

-- Create composite index for common query pattern (status + commence_time + last_polled_at)
CREATE INDEX IF NOT EXISTS idx_events_polling_filter ON events(status, commence_time, last_polled_at);

-- Add comment
COMMENT ON COLUMN events.last_polled_at IS 'Timestamp of last successful odds poll for this event. Used to implement smart polling that skips recently-polled events.';





