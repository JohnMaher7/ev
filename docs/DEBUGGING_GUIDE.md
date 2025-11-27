# 🔍 Trade Debugging Guide

This guide helps you find and diagnose issues with bot trades.

## Quick Start

### Option 1: Node.js Script (Recommended)

Run the debugging script to get a comprehensive report:

```bash
# Basic usage - last 24 hours
node scripts/debug-trades.js

# Show only failed trades
node scripts/debug-trades.js --failed-only

# Show detailed events for each trade
node scripts/debug-trades.js --events

# Custom time window and limit
node scripts/debug-trades.js --hours 48 --limit 50

# Combine options
node scripts/debug-trades.js --failed-only --events --hours 12
```

**What it shows:**
- ✅ Trades with errors
- ✅ Failed bet placements
- ✅ Suspicious calculations (inverted spreads, missing lays, etc.)
- ✅ Event timelines
- ✅ Summary statistics

### Option 2: SQL Queries (Direct Database Access)

Open Supabase SQL Editor and run queries from `scripts/debug-trades.sql`:

1. **Recent trades with errors:**
   ```sql
   SELECT id, event_name, status, last_error, back_price, lay_price
   FROM strategy_trades
   WHERE strategy_key = 'epl_under25'
     AND last_error IS NOT NULL
   ORDER BY created_at DESC
   LIMIT 20;
   ```

2. **Failed bet placements:**
   ```sql
   SELECT t.event_name, e.event_type, e.occurred_at, e.payload->>'errorCode'
   FROM strategy_trade_events e
   JOIN strategy_trades t ON t.id = e.trade_id
   WHERE e.event_type IN ('BACK_FAILED', 'LAY_FAILED')
   ORDER BY e.occurred_at DESC;
   ```

3. **Trades stuck without lay (exposed):**
   ```sql
   SELECT id, event_name, back_matched_size, back_price
   FROM strategy_trades
   WHERE status = 'back_matched'
     AND lay_price IS NULL;
   ```

## Common Issues & Solutions

### Issue: "Back matched but no lay placed"

**Symptoms:**
- Trade status is `back_matched`
- `lay_price` is NULL
- Trade is exposed to market risk

**Check:**
1. Look for `LAY_FAILED` events in `strategy_trade_events`
2. Check `last_error` field for error messages
3. Verify market is still open and has liquidity

**Common causes:**
- Market closed before lay could be placed
- Insufficient liquidity at target price
- API error during lay placement

### Issue: "Inverted spread (back_price < lay_price)"

**Symptoms:**
- `back_price` is lower than `lay_price`
- This indicates a guaranteed loss

**Check:**
1. Review `BACK_PLACED` event payload for actual price
2. Check if back was placed at wrong price
3. Verify market prices at time of placement

**Common causes:**
- Back order matched at worse price than expected
- Market moved significantly between back and lay
- Calculation error in stake/price logic

### Issue: "Trade stuck in back_pending"

**Symptoms:**
- Status remains `back_pending` after kickoff
- `back_matched_size` is 0 or NULL

**Check:**
1. Query `strategy_trade_events` for `BACK_PLACED` event
2. Check if `back_order_ref` exists
3. Verify order status on Betfair (if you have access)

**Common causes:**
- Order never matched (insufficient liquidity)
- Order was cancelled by Betfair
- Market suspended before match

### Issue: "Failed bet placement"

**Symptoms:**
- `BACK_FAILED` or `LAY_FAILED` events in logs
- `last_error` contains error code

**Common error codes:**
- `INSUFFICIENT_FUNDS` - Account balance too low
- `MARKET_NOT_OPEN_FOR_BETTING` - Market closed/suspended
- `INVALID_PRICE` - Price outside valid range
- `BET_TAKEN_OR_LAPSED` - Order already matched/cancelled
- `DUPLICATE_BETIDS` - Bet ID conflict

## Log Sources

### 1. Database Tables

**`strategy_trades`** - Main trade records
- `last_error` - Latest error message
- `status` - Current trade state
- `back_price`, `lay_price` - Bet prices
- `back_matched_size`, `lay_matched_size` - Matched amounts

**`strategy_trade_events`** - Event history
- `event_type` - Event name (BACK_PLACED, LAY_FAILED, etc.)
- `occurred_at` - Timestamp
- `payload` - Event details (JSONB)

### 2. Console Logs

If running the bot locally, check console output for:
- `[strategy:epl_under25]` prefixed messages
- Error messages with stack traces
- Bet placement confirmations

### 3. Web UI

Visit `/strategies/epl-under25` to see:
- Recent trades
- Trade status and P&L
- Click on a trade to see its event timeline

## Debugging Workflow

1. **Identify the problem:**
   ```bash
   node scripts/debug-trades.js --failed-only
   ```

2. **Get detailed events for problematic trade:**
   ```bash
   node scripts/debug-trades.js --events --limit 5
   ```

3. **Check specific trade in database:**
   ```sql
   SELECT * FROM strategy_trades WHERE id = '<trade_id>';
   SELECT * FROM strategy_trade_events WHERE trade_id = '<trade_id>' ORDER BY occurred_at;
   ```

4. **Look for patterns:**
   - Are failures happening at specific times?
   - Are certain markets/events failing more?
   - Are error codes consistent?

5. **Check bot logs:**
   - If running in Docker: `docker logs <container>`
   - If running as service: check service logs
   - Look for `[strategy:epl_under25]` messages

## Environment Variables

The debugging script needs:
- `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`

These should be in `.env` or `.env.local` in the project root.

## Tips

- Use `--hours` to adjust time window (default: 24h)
- Use `--limit` to control output size (default: 20)
- Combine `--failed-only` with `--events` for detailed failure analysis
- Export SQL results to CSV for further analysis
- Check `strategy_trade_events.payload` for detailed error information

## Need More Help?

- Check the main strategy file: `bot/lib/strategies/epl-under25.js`
- Review event types in the code (search for `logEvent`)
- Check Betfair API documentation for error code meanings

