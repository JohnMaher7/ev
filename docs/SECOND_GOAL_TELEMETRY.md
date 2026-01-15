# Second Goal Recovery Telemetry

## Overview

This telemetry system tracks market behavior after a 2nd goal is detected in the `epl_under25_goalreact` strategy. The goal is to determine the optimal stop-loss percentage by measuring actual market recovery patterns.

## What We Track

### 1. `second_goal_settled_price` (DECIMAL 10,4)
- **Definition**: The Back price captured exactly after the 90-second verification wait following the 2nd goal detection.
- **Purpose**: Establishes the "baseline" from which recovery is measured.
- **Maps to**: `state.stop_loss_baseline` in the code.
- **When captured**: At the end of `handleStopLossWait`, when transitioning to `STOP_LOSS_ACTIVE`.

### 2. `min_price_after_2nd_goal` (DECIMAL 10,4)
- **Definition**: The lowest Back price observed from the moment the 2nd goal is detected until the trade completes.
- **Purpose**: Measures the best potential recovery point (lowest price = highest potential profit).
- **Maps to**: `state.min_price_after_2nd_goal` in the code.
- **When tracked**: 
  - Initialized when 2nd goal detected (in `handleLive`)
  - Updated continuously during `handleStopLossWait` (verification phase)
  - Updated continuously during `handleStopLossActive` (execution phase)

## Implementation Details

### Code Changes

**File**: `bot/lib/strategies/epl-under25-goalreact.js`

1. **Initialization** (in `handleLive`):
   ```javascript
   // When 2nd goal detected, initialize min tracking
   state.min_price_after_2nd_goal = backPrice;
   ```

2. **Tracking** (in `handleStopLossWait` and `handleStopLossActive`):
   ```javascript
   // Update min price if current price is lower
   if (state.min_price_after_2nd_goal === undefined || backPrice < state.min_price_after_2nd_goal) {
     state.min_price_after_2nd_goal = backPrice;
   }
   ```

3. **Persistence** (in `settleTradeWithPnl`):
   ```javascript
   await this.updateTrade(trade.id, {
     // ... other fields
     second_goal_settled_price: state.stop_loss_baseline || null,
     min_price_after_2nd_goal: state.min_price_after_2nd_goal || null,
   });
   ```

### Database Schema

**Table**: `strategy_trades`

```sql
ALTER TABLE strategy_trades
ADD COLUMN IF NOT EXISTS second_goal_settled_price DECIMAL(10,4),
ADD COLUMN IF NOT EXISTS min_price_after_2nd_goal DECIMAL(10,4);
```

**Migration File**: `docs/database/migrations/add_second_goal_telemetry.sql`

## How to Use the Data

### Step 1: Run the Migration

```bash
# Connect to your Supabase instance
psql -h your-supabase-host -U postgres -d postgres

# Run the migration
\i docs/database/migrations/add_second_goal_telemetry.sql
```

### Step 2: Collect Data

Let the strategy run for a statistically significant period (recommend at least 50+ trades with 2nd goals).

### Step 3: Analyze the Data

Use the provided analysis queries in `docs/database/queries/analyze_second_goal_recovery.sql`:

1. **Recovery Statistics Summary**: Shows how often markets recover and by how much.
2. **Stop-Loss Optimization Analysis**: Compares outcomes at different stop-loss percentages (10%, 15%, 20%, 25%, 30%).
3. **Individual Trade Details**: Deep dive into specific trades.
4. **Recovery by Competition**: Identifies league-specific patterns.

### Step 4: Interpret Results

**Key Metrics to Consider:**

1. **Recovery Rate**: What % of trades showed recovery (min_price < settled_price)?
2. **Recovery Depth**: How much did prices typically recover (percentiles)?
3. **Trigger Rate**: At each stop-loss %, how often would it have triggered vs. avoided?

**Example Interpretation:**

If the data shows:
- **P50 (median) recovery**: 12%
- **P75 recovery**: 18%
- **P90 recovery**: 25%

This suggests:
- A 10% stop-loss would trigger too often (missing most recoveries)
- A 20% stop-loss captures 90% of recoveries (good balance)
- A 30% stop-loss is too loose (giving back too much profit)

## Performance Considerations

### Zero-Latency Design

- **In-memory tracking**: All comparisons happen in the polling loop (no DB writes during tracking).
- **Single write**: Data is persisted only once, when the trade settles.
- **No overhead**: Simple `if` comparison on each poll (~50ms total per poll cycle).

### Data Volume

- **Columns**: 2 new DECIMAL(10,4) columns = 8 bytes per trade
- **Growth rate**: Only populated for trades that reach 2nd goal (~20-30% of all trades)
- **Impact**: Negligible (estimated <1KB per day)

## FAQs

**Q: Why track the minimum price instead of the final price?**  
A: The minimum price represents the best potential recovery point. Even if a 3rd goal occurs and prices spike again, we want to know how low the market went (where we could have exited for maximum profit).

**Q: Does this slow down the bot?**  
A: No. The tracking uses simple in-memory comparisons (microseconds). The only DB write occurs once when the trade settles.

**Q: What if no 2nd goal occurs?**  
A: Both columns remain NULL. This is intentional - we only analyze trades that actually experienced a 2nd goal.

**Q: How do I know when I have enough data?**  
A: Aim for at least 50 trades with 2nd goals. Check the sample size in Query 1 (`total_2nd_goal_trades`).

**Q: Can I backtest different stop-loss percentages?**  
A: Yes! Query 2 simulates different stop-loss percentages against historical data, showing trigger rates and save rates for each setting.

## Next Steps

1. ✅ Deploy the migration to production
2. ✅ Deploy the updated strategy code
3. ⏳ Collect data (2-4 weeks recommended)
4. ⏳ Run analysis queries
5. ⏳ Update `stop_loss_pct` setting based on findings
6. ⏳ Monitor P&L improvement

## Maintenance

- **Data retention**: Keep indefinitely (valuable for long-term strategy optimization)
- **Index**: Optional index provided in migration (commented out by default)
- **Monitoring**: Check `strategy_trade_events` for `TRADE_SETTLED` events to see telemetry in action

---

**Implementation Date**: 2026-01-02  
**Strategy**: `epl_under25_goalreact`  
**Status**: ✅ Ready for production

