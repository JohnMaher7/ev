# Milestone Tracking Fix - Live Phase Implementation

## Problem Statement
Profit milestones (`seconds_to_10_pct`, `seconds_to_15_pct`, etc.) were only tracked during the `POST_TRADE_MONITOR` phase, resulting in inaccurate timestamps when trades exited during the `LIVE` phase (e.g., hitting 12% profit target before 10% milestone could be recorded).

## Solution Overview
Refactored `handleLive` to track milestones in real-time during active trading, ensuring accurate timestamps regardless of exit timing.

## Changes Made

### 1. Enhanced `handleLive` Method (Lines 2333-2377)
**Added milestone tracking logic:**
```javascript
// Initialize milestones if not present
if (!state.shadow_milestones) {
  state.shadow_milestones = {};
}

// Calculate current profit % and elapsed time
const profitPct = ((state.entry_price - backPrice) / backPrice) * 100;
const elapsedSeconds = state.position_entered_at 
  ? Math.floor((Date.now() - state.position_entered_at) / 1000)
  : null;

// Check milestone thresholds (in-memory only, no DB calls for performance)
const newMilestones = [];
if (elapsedSeconds !== null) {
  const milestones = [10, 15, 20, 25, 30];
  for (const threshold of milestones) {
    if (profitPct >= threshold && state.shadow_milestones[threshold] === undefined) {
      state.shadow_milestones[threshold] = elapsedSeconds;
      newMilestones.push({ threshold, elapsedSeconds, profitPct });
    }
  }
}
```

**Key Features:**
- ✅ **Zero-await tracking**: Milestone detection happens in-memory without blocking DB calls
- ✅ **Idempotent**: Only records each milestone once (`undefined` check)
- ✅ **Reuses existing calculation**: Leverages already-computed `profitPct` for minimal overhead
- ✅ **Fire-and-forget logging**: Event logging uses async `.catch()` to prevent blocking

### 2. Fixed `initializeShadowMonitoring` Method (Lines 1127-1151)
**Changed from:**
```javascript
// Initialize milestone tracking
state.shadow_milestones = {};
```

**To:**
```javascript
// Initialize milestone tracking ONLY if not already present
// This preserves milestones captured during LIVE phase
if (!state.shadow_milestones) {
  state.shadow_milestones = {};
}
```

**Impact:**
- Prevents overwriting milestones tracked during `LIVE` phase when transitioning to `POST_TRADE_MONITOR`
- Ensures data continuity across phase transitions

## Data Flow Verification

### Trade Exit During LIVE Phase
1. `handleLive` tracks milestones → updates `state.shadow_milestones` in-memory
2. Trade hits profit target → calls `settleTradeWithPnl`
3. `settleTradeWithPnl` → calls `initializeShadowMonitoring` (preserves existing milestones)
4. Trade moves to `POST_TRADE_MONITOR` → `handlePostTradeMonitor` continues tracking (won't overwrite existing)
5. Eventually `finalizeShadowMonitoring` → writes all milestones to DB flat columns

### Trade Exit During POST_TRADE_MONITOR Phase
1. Trade skipped/completed without entering `LIVE` → no milestones tracked yet
2. `handlePostTradeMonitor` tracks milestones as before (unchanged behavior)
3. `finalizeShadowMonitoring` → writes milestones to DB

## Performance Considerations

### Zero-Impact Design
- **No synchronous DB calls** in the tight tracking loop
- **Minimal CPU overhead**: Single `for` loop over 5 thresholds
- **Fire-and-forget logging**: Event insertion happens asynchronously
- **Memory-only state updates**: Existing `await this.updateTrade()` at line 2659 persists changes

### Benchmark Estimate
- **Added CPU cycles per poll**: ~5 comparisons + 1 arithmetic operation = **< 1µs overhead**
- **DB calls**: Zero additional blocking calls (logging is async)

## Testing Checklist

### Unit Test Scenarios
- [ ] Trade exits at 12% profit → verify 10% milestone captured with correct timestamp
- [ ] Trade hits multiple milestones (10%, 15%, 20%) before exit → verify all captured
- [ ] Trade enters LIVE, hits milestones, then 2nd goal → verify milestones persist through STOP_LOSS phases
- [ ] Skipped trade (shadow monitoring only) → verify milestones tracked during POST_TRADE_MONITOR
- [ ] Trade exits at 8% profit (below 10% threshold) → verify no milestones recorded

### Integration Tests
- [ ] Run live simulation for 10 trades → verify all milestone columns populated correctly in DB
- [ ] Compare milestone timestamps before/after fix → verify timestamps are earlier (more accurate)
- [ ] Check strategy_trade_events → verify `LIVE_MILESTONE_REACHED` events logged

## Database Schema (No Changes Required)
Existing columns already support this data:
- `seconds_to_10_pct` (integer)
- `seconds_to_15_pct` (integer)
- `seconds_to_20_pct` (integer)
- `seconds_to_25_pct` (integer)
- `seconds_to_30_pct` (integer)

## Rollout Plan
1. ✅ Code review and approval
2. Deploy to staging environment
3. Run 24h shadow testing (compare milestone accuracy vs production)
4. Deploy to production during low-activity window
5. Monitor logs for `LIVE_MILESTONE_REACHED` events

## Expected Improvements
- **Accuracy**: Milestone timestamps now reflect actual time-to-profit, not shadow monitoring artifacts
- **Completeness**: 100% milestone capture rate for trades exiting during LIVE phase (previously 0%)
- **Analytics**: More reliable data for profit velocity analysis and strategy optimization

## Notes
- No breaking changes to existing functionality
- Backward compatible with existing trades (only new trades benefit from fix)
- Logging format matches existing `SHADOW_MILESTONE_REACHED` events for consistency

