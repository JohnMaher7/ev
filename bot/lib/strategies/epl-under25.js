const { addDays } = require('date-fns');

const { roundToBetfairTick } = require('../betfair-utils');
const {
  SOCCER_EVENT_TYPE_ID,
  UNDER_RUNNER_NAME,
  COMPETITION_MATCHERS,
  COMPETITION_IDS,
  calculateLayStake,
  calculateHedgeStake,
  computeRealisedPnlSnapshot,
  formatFixtureName,
  ticksBelow,
  createSafeApiWrappers,
  ensureMarket,
} = require('./shared');

const STRATEGY_KEY = 'epl_under25';

function getDefaultSettings() {
  return {
    // Code is the source of truth for this strategy's settings.
    // (Avoid env overrides here to prevent accidental config drift / Supabase "reverts".)
    default_stake: 300,
    fixture_lookahead_days: 2,
    commission_rate: 0.0175,
    // Strategy-specific settings (stored in extra JSONB)
    min_back_price: 1.5,
    min_profit_pct: 10,
    back_lead_minutes: 45,
    lay_ticks_below_back: 3,
    lay_persistence: 'PERSIST', // PERSIST = keep in-play

    // Stop-loss / recovery (goal-react style: wait, then exit on drift)
    // NOTE: This strategy already detects goal spikes and enters recovery mode.
    // These settings make the wait + drift percentage configurable.
    stop_loss_wait_seconds: 180,
    stop_loss_pct: 20,

    // Market liquidity threshold - skip trades if total matched volume is below this
    min_market_liquidity: 1000,
  };
}

// calculateLayStake and calculateHedgeStake imported from shared.js

// computeTargetLayPrice, formatFixtureName, computeRealisedPnlSnapshot imported from shared.js

function computeTargetLayPrice(backPrice, settings) {
  // Profit locking logic: Target Price = Back Price / (1 + Profit%)
  // e.g. Back @ 2.0, 10% profit => 2.0 / 1.10 = 1.81
  const profitPct = settings?.min_profit_pct || 10;
  const target = backPrice / (1 + (profitPct / 100));
  return roundToBetfairTick(target);
}

class EplUnder25Strategy {
  constructor({ supabase, betfair, logger = console }) {
    this.supabase = supabase;
    this.betfair = betfair;
    this.logger = logger;
    this.settings = null;
    this.defaults = getDefaultSettings();

    this.processingScheduled = false;
    this.processingActive = false;
    this.syncingFixtures = false;
    this.scheduledTimer = null;

    // Smart scheduler state
    this.smartSchedulerTimer = null;
    this.activePollingTimer = null;

    this.timers = [];

    // Bind methods to ensure 'this' context is preserved
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);
    this.processScheduledTrades = this.processScheduledTrades.bind(this);
    this.processActiveTrades = this.processActiveTrades.bind(this);
    this.syncFixtures = this.syncFixtures.bind(this);
    this.ensureSettings = this.ensureSettings.bind(this);
    this.checkBackOrder = this.checkBackOrder.bind(this);
    this.scheduleNextTradeCheck = this.scheduleNextTradeCheck.bind(this);
    this.calculateNextWakeTime = this.calculateNextWakeTime.bind(this);
    this.smartSchedulerLoop = this.smartSchedulerLoop.bind(this);
    this.startActivePolling = this.startActivePolling.bind(this);
    this.stopActivePolling = this.stopActivePolling.bind(this);
  }

  async start() {
    await this.ensureSettings();
    
    this.logger.log(`[strategy:epl_under25] Starting strategy (enabled=${this.settings?.enabled})`);
    
    // Initial fixture sync
    await this.syncFixtures('startup');

    this.watchSettings();
    
    // Sync fixtures every 24 hours (always needed)
    this.timers.push(setInterval(() => this.syncFixtures('interval').catch(this.logError('syncFixtures')), 24 * 60 * 60 * 1000));

    // Scheduler Mode: smart (default, efficient) or fixed (legacy, wasteful)
    const schedulerMode = process.env.EPL_UNDER25_SCHEDULER_MODE || 'smart';
    
    if (schedulerMode === 'smart') {
      // SMART MODE: Fixture-aware scheduling (sleeps when no games, wakes when needed)
      this.logger.log(`[strategy:epl_under25] ⚡ Smart scheduler active (fixture-aware, efficient)`);
      this.logger.log('[strategy:epl_under25] - Will sleep during quiet periods');
      this.logger.log('[strategy:epl_under25] - Will wake before fixtures');
      this.logger.log('[strategy:epl_under25] - Will start 5s polling only for in-play games');
      
      // Start the smart scheduler loop
      this.smartSchedulerLoop();
      
      this.logger.log('[strategy:epl_under25] Started successfully (smart mode)');
      
    } else if (schedulerMode === 'fixed') {
      // LEGACY MODE: Continuous polling (wasteful but simple - for rollback)
      this.logger.log(`[strategy:epl_under25] ⚠️  Fixed scheduler active (continuous polling - LEGACY MODE)`);
      this.logger.log('[strategy:epl_under25] WARNING: This mode is inefficient - polls 24/7 even with no games');
      
      // Process scheduled trades on startup
      await this.processScheduledTrades('startup');
      
      // Scheduled trades: every 45s
      this.timers.push(setInterval(() => this.processScheduledTrades('interval').catch(this.logError('processScheduledTrades')), 45 * 1000));
      
      // Active trades: every 5s (always running)
      this.logger.log('[strategy:epl_under25] Setting up continuous 5-second polling...');
      const activeTradeTimer = setInterval(() => {
        this.processActiveTrades('interval').catch((err) => {
          this.logger.error(`[strategy:epl_under25] processActiveTrades error: ${err?.message || err}`);
        });
      }, 5 * 1000);
      this.timers.push(activeTradeTimer);
      
      // Test immediately
      await this.processActiveTrades('startup-test').catch((err) => {
        this.logger.error(`[strategy:epl_under25] startup test failed: ${err?.message || err}`);
      });
      
      this.logger.log('[strategy:epl_under25] Started successfully (fixed mode - 5s active, 45s scheduled)');
      
    } else {
      throw new Error(`Invalid EPL_UNDER25_SCHEDULER_MODE: ${schedulerMode} (must be 'smart' or 'fixed')`);
    }
  }

  async stop() {
    this.logger.log('[strategy:epl_under25] Stopping strategy...');
    
    // Clear all timers
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    if (this.scheduledTimer) clearTimeout(this.scheduledTimer);
    
    // Clear smart scheduler timers
    if (this.smartSchedulerTimer) {
      clearTimeout(this.smartSchedulerTimer);
      this.smartSchedulerTimer = null;
    }
    if (this.activePollingTimer) {
      clearInterval(this.activePollingTimer);
      this.activePollingTimer = null;
    }
    
    this.timers = [];
    this.logger.log('[strategy:epl_under25] Strategy stopped');
  }

  logError(method) {
    return (err) => {
      this.logger.error(`[strategy:epl_under25] ${method} error:`, err && err.message ? err.message : err);
    };
  }

  // --- Smart Scheduler: Fixture-Aware Polling (Efficient) ---

  /**
   * Calculate when the bot needs to wake up next
   * Returns milliseconds until next required action
   */
  async calculateNextWakeTime() {
    const now = Date.now();
    
    // Priority 1: Check for active trades that need monitoring
    // INCLUDES back_pending - we poll these to detect pre-match matches and place lay immediately
    // INCLUDES post_trade_monitor - shadow monitoring (low priority but needs polling)
    const { data: activeTrades } = await this.supabase
      .from('strategy_trades')
      .select('id, status')
      .eq('strategy_key', STRATEGY_KEY)
      .in('status', ['back_pending', 'back_matched', 'hedge_pending', 'post_trade_monitor'])
      .limit(1);
    
    if (activeTrades?.length > 0) {
      this.logger.log(`[strategy:epl_under25] Active trades detected (${activeTrades[0].status}) - need polling`);
      return 0; // Wake now - active trades need polling
    }
    
    // Priority 3: Check for scheduled trades approaching kickoff
    const { data: scheduledTrades } = await this.supabase
      .from('strategy_trades')
      .select('kickoff_at, event_id')
      .eq('strategy_key', STRATEGY_KEY)
      .eq('status', 'scheduled')
      .gt('kickoff_at', new Date().toISOString())
      .order('kickoff_at', { ascending: true })
      .limit(1);
    
    if (scheduledTrades?.length > 0) {
      const kickoff = new Date(scheduledTrades[0].kickoff_at).getTime();
      const leadTime = (this.settings?.back_lead_minutes || 30) * 60 * 1000;
      const windowStartTime = kickoff - leadTime; // When trade window opens
      const delay = windowStartTime - now;
      
      // Check if trade window is already open (or about to open within 10s)
      if (delay <= 10000) {
        this.logger.log(`[strategy:epl_under25] Trade window is OPEN - process scheduled trades now`);
        return 0; // Trade window is open/opening - process immediately
      }
      
      // Cap between 1 minute and 24 hours
      const cappedDelay = Math.max(60 * 1000, Math.min(delay, 24 * 60 * 60 * 1000));
      const kickoffDate = new Date(scheduledTrades[0].kickoff_at);
      this.logger.log(`[strategy:epl_under25] Next fixture: ${kickoffDate.toISOString()} (wake in ${(cappedDelay/60000).toFixed(1)} min)`);
      return cappedDelay;
    }
    
    // Priority 4: No scheduled trades - resync fixtures in 24h
    this.logger.log('[strategy:epl_under25] No scheduled trades - sleeping until fixture resync (24h)');
    return 24 * 60 * 60 * 1000;
  }

  /**
   * Smart scheduler loop - only polls when needed
   * Handles: sleeping between fixtures, waking for bets, starting/stopping active polling
   */
  async smartSchedulerLoop() {
    // Prevent concurrent execution
    if (this.syncingFixtures || this.processingScheduled) {
      this.smartSchedulerTimer = setTimeout(() => this.smartSchedulerLoop(), 10000);
      return;
    }
    
    try {
      const nextWake = await this.calculateNextWakeTime();
      
      if (nextWake === 0) {
        // Immediate action needed - trade window is open or in-play games active
        
        // Check if we need active polling (for in-play games)
        const { data: activeTrades } = await this.supabase
          .from('strategy_trades')
          .select('id')
          .eq('strategy_key', STRATEGY_KEY)
          .in('status', ['back_pending', 'back_matched', 'hedge_pending'])
          .limit(1);
        
        if (activeTrades?.length > 0) {
          // Start 5s active polling if not running
          if (!this.activePollingTimer) {
            this.startActivePolling();
          }
        }
        
        // Process scheduled trades (place bets if in window)
        await this.processScheduledTrades('smart-scheduler');
        
        // IMPORTANT: Recalculate next wake time instead of blindly checking every 30s
        // After placing bets, we should sleep until kickoff (when back_pending orders need checking)
        // This prevents wasting resources polling games outside the window
        // Changed from 5s to 1 minute to reduce API calls when trade window is open
        this.smartSchedulerTimer = setTimeout(() => this.smartSchedulerLoop(), 60 * 1000);
        
      } else {
        // More than 5 minutes away - go to sleep
        const wakeMinutes = (nextWake / 60000).toFixed(1);
        this.logger.log(`[strategy:epl_under25] Smart scheduler: SLEEPING for ${wakeMinutes} minutes (no games need attention)`);
        
        // Stop active polling if running (no in-play games)
        this.stopActivePolling();
        
        // Sleep until calculated wake time
        // IMPORTANT: When we wake up, we MUST check if trade window is open
        this.smartSchedulerTimer = setTimeout(() => {
          this.logger.log(`[strategy:epl_under25] Smart scheduler: WAKING UP - checking for work`);
          // Immediately recalculate and process - don't wait for next cycle
          this.smartSchedulerLoop();
        }, nextWake);
      }
      
    } catch (err) {
      this.logger.error(`[strategy:epl_under25] Smart scheduler error: ${err.message}`, err);
      // On error, retry in 1 minute (safe fallback)
      this.smartSchedulerTimer = setTimeout(() => this.smartSchedulerLoop(), 60000);
    }
  }

  /**
   * Start active 30-second polling for in-play games
   * Only called when games are actually in-play
   */
  startActivePolling() {
    if (this.activePollingTimer) return; // Already running
    
    this.logger.log('[strategy:epl_under25] ▶ STARTING active 30s polling (in-play games detected)');
    
    this.activePollingTimer = setInterval(() => {
      this.processActiveTrades('smart-active').catch(this.logError('processActiveTrades'));
    }, 30 * 1000);
    
    // Run immediately
    this.processActiveTrades('smart-active-immediate').catch(this.logError('processActiveTrades'));
  }

  /**
   * Stop active 30-second polling when no in-play games
   * Saves database queries
   */
  stopActivePolling() {
    if (this.activePollingTimer) {
      this.logger.log('[strategy:epl_under25] ⏸ STOPPING active 30s polling (no in-play games)');
      clearInterval(this.activePollingTimer);
      this.activePollingTimer = null;
    }
  }

  // --- Safe API Wrappers (1 Retry) ---

  async requireSessionWithRetry(label) {
    try {
      return await this.betfair.requireSession(label);
    } catch (err) {
      this.logger.warn(`[strategy:epl_under25] Session retry needed for ${label}: ${err.message}`);
      return await this.betfair.requireSession(label);
    }
  }

  async rpcWithRetry(sessionToken, method, params, label) {
    const isInvalidSessionError = (err) => {
      const msg = err && err.message ? err.message : String(err);
      return /INVALID_SESSION_INFORMATION|ANGX-0003/i.test(msg);
    };

    try {
      return await this.betfair.rpc(sessionToken, method, params);
    } catch (err) {
      this.logger.warn(`[strategy:epl_under25] RPC retry needed for ${label} (${method}): ${err.message}`);
      try {
        if (isInvalidSessionError(err) && typeof this.betfair.invalidateSession === 'function') {
          this.logger.warn(`[strategy:epl_under25] Invalid session detected for ${label}; re-authenticating...`);
          this.betfair.invalidateSession();
          const newToken = await this.requireSessionWithRetry(`reauth-${label}`);
          return await this.betfair.rpc(newToken, method, params);
        }

        // Fallback: retry call once with the same token (transient failure)
        return await this.betfair.rpc(sessionToken, method, params);
      } catch (err2) {
        this.logger.error(`[strategy:epl_under25] Emergency Exit: ${label} ${err2.message}`);
        throw err2; // Throw to be caught by caller to skip tick
      }
    }
  }

  async getMarketBookSafe(marketId, sessionToken, label) {
    try {
      const books = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listMarketBook', {
        marketIds: [marketId],
        priceProjection: { priceData: ['EX_BEST_OFFERS'] },
      }, label);
      return books?.[0];
    } catch (err) {
      return null; // Return null on failure to skip gracefully
    }
  }

  async getOrderStatusSafe(betId, sessionToken, label) {
    if (!betId) return null;
    try {
      const res = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCurrentOrders', {
        betIds: [betId],
        orderProjection: 'ALL',
      }, label);
      const order = res?.currentOrders?.[0];
      return order?.status;
    } catch (err) {
      return null;
    }
  }

  /**
   * Get full order details including matched/remaining sizes
   * CRITICAL: Use this to verify actual matched amounts before settling
   */
  async getOrderDetailsSafe(betId, sessionToken, label) {
    if (!betId) return null;
    try {
      const res = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCurrentOrders', {
        betIds: [betId],
        orderProjection: 'ALL',
      }, label);
      const order = res?.currentOrders?.[0];
      if (!order) {
        // Order not in current orders - might be cleared/cancelled
        return null;
      }
      return {
        status: order.status,
        sizeMatched: order.sizeMatched || 0,
        sizeRemaining: order.sizeRemaining || 0,
        averagePriceMatched: order.averagePriceMatched || order.price,
        betId: order.betId,
        side: order.side,
        price: order.price,
      };
    } catch (err) {
      this.logger.error(`[strategy:epl_under25] getOrderDetailsSafe error: ${err.message}`);
      return null;
    }
  }

  /**
   * Handle lay order cancelled/failed - decide next action based on current price
   * - If no goal detected (price stable): Re-place profit target lay
   * - If goal detected (30% spike): Move to EVENT_WAIT/RECOVERY phase
   */
  async placeEmergencyHedge(trade, sessionToken, market, state) {
    const backMatched = trade.back_matched_size || trade.back_size || 0;
    const backPrice = trade.back_price;
    
    if (backMatched <= 0) {
      this.logger.log(`[strategy:epl_under25] No back exposure - no action needed`);
      return;
    }
    
    const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'rehedge-book');
    const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
    const currentBackPrice = runner?.ex?.availableToBack?.[0]?.price;
    const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;
    
    if (!currentBackPrice || !currentLayPrice) {
      this.logger.error(`[strategy:epl_under25] ❌ No prices available - POSITION EXPOSED`);
      await this.updateTrade(trade.id, {
        last_error: 'REHEDGE_FAILED_NO_PRICE',
        state_data: { ...state, rehedge_failed: true, failed_at: new Date().toISOString() },
      });
      await this.logEvent(trade.id, 'REHEDGE_FAILED', {
        reason: 'NO_PRICES',
        back_exposure: backMatched,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    
    // Check if this looks like a goal (30% price spike from stable price)
    const stablePrice = state.last_stable_price || backPrice;
    const priceChangePct = ((currentBackPrice - stablePrice) / stablePrice) * 100;
    const goalThreshold = 30; // 30% spike = likely goal
    
    this.logger.log(`[strategy:epl_under25] Lay order cancelled - checking situation: current=${currentBackPrice}, stable=${stablePrice}, change=${priceChangePct.toFixed(1)}%`);
    
    if (priceChangePct >= goalThreshold) {
      // GOAL DETECTED - Move to EVENT_WAIT phase (same as normal goal detection)
      this.logger.log(`[strategy:epl_under25] 🎯 GOAL DETECTED during suspension (${priceChangePct.toFixed(1)}% spike) - moving to EVENT_WAIT`);
      
      state.phase = 'EVENT_WAIT';
      state.spike_start_ts = Date.now();
      state.peak_price = currentBackPrice;
      state.lay_cancelled_during_goal = true;
      
      await this.updateTrade(trade.id, {
        state_data: state,
        last_error: null,
      });
      
      await this.logEvent(trade.id, 'GOAL_DETECTED_LAY_CANCELLED', {
        price_change_pct: priceChangePct,
        current_price: currentBackPrice,
        stable_price: stablePrice,
        action: 'MOVING_TO_EVENT_WAIT',
        timestamp: new Date().toISOString(),
      });
      
      // Will be handled by EVENT_WAIT phase on next tick
      return;
    }
    
    // NO GOAL - Price is stable, re-place original profit target lay
    this.logger.log(`[strategy:epl_under25] Price stable (${priceChangePct.toFixed(1)}% change) - re-placing profit target lay`);
    
    const targetPrice = computeTargetLayPrice(backPrice, this.settings);
    const { layStake } = this.calculateHedgeStakeFromBook(book, market.selectionId, trade, targetPrice);
    
    if (layStake <= 0) {
      this.logger.error(`[strategy:epl_under25] Invalid lay stake calculated: ${layStake}`);
      return;
    }
    
    const placeRes = await this.placeLimitLaySafe(market.marketId, market.selectionId, layStake, targetPrice, sessionToken, 'replace-profit-lay');
    
    if (placeRes.status === 'SUCCESS') {
      this.logger.log(`[strategy:epl_under25] ✓ Profit lay RE-PLACED @ ${targetPrice} (betId: ${placeRes.betId})`);
      
      // Continue in MONITORING phase with new order
      state.phase = 'MONITORING';
      state.profit_order_id = placeRes.betId;
      state.lay_snapshot = { stake: layStake, price: targetPrice };
      state.lay_replaced = true;
      
      await this.updateTrade(trade.id, {
        lay_order_ref: placeRes.betId,
        lay_price: targetPrice,
        lay_size: layStake,
        lay_placed_at: new Date().toISOString(),
        state_data: state,
        last_error: null,
      });
      
      await this.logEvent(trade.id, 'LAY_REPLACED', {
        betId: placeRes.betId,
        lay_price: targetPrice,
        lay_stake: layStake,
        reason: 'ORIGINAL_CANCELLED_NO_GOAL',
        timestamp: new Date().toISOString(),
      });
    } else {
      this.logger.error(`[strategy:epl_under25] ❌ Re-place profit lay FAILED: ${placeRes.errorCode}`);
      await this.updateTrade(trade.id, {
        last_error: `LAY_REPLACE_FAILED: ${placeRes.errorCode}`,
        state_data: { ...state, lay_replace_failed: true },
      });
      await this.logEvent(trade.id, 'LAY_REPLACE_FAILED', {
        errorCode: placeRes.errorCode,
        back_exposure: backMatched,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Cancel an order on Betfair.
   * @param {string} betId - The bet ID to cancel
   * @param {string} marketId - The market ID (REQUIRED by Betfair API)
   * @param {string} sessionToken - Session token
   * @param {string} label - Label for logging
   * @returns {Promise<{status: string, errorCode?: string, sizeCancelled?: number}>}
   */
  async cancelOrderSafe(betId, marketId, sessionToken, label) {
    if (!betId) {
      return { status: 'FAILED', errorCode: 'NO_BET_ID' };
    }
    if (!marketId) {
      this.logger.error(`[strategy:epl_under25] cancelOrderSafe: marketId is required for bet ${betId}`);
      return { status: 'FAILED', errorCode: 'NO_MARKET_ID' };
    }
    try {
      const res = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/cancelOrders', {
        marketId,
        instructions: [{ betId }],
      }, label);
      
      const report = res?.instructionReports?.[0];
      if (report && report.status === 'SUCCESS') {
        return { 
          status: 'SUCCESS', 
          sizeCancelled: report.sizeCancelled || 0,
        };
      }
      
      // API returned failure
      const errorCode = report?.errorCode || res?.errorCode || 'UNKNOWN';
      this.logger.warn(`[strategy:epl_under25] cancelOrderSafe failed for bet ${betId}: ${errorCode}`);
      return { status: 'FAILED', errorCode };
    } catch (err) {
      this.logger.error(`[strategy:epl_under25] cancelOrderSafe exception for bet ${betId}: ${err.message}`);
      return { status: 'FAILED', errorCode: 'EXCEPTION' };
    }
  }

  /**
   * Cancel an order and CONFIRM it is no longer executable (prevents double-exposure).
   * Polls listCurrentOrders until the order is closed or timeout.
   *
   * @param {string} betId - The bet ID to cancel
   * @param {string} marketId - The market ID (REQUIRED by Betfair API)
   * @param {string} sessionToken - Session token
   * @param {string} label - Label for logging
   * @param {Object} opts - Options: confirmMs, pollMs, maxCancelAttempts, notFoundThreshold
   * @returns {Promise<{closed: boolean, attempts: number, elapsed_ms: number, last_details: any, reason: string, errorCode?: string}>}
   */
  async cancelOrderAndConfirm(betId, marketId, sessionToken, label, opts = {}) {
    const confirmMs = typeof opts.confirmMs === 'number' ? opts.confirmMs : 10000;
    const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : 500;
    const maxCancelAttempts = typeof opts.maxCancelAttempts === 'number' ? opts.maxCancelAttempts : 3;
    const notFoundThreshold = typeof opts.notFoundThreshold === 'number' ? opts.notFoundThreshold : 3;

    if (!betId) {
      return { closed: true, attempts: 0, elapsed_ms: 0, last_details: null, reason: 'NO_BET_ID' };
    }
    
    if (!marketId) {
      this.logger.error(`[strategy:epl_under25] cancelOrderAndConfirm: marketId is required for bet ${betId}`);
      return { closed: false, attempts: 0, elapsed_ms: 0, last_details: null, reason: 'NO_MARKET_ID', errorCode: 'NO_MARKET_ID' };
    }

    const start = Date.now();
    const deadline = start + confirmMs;
    let attempts = 0;
    let consecutiveNotFound = 0;
    let lastDetails = null;

    while (Date.now() < deadline && attempts < maxCancelAttempts) {
      attempts += 1;
      
      // Call cancelOrderSafe and check for IMMEDIATE API failure
      const cancelRes = await this.cancelOrderSafe(betId, marketId, sessionToken, `${label}-cancel-${attempts}`);
      
      if (cancelRes && cancelRes.status === 'FAILED') {
        // Betfair API rejected the cancel request immediately
        this.logger.error(`[strategy:epl_under25] Cancel API FAILED for bet ${betId}: ${cancelRes.errorCode}`);
        
        // Check if the order might already be closed (e.g., BET_TAKEN_OR_LAPSED)
        const checkDetails = await this.getOrderDetailsSafe(betId, sessionToken, `${label}-post-fail-check`);
        if (!checkDetails || checkDetails.status !== 'EXECUTABLE' || (checkDetails.sizeRemaining || 0) === 0) {
          // Order is already closed - treat as success
          return {
            closed: true,
            attempts,
            elapsed_ms: Date.now() - start,
            last_details: checkDetails,
            reason: 'ALREADY_CLOSED_AFTER_FAIL',
          };
        }
        
        // If this is a permanent error (not transient), don't keep retrying
        const permanentErrors = ['BET_ACTION_ERROR', 'INVALID_BET_ID', 'NO_MARKET_ID'];
        if (permanentErrors.includes(cancelRes.errorCode)) {
          return {
            closed: false,
            attempts,
            elapsed_ms: Date.now() - start,
            last_details: checkDetails,
            reason: 'PERMANENT_API_ERROR',
            errorCode: cancelRes.errorCode,
          };
        }
        
        // Transient error - continue to next attempt after a short wait
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }

      // Poll until closed or until we decide to re-issue cancel
      while (Date.now() < deadline) {
        const details = await this.getOrderDetailsSafe(betId, sessionToken, `${label}-check-${attempts}`);

        if (!details) {
          consecutiveNotFound += 1;
          if (consecutiveNotFound >= notFoundThreshold) {
            return {
              closed: true,
              attempts,
              elapsed_ms: Date.now() - start,
              last_details: lastDetails,
              reason: 'NOT_FOUND_CONSECUTIVE',
            };
          }
        } else {
          consecutiveNotFound = 0;
          lastDetails = details;

          // "Closed" = no remaining size OR not executable (EXECUTION_COMPLETE / CANCELLED / etc.)
          if ((details.sizeRemaining || 0) === 0 || details.status !== 'EXECUTABLE') {
            return {
              closed: true,
              attempts,
              elapsed_ms: Date.now() - start,
              last_details: details,
              reason: 'CLOSED_OR_NOT_EXECUTABLE',
            };
          }
        }

        await new Promise((r) => setTimeout(r, pollMs));

        // If still EXECUTABLE with remaining after some polling, break to re-issue cancel
        if (lastDetails && lastDetails.status === 'EXECUTABLE' && (lastDetails.sizeRemaining || 0) > 0) {
          // Re-issue cancel after ~2s of polling
          const polledMs = Date.now() - start;
          if (polledMs >= attempts * 2000) break;
        }
      }
    }

    return {
      closed: false,
      attempts,
      elapsed_ms: Date.now() - start,
      last_details: lastDetails,
      reason: 'NOT_CONFIRMED_BEFORE_DEADLINE',
    };
  }

  async placeLimitLaySafe(marketId, selectionId, size, price, sessionToken, label, persistenceType = 'LAPSE') {
    const customerRef = `LAY-${Date.now()}`;
    try {
      const placeRes = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/placeOrders', {
        marketId,
        customerRef,
        instructions: [
          {
            selectionId,
            side: 'LAY',
            orderType: 'LIMIT',
            limitOrder: {
              size,
              price,
              persistenceType,
            },
          },
        ],
      }, label);
      const report = placeRes?.instructionReports?.[0];
      if (report && report.status === 'SUCCESS') {
        return { status: 'SUCCESS', betId: report.betId };
      }
      return { status: 'FAILED', errorCode: report?.errorCode || placeRes?.errorCode };
    } catch (err) {
      return { status: 'FAILED', errorCode: 'EXCEPTION' };
    }
  }

  /**
   * Place order with verification and retry logic
   * GUARDRAIL: Verifies order placement succeeded, retries if cancelled due to suspension
   * 
   * @param {Object} params - Order parameters
   * @param {string} params.marketId - Market ID
   * @param {number} params.selectionId - Selection ID
   * @param {number} params.stake - Order stake
   * @param {number} params.price - Order price
   * @param {string} params.sessionToken - Betfair session token
   * @param {string} params.label - Log label
   * @param {string} params.persistenceType - Persistence type (LAPSE or PERSIST)
   * @param {number} params.maxRetries - Max retry attempts (default 3)
   * @param {number} params.verifyDelayMs - Delay before verification (default 1000ms)
   * @returns {Object} { status: 'SUCCESS'|'FAILED', betId, matchedSize, error }
   */
  /**
   * Place order with lightweight verification (no blocking delay)
   * GUARDRAIL: Returns immediately, continuous monitoring handles retries
   * 
   * NOTE: We skip the verification delay to avoid slowing down the bot.
   * The RECOVERY_PENDING and MONITORING phases already check order status
   * on every poll cycle and will retry if cancelled.
   */
  async placeLayOrderWithVerification({ marketId, selectionId, stake, price, sessionToken, label, persistenceType = 'LAPSE', maxRetries = 1, verifyDelayMs = 0 }) {
    // Place the order (single attempt - retries handled by state machine)
    const placeRes = await this.placeLimitLaySafe(marketId, selectionId, stake, price, sessionToken, label, persistenceType);
    
    if (placeRes.status !== 'SUCCESS') {
      this.logger.warn(`[strategy:epl_under25] Order placement failed: ${placeRes.errorCode}`);
      return { status: 'FAILED', error: placeRes.errorCode, attempts: 1 };
    }
    
    this.logger.log(`[strategy:epl_under25] Order placed: ${placeRes.betId} @ ${price}`);
    
    // Return immediately - state machine polling will verify and retry if needed
    return {
      status: 'SUCCESS',
      betId: placeRes.betId,
      matchedSize: 0,
      remainingSize: stake,
      orderStatus: 'EXECUTABLE',
      attempts: 1,
    };
  }

  calculateHedgeStakeFromBook(book, selectionId, trade, overrideLayPrice = null) {
    return calculateHedgeStake(
      book,
      selectionId,
      trade.back_matched_size || trade.back_size,
      trade.back_price,
      this.settings.commission_rate || this.defaults.commission_rate,
      overrideLayPrice
    );
  }

  // --- Core Logic ---

  async ensureSettings() {
    const { data, error } = await this.supabase
      .from('strategy_settings')
      .select('*')
      .eq('strategy_key', STRATEGY_KEY)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;

    if (!data) {
      const insert = {
        strategy_key: STRATEGY_KEY,
        enabled: true,
        default_stake: this.defaults.default_stake,
        fixture_lookahead_days: this.defaults.fixture_lookahead_days,
        commission_rate: this.defaults.commission_rate,
        extra: {
          min_back_price: this.defaults.min_back_price,
          min_profit_pct: this.defaults.min_profit_pct,
          back_lead_minutes: this.defaults.back_lead_minutes,
          lay_ticks_below_back: this.defaults.lay_ticks_below_back,
          lay_persistence: this.defaults.lay_persistence,
          stop_loss_wait_seconds: this.defaults.stop_loss_wait_seconds,
          stop_loss_pct: this.defaults.stop_loss_pct,
          min_market_liquidity: this.defaults.min_market_liquidity,
        },
      };
      const { data: created, error: insertErr } = await this.supabase
        .from('strategy_settings')
        .insert(insert)
        .select()
        .single();
      if (insertErr) throw insertErr;
      // Flatten `extra` but prevent it from shadowing top-level columns.
      const createdExtra = created.extra || {};
      const {
        enabled: _enabled,
        default_stake: _defaultStake,
        fixture_lookahead_days: _fixtureLookaheadDays,
        commission_rate: _commissionRate,
        ...createdExtraFlat
      } = createdExtra;
      this.settings = { ...created, ...createdExtraFlat };
    } else {
      // Merge top-level and extra fields (extra takes precedence)
      // Flatten `extra` but prevent it from shadowing top-level columns.
      const existingExtra = data.extra || {};
      const {
        enabled: _enabled,
        default_stake: _defaultStake,
        fixture_lookahead_days: _fixtureLookaheadDays,
        commission_rate: _commissionRate,
        ...existingExtraFlat
      } = existingExtra;
      this.settings = { ...data, ...existingExtraFlat };
      
      // Code defaults are the source of truth: auto-sync to database (one-way).
      const updates = {};
      const extraUpdates = {};
      let needsUpdate = false;
      
      // Top-level columns
      if (data.default_stake !== this.defaults.default_stake) {
        this.logger.log(`[strategy:epl_under25] Syncing default_stake: ${data.default_stake} → ${this.defaults.default_stake} (from code defaults)`);
        updates.default_stake = this.defaults.default_stake;
        needsUpdate = true;
      }
      if (data.fixture_lookahead_days !== this.defaults.fixture_lookahead_days) {
        this.logger.log(`[strategy:epl_under25] Syncing fixture_lookahead_days: ${data.fixture_lookahead_days} → ${this.defaults.fixture_lookahead_days} (from code defaults)`);
        updates.fixture_lookahead_days = this.defaults.fixture_lookahead_days;
        needsUpdate = true;
      }
      if (data.commission_rate !== this.defaults.commission_rate) {
        this.logger.log(`[strategy:epl_under25] Syncing commission_rate: ${data.commission_rate} → ${this.defaults.commission_rate} (from code defaults)`);
        updates.commission_rate = this.defaults.commission_rate;
        needsUpdate = true;
      }
      
      // Strategy-specific settings in `extra` JSON
      const extraKeys = [
        'min_back_price',
        'min_profit_pct',
        'back_lead_minutes',
        'lay_ticks_below_back',
        'lay_persistence',
        'stop_loss_wait_seconds',
        'stop_loss_pct',
        'min_market_liquidity',
      ];
      for (const k of extraKeys) {
        // Match goal-react behavior: if missing or different, sync to defaults.
        // (This also backfills new keys into `extra` on existing rows.)
        if (this.settings[k] !== this.defaults[k]) {
          this.logger.log(`[strategy:epl_under25] Syncing ${k}: ${this.settings[k]} → ${this.defaults[k]} (from code defaults)`);
          extraUpdates[k] = this.defaults[k];
          needsUpdate = true;
        }
      }
      
      if (needsUpdate) {
        if (Object.keys(extraUpdates).length > 0) {
          // Merge with existing extra
          const currentExtra = data.extra || {};
          updates.extra = { ...currentExtra, ...extraUpdates };
        }
        
        const { error: updateErr } = await this.supabase
          .from('strategy_settings')
          .update(updates)
          .eq('strategy_key', STRATEGY_KEY);
        if (updateErr) throw updateErr;
        
        // Update local settings
        Object.assign(this.settings, updates);
        if (updates.extra) {
          Object.assign(this.settings, updates.extra);
        }
      }
    }
  }

  async refreshSettings() {
    const { data, error } = await this.supabase
      .from('strategy_settings')
      .select('*')
      .eq('strategy_key', STRATEGY_KEY)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    if (data) {
      // Keep the same flattened shape as ensureSettings() for downstream logic.
      const extra = data.extra || {};
      const {
        enabled: _enabled,
        default_stake: _defaultStake,
        fixture_lookahead_days: _fixtureLookaheadDays,
        commission_rate: _commissionRate,
        ...extraFlat
      } = extra;
      this.settings = { ...data, ...extraFlat };
    }
  }

  watchSettings(intervalMs = 5 * 60 * 1000) {
    const run = async () => {
      try {
        await this.refreshSettings();
      } catch (err) {
        this.logger.warn('[strategy:epl_under25] settings refresh failed:', err && err.message ? err.message : err);
      }
    };

    run();
    this.timers.push(setInterval(run, intervalMs));
  }

  async syncFixtures(trigger = 'manual') {
    if (this.syncingFixtures) return;
    this.syncingFixtures = true;
    try {
      if (!this.settings?.enabled) return;

      const now = new Date();
      const lookaheadDays = this.settings.fixture_lookahead_days || this.defaults.fixture_lookahead_days;
      const windowEnd = addDays(now, lookaheadDays);

      const sessionToken = await this.requireSessionWithRetry(`fixtures-${trigger}`);

      // 1. Get competitions - find league competition IDs
      const competitionsRes = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCompetitions', {
        filter: { eventTypeIds: [SOCCER_EVENT_TYPE_ID] },
      }, 'listCompetitions');

      this.logger.log(`[strategy:epl_under25] Fetched ${competitionsRes?.length || 0} soccer competitions from Betfair`);
      // Match competitions by name using regex
      const matchedCompetitions = (competitionsRes || [])
        .filter((c) => COMPETITION_MATCHERS.some((rx) => rx.test(c.competition?.name || '')));

      if (matchedCompetitions.length > 0) {
        this.logger.log(`[strategy:epl_under25] ✓ Matched competitions: ${matchedCompetitions.map(c => `"${c.competition?.name}" (ID: ${c.competition?.id})`).join(', ')}`);
      } else {
        this.logger.warn(`[strategy:epl_under25] ⚠️ No competitions matched regex patterns: ${COMPETITION_MATCHERS.map(r => r.toString()).join(', ')}`);
        this.logger.log(`[strategy:epl_under25] Available competitions (first 15): ${(competitionsRes || []).slice(0,15).map(c => `"${c.competition?.name}" (ID: ${c.competition?.id})`).join(', ')}`);
      }

      const matchedCompetitionIds = matchedCompetitions
        .map((c) => c.competition?.id)
        .filter(Boolean);

      // Build competition ID -> name map for later use
      const competitionIdToName = new Map();
      matchedCompetitions.forEach(c => {
        if (c.competition?.id && c.competition?.name) {
          competitionIdToName.set(String(c.competition.id), c.competition.name);
        }
      });

      // Use matched IDs, fallback to hardcoded competition IDs if no regex match
      let competitionIds = matchedCompetitionIds;
      if (competitionIds.length === 0) {
        this.logger.warn(`[strategy:epl_under25] Using hardcoded competition IDs: ${COMPETITION_IDS.join(', ')}`);
        competitionIds = COMPETITION_IDS;
        // Add hardcoded names for fallback
        competitionIds.forEach(id => {
          if (!competitionIdToName.has(id)) {
            if (id === '10932509') competitionIdToName.set(id, 'English Premier League');
            else if (id === '59') competitionIdToName.set(id, 'German Bundesliga');
            else if (id === '117') competitionIdToName.set(id, 'Spanish La Liga');
            else if (id === '81') competitionIdToName.set(id, 'Italian Serie A');
            else if (id === '228') competitionIdToName.set(id, 'UEFA Champions League');
            else if (id === '2005') competitionIdToName.set(id, 'UEFA Europa League');
            else if (id === '12209528') competitionIdToName.set(id, 'Africa Cup of Nations');
            else if (id === '7129730') competitionIdToName.set(id, 'English Sky Bet Championship');
            else if (id === '12117172') competitionIdToName.set(id, 'Australian A-League Men');
            else if (id === '55') competitionIdToName.set(id, 'French Ligue 1');
            else if (id === '105') competitionIdToName.set(id, 'Scottish Premiership');
            else if (id === '99') competitionIdToName.set(id, 'Portuguese Primeira Liga');
            else if (id === '30558') competitionIdToName.set(id, 'English FA Cup');
            else if (id === '12209520') competitionIdToName.set(id, 'Spanish Super Cup');
            else if (id === '2134') competitionIdToName.set(id, 'English Football League Cup');
          }
        });
      }

      if (!competitionIds.length) {
        this.logger.error(`[strategy:${STRATEGY_KEY}] CRITICAL: No competition IDs available - cannot proceed`);
        return;
      }

      this.logger.log(`[strategy:epl_under25] Using competition IDs for event sync: ${competitionIds.join(', ')}`);

      // 2. Get events - Betfair API filters by competitionIds, ensuring only matched league events
      const eventsRes = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listEvents', {
        filter: {
          eventTypeIds: [SOCCER_EVENT_TYPE_ID],
          competitionIds, // Betfair will only return events from these competition IDs
          marketStartTime: {
            from: now.toISOString(),
            to: windowEnd.toISOString(),
          },
        },
        maxResults: 100,
      }, 'listEvents');

      this.logger.log(`[strategy:epl_under25] listEvents returned ${eventsRes?.length || 0} events for competition IDs: ${competitionIds.join(', ')}`);
      
      // Fetch market catalogues to get competition info for each event
      // listEvents doesn't include competition info, so we need to get it from markets
      const eventIds = (eventsRes || []).map(evt => evt.event?.id).filter(Boolean);
      const eventIdToCompetition = new Map();
      
      if (eventIds.length > 0) {
        try {
          const marketCatalogues = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listMarketCatalogue', {
            filter: {
              eventIds: eventIds,
              marketTypeCodes: ['OVER_UNDER_25'],
            },
            maxResults: 1000,
            marketProjection: ['EVENT', 'COMPETITION'],
          }, 'listMarketCatalogue-competition');
          
          // Extract competition info from market catalogues
          (marketCatalogues || []).forEach(market => {
            if (market.event?.id && market.competition?.id && market.competition?.name) {
              const compName = competitionIdToName.get(String(market.competition.id)) || market.competition.name;
              eventIdToCompetition.set(market.event.id, compName);
            }
          });
        } catch (err) {
          this.logger.warn(`[strategy:epl_under25] Failed to fetch competition info from markets: ${err.message}`);
        }
      }
      
      // Build fixture map - all events are from matched leagues because of competitionIds filter
      const fixtureMap = new Map();
      
      (eventsRes || []).forEach((evt) => {
        if (!evt?.event?.id) return;
        
        const eventName = evt.event.name || '';
        const parts = eventName.split(' v ');
        const home = parts[0]?.trim() || null;
        const away = parts[1]?.trim() || null;
        
        // Get competition name from event-to-competition map or fallback
        let competitionName = eventIdToCompetition.get(evt.event.id);
        if (!competitionName) {
          // Fallback: if only one competition matched, use that name
          if (competitionIdToName.size === 1) {
            competitionName = Array.from(competitionIdToName.values())[0];
          } else {
            competitionName = 'Multiple Leagues'; // Generic fallback
          }
        }
        
        this.logger.log(`[strategy:epl_under25] Adding fixture (${competitionName}): ${eventName} (kickoff: ${evt.event?.openDate})`);
        
        fixtureMap.set(evt.event.id, {
          strategy_key: STRATEGY_KEY,
          betfair_event_id: evt.event.id,
          event_id: evt.event.id,
          competition: competitionName,
          home,
          away,
          kickoff_at: evt.event?.openDate,
          metadata: evt,
        });
      });

      const fixtures = Array.from(fixtureMap.values());
      const validEventIds = new Set(fixtures.map((f) => f.betfair_event_id));

      this.logger.log(`[strategy:epl_under25] Fixtures sync found ${fixtures.length} events.`);
      if (fixtures.length > 0) {
        const sample = fixtures.slice(0, 3).map(f => `${f.home} v ${f.away}`).join(', ');
        this.logger.log(`[strategy:epl_under25] Sample events: ${sample}`);
      }

      if (fixtures.length === 0) {
        return;
      }

      const { error: upsertErr } = await this.supabase
        .from('strategy_fixtures')
        .upsert(fixtures, { onConflict: 'strategy_key,betfair_event_id' });
      if (upsertErr) throw upsertErr;

      // Drop fixtures that have already kicked off
      const { error: pruneErr } = await this.supabase
        .from('strategy_fixtures')
        .delete()
        .eq('strategy_key', STRATEGY_KEY)
        .lt('kickoff_at', now.toISOString());
      if (pruneErr && pruneErr.code !== 'PGRST204') throw pruneErr;

      // Ensure trade records exist for all fixtures (creates or reactivates)
      for (const fixture of fixtures) {
        try {
          await this.ensureTradeRecord(fixture);
        } catch (err) {
          this.logger.error(`[strategy:epl_under25] Failed to ensure trade record for ${fixture.betfair_event_id}: ${err.message}`);
          // Continue processing other fixtures even if one fails
        }
      }
    } catch (err) {
      this.logger.error(`[strategy:epl_under25] Fixtures sync error: ${err.message}`);
    } finally {
      this.syncingFixtures = false;
      // If adaptive mode is on, re-schedule after sync as we might have new fixtures
      if (process.env.EPL_UNDER25_SCHEDULER_MODE === 'adaptive') {
        this.scheduleNextTradeCheck();
      }
    }
  }

  async ensureTradeRecord(fixture) {
    // Define variables at the top to avoid ReferenceError
    const competitionName = fixture.competition || 'Unknown';
    const eventName = formatFixtureName(fixture.home, fixture.away, fixture.event_id || fixture.betfair_event_id);
    
    const { data: existing, error } = await this.supabase
      .from('strategy_trades')
      .select('id, status')
      .eq('strategy_key', STRATEGY_KEY)
      .eq('betfair_event_id', fixture.betfair_event_id)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    
    // If trade exists and is active, return it
    if (existing && existing.status === 'scheduled') {
      return existing.id;
    }
    
    // If trade exists but is cancelled, reactivate it
    if (existing && existing.status === 'cancelled') {
      this.logger.log(`[strategy:epl_under25] Reactivating cancelled trade for event ${fixture.betfair_event_id}`);
      await this.supabase
        .from('strategy_trades')
        .update({
          status: 'scheduled',
          kickoff_at: fixture.kickoff_at,
          last_error: null,
          competition_name: competitionName,
          event_name: eventName,
        })
        .eq('id', existing.id);
      await this.logEvent(existing.id, 'TRADE_REACTIVATED', { fixture });
      return existing.id;
    }
    
    // If trade exists with other status (back_pending, back_matched, etc), ensure snapshot columns exist
    if (existing) {
      if (!existing.competition_name || !existing.event_name) {
        await this.supabase
          .from('strategy_trades')
          .update({
            competition_name: competitionName,
            event_name: eventName,
          })
          .eq('id', existing.id);
      }
      return existing.id;
    }

    // Create new trade record
    const insert = {
      strategy_key: STRATEGY_KEY,
      betfair_event_id: fixture.betfair_event_id,
      event_id: fixture.event_id,
      runner_name: UNDER_RUNNER_NAME,
       competition_name: competitionName,
       event_name: eventName,
      kickoff_at: fixture.kickoff_at,
      status: 'scheduled',
      target_stake: this.settings.default_stake,
      hedge_target_price: null, // Will be computed when back is matched
    };
    const { data, error: insertErr } = await this.supabase
      .from('strategy_trades')
      .insert(insert)
      .select('id')
      .single();
    if (insertErr) throw insertErr;
    await this.logEvent(data.id, 'TRADE_CREATED', { fixture });
    return data.id;
  }

  async pruneFixtures(validEventIds = new Set()) {
    const keepSet = validEventIds instanceof Set ? validEventIds : new Set(validEventIds || []);
    if (!keepSet.size) {
      this.logger.log('[strategy:epl_under25] Fixture prune skipped (no league ids fetched).');
      return;
    }

    const { data: existing, error } = await this.supabase
      .from('strategy_fixtures')
      .select('betfair_event_id')
      .eq('strategy_key', STRATEGY_KEY);
    if (error && error.code !== 'PGRST116') throw error;

    const staleIds = (existing || [])
      .map((f) => f.betfair_event_id)
      .filter((id) => id && !keepSet.has(id));

    if (!staleIds.length) return;

    const { error: deleteErr } = await this.supabase
      .from('strategy_fixtures')
      .delete()
      .eq('strategy_key', STRATEGY_KEY)
      .in('betfair_event_id', staleIds);
    if (deleteErr) throw deleteErr;

    this.logger.log(`[strategy:epl_under25] Pruned ${staleIds.length} stale fixtures outside league scope.`);
  }

  async pruneStaleTrades(validEventIds = new Set()) {
    const keepSet = validEventIds instanceof Set ? validEventIds : new Set(validEventIds || []);
    if (!keepSet.size) {
      this.logger.log('[strategy:epl_under25] Trade prune skipped (no league ids fetched).');
      return;
    }

    const { data: trades, error } = await this.supabase
      .from('strategy_trades')
      .select('id, betfair_event_id, status')
      .eq('strategy_key', STRATEGY_KEY)
      .in('status', ['scheduled', 'back_pending']);
    if (error && error.code !== 'PGRST116') throw error;

    const stale = (trades || []).filter((trade) => !keepSet.has(trade.betfair_event_id));
    if (!stale.length) return;

    const staleIds = stale.map((trade) => trade.id);
    const { error: updateErr } = await this.supabase
      .from('strategy_trades')
      .update({ status: 'cancelled', last_error: 'PRUNED_OUT_OF_SCOPE' })
      .in('id', staleIds);
    if (updateErr) throw updateErr;

    for (const trade of stale) {
      await this.logEvent(trade.id, 'TRADE_PRUNED', { reason: 'OUT_OF_SCOPE', betfair_event_id: trade.betfair_event_id });
    }

    this.logger.warn(`[strategy:epl_under25] Cancelled ${staleIds.length} scheduled trades outside league scope.`);
  }

  async processScheduledTrades(trigger = 'manual') {
    if (this.processingScheduled) return;
    this.processingScheduled = true;

    // Renamed log to avoid collision with main bot
    this.logger.log(`[strategy:epl_under25] Polling scheduled trades (trigger=${trigger}, ts=${new Date().toISOString()})`);

    try {
      if (!this.settings?.enabled) return;

      const { data: trades, error } = await this.supabase
        .from('strategy_trades')
        .select('*')
        .eq('strategy_key', STRATEGY_KEY)
        .eq('status', 'scheduled')
        .order('kickoff_at', { ascending: true });

      if (error) throw error;

      const totalCount = trades?.length || 0;
      const leadTime = this.settings?.back_lead_minutes || this.defaults.back_lead_minutes;
      const now = new Date();
      const windowTrades = (trades || []).filter((trade) => {
        if (!trade?.kickoff_at) return false;
        const diff = (new Date(trade.kickoff_at).getTime() - now.getTime()) / 60000;
        return diff <= leadTime && diff > 0;
      });

      this.logger.log(`[strategy:epl_under25] Scheduled poll summary: total=${totalCount}, within_${leadTime}m=${windowTrades.length}`);

      if (!trades || trades.length === 0) {
        if (trigger === 'adaptive') this.scheduleNextTradeCheck();
        return;
      }

      // Manual fixture name lookup
      const eventIds = trades.map(t => t.betfair_event_id);
      const { data: fixtures } = await this.supabase
        .from('strategy_fixtures')
        .select('betfair_event_id, home, away')
        .eq('strategy_key', STRATEGY_KEY)
        .in('betfair_event_id', eventIds);

      const fixtureMap = {};
      if (fixtures) fixtures.forEach(f => fixtureMap[f.betfair_event_id] = `${f.home} v ${f.away}`);

      for (const trade of trades) {
        try {
          trade.fixture_name = fixtureMap[trade.betfair_event_id] || trade.event_id;
          await this.handleScheduledTrade(trade, now, trigger);
        } catch (err) {
          this.logger.error('[strategy:epl_under25] scheduled trade error:', err.message || err);
        }
      }
    } finally {
      this.processingScheduled = false;
      if (trigger === 'adaptive' || process.env.EPL_UNDER25_SCHEDULER_MODE === 'adaptive') {
        this.scheduleNextTradeCheck();
      }
    }
  }

  async scheduleNextTradeCheck() {
    if (this.scheduledTimer) clearTimeout(this.scheduledTimer);

    // Find next relevant kickoff
    const { data: trades } = await this.supabase
      .from('strategy_trades')
      .select('kickoff_at')
      .eq('strategy_key', STRATEGY_KEY)
      .eq('status', 'scheduled')
      .gt('kickoff_at', new Date().toISOString())
      .order('kickoff_at', { ascending: true })
      .limit(1);

    const leadTime = this.settings?.back_lead_minutes || this.defaults.back_lead_minutes;
    const now = Date.now();
    let nextCheck = 45 * 1000; // Default 45s

    if (trades && trades.length > 0) {
      const kickoff = new Date(trades[0].kickoff_at).getTime();
      // Wake up 30s before the window opens (leadTime)
      const targetTime = kickoff - (leadTime * 60 * 1000) - 30000;
      let delay = targetTime - now;
      
      // Clamp delay between 5s and 15m
      if (delay < 5000) delay = 5000;
      if (delay > 15 * 60 * 1000) delay = 15 * 60 * 1000;
      
      nextCheck = delay;
      this.logger.log(`[strategy:epl_under25] Next adaptive check in ${(nextCheck/1000).toFixed(1)}s`);
    }

    this.scheduledTimer = setTimeout(() => this.processScheduledTrades('adaptive').catch(this.logError('processScheduledTrades')), nextCheck);
  }

  async processActiveTrades(trigger = 'manual') {
    try {
      // Log entry FIRST before any checks
      this.logger.log(`[strategy:epl_under25] >>> Active polling tick START (trigger=${trigger}, ts=${new Date().toISOString()})`);
      
      if (this.processingActive) {
        this.logger.log('[strategy:epl_under25] Active tick: already processing, skipping');
        return;
      }
      
      this.processingActive = true;
      
      if (!this.settings) {
        this.logger.warn('[strategy:epl_under25] Active tick: settings not loaded');
        return;
      }
      
      if (!this.settings.enabled) {
        this.logger.log('[strategy:epl_under25] Active tick: strategy disabled in settings');
        return;
      }

      this.logger.log('[strategy:epl_under25] Active tick: querying strategy_trades...');
      const { data: trades, error } = await this.supabase
        .from('strategy_trades')
        .select('*')
        .eq('strategy_key', STRATEGY_KEY)
        .in('status', ['back_pending', 'back_matched', 'hedge_pending', 'post_trade_monitor'])
        .order('kickoff_at', { ascending: true });

      if (error) {
        this.logger.error(`[strategy:epl_under25] Active tick: database error: ${error.message}`);
        throw error;
      }

      // Active Loop Logging
      if (!trades || trades.length === 0) {
        this.logger.log('[strategy:epl_under25] Active tick: no active trades');
        
        // Smart mode: Stop polling if no active trades
        if (process.env.EPL_UNDER25_SCHEDULER_MODE === 'smart' || !process.env.EPL_UNDER25_SCHEDULER_MODE) {
          this.stopActivePolling();
          // Trigger smart scheduler to recalculate next wake time
          setImmediate(() => this.smartSchedulerLoop());
        }
        return;
      }

      // --- Priority Sorting: Process real-money trades FIRST ---
      // Critical: Ensures shadow monitoring never delays real trade execution
      const statusPriority = {
        // Priority 1 - Real money at risk
        'back_pending': 1,
        'back_matched': 1,
        'hedge_pending': 1,
        // Priority 2 - Shadow monitoring (data collection only)
        'post_trade_monitor': 2,
      };
      
      trades.sort((a, b) => {
        const priorityA = statusPriority[a.status] ?? 3;
        const priorityB = statusPriority[b.status] ?? 3;
        return priorityA - priorityB;
      });
      
      // Count by priority for diagnostics
      const realCount = trades.filter(t => statusPriority[t.status] === 1).length;
      const shadowCount = trades.filter(t => statusPriority[t.status] === 2).length;
      
      if (shadowCount > 0) {
        this.logger.log(`[strategy:epl_under25] 🚦 Traffic Control: ${realCount} real | ${shadowCount} shadow`);
      }

      const counts = { back_pending: 0, back_matched: 0, hedge_pending: 0, post_trade_monitor: 0 };
      trades.forEach(t => { if(counts[t.status] !== undefined) counts[t.status]++ });
      this.logger.log(`[strategy:epl_under25] Active tick: ${trades.length} trades (states: back_pending=${counts.back_pending}, back_matched=${counts.back_matched}, hedge_pending=${counts.hedge_pending}, post_trade_monitor=${counts.post_trade_monitor})`);

      const now = new Date();
      for (const trade of trades) {
        try {
          // Data capture: back_price_at_kickoff (1 min before kickoff, regardless of trade status)
          // This is purely for analysis - does not affect strategy logic
          await this.captureBackPriceAtKickoff(trade, now);
          
          if (trade.status === 'back_pending') {
            await this.checkBackOrder(trade, now);
          } else if (trade.status === 'post_trade_monitor') {
            // Shadow monitoring - separate handler with throttling
            await this.handlePostTradeMonitor(trade, now);
          } else {
            await this.runStateMachine(trade, now);
          }
        } catch (err) {
          this.logger.error(`[strategy:epl_under25] active trade error (ID:${trade.id}):`, err.message || err);
        }
      }
    } catch (err) {
      this.logger.error(`[strategy:epl_under25] processActiveTrades FATAL error: ${err?.message || err}`, err);
    } finally {
      this.processingActive = false;
      this.logger.log(`[strategy:epl_under25] <<< Active polling tick END`);
    }
  }

  async runStateMachine(trade, now) {
    let state = trade.state_data || {};
    let phase = state.phase || 'INITIAL';
    let updatedState = false;

    const sessionToken = await this.requireSessionWithRetry(`sm-phase-${phase}`);
    const market = await this.ensureMarket(trade, sessionToken);
    if (!market) return; // Market not found or invalid

    // Check if market has closed/settled (game ended)
    const book = await this.getMarketBookSafe(market.marketId, sessionToken, `phase-${phase}-book`);
    if (book && book.status === 'CLOSED') {
      // CRITICAL FIX: Market closed - verify lay order status before settling
      // Don't assume lay matched - it may have been cancelled (e.g., 3rd goal scored)
      this.logger.log(`[strategy:epl_under25] Market closed - verifying lay order status before settlement (phase: ${phase})`);
      
      // Determine which order to check (profit_order_id in MONITORING, recovery_order_id in RECOVERY_PENDING)
      const activeOrderId = state.profit_order_id || state.recovery_order_id;
      let verifiedLayStake = 0;
      let verifiedLayPrice = trade.lay_price || 0;
      
      if (activeOrderId) {
        const orderDetails = await this.getOrderDetailsSafe(activeOrderId, sessionToken, 'market-closed-verify');
        
        if (orderDetails) {
          verifiedLayStake = orderDetails.sizeMatched || 0;
          verifiedLayPrice = orderDetails.averagePriceMatched || trade.lay_price || 0;
          
          this.logger.log(`[strategy:epl_under25] Lay order ${activeOrderId} verification: matched=£${verifiedLayStake}, status=${orderDetails.status}`);
          
          if (verifiedLayStake === 0) {
            this.logger.warn(`[strategy:epl_under25] ⚠️ CRITICAL: Lay order was CANCELLED (0 matched) - recording as FULL LOSS`);
          }
        } else {
          // Order not found - likely cancelled/voided
          this.logger.warn(`[strategy:epl_under25] ⚠️ Lay order ${activeOrderId} NOT FOUND - assuming cancelled (0 matched)`);
          verifiedLayStake = 0;
        }
      } else {
        this.logger.warn(`[strategy:epl_under25] ⚠️ No active lay order to verify - phase=${phase}`);
      }
      
      // Mark as completed for settlement semantics (enables forced-loss handling when layStake is 0)
      state.phase = 'COMPLETED';

      // Settle with verified matched amounts (explicit 0 if cancelled)
      await this.settleTradeWithPnl(trade, state, {
        layStakeOverride: verifiedLayStake,
        layPriceOverride: verifiedLayPrice,
        partialLayMatched: state.partial_lay_matched || 0,
        partialLayPrice: state.partial_lay_price || 0,
        additionalPatch: { last_error: `MARKET_CLOSED_${phase}` },
      });
      return;
    }

    // Capture actual kickoff time when market turns in-play
    if (book && book.inplay === true && !state.actual_kickoff_time) {
      state.actual_kickoff_time = Date.now();
      this.logger.log(`[strategy:epl_under25] ⚽ Match started! Recording actual kickoff time.`);
      await this.updateTrade(trade.id, { state_data: state });
      updatedState = false; // Reset flag since we just persisted
    }

    // --- PHASE 1: INITIALIZATION & ORDER PLACEMENT ---
    if (phase === 'INITIAL') {
      if (!book || !book.inplay) return; // Wait for in-play

      // Check if lay order was already placed (new pre-match strategy)
      if (trade.lay_order_ref) {
        this.logger.log(`[strategy:epl_under25] Lay order already exists (${trade.lay_order_ref}) - skipping INITIAL, entering MONITORING`);
        state.phase = 'MONITORING';
        state.profit_order_id = trade.lay_order_ref;
        state.last_stable_price = trade.back_price;
        state.lay_snapshot = { stake: trade.lay_size, price: trade.lay_price };
        updatedState = true;
      } else {
        // Legacy fallback: place lay order now if not already placed
        const targetPrice = computeTargetLayPrice(trade.back_price, this.settings);
        const { layStake } = this.calculateHedgeStakeFromBook(book, market.selectionId, trade, targetPrice);

        if (layStake > 0) {
          const placeRes = await this.placeLimitLaySafe(market.marketId, market.selectionId, layStake, targetPrice, sessionToken, 'phase1-place');
          if (placeRes.status === 'SUCCESS') {
            state.phase = 'MONITORING';
            state.profit_order_id = placeRes.betId;
            state.last_stable_price = trade.back_price;
            state.lay_snapshot = { stake: layStake, price: targetPrice };
            await this.recordLaySnapshot(trade, { layStake, layPrice: targetPrice, betId: placeRes.betId });
            updatedState = true;
            this.logger.log(`[strategy:epl_under25] Phase 1 Complete: Placed Profit Lay @ ${targetPrice} (ID: ${placeRes.betId})`);
          } else {
            this.logger.warn(`[strategy:epl_under25] Phase 1 Failed: ${placeRes.errorCode}`);
          }
        }
      }
    }

    // --- PHASE 2: MONITORING LOOP ---
    else if (phase === 'MONITORING') {
      // CRITICAL FIX: Verify ACTUAL matched size, not just status
      // Status can be misleading - order might be cancelled/lapsed due to suspension
      const orderDetails = await this.getOrderDetailsSafe(state.profit_order_id, sessionToken, 'phase2-verify');
      
      if (!orderDetails) {
        // Order not found - might be cancelled due to suspension
        this.logger.warn(`[strategy:epl_under25] ⚠️ Lay order ${state.profit_order_id} NOT FOUND - checking if suspended/cancelled`);
        
        // Check if we have exposure and need to re-hedge
        const backMatched = trade.back_matched_size || trade.back_size || 0;
        if (backMatched > 0) {
          this.logger.warn(`[strategy:epl_under25] ⚠️ EXPOSED: Back £${backMatched} matched but lay order disappeared - PLACING EMERGENCY HEDGE`);
          await this.placeEmergencyHedge(trade, sessionToken, market, state);
        }
        return;
      }
      
      // Check if order was cancelled/lapsed (e.g., due to market suspension)
      if (orderDetails.status !== 'EXECUTABLE' && orderDetails.status !== 'EXECUTION_COMPLETE') {
        this.logger.warn(`[strategy:epl_under25] ⚠️ Lay order status: ${orderDetails.status} (matched: £${orderDetails.sizeMatched}) - order may have been cancelled`);
        
        if (orderDetails.sizeMatched > 0) {
          // Partially matched before cancellation - settle with what matched
          this.logger.log(`[strategy:epl_under25] Lay partially matched £${orderDetails.sizeMatched} before cancellation`);
          await this.settleTradeWithPnl(trade, state, {
            layStakeOverride: orderDetails.sizeMatched,
            layPriceOverride: orderDetails.averagePriceMatched || trade.lay_price,
            partialLayMatched: state.partial_lay_matched || 0,
            partialLayPrice: state.partial_lay_price || 0,
          });
        } else {
          // No lay matched - trade is exposed, need emergency hedge
          this.logger.warn(`[strategy:epl_under25] ⚠️ Lay order cancelled with no match - PLACING EMERGENCY HEDGE`);
          await this.placeEmergencyHedge(trade, sessionToken, market, state);
        }
        return;
      }
      
      if (orderDetails.status === 'EXECUTION_COMPLETE' || (orderDetails.sizeMatched > 0 && orderDetails.sizeRemaining === 0)) {
        // Verify actual matched size before celebrating
        const actualMatchedSize = orderDetails.sizeMatched || 0;
        const expectedSize = state.lay_snapshot?.stake || trade.lay_size || 0;
        
        if (actualMatchedSize < expectedSize * 0.99) {
          // Less than expected matched - partial fill
          this.logger.warn(`[strategy:epl_under25] ⚠️ Lay only partially matched: £${actualMatchedSize} of £${expectedSize}`);
        }
        
        // Calculate exposure time: only count in-play time
        const layMatchedAtMs = Date.now();
        const layMatchedAt = new Date(layMatchedAtMs).toISOString();
        const stateData = trade.state_data || {};
        const backMatchedAt = stateData.position_entered_at || 0;
        // Use actual kickoff time if available, fallback to scheduled kickoff
        const actualKickoffTime = stateData.actual_kickoff_time || 0;
        const scheduledKickoffTime = trade.kickoff_at ? new Date(trade.kickoff_at).getTime() : 0;
        const kickoffTime = actualKickoffTime || scheduledKickoffTime;
        const exposureStartTime = Math.max(backMatchedAt, kickoffTime);
        const exposureTimeSeconds = exposureStartTime > 0 
          ? Math.max(0, Math.floor((layMatchedAtMs - exposureStartTime) / 1000))
          : null;
        
        this.logger.log(`[strategy:epl_under25] 🏆 Trade Completed: Profit Target Reached (matched £${actualMatchedSize})`);
        this.logger.log(`[strategy:epl_under25]   📊 EXPOSURE TIME: ${exposureTimeSeconds != null ? `${exposureTimeSeconds}s (${(exposureTimeSeconds / 60).toFixed(1)} mins)` : 'N/A'}`);
        
        // Lay order genuinely matched
        await this.logEvent(trade.id, 'LAY_MATCHED', {
          betId: state.profit_order_id,
          lay_price: orderDetails.averagePriceMatched || state.lay_snapshot?.price || trade.lay_price,
          lay_stake: actualMatchedSize,
          expected_stake: expectedSize,
          exposure_time_seconds: exposureTimeSeconds,
          timestamp: layMatchedAt,
        });
        
        state.phase = 'COMPLETED';
        await this.settleTradeWithPnl(trade, state, {
          layStakeOverride: actualMatchedSize,
          layPriceOverride: orderDetails.averagePriceMatched || trade.lay_price,
          exposureTimeSeconds: exposureTimeSeconds,
          partialLayMatched: state.partial_lay_matched || 0,
          partialLayPrice: state.partial_lay_price || 0,
        });
        
        // Trigger smart scheduler to recalculate (trade completed)
        if (process.env.EPL_UNDER25_SCHEDULER_MODE === 'smart' || !process.env.EPL_UNDER25_SCHEDULER_MODE) {
          setImmediate(() => this.smartSchedulerLoop());
        }
        return;
      }

      const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'phase2-book');
      const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
      const currentBackPrice = runner?.ex?.availableToBack?.[0]?.price;
      const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;

      // --- LIVE TRACKING: Track min_post_entry_price during MONITORING phase ---
      // This ensures we capture how close we got to profit BEFORE any goal occurs
      if (currentLayPrice) {
        // Initialize min_post_entry_price if null (use current lay price or entry price)
        if (state.min_post_entry_price === null || state.min_post_entry_price === undefined) {
          state.min_post_entry_price = currentLayPrice;
          state.time_at_min_price = 0; // Just started tracking
          this.logger.log(`[strategy:epl_under25] 📊 LIVE min_post_entry_price initialized: ${currentLayPrice}`);
          updatedState = true;
        } 
        // Update if current price is lower (better potential profit)
        else if (currentLayPrice < state.min_post_entry_price) {
          const previousMin = state.min_post_entry_price;
          state.min_post_entry_price = currentLayPrice;
          const elapsedSeconds = state.position_entered_at 
            ? Math.floor((Date.now() - state.position_entered_at) / 1000)
            : 0;
          state.time_at_min_price = elapsedSeconds;
          this.logger.log(`[strategy:epl_under25] 📊 LIVE min_post_entry_price updated: ${previousMin} → ${currentLayPrice} (${elapsedSeconds}s into trade)`);
          updatedState = true;
        }
      }

      if (currentBackPrice) {
        if (currentBackPrice > (state.last_stable_price * 1.30)) {
          // SPIKE DETECTED - 30% price movement indicates possible goal
          // NOTE: min_post_entry_price is already tracked above and will be preserved in state
          this.logger.log(`[strategy:epl_under25] 🎯 Goal Detected (Price: ${currentBackPrice.toFixed(2)} > ${(state.last_stable_price * 1.30).toFixed(2)}) - Cancelling profit order`);
          this.logger.log(`[strategy:epl_under25]   Min price reached before goal: ${state.min_post_entry_price || 'N/A'}`);
          
          // Cancel the profit lay order (with marketId for Betfair API)
          await this.cancelOrderSafe(state.profit_order_id, market.marketId, sessionToken, 'phase2-cancel-goal');
          
          // CRITICAL FIX: Verify cancellation and check if lay was matched before/during cancel
          const orderDetails = await this.getOrderDetailsSafe(state.profit_order_id, sessionToken, 'phase2-verify-after-goal');
          const expectedLaySize = state.lay_snapshot?.stake || trade.lay_size || 0;
          
          if (orderDetails) {
            const matchedSize = orderDetails.sizeMatched || 0;
            const matchedPrice = orderDetails.averagePriceMatched || state.lay_snapshot?.price || trade.lay_price;
            
            // Scenario 1: Fully matched - trade is complete with profit!
            if (orderDetails.status === 'EXECUTION_COMPLETE' || (matchedSize > 0 && orderDetails.sizeRemaining === 0)) {
              this.logger.log(`[strategy:epl_under25] 🏆 LAY WAS FULLY MATCHED during goal! £${matchedSize} @ ${matchedPrice} - settling as WIN`);
              
              state.phase = 'COMPLETED';
              await this.settleTradeWithPnl(trade, state, {
                layStakeOverride: matchedSize,
                layPriceOverride: matchedPrice,
                partialLayMatched: state.partial_lay_matched || 0,
                partialLayPrice: state.partial_lay_price || 0,
              });
              
              await this.logEvent(trade.id, 'LAY_MATCHED_DURING_GOAL', {
                betId: state.profit_order_id,
                matched_size: matchedSize,
                matched_price: matchedPrice,
                goal_detected: true,
                timestamp: new Date().toISOString(),
              });
              
              // Trigger smart scheduler to recalculate (trade completed)
              if (process.env.EPL_UNDER25_SCHEDULER_MODE === 'smart' || !process.env.EPL_UNDER25_SCHEDULER_MODE) {
                setImmediate(() => this.smartSchedulerLoop());
              }
              return;
            }
            
            // Scenario 2: Partially matched - record partial match, continue to stop-loss for remaining
            if (matchedSize > 0 && matchedSize < expectedLaySize) {
              this.logger.log(`[strategy:epl_under25] ⚠️ LAY PARTIALLY MATCHED before goal: £${matchedSize} of £${expectedLaySize} @ ${matchedPrice}`);
              this.logger.log(`[strategy:epl_under25]   Remaining unhedged exposure: £${(expectedLaySize - matchedSize).toFixed(2)} - proceeding to EVENT_WAIT`);
              
              // Store partial match info for stop-loss calculation
              state.partial_lay_matched = matchedSize;
              state.partial_lay_price = matchedPrice;
              
              await this.logEvent(trade.id, 'LAY_PARTIAL_MATCH_ON_GOAL', {
                betId: state.profit_order_id,
                matched_size: matchedSize,
                expected_size: expectedLaySize,
                matched_price: matchedPrice,
                remaining_exposure: expectedLaySize - matchedSize,
                timestamp: new Date().toISOString(),
              });
              // Continue to EVENT_WAIT below
            } else {
              // Scenario 3: Not matched at all - full exposure remains
              this.logger.log(`[strategy:epl_under25] Lay order cancelled successfully (no matches) - full exposure remains`);
            }
          } else {
            // Order not found - likely cancelled successfully
            this.logger.log(`[strategy:epl_under25] Lay order ${state.profit_order_id} not found after cancel - assuming cancelled`);
          }

          state.phase = 'EVENT_WAIT';
          state.spike_start_ts = Date.now();
          state.peak_price = currentBackPrice;
          state.lay_cancelled_on_goal = true;
          // FREEZE FLAG: Prevent shadow monitor from overwriting min_post_entry_price after goal
          state.goal_detected_during_live_trade = true;
          state.min_price_frozen_at_goal = state.min_post_entry_price;  // Snapshot for audit trail
          updatedState = true;
          
          await this.logEvent(trade.id, 'GOAL_DETECTED_LAY_CANCELLED', {
            current_price: currentBackPrice,
            stable_price: state.last_stable_price,
            spike_pct: ((currentBackPrice - state.last_stable_price) / state.last_stable_price * 100),
            partial_lay_matched: state.partial_lay_matched || 0,
            partial_lay_price: state.partial_lay_price || 0,
            min_price_frozen: state.min_post_entry_price,  // Log frozen value
            timestamp: new Date().toISOString(),
          });
        } else {
          // Update stable price
          state.last_stable_price = currentBackPrice;
          updatedState = true;
        }
      }
    }

    // --- PHASE 3: EVENT CONFIRMATION (180s) ---
    else if (phase === 'EVENT_WAIT') {
      const elapsed = (Date.now() - (state.spike_start_ts || 0)) / 1000;
      const stopLossWaitSeconds = this.settings?.stop_loss_wait_seconds || this.defaults.stop_loss_wait_seconds || 180;
      const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'phase3-book');
      const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
      const currentBackPrice = runner?.ex?.availableToBack?.[0]?.price;

      if (currentBackPrice && currentBackPrice > (state.peak_price || 0)) {
        state.peak_price = currentBackPrice;
        updatedState = true;
      }

      if (elapsed >= stopLossWaitSeconds) {
        this.logger.log(`[strategy:epl_under25] Phase 3 Decision Time (${stopLossWaitSeconds}s elapsed). Current: ${currentBackPrice?.toFixed(2)}, Stable: ${state.last_stable_price?.toFixed(2)}`);

        // Scenario A: False Alarm (VAR check / disallowed goal)
        if (currentBackPrice && currentBackPrice < (state.last_stable_price * 1.10)) {
          this.logger.log(`[strategy:epl_under25] False Alarm - Resuming (Price returned to within 10% of stable: ${currentBackPrice.toFixed(2)} < ${(state.last_stable_price * 1.10).toFixed(2)})`);
          
          const targetPrice = computeTargetLayPrice(trade.back_price, this.settings);
          const { layStake } = this.calculateHedgeStakeFromBook(book, market.selectionId, trade, targetPrice);
          
          if (layStake > 0) {
            const placeRes = await this.placeLimitLaySafe(market.marketId, market.selectionId, layStake, targetPrice, sessionToken, 'phase3-replace');
            if (placeRes.status === 'SUCCESS') {
              this.logger.log(`[strategy:epl_under25] Resuming normal monitoring - Profit order re-placed @ ${targetPrice} (ID: ${placeRes.betId})`);
              state.phase = 'MONITORING';
              state.profit_order_id = placeRes.betId;
              state.lay_snapshot = { stake: layStake, price: targetPrice };
              await this.recordLaySnapshot(trade, { layStake, layPrice: targetPrice, betId: placeRes.betId });
              updatedState = true;
            } else {
              this.logger.error(`[strategy:epl_under25] Failed to re-place profit order: ${placeRes.errorCode}`);
            }
          }
        } 
        // Scenario B: Goal Confirmed
        else {
          this.logger.log('[strategy:epl_under25] Goal Confirmed - Entering Recovery Phase');
          
          // Check for partial lay match from earlier goal cancellation
          const partialLayMatched = state.partial_lay_matched || 0;
          const partialLayPrice = state.partial_lay_price || 0;
          
          if (partialLayMatched > 0) {
            this.logger.log(`[strategy:epl_under25] Partial lay already matched: £${partialLayMatched} @ ${partialLayPrice}`);
          }
          
          // Capture baseline price for drift calculation
          const baselineLayPrice = runner?.ex?.availableToLay?.[0]?.price;
          if (!baselineLayPrice) {
            this.logger.error('[strategy:epl_under25] No lay price available for recovery, staying in wait');
            return;
          }
          
          const stopLossPct = this.settings?.stop_loss_pct || this.defaults.stop_loss_pct || 15;
          const driftFactor = 1 - (stopLossPct / 100);

          // Calculate target hedge price: (1 - stopLossPct%) of baseline lay price
          const targetHedgePrice = roundToBetfairTick(baselineLayPrice * driftFactor);
          
          // Calculate remaining exposure after partial match
          const fullBackStake = trade.back_matched_size || trade.back_stake || trade.back_size || 0;
          let remainingBackExposure = fullBackStake;
          
          if (partialLayMatched > 0 && partialLayPrice > 0) {
            // Partial lay covers: partialLayMatched * partialLayPrice / backPrice worth of back stake
            const backPrice = trade.back_price;
            const hedgedBackAmount = (partialLayMatched * partialLayPrice) / backPrice;
            remainingBackExposure = Math.max(0, fullBackStake - hedgedBackAmount);
            this.logger.log(`[strategy:epl_under25] Partial lay hedged £${hedgedBackAmount.toFixed(2)} of back`);
            this.logger.log(`[strategy:epl_under25] Remaining unhedged exposure: £${remainingBackExposure.toFixed(2)} (of £${fullBackStake})`);
          }
          
          // Calculate lay stake for remaining exposure only
          const { layStake } = calculateHedgeStake(book, market.selectionId, remainingBackExposure, trade.back_price, this.settings.commission_rate, targetHedgePrice);
          
          if (layStake > 0) {
            // GUARDRAIL: Place order with verification and retry
            const placeResult = await this.placeLayOrderWithVerification({
              marketId: market.marketId,
              selectionId: market.selectionId,
              stake: layStake,
              price: targetHedgePrice,
              sessionToken,
              label: 'phase3-recovery',
              persistenceType: 'PERSIST',  // Keep in-play for recovery
              maxRetries: 3,
              verifyDelayMs: 500,
            });
            
            if (placeResult.status === 'SUCCESS' || placeResult.status === 'PARTIAL') {
              this.logger.log(`[strategy:epl_under25] ✓ Recovery order placed: Lay @ ${targetHedgePrice} (${stopLossPct}% below ${baselineLayPrice.toFixed(2)}) - bet ID: ${placeResult.betId}`);
              state.phase = 'RECOVERY_PENDING';
              state.recovery_order_id = placeResult.betId;
              state.recovery_target_price = targetHedgePrice;
              state.recovery_retry_count = 0;
              state.lay_snapshot = { stake: layStake, price: targetHedgePrice };
              state.partial_lay_matched = partialLayMatched;
              state.partial_lay_price = partialLayPrice;
              await this.recordLaySnapshot(trade, { layStake, layPrice: targetHedgePrice, betId: placeResult.betId });
              updatedState = true;
              
              await this.logEvent(trade.id, 'RECOVERY_ORDER_PLACED', {
                betId: placeResult.betId,
                lay_price: targetHedgePrice,
                lay_stake: layStake,
                baseline_price: baselineLayPrice,
                stop_loss_pct: stopLossPct,
                partial_lay_matched: partialLayMatched,
                partial_lay_price: partialLayPrice,
                remaining_exposure: remainingBackExposure,
                verification_attempts: placeResult.attempts,
                timestamp: new Date().toISOString(),
              });
            } else {
              this.logger.error(`[strategy:epl_under25] ❌ Failed to place recovery order after ${placeResult.attempts} attempts: ${placeResult.error}`);
              await this.logEvent(trade.id, 'RECOVERY_ORDER_FAILED', {
                error: placeResult.error,
                attempts: placeResult.attempts,
                baseline_price: baselineLayPrice,
                target_price: targetHedgePrice,
                timestamp: new Date().toISOString(),
              });
            }
          } else {
            this.logger.warn(`[strategy:epl_under25] No lay stake needed - exposure may be fully hedged by partial match`);
          }
        }
      }
    }

    // --- PHASE 4: RECOVERY PENDING (Wait for Drift Order to Match) ---
    else if (phase === 'RECOVERY_PENDING') {
      // CRITICAL FIX: Verify ACTUAL order details, not just status
      // Orders can be cancelled/lapsed due to market suspension
      const orderDetails = await this.getOrderDetailsSafe(state.recovery_order_id, sessionToken, 'phase4-verify');
      
      if (!orderDetails) {
        // Order not found - might be cancelled due to suspension
        this.logger.warn(`[strategy:epl_under25] ⚠️ Recovery order ${state.recovery_order_id} NOT FOUND - likely cancelled`);
        
        // GUARDRAIL: Retry placing the stop-loss order
        const retryCount = state.recovery_retry_count || 0;
        const maxRetries = 3;
        
        if (retryCount < maxRetries) {
          this.logger.log(`[strategy:epl_under25] Retrying recovery order (attempt ${retryCount + 1}/${maxRetries})`);
          
          const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'phase4-retry-book');
          const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
          const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;
          
          if (currentLayPrice) {
            const { layStake } = this.calculateHedgeStakeFromBook(book, market.selectionId, trade, currentLayPrice);
            
            if (layStake > 0) {
              const placeRes = await this.placeLimitLaySafe(market.marketId, market.selectionId, layStake, currentLayPrice, sessionToken, 'phase4-retry');
              
              if (placeRes.status === 'SUCCESS') {
                this.logger.log(`[strategy:epl_under25] ✓ Recovery order RE-PLACED @ ${currentLayPrice} (betId: ${placeRes.betId})`);
                state.recovery_order_id = placeRes.betId;
                state.recovery_target_price = currentLayPrice;
                state.recovery_retry_count = retryCount + 1;
                state.lay_snapshot = { stake: layStake, price: currentLayPrice };
                
                await this.updateTrade(trade.id, {
                  lay_order_ref: placeRes.betId,
                  lay_price: currentLayPrice,
                  lay_size: layStake,
                  state_data: state,
                  last_error: null,
                });
                
                await this.logEvent(trade.id, 'RECOVERY_ORDER_RETRIED', {
                  betId: placeRes.betId,
                  lay_price: currentLayPrice,
                  lay_stake: layStake,
                  retry_attempt: retryCount + 1,
                  reason: 'ORIGINAL_CANCELLED',
                  timestamp: new Date().toISOString(),
                });
              } else {
                this.logger.error(`[strategy:epl_under25] Recovery retry FAILED: ${placeRes.errorCode}`);
                state.recovery_retry_count = retryCount + 1;
                await this.updateTrade(trade.id, {
                  state_data: state,
                  last_error: `RECOVERY_RETRY_FAILED: ${placeRes.errorCode}`,
                });
              }
            }
          }
        } else {
          this.logger.error(`[strategy:epl_under25] ❌ CRITICAL: Recovery order failed after ${maxRetries} retries - POSITION EXPOSED`);
          await this.updateTrade(trade.id, {
            last_error: `RECOVERY_FAILED_MAX_RETRIES`,
            state_data: { ...state, recovery_failed: true },
          });
          await this.logEvent(trade.id, 'RECOVERY_FAILED_MAX_RETRIES', {
            max_retries: maxRetries,
            back_exposure: trade.back_matched_size || trade.back_size,
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }
      
      // Check if order was cancelled/lapsed (not EXECUTABLE or EXECUTION_COMPLETE)
      if (orderDetails.status !== 'EXECUTABLE' && orderDetails.status !== 'EXECUTION_COMPLETE') {
        this.logger.warn(`[strategy:epl_under25] ⚠️ Recovery order status: ${orderDetails.status} (matched: £${orderDetails.sizeMatched})`);
        
        if (orderDetails.sizeMatched > 0) {
          // Partially matched before cancellation - settle with what matched
          this.logger.log(`[strategy:epl_under25] Recovery partially matched £${orderDetails.sizeMatched} before cancellation`);
          
          state.phase = 'COMPLETED';
          await this.settleTradeWithPnl(trade, state, {
            layStakeOverride: orderDetails.sizeMatched,
            layPriceOverride: orderDetails.averagePriceMatched || state.recovery_target_price,
            partialLayMatched: state.partial_lay_matched || 0,
            partialLayPrice: state.partial_lay_price || 0,
          });
          
          await this.logEvent(trade.id, 'RECOVERY_PARTIAL_MATCH', {
            matched_size: orderDetails.sizeMatched,
            matched_price: orderDetails.averagePriceMatched,
            status: orderDetails.status,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        
        // No match - RETRY IMMEDIATELY (don't wait for next tick)
        this.logger.log(`[strategy:epl_under25] Order cancelled with no match - retrying immediately`);
        
        const retryCount = state.recovery_retry_count || 0;
        const maxRetries = 3;
        
        if (retryCount < maxRetries) {
          const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'phase4-cancelled-retry-book');
          const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
          const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;
          
          if (currentLayPrice) {
            const { layStake } = this.calculateHedgeStakeFromBook(book, market.selectionId, trade, currentLayPrice);
            
            if (layStake > 0) {
              const placeRes = await this.placeLimitLaySafe(market.marketId, market.selectionId, layStake, currentLayPrice, sessionToken, 'phase4-cancelled-retry');
              
              if (placeRes.status === 'SUCCESS') {
                this.logger.log(`[strategy:epl_under25] ✓ Recovery order RE-PLACED @ ${currentLayPrice} (betId: ${placeRes.betId})`);
                state.recovery_order_id = placeRes.betId;
                state.recovery_target_price = currentLayPrice;
                state.recovery_retry_count = retryCount + 1;
                state.lay_snapshot = { stake: layStake, price: currentLayPrice };
                
                await this.updateTrade(trade.id, {
                  lay_order_ref: placeRes.betId,
                  lay_price: currentLayPrice,
                  lay_size: layStake,
                  state_data: state,
                  last_error: null,
                });
                
                await this.logEvent(trade.id, 'RECOVERY_ORDER_RETRIED', {
                  betId: placeRes.betId,
                  lay_price: currentLayPrice,
                  lay_stake: layStake,
                  retry_attempt: retryCount + 1,
                  reason: `ORDER_STATUS_${orderDetails.status}`,
                  timestamp: new Date().toISOString(),
                });
              } else {
                this.logger.error(`[strategy:epl_under25] Recovery retry FAILED: ${placeRes.errorCode}`);
                state.recovery_retry_count = retryCount + 1;
                state.recovery_order_id = null;
                await this.updateTrade(trade.id, {
                  state_data: state,
                  last_error: `RECOVERY_RETRY_FAILED: ${placeRes.errorCode}`,
                });
              }
            }
          } else {
            // No lay price - market might still be suspended, wait for next tick
            this.logger.warn(`[strategy:epl_under25] No lay price available for retry - market may be suspended`);
            state.recovery_order_id = null;
            await this.updateTrade(trade.id, { state_data: state });
          }
        } else {
          this.logger.error(`[strategy:epl_under25] ❌ CRITICAL: Recovery order failed after ${maxRetries} retries - POSITION EXPOSED`);
          await this.updateTrade(trade.id, {
            last_error: `RECOVERY_FAILED_MAX_RETRIES`,
            state_data: { ...state, recovery_failed: true },
          });
        }
        return;
      }
      
      if (orderDetails.status === 'EXECUTION_COMPLETE' || (orderDetails.sizeMatched > 0 && orderDetails.sizeRemaining === 0)) {
        // Verify actual matched size
        const actualMatchedSize = orderDetails.sizeMatched || 0;
        const matchedPrice = orderDetails.averagePriceMatched || state.recovery_target_price || trade.lay_price;
        
        // Recovery lay order matched - log with timestamp
        const recoveryLayMatchedAt = new Date().toISOString();
        await this.logEvent(trade.id, 'LAY_MATCHED', {
          betId: state.recovery_order_id,
          lay_price: matchedPrice,
          lay_stake: actualMatchedSize,
          recovery_order: true,
          timestamp: recoveryLayMatchedAt,
        });
        
        this.logger.log(`[strategy:epl_under25] Recovery order matched - Drift Target Reached (£${actualMatchedSize} @ ${matchedPrice})`);
        state.phase = 'COMPLETED';
        await this.settleTradeWithPnl(trade, state, {
          layStakeOverride: actualMatchedSize,
          layPriceOverride: matchedPrice,
          partialLayMatched: state.partial_lay_matched || 0,
          partialLayPrice: state.partial_lay_price || 0,
        });
        
        // Trigger smart scheduler to recalculate (trade completed)
        if (process.env.EPL_UNDER25_SCHEDULER_MODE === 'smart' || !process.env.EPL_UNDER25_SCHEDULER_MODE) {
          setImmediate(() => this.smartSchedulerLoop());
        }
        return;
      }
      
      // Order is still pending (EXECUTABLE) - log status periodically
      const pendingMatched = orderDetails.sizeMatched || 0;
      const pendingRemaining = orderDetails.sizeRemaining || 0;
      this.logger.log(`[strategy:epl_under25] Recovery: Waiting for drift to ${state.recovery_target_price} (Order: ${state.recovery_order_id}, matched: £${pendingMatched}, remaining: £${pendingRemaining})`);
    }

    if (updatedState) {
      await this.updateTrade(trade.id, { state_data: state });
    }
  }

  async ensureMarket(trade, sessionToken) {
    if (trade.betfair_market_id && trade.selection_id) {
      return { marketId: trade.betfair_market_id, selectionId: trade.selection_id };
    }

    const markets = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listMarketCatalogue', {
      filter: {
        eventIds: [trade.betfair_event_id],
        marketTypeCodes: ['OVER_UNDER_25'],
      },
      maxResults: 1,
      marketProjection: ['RUNNER_METADATA'],
    }, 'ensureMarket');

    const market = markets?.[0];
    if (!market) {
      this.logger.warn(`[strategy:epl_under25] Market OVER_UNDER_25 not found for event ${trade.betfair_event_id}`);
      return null;
    }

    const runner = market.runners.find(r => r.runnerName === UNDER_RUNNER_NAME || r.runnerName === 'Under 2.5 Goals');
    if (!runner) {
      this.logger.warn(`[strategy:epl_under25] Runner ${UNDER_RUNNER_NAME} not found in market ${market.marketId}`);
      return null;
    }

    await this.updateTrade(trade.id, {
      betfair_market_id: market.marketId,
      selection_id: runner.selectionId,
    });

    return { marketId: market.marketId, selectionId: runner.selectionId };
  }

  async placeBackOrder(trade, trigger) {
    const sessionToken = await this.requireSessionWithRetry('place-back');
    const market = await this.ensureMarket(trade, sessionToken);
    if (!market) return;

    const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'placeBack-book');
    const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
    
    // Check market liquidity if available (Betfair API may expose totalMatched)
    const minLiquidity = this.settings.min_market_liquidity || this.defaults.min_market_liquidity;
    const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;
    
    if (book && typeof book.totalMatched === 'number') {
      if (book.totalMatched < minLiquidity) {
        this.logger.log(`[strategy:epl_under25] Market liquidity too low (${book.totalMatched} < ${minLiquidity}) for ${trade.fixture_name} - transitioning to shadow monitoring`);
        
        // Shadow monitoring: Track price to collect data without real exposure
        const shadowState = {
          phase: 'POST_TRADE_MONITOR',
          is_shadow_trade: true,
          skip_reason: 'MARKET_LIQUIDITY_TOO_LOW',
          theoretical_entry_price: currentLayPrice || null,
          theoretical_entry_time: Date.now(),
          monitor_started_at: Date.now(),
          min_post_entry_price: currentLayPrice || null,
          last_monitor_poll: 0,
        };
        
        await this.updateTrade(trade.id, {
          status: 'post_trade_monitor',
          state_data: shadowState,
          theoretical_entry_price: currentLayPrice || null,
          last_error: `MARKET_LIQUIDITY_TOO_LOW: ${book.totalMatched} < ${minLiquidity}`,
        });
        await this.logEvent(trade.id, 'SHADOW_MONITORING_STARTED', {
          reason: 'MARKET_LIQUIDITY_TOO_LOW',
          theoretical_entry_price: currentLayPrice,
          total_matched: book.totalMatched,
          min_liquidity: minLiquidity,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }
    // If totalMatched is not available, skip the check (graceful fallback)
    
    // Get BOTH back and lay prices for logging
    const bestBackPrice = runner?.ex?.availableToBack?.[0]?.price;
    const bestLayPrice = runner?.ex?.availableToLay?.[0]?.price;

    if (!bestLayPrice) {
      this.logger.log(`[strategy:epl_under25] No lay price available for ${trade.fixture_name}`);
      return;
    }

    const minPrice = this.settings.min_back_price || this.defaults.min_back_price;
    if (bestLayPrice < minPrice) {
      this.logger.log(`[strategy:epl_under25] Lay price ${bestLayPrice} too low (min: ${minPrice}) for ${trade.fixture_name} - transitioning to shadow monitoring`);
      
      // Shadow monitoring: Track price to collect data without real exposure
      const shadowState = {
        phase: 'POST_TRADE_MONITOR',
        is_shadow_trade: true,
        skip_reason: 'LAY_PRICE_TOO_LOW',
        theoretical_entry_price: bestLayPrice,
        theoretical_entry_time: Date.now(),
        monitor_started_at: Date.now(),
        min_post_entry_price: bestLayPrice,  // Initialize with current price
        last_monitor_poll: 0,  // Allow immediate first poll
      };
      
      await this.updateTrade(trade.id, {
        status: 'post_trade_monitor',
        state_data: shadowState,
        theoretical_entry_price: bestLayPrice,
        last_error: `LAY_PRICE_TOO_LOW: ${bestLayPrice} < ${minPrice}`,
      });
      await this.logEvent(trade.id, 'SHADOW_MONITORING_STARTED', {
        reason: 'LAY_PRICE_TOO_LOW',
        theoretical_entry_price: bestLayPrice,
        lay_price: bestLayPrice,
        min_price: minPrice,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const stake = trade.target_stake || this.settings.default_stake;
    const customerRef = `BACK-${Date.now()}`;
    
    try {
        // STRATEGY 1: Place back at lay price
        const placeRes = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/placeOrders', {
        marketId: market.marketId,
        customerRef,
        instructions: [
            {
            selectionId: market.selectionId,
            side: 'BACK',
            orderType: 'LIMIT',
            limitOrder: {
                size: stake,
                price: bestLayPrice,  // Place at LAY price for better value
                persistenceType: 'LAPSE',  // Will cancel if unmatched when market goes in-play
            },
            },
        ],
        }, 'placeBack');

        const report = placeRes?.instructionReports?.[0];
        if (report && report.status === 'SUCCESS') {
        this.logger.log(`[strategy:epl_under25] Placed BACK order @ LAY PRICE ${bestLayPrice} for ${trade.fixture_name} (back was ${bestBackPrice}, spread saved)`);
        this.logger.log(`[strategy:epl_under25] Back order will be checked at kickoff. Lay will be placed after back matches.`);

        // Update trade - lay will be placed after back is confirmed matched at kickoff
        await this.updateTrade(trade.id, {
            status: 'back_pending',  // Not matched yet - will check at kickoff
            back_price: bestLayPrice,
            back_price_snapshot: trade.back_price_snapshot || bestLayPrice,
            back_size: stake,
            back_stake: stake,
            back_order_ref: report.betId,
            betfair_market_id: market.marketId,
            selection_id: market.selectionId,
            back_placed_at: new Date().toISOString(),
            needs_check_at: trade.kickoff_at,  // Check at kickoff
            total_stake: stake,  // Only back stake for now, lay added after match
            // Lay order will be placed after back matches - keep these null
            lay_order_ref: null,
            lay_price: null,
            lay_size: null,
            lay_placed_at: null,
            // State machine starts at INITIAL - will transition after lay is placed
            state_data: { phase: 'INITIAL' },
        });

        trade.back_price = bestLayPrice;
        trade.back_size = stake;
        trade.back_stake = stake;
        trade.back_price_snapshot = trade.back_price_snapshot || bestLayPrice;
        trade.total_stake = stake;
        trade.back_order_ref = report.betId;
        trade.betfair_market_id = market.marketId;
        trade.selection_id = market.selectionId;

        const backPlacedAt = new Date().toISOString();
        await this.logEvent(trade.id, 'BACK_PLACED', { 
          price: bestLayPrice, 
          stake, 
          betId: report.betId, 
          backPrice: bestBackPrice,
          timestamp: backPlacedAt,
          note: 'Lay will be placed after back matches at kickoff',
        });
        } else {
        this.logger.error(`[strategy:epl_under25] Failed to place BACK order: ${report?.errorCode}`);
        await this.logEvent(trade.id, 'BACK_FAILED', { errorCode: report?.errorCode });
        }
    } catch (err) {
        this.logger.error(`[strategy:epl_under25] BACK order exception: ${err.message}`);
    }
  }

  async checkBackOrder(trade, now) {
    const sessionToken = await this.requireSessionWithRetry('back-order-check');
    
    const kickoff = trade.kickoff_at ? new Date(trade.kickoff_at) : null;
    if (!kickoff) {
      this.logger.warn(`[strategy:epl_under25] checkBackOrder called but no kickoff time for trade ${trade.id}`);
      return;
    }
    
    const isPreMatch = now < kickoff;
    const eventName = trade.event_name || trade.fixture_name || trade.event_id || 'Unknown';
    this.logger.log(`[strategy:epl_under25] Checking back order for ${eventName} (${isPreMatch ? 'PRE-MATCH' : 'AT/POST KICKOFF'})`);
    
    try {
        const res = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCurrentOrders', {
            betIds: [trade.back_order_ref],
            orderProjection: 'ALL',
        }, 'checkBackOrder-details');
        const order = res?.currentOrders?.[0];
        
        if (!order) {
            // CRITICAL FIX: Order not found could mean:
            // 1. Fully matched and cleared (good)
            // 2. Cancelled/lapsed due to suspension (bad - no exposure)
            // 3. Market closed (game over)
            
            // Check cleared orders to verify it actually matched
            this.logger.log(`[strategy:epl_under25] Order ${trade.back_order_ref} not in current orders - checking cleared orders...`);
            
            try {
              const clearedRes = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listClearedOrders', {
                betIds: [trade.back_order_ref],
                betStatus: 'SETTLED',
              }, 'checkBackOrder-cleared');
              
              const clearedOrder = clearedRes?.clearedOrders?.[0];
              if (clearedOrder && clearedOrder.sizeSettled > 0) {
                // Verified: order was matched
                const matchedStake = clearedOrder.sizeSettled;
                const matchedPrice = clearedOrder.priceMatched;
                
                this.logger.log(`[strategy:epl_under25] ✓ Back order VERIFIED matched via cleared orders: £${matchedStake} @ ${matchedPrice}`);
                
                trade.back_matched_size = matchedStake;
                trade.back_price = matchedPrice;
                await this.logEvent(trade.id, 'BACK_VERIFIED_MATCHED', { 
                  matchedStake, 
                  matchedPrice, 
                  source: 'cleared_orders',
                  timestamp: new Date().toISOString(),
                });
                
                await this.placeLayForGreenUp(trade, sessionToken, matchedStake, matchedPrice);
                return;
              }
            } catch (clearErr) {
              this.logger.warn(`[strategy:epl_under25] Cleared orders check failed: ${clearErr.message}`);
            }
            
            // Order not in current or cleared - likely cancelled/lapsed
            // SAFE: Do NOT place lay - no exposure exists
            this.logger.warn(`[strategy:epl_under25] ⚠️ Back order ${trade.back_order_ref} NOT FOUND anywhere - likely cancelled/lapsed`);
            this.logger.log(`[strategy:epl_under25] Terminating trade - no back exposure, no lay needed`);
            
            await this.updateTrade(trade.id, {
              status: 'cancelled',
              back_matched_size: 0,
              back_stake: 0,
              total_stake: 0,
              last_error: 'BACK_ORDER_NOT_FOUND_CANCELLED',
            });
            
            await this.logEvent(trade.id, 'BACK_ORDER_LOST', {
              betId: trade.back_order_ref,
              reason: 'Order not in current or cleared orders - likely cancelled due to suspension',
              timestamp: new Date().toISOString(),
            });
            return;
        }

        // Check if order matched (fully or partially)
        if (order.status === 'EXECUTION_COMPLETE' || order.sizeMatched >= (trade.back_size || 0)) {
            const matchedStake = order.sizeMatched || trade.back_size || trade.target_stake || 0;
            const matchedPrice = order.averagePriceMatched || order.price;
            
            // CRITICAL FIX: Check if this is a retry bet - combine with original matched amount
            const stateData = trade.state_data || {};
            const originalMatchedAmount = stateData.original_matched_amount || 0;
            const originalMatchedPrice = stateData.original_matched_price || 0;
            
            let totalStake = matchedStake;
            let weightedAvgPrice = matchedPrice;
            
            if (originalMatchedAmount > 0 && originalMatchedPrice > 0) {
                // This is a retry bet - combine with original
                totalStake = originalMatchedAmount + matchedStake;
                
                // Calculate weighted average price: ((S1 * P1) + (S2 * P2)) / (S1 + S2)
                const totalValue = (originalMatchedAmount * originalMatchedPrice) + (matchedStake * matchedPrice);
                weightedAvgPrice = Math.round((totalValue / totalStake) * 100) / 100;
                
                this.logger.log(`[strategy:epl_under25] 🔗 COMBINING BETS:`);
                this.logger.log(`[strategy:epl_under25]   Original: £${originalMatchedAmount} @ ${originalMatchedPrice}`);
                this.logger.log(`[strategy:epl_under25]   Retry: £${matchedStake} @ ${matchedPrice}`);
                this.logger.log(`[strategy:epl_under25]   TOTAL: £${totalStake} @ ${weightedAvgPrice} (weighted avg)`);
            } else {
                this.logger.log(`[strategy:epl_under25] ✓ Back bet FULLY MATCHED @ ${matchedPrice} (£${matchedStake}) ${isPreMatch ? 'PRE-MATCH' : ''} - placing lay for green-up`);
            }
            
            trade.back_matched_size = totalStake;
            trade.back_price = weightedAvgPrice;
            
            // Store position entered time for exposure calculation
            const positionEnteredAt = now.getTime();
            stateData.position_entered_at = positionEnteredAt;
            await this.updateTrade(trade.id, { state_data: stateData });
            
            await this.logEvent(trade.id, 'BACK_MATCHED', { 
              order,
              matched_price: matchedPrice,
              matched_size: matchedStake,
              original_matched_amount: originalMatchedAmount,
              original_matched_price: originalMatchedPrice,
              total_stake: totalStake,
              weighted_avg_price: weightedAvgPrice,
              is_combined_bet: originalMatchedAmount > 0,
              pre_match: isPreMatch,
              timestamp: new Date().toISOString(),
            });
            
            // Place lay bet for green-up IMMEDIATELY (even pre-match)
            // Lay uses PERSIST so it stays when market goes in-play
            // CRITICAL: Use combined totalStake and weightedAvgPrice
            await this.placeLayForGreenUp(trade, sessionToken, totalStake, weightedAvgPrice);
            return;
        }

        // Pre-match: if order still pending, check timeout guardrail
        if (isPreMatch) {
            const matchedAmount = order.sizeMatched || 0;
            const unmatchedAmount = order.sizeRemaining || 0;
            const minsToKickoff = (kickoff.getTime() - now.getTime()) / 60000;
            const stateData = trade.state_data || {};
            
            // NEW RULE: If ANY portion is unmatched 10 minutes before kickoff, cancel unmatched and retry at current lay price
            if (unmatchedAmount > 0 && minsToKickoff <= 10 && minsToKickoff > 0) {
                // Check if we've already retried (prevent multiple retries)
                if (stateData.retry_attempted) {
                    this.logger.log(`[strategy:epl_under25] Pre-match: £${unmatchedAmount} still unmatched, but retry already attempted - waiting for kickoff`);
                    return;
                }
                
                this.logger.log(`[strategy:epl_under25] ⚠️ Back order has unmatched portion (£${unmatchedAmount} of £${trade.back_size}) at ${minsToKickoff.toFixed(1)} mins before kickoff - cancelling and retrying`);
                
                // Store original order reference for audit trail
                const originalBackOrderRef = trade.back_order_ref;
                const originalMatchedAmount = matchedAmount;
                const originalMatchedPrice = order.averagePriceMatched || order.price;
                
                try {
                    // Fetch market first (needed for cancel API)
                    const market = await this.ensureMarket(trade, sessionToken);
                    if (!market) {
                        this.logger.error(`[strategy:epl_under25] Failed to get market for retry - cannot cancel`);
                        await this.updateTrade(trade.id, {
                            last_error: 'RETRY_FAILED_NO_MARKET',
                            state_data: { ...stateData, retry_attempted: true },
                        });
                        return;
                    }
                    
                    // Cancel the unmatched portion with CONFIRMATION (prevents placing retry while original still open)
                    const cancelRes = await this.cancelOrderAndConfirm(originalBackOrderRef, market.marketId, sessionToken, 'checkBackOrder-retry-cancel', {
                        confirmMs: 10000,  // 10 seconds max
                        pollMs: 500,
                        maxCancelAttempts: 5,
                        notFoundThreshold: 3,
                    });
                    
                    // Get final matched amount after cancellation
                    let finalMatchedAmount = originalMatchedAmount;
                    let finalMatchedPrice = originalMatchedPrice;
                    if (cancelRes.last_details) {
                        finalMatchedAmount = cancelRes.last_details.sizeMatched || originalMatchedAmount;
                        finalMatchedPrice = cancelRes.last_details.averagePriceMatched || originalMatchedPrice;
                    }
                    
                    if (!cancelRes.closed) {
                        // Cancel not confirmed - don't place retry to avoid double exposure
                        this.logger.error(`[strategy:epl_under25] ❌ Cancel NOT CONFIRMED for bet ${originalBackOrderRef} - NOT placing retry`);
                        await this.updateTrade(trade.id, {
                            last_error: 'CANCEL_NOT_CONFIRMED_FOR_RETRY',
                            state_data: { ...stateData, retry_attempted: true, cancel_failed: true },
                        });
                        await this.logEvent(trade.id, 'BACK_CANCEL_NOT_CONFIRMED', {
                            betId: originalBackOrderRef,
                            attempts: cancelRes.attempts,
                            elapsed_ms: cancelRes.elapsed_ms,
                            matched_before_cancel: originalMatchedAmount,
                            reason: cancelRes.reason,
                            timestamp: new Date().toISOString(),
                        });
                        return;
                    }
                    
                    this.logger.log(`[strategy:epl_under25] ✓ Cancel confirmed for ${originalBackOrderRef} - final matched: £${finalMatchedAmount}`);
                    
                    // Calculate amount to retry (only the unmatched portion)
                    const amountToRetry = (trade.target_stake || this.settings.default_stake) - finalMatchedAmount;
                    
                    if (amountToRetry <= 0) {
                        // Everything matched during cancel confirmation - proceed with green-up
                        // Note: finalMatchedAmount already represents the TOTAL matched (original bet fully filled)
                        this.logger.log(`[strategy:epl_under25] Full stake matched during cancel confirmation - proceeding with lay`);
                        this.logger.log(`[strategy:epl_under25]   Total matched: £${finalMatchedAmount} @ ${finalMatchedPrice}`);
                        trade.back_matched_size = finalMatchedAmount;
                        trade.back_price = finalMatchedPrice;
                        await this.updateTrade(trade.id, {
                            back_matched_size: finalMatchedAmount,
                            back_price: finalMatchedPrice,
                            state_data: { ...stateData, retry_attempted: true },
                        });
                        await this.placeLayForGreenUp(trade, sessionToken, finalMatchedAmount, finalMatchedPrice);
                        return;
                    }
                    
                    // Get current market prices for retry
                    const retryBook = await this.getMarketBookSafe(market.marketId, sessionToken, 'checkBackOrder-retry-book');
                    const retryRunner = retryBook?.runners?.find(r => r.selectionId == market.selectionId);
                    const currentLayPrice = retryRunner?.ex?.availableToLay?.[0]?.price;
                    
                    if (!currentLayPrice) {
                        this.logger.error(`[strategy:epl_under25] No lay price for retry - keeping matched portion (£${finalMatchedAmount})`);
                        
                        // If we have some matched amount, proceed with that
                        if (finalMatchedAmount > 0) {
                            this.logger.log(`[strategy:epl_under25] Proceeding with partially matched amount: £${finalMatchedAmount}`);
                            trade.back_matched_size = finalMatchedAmount;
                            trade.back_price = finalMatchedPrice;
                            await this.updateTrade(trade.id, {
                                back_matched_size: finalMatchedAmount,
                                back_price: finalMatchedPrice,
                                back_stake: finalMatchedAmount,
                                state_data: { ...stateData, retry_attempted: true },
                            });
                            await this.placeLayForGreenUp(trade, sessionToken, finalMatchedAmount, finalMatchedPrice);
                        } else {
                            await this.updateTrade(trade.id, {
                                status: 'cancelled',
                                last_error: 'RETRY_FAILED_NO_LAY_PRICE',
                                state_data: { ...stateData, retry_attempted: true },
                            });
                            await this.logEvent(trade.id, 'RETRY_FAILED', {
                                reason: 'NO_LAY_PRICE',
                                original_bet_id: originalBackOrderRef,
                                timestamp: new Date().toISOString(),
                            });
                        }
                        return;
                    }
                    
                    // Place retry order for ONLY the unmatched amount
                    this.logger.log(`[strategy:epl_under25] Placing retry for unmatched £${amountToRetry.toFixed(2)} @ current lay price ${currentLayPrice}`);
                    
                    const customerRef = `BACK-RETRY-${Date.now()}`;
                    const placeRes = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/placeOrders', {
                        marketId: market.marketId,
                        customerRef,
                        instructions: [
                            {
                                selectionId: market.selectionId,
                                side: 'BACK',
                                orderType: 'LIMIT',
                                limitOrder: {
                                    size: amountToRetry,
                                    price: currentLayPrice,
                                    persistenceType: 'LAPSE',
                                },
                            },
                        ],
                    }, 'checkBackOrder-retry-place');
                    
                    const report = placeRes?.instructionReports?.[0];
                    if (report && report.status === 'SUCCESS') {
                        this.logger.log(`[strategy:epl_under25] ✓ Retry back placed: £${amountToRetry} @ ${currentLayPrice} (betId: ${report.betId})`);
                        
                        // Calculate combined weighted average price if we have original matched portion
                        let combinedMatchedSize = finalMatchedAmount;
                        let combinedMatchedPrice = finalMatchedPrice;
                        
                        // Store retry bet info - will combine with original matched on next check
                        await this.updateTrade(trade.id, {
                            back_order_ref: report.betId,
                            back_matched_size: finalMatchedAmount,  // Already matched from original
                            back_price: finalMatchedPrice,
                            state_data: { 
                                ...stateData, 
                                retry_attempted: true, 
                                original_back_order_ref: originalBackOrderRef,
                                original_matched_amount: finalMatchedAmount,
                                original_matched_price: finalMatchedPrice,
                                retry_bet_id: report.betId,
                                retry_amount: amountToRetry,
                                retry_price: currentLayPrice,
                            },
                        });
                        
                        trade.back_order_ref = report.betId;
                        
                        await this.logEvent(trade.id, 'BACK_RETRY_PLACED', {
                            new_bet_id: report.betId,
                            original_bet_id: originalBackOrderRef,
                            original_matched_amount: finalMatchedAmount,
                            original_matched_price: finalMatchedPrice,
                            retry_amount: amountToRetry,
                            retry_price: currentLayPrice,
                            mins_to_kickoff: minsToKickoff,
                            timestamp: new Date().toISOString(),
                        });
                    } else {
                        this.logger.error(`[strategy:epl_under25] ❌ Retry back FAILED: ${report?.errorCode}`);
                        
                        // If we have original matched amount, proceed with that
                        if (finalMatchedAmount > 0) {
                            this.logger.log(`[strategy:epl_under25] Retry failed but have £${finalMatchedAmount} matched - proceeding with partial`);
                            trade.back_matched_size = finalMatchedAmount;
                            trade.back_price = finalMatchedPrice;
                            await this.updateTrade(trade.id, {
                                back_matched_size: finalMatchedAmount,
                                back_price: finalMatchedPrice,
                                back_stake: finalMatchedAmount,
                                state_data: { ...stateData, retry_attempted: true, retry_failed: true },
                            });
                            await this.placeLayForGreenUp(trade, sessionToken, finalMatchedAmount, finalMatchedPrice);
                        } else {
                            await this.updateTrade(trade.id, {
                                status: 'cancelled',
                                last_error: `RETRY_FAILED: ${report?.errorCode}`,
                                state_data: { ...stateData, retry_attempted: true },
                            });
                            await this.logEvent(trade.id, 'RETRY_FAILED', {
                                reason: 'PLACE_ORDER_FAILED',
                                errorCode: report?.errorCode,
                                original_bet_id: originalBackOrderRef,
                                timestamp: new Date().toISOString(),
                            });
                        }
                    }
                } catch (retryErr) {
                    this.logger.error(`[strategy:epl_under25] Retry exception: ${retryErr.message}`);
                    
                    // If we had some matched before the error, note it
                    if (originalMatchedAmount > 0) {
                        await this.updateTrade(trade.id, {
                            back_matched_size: originalMatchedAmount,
                            back_price: originalMatchedPrice,
                            back_stake: originalMatchedAmount,
                            last_error: `RETRY_EXCEPTION: ${retryErr.message}`,
                            state_data: { ...stateData, retry_attempted: true, retry_exception: true },
                        });
                    } else {
                        await this.updateTrade(trade.id, {
                            status: 'cancelled',
                            last_error: `RETRY_EXCEPTION: ${retryErr.message}`,
                            state_data: { ...stateData, retry_attempted: true },
                        });
                    }
                    await this.logEvent(trade.id, 'RETRY_FAILED', {
                        reason: 'EXCEPTION',
                        error: retryErr.message,
                        original_bet_id: originalBackOrderRef,
                        original_matched_amount: originalMatchedAmount,
                        timestamp: new Date().toISOString(),
                    });
                }
                return;
            }
            
            // Log status for trades not yet at 10 minute window
            if (matchedAmount > 0 && unmatchedAmount > 0) {
                this.logger.log(`[strategy:epl_under25] Pre-match partial: £${matchedAmount} of £${trade.back_size} matched (${minsToKickoff.toFixed(1)} mins to kickoff, retry at 10 mins)`);
            } else if (matchedAmount === 0) {
                this.logger.log(`[strategy:epl_under25] Pre-match: back order pending, no matches yet (${minsToKickoff.toFixed(1)} mins to kickoff)`);
            }
            
            // Still pending - will check again on next poll
            return;
        }

        // Order partially matched or still unmatched at/after kickoff
        if (now >= kickoff) {
            const currentMatched = order.sizeMatched || 0;
            const unmatchedAmount = (order.sizeRemaining || 0);
            
            // CRITICAL FIX: Retrieve original matched amount from first bet (if retry occurred)
            const stateData = trade.state_data || {};
            const originalMatchedAmount = stateData.original_matched_amount || 0;
            const originalMatchedPrice = stateData.original_matched_price || 0;
            
            // Calculate TOTAL matched (original + current)
            const totalMatched = originalMatchedAmount + currentMatched;
            
            // Cancel any unmatched portion
            if (unmatchedAmount > 0) {
                this.logger.log(`[strategy:epl_under25] Cancelling unmatched portion (£${unmatchedAmount} of £${trade.back_size})`);
                await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/cancelOrders', {
                    marketId: trade.betfair_market_id,
                    instructions: [{ betId: trade.back_order_ref }],
                }, 'cancelBack-kickoff');
            }
            
            // If ANY amount matched (including original), proceed with the matched amount
            if (totalMatched > 0) {
                const currentMatchedPrice = order.averagePriceMatched || order.price;
                
                let finalStake = totalMatched;
                let finalPrice = currentMatchedPrice;
                
                // If we have BOTH original and current matches, calculate weighted average
                if (originalMatchedAmount > 0 && originalMatchedPrice > 0 && currentMatched > 0) {
                    // Calculate weighted average price: ((S1 * P1) + (S2 * P2)) / (S1 + S2)
                    const totalValue = (originalMatchedAmount * originalMatchedPrice) + (currentMatched * currentMatchedPrice);
                    finalPrice = Math.round((totalValue / finalStake) * 100) / 100;
                    
                    this.logger.log(`[strategy:epl_under25] 🔗 COMBINING BOTH BETS AT KICKOFF:`);
                    this.logger.log(`[strategy:epl_under25]   Original (cancelled): £${originalMatchedAmount} @ ${originalMatchedPrice}`);
                    this.logger.log(`[strategy:epl_under25]   Retry (partial): £${currentMatched} @ ${currentMatchedPrice}`);
                    this.logger.log(`[strategy:epl_under25]   TOTAL MATCHED: £${finalStake} @ ${finalPrice} (weighted avg)`);
                } else if (originalMatchedAmount > 0 && currentMatched === 0) {
                    // Only original matched, retry completely unmatched
                    finalStake = originalMatchedAmount;
                    finalPrice = originalMatchedPrice;
                    this.logger.log(`[strategy:epl_under25] ⚠️ Retry bet COMPLETELY UNMATCHED at kickoff`);
                    this.logger.log(`[strategy:epl_under25]   Using ORIGINAL matched amount: £${finalStake} @ ${finalPrice}`);
                } else {
                    // Only current matched (no retry was attempted, or retry fully matched)
                    this.logger.log(`[strategy:epl_under25] ⚠️ PARTIAL MATCH: £${currentMatched} of £${trade.back_size} @ ${currentMatchedPrice} - placing lay for green-up on matched portion`);
                }
                
                trade.back_matched_size = finalStake;
                trade.back_price = finalPrice;
                
                // Store position entered time for exposure calculation
                stateData.position_entered_at = now.getTime();
                await this.updateTrade(trade.id, { state_data: stateData });
                
                await this.logEvent(trade.id, 'BACK_PARTIALLY_MATCHED', { 
                    order, 
                    current_matched: currentMatched,
                    unmatched_amount: unmatchedAmount,
                    current_matched_price: currentMatchedPrice,
                    original_matched_amount: originalMatchedAmount,
                    original_matched_price: originalMatchedPrice,
                    total_matched: finalStake,
                    final_weighted_price: finalPrice,
                    is_combined_bet: originalMatchedAmount > 0 && currentMatched > 0,
                    timestamp: new Date().toISOString(),
                });
                
                // Place lay bet for green-up on the TOTAL matched portion
                // CRITICAL: Use finalStake and finalPrice (not just current order)
                await this.placeLayForGreenUp(trade, sessionToken, finalStake, finalPrice);
            } else {
                // BOTH original and retry completely unmatched - cancel and terminate
                this.logger.log(`[strategy:epl_under25] ✗ Back bet COMPLETELY UNMATCHED at kickoff - terminating trade (no exposure)`);
                this.logger.log(`[strategy:epl_under25]   Original matched: £${originalMatchedAmount}, Retry matched: £${currentMatched}, Total: £${totalMatched}`);
                await this.updateTrade(trade.id, { 
                    status: 'cancelled', 
                    back_stake: 0,
                    back_matched_size: 0,
                    total_stake: 0,
                    last_error: 'BACK_UNMATCHED_AT_KICKOFF - no liquidity at target price' 
                });
                trade.status = 'cancelled';
                await this.logEvent(trade.id, 'BACK_CANCELLED', { 
                    order,
                    original_matched_amount: originalMatchedAmount,
                    retry_matched_amount: currentMatched,
                    total_matched: totalMatched,
                    reason: 'Completely unmatched at kickoff - no lay placed, no exposure' 
                });
            }
        }
    } catch (err) {
        this.logger.error(`[strategy:epl_under25] checkBackOrder error: ${err.message}`);
    }
  }

  /**
   * Place lay bet after back is confirmed matched - calculates green-up stake
   * Green-up formula: layStake = backMatchedStake * backPrice / layPrice
   */
  async placeLayForGreenUp(trade, sessionToken, backMatchedStake, backMatchedPrice) {
    try {
      // Get current market prices
      const book = await this.getMarketBookSafe(trade.betfair_market_id, sessionToken, 'greenup-book');
      const runner = book?.runners?.find(r => r.selectionId == trade.selection_id);
      const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;
      
      if (!currentLayPrice) {
        this.logger.error(`[strategy:epl_under25] No lay price available for green-up - trade exposed!`);
        await this.updateTrade(trade.id, {
          status: 'back_matched',
          back_matched_size: backMatchedStake,
          back_price: backMatchedPrice,
          back_stake: backMatchedStake,
          total_stake: backMatchedStake,
          last_error: 'NO_LAY_PRICE_FOR_GREENUP',
        });
        return;
      }

      // Calculate lay stake for green-up: layStake = backStake * backPrice / layPrice
      // CRITICAL: Use matched back price as anchor, NOT current market lay price
      const layTicksCount = this.settings.lay_ticks_below_back || this.defaults.lay_ticks_below_back || 2;
      const targetLayPrice = ticksBelow(backMatchedPrice, layTicksCount);
      const greenUpLayStake = (backMatchedStake * backMatchedPrice) / targetLayPrice;
      const layStake = Math.max(0, Math.round(greenUpLayStake * 100) / 100);
      
      this.logger.log(`[strategy:epl_under25] Green-up calculation: Back £${backMatchedStake} @ ${backMatchedPrice} → Lay £${layStake} @ ${targetLayPrice} (${layTicksCount} ticks below back price)`);
      this.logger.log(`[strategy:epl_under25]   Formula: ${backMatchedStake} × ${backMatchedPrice} / ${targetLayPrice} = ${layStake} | Current market lay: ${currentLayPrice}`);

      if (layStake <= 0) {
        this.logger.error(`[strategy:epl_under25] Invalid lay stake calculated: ${layStake}`);
        return;
      }

      // Place lay order with PERSIST (keeps in-play)
      // GUARDRAIL: Use verification to ensure order is actually placed
      const layPersistence = this.settings.lay_persistence || this.defaults.lay_persistence || 'PERSIST';
      
      const layResult = await this.placeLayOrderWithVerification({
        marketId: trade.betfair_market_id,
        selectionId: trade.selection_id,
        stake: layStake,
        price: targetLayPrice,
        sessionToken,
        label: 'greenup-lay',
        persistenceType: layPersistence,
        maxRetries: 3,
        verifyDelayMs: 500,
      });
      
      if (layResult.status === 'SUCCESS' || layResult.status === 'PARTIAL') {
        const layBetId = layResult.betId;
        this.logger.log(`[strategy:epl_under25] ✓ LAY ORDER PLACED for green-up: £${layStake} @ ${targetLayPrice} (persistence=${layPersistence}, verified after ${layResult.attempts} attempts) - betId: ${layBetId}`);
        
        // Calculate expected green-up profit
        const profitIfWins = backMatchedStake * (backMatchedPrice - 1) - layStake * (targetLayPrice - 1);
        const profitIfLoses = layStake - backMatchedStake;
        const commission = this.settings.commission_rate || this.defaults.commission_rate;
        const expectedProfit = Math.min(profitIfWins, profitIfLoses) * (1 - commission);
        this.logger.log(`[strategy:epl_under25]   Expected green-up profit: £${expectedProfit.toFixed(2)} (if wins: £${profitIfWins.toFixed(2)}, if loses: £${profitIfLoses.toFixed(2)})`);
        
        // Update trade with lay info and transition to back_matched (state machine will monitor)
        await this.updateTrade(trade.id, {
          status: 'back_matched',
          back_matched_size: backMatchedStake,
          back_price: backMatchedPrice,
          back_stake: backMatchedStake,
          lay_order_ref: layBetId,
          lay_price: targetLayPrice,
          lay_size: layStake,
          lay_placed_at: new Date().toISOString(),
          total_stake: backMatchedStake + layStake,
          last_error: null,
          // State machine - start at MONITORING since lay is placed
          state_data: {
            phase: 'MONITORING',
            profit_order_id: layBetId,
            last_stable_price: backMatchedPrice,
            lay_snapshot: { stake: layStake, price: targetLayPrice },
          },
        });
        
        trade.status = 'back_matched';
        trade.lay_order_ref = layBetId;
        trade.lay_price = targetLayPrice;
        trade.lay_size = layStake;
        trade.total_stake = backMatchedStake + layStake;
        
        await this.logEvent(trade.id, 'LAY_PLACED', {
          price: targetLayPrice,
          stake: layStake,
          betId: layBetId,
          persistence: layPersistence,
          verification_attempts: layResult.attempts,
          green_up_calc: {
            back_matched_stake: backMatchedStake,
            back_matched_price: backMatchedPrice,
            formula: 'backStake * backPrice / layPrice',
          },
          expected_profit: expectedProfit,
          timestamp: new Date().toISOString(),
        });
        
      } else {
        const errorCode = layResult.error || 'unknown';
        this.logger.error(`[strategy:epl_under25] ✗ LAY ORDER FAILED after ${layResult.attempts} attempts: ${errorCode} - trade is exposed!`);
        
        await this.updateTrade(trade.id, {
          status: 'back_matched',
          back_matched_size: backMatchedStake,
          back_price: backMatchedPrice,
          back_stake: backMatchedStake,
          total_stake: backMatchedStake,
          last_error: `LAY_PLACEMENT_FAILED: ${errorCode}`,
          state_data: { phase: 'INITIAL' },  // Will retry lay placement
        });
        
        await this.logEvent(trade.id, 'LAY_FAILED', { 
          errorCode,
          attempted_price: targetLayPrice,
          attempted_stake: layStake,
        });
      }
      
    } catch (err) {
      this.logger.error(`[strategy:epl_under25] placeLayForGreenUp error: ${err.message}`);
      await this.updateTrade(trade.id, {
        status: 'back_matched',
        back_matched_size: backMatchedStake,
        back_price: backMatchedPrice,
        back_stake: backMatchedStake,
        total_stake: backMatchedStake,
        last_error: `LAY_PLACEMENT_EXCEPTION: ${err.message}`,
        state_data: { phase: 'INITIAL' },
      });
    }
  }

  async handleScheduledTrade(trade, now, trigger) {
    const kickoff = trade.kickoff_at ? new Date(trade.kickoff_at) : null;
    if (!kickoff) return;
    const minsToKick = (kickoff.getTime() - now.getTime()) / 60000;
    const leadTime = this.settings.back_lead_minutes || this.defaults.back_lead_minutes;

    // Early return for trades outside window - don't clutter logs
    if (minsToKick > leadTime) {
      // Trade not in window yet - smart scheduler will wake us later
      return;
    }

    // Only log trades that are in window or need action
    const fixtureName = trade.fixture_name || trade.event_id;
    const tradeRef = typeof trade.id === 'string'
      ? trade.id.slice(0, 8)
      : (trade.id || 'unknown');

    this.logger.log(`[strategy:${STRATEGY_KEY}] check trade ${fixtureName} (ID:${tradeRef}): minsToKick=${minsToKick.toFixed(1)}, leadTime=${leadTime}`);

    if (minsToKick < -10) {
      await this.updateTrade(trade.id, { status: 'cancelled', last_error: 'Missed pre-match window' });
      await this.logEvent(trade.id, 'MISSED_WINDOW', { now: now.toISOString(), kickoff: kickoff.toISOString() });
      return;
    }

    // Data capture: back_price_at_kickoff (1 min before kickoff, for scheduled trades)
    // This is purely for analysis - does not affect strategy logic
    await this.captureBackPriceAtKickoff(trade, now);

    if (minsToKick <= leadTime && minsToKick > 0) {
      await this.placeBackOrder(trade, trigger);
    }
  }

  async recordLaySnapshot(trade, { layStake, layPrice, betId }) {
    const numericLayStake = Number(layStake || 0);
    const totalStake = (trade.back_stake || trade.back_size || 0) + numericLayStake;

    const patch = {
      lay_price: layPrice,
      lay_size: numericLayStake,
      total_stake: totalStake,
    };
    if (betId) {
      patch.lay_order_ref = betId;
    }

    await this.updateTrade(trade.id, patch);

    trade.lay_price = layPrice;
    trade.lay_size = numericLayStake;
    if (betId) {
      trade.lay_order_ref = betId;
    }
    trade.total_stake = totalStake;
  }

  async settleTradeWithPnl(trade, state, options = {}) {
    const {
      layStakeOverride,
      layPriceOverride,
      additionalPatch = {},
      exposureTimeSeconds = null,
      partialLayMatched = 0,
      partialLayPrice = 0,
    } = options;

    const commission = this.settings?.commission_rate ?? this.defaults.commission_rate;
    
    // FIX: Use || instead of ?? to skip explicit zeros
    // Priority: matched amounts > requested amounts > fallbacks
    const backStake = Number(
      trade.back_matched_size ||
      trade.back_stake ||
      trade.back_size ||
      trade.target_stake ||
      0,
    );
    const backPrice = trade.back_price || trade.back_price_snapshot || trade.hedge_target_price;
    
    // CRITICAL FIX: Explicit type check to handle 0 matched stake correctly
    // Using || would treat 0 as falsy and fall back to trade.lay_size (phantom match bug)
    let currentLayStake = 0;
    if (typeof layStakeOverride === 'number') {
      // layStakeOverride parameter passed (including 0 for cancelled orders)
      currentLayStake = layStakeOverride;
    } else if (trade.lay_matched_size !== undefined && trade.lay_matched_size !== null) {
      // Use actual matched size from trade record
      currentLayStake = trade.lay_matched_size;
    } else {
      // Fallback to requested size (for legacy records)
      currentLayStake = trade.lay_size || 0;
    }
    currentLayStake = Number(currentLayStake);
    
    // CRITICAL FIX: Aggregate partial lay matches (profit target) with stop-loss lay
    // Without this, partial matches are lost from P&L calculation
    let aggregateLayStake = currentLayStake;
    let aggregateLayPrice = layPriceOverride || trade.lay_price || trade.hedge_target_price || 0;
    
    if (partialLayMatched > 0 && partialLayPrice > 0) {
      // Combine partial match with stop-loss/recovery lay
      const totalLayStake = partialLayMatched + currentLayStake;
      
      if (totalLayStake > 0) {
        // Weighted average price: (partial_stake * partial_price + current_stake * current_price) / total_stake
        aggregateLayPrice = (
          (partialLayMatched * partialLayPrice) + (currentLayStake * (layPriceOverride || trade.lay_price || 0))
        ) / totalLayStake;
        aggregateLayStake = totalLayStake;
      }
      
      this.logger.log(`[strategy:epl_under25] Aggregating lay positions:`);
      this.logger.log(`[strategy:epl_under25]   Partial (profit target): £${partialLayMatched.toFixed(2)} @ ${partialLayPrice.toFixed(2)}`);
      this.logger.log(`[strategy:epl_under25]   Stop-loss/Recovery: £${currentLayStake.toFixed(2)} @ ${(layPriceOverride || trade.lay_price || 0).toFixed(2)}`);
      this.logger.log(`[strategy:epl_under25]   Aggregate: £${aggregateLayStake.toFixed(2)} @ ${aggregateLayPrice.toFixed(2)} (weighted avg)`);
    }
    
    const layStake = aggregateLayStake;
    const layPrice = aggregateLayPrice;
    
    // Validation logging - show exactly what values are being used
    const eventName = trade.event_name || trade.fixture_name || trade.event_id || 'Unknown';
    this.logger.log(`[strategy:epl_under25] Settlement calc for ${eventName}:`);
    this.logger.log(`[strategy:epl_under25]   Back: £${backStake} @ ${backPrice} (matched=${trade.back_matched_size}, stake=${trade.back_stake}, size=${trade.back_size})`);
    this.logger.log(`[strategy:epl_under25]   Lay:  £${layStake} @ ${layPrice} (matched=${trade.lay_matched_size}, size=${trade.lay_size}, override=${layStakeOverride})`);
    this.logger.log(`[strategy:epl_under25]   Commission: ${(commission * 100).toFixed(2)}%`);
    
    // Calculate P&L
    let realised = computeRealisedPnlSnapshot({
      backStake,
      backPrice,
      layStake,
      layPrice,
      commission,
    });

    // --- FIX: Handle Full Loss on Market Closure (Zero Lay Match) ---
    // If PnL is null, it means layStake was 0.
    // If we are settling because the market is CLOSED (or cancelled/monitor phase),
    // this implies a 100% loss of the back stake.
    if (realised === null && (state?.phase === 'COMPLETED' || trade.status === 'cancelled' || trade.status === 'post_trade_monitor')) {
      // STRICT CHECK: Only force loss if we have a back stake but ABSOLUTELY NO lay stake.
      // (Partial matches return a valid negative number, so they won't trigger this).
      if (backStake > 0 && layStake === 0) {
        realised = -backStake;
        this.logger.log(`[strategy:epl_under25] 📉 Market settled with NO lay match - forcing PnL to FULL LOSS: £${realised.toFixed(2)}`);
      }
    }

    // Handle null P&L (lay not matched - trade incomplete)
    if (realised === null) {
      this.logger.warn(`[strategy:epl_under25] ⚠️ Cannot calculate P&L - lay data missing (layStake=${layStake}, layPrice=${layPrice})`);
      this.logger.warn(`[strategy:epl_under25]   Trade ${eventName} will be marked hedged but P&L is NULL (incomplete data)`);
    }

    // Calculate exposure time (only in-play time - can't be negative)
    // For prematch: exposure = lay_matched_time - max(back_matched_time, actual_kickoff_time)
    // This ensures we only count in-play exposure, not pre-match waiting time
    const stateData = state || trade.state_data || {};
    const layMatchedAt = Date.now();
    let finalExposureTimeSeconds = exposureTimeSeconds;
    
    if (finalExposureTimeSeconds == null && stateData.position_entered_at) {
      const backMatchedAt = stateData.position_entered_at;
      // Use actual kickoff time if available, fallback to scheduled kickoff
      const actualKickoffTime = stateData.actual_kickoff_time || 0;
      const scheduledKickoffTime = trade.kickoff_at ? new Date(trade.kickoff_at).getTime() : 0;
      const kickoffTime = actualKickoffTime || scheduledKickoffTime;
      
      // Exposure starts from whichever is later: back matched or kickoff
      const exposureStartTime = Math.max(backMatchedAt, kickoffTime);
      finalExposureTimeSeconds = Math.max(0, Math.floor((layMatchedAt - exposureStartTime) / 1000));
      
      this.logger.log(`[strategy:epl_under25]   Exposure: ${finalExposureTimeSeconds}s (back matched: ${new Date(backMatchedAt).toISOString()}, kickoff: ${kickoffTime ? new Date(kickoffTime).toISOString() : 'N/A'} ${actualKickoffTime ? '(actual)' : '(scheduled)'}, lay matched: ${new Date(layMatchedAt).toISOString()})`);
    }

    // Initialize shadow monitoring state for post-trade analytics
    // CRITICAL: Preserve min_post_entry_price from live MONITORING phase (don't reset to null)
    // CRITICAL: Preserve goal_detected_during_live_trade flag to freeze min price in shadow monitor
    const monitorState = {
      ...state,
      phase: 'POST_TRADE_MONITOR',
      is_shadow_trade: false,  // This is a completed trade, not a skipped one
      exit_reason: additionalPatch.last_error || 'TRADE_SETTLED',
      realised_pnl: realised,
      monitor_started_at: Date.now(),
      // Preserve min_post_entry_price from live tracking (if available)
      // Only reset to null if it was never tracked during MONITORING phase
      min_post_entry_price: state.min_post_entry_price || null,
      // Preserve goal flag to prevent corruption from post-goal drift
      goal_detected_during_live_trade: state.goal_detected_during_live_trade || false,
      min_price_frozen_at_goal: state.min_price_frozen_at_goal || null,
      last_monitor_poll: 0,  // Allow immediate first poll
    };
    
    // Log goal freeze status for audit trail
    if (state.goal_detected_during_live_trade) {
      this.logger.log(`[strategy:epl_under25]   🔒 Goal flag preserved: min_post_entry_price=${state.min_post_entry_price} FROZEN (will not update in shadow monitoring)`);
    }

    const patch = {
      status: 'post_trade_monitor',  // Transition to shadow monitoring
      lay_matched_size: layStake || null,
      realised_pnl: realised,  // May be null if lay data missing
      pnl: realised,
      settled_at: new Date().toISOString(),
      total_stake: backStake + layStake,
      exposure_time_seconds: finalExposureTimeSeconds,
      state_data: monitorState,
      ...additionalPatch,
    };

    await this.updateTrade(trade.id, patch);

    // Log clear profit/loss outcome (handle null realised)
    if (realised !== null) {
      const outcomeSymbol = realised >= 0 ? '✓ PROFIT' : '✗ LOSS';
      this.logger.log(`[strategy:epl_under25] ${outcomeSymbol}: £${realised.toFixed(2)} on ${eventName}`);
    } else {
      this.logger.log(`[strategy:epl_under25] ⚠️ P&L UNKNOWN (incomplete data) on ${eventName}`);
    }
    this.logger.log(`[strategy:epl_under25]   Back: £${backStake.toFixed(2)} @ ${backPrice} | Lay: £${layStake.toFixed(2)} @ ${layPrice}`);
    
    // Log min_post_entry_price preservation (data quality check)
    if (state.min_post_entry_price) {
      this.logger.log(`[strategy:epl_under25]   📊 Min price captured: ${state.min_post_entry_price} (preserved from live tracking)`);
    } else {
      this.logger.log(`[strategy:epl_under25]   ⚠️ Min price: NOT CAPTURED (trade settled before tracking initialized)`);
    }

    await this.logEvent(trade.id, 'TRADE_SETTLED', {
      realised_pnl: realised,
      back_stake: backStake,
      back_price: backPrice,
      lay_stake: layStake,
      lay_price: layPrice,
      commission,
      exposure_time_seconds: finalExposureTimeSeconds,
      min_post_entry_price: state.min_post_entry_price || null,
      time_at_min_price: state.time_at_min_price || null,
      goal_detected_during_live_trade: state.goal_detected_during_live_trade || false,
      min_price_frozen_at_goal: state.min_price_frozen_at_goal || null,
      outcome: realised === null ? 'unknown' : (realised >= 0 ? 'profit' : 'loss'),
    });

    trade.status = 'hedged';
    trade.lay_matched_size = layStake;
    trade.realised_pnl = realised;
    trade.pnl = realised;
    trade.total_stake = backStake + layStake;
  }

  // --- Post-Trade Shadow Monitoring ---

  /**
   * POST_TRADE_MONITOR handler.
   * Tracks min price after trade completion/skip for analytics.
   * 
   * PERFORMANCE: 60-second throttle to prevent API exhaustion during goal spikes.
   * Shadow trades are low priority - real trades always execute first.
   * 
   * DATA INTEGRITY: 
   * - Inherits min_post_entry_price from live MONITORING phase if available
   * - If goal occurred during live trading, starts with pre-goal minimum (preserved)
   * - If goal occurs during shadow monitoring, freezes min at pre-goal value (90s confirmation)
   * - This prevents end-of-game drift (1.01) from overwriting valid minimums
   * 
   * Stop conditions:
   * - 120 mins elapsed since monitoring started
   * - Market closed
   */
  async handlePostTradeMonitor(trade, now) {
    const state = trade.state_data || {};
    const eventName = trade.event_name || trade.fixture_name || trade.event_id || 'Unknown';
    
    // --- Throttle Gate: 60-second cooldown ---
    // During goal spikes, main loop runs every few seconds.
    // Shadow monitoring doesn't need that resolution - 60s is sufficient.
    const SHADOW_POLL_COOLDOWN_MS = 60000;
    const pollCheckTime = Date.now();
    
    if (state.last_monitor_poll && (pollCheckTime - state.last_monitor_poll) < SHADOW_POLL_COOLDOWN_MS) {
      // Throttled - skip this poll cycle
      return;
    }
    
    // Update last poll time (will be persisted at end)
    state.last_monitor_poll = pollCheckTime;
    
    // --- Stop Condition: Max duration (120 mins) ---
    const MAX_MONITOR_DURATION_MS = 120 * 60 * 1000;
    if (state.monitor_started_at && (pollCheckTime - state.monitor_started_at) > MAX_MONITOR_DURATION_MS) {
      this.logger.log(`[strategy:epl_under25] Shadow monitoring timeout (120 mins) for ${eventName} - finalizing`);
      await this.finalizeShadowMonitoring(trade, state, 'MAX_DURATION_REACHED');
      return;
    }
    
    // --- Get market data ---
    const sessionToken = await this.requireSessionWithRetry('shadow-monitor');
    const market = await this.ensureMarket(trade, sessionToken);
    if (!market) {
      this.logger.warn(`[strategy:epl_under25] Shadow monitor: no market for ${eventName}`);
      return;
    }
    
    const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'shadow-monitor');
    
    // --- Stop Condition: Market closed ---
    if (book && book.status === 'CLOSED') {
      this.logger.log(`[strategy:epl_under25] Market closed for ${eventName} - finalizing shadow monitoring`);
      await this.finalizeShadowMonitoring(trade, state, 'MARKET_CLOSED');
      return;
    }
    
    // --- Track min price (lowest lay price = best potential profit) ---
    const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
    const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;
    
    if (currentLayPrice) {
      // --- FREEZE ON GOAL: Skip updates if goal was detected during live trade OR confirmed in shadow monitoring ---
      if (state.goal_detected_during_live_trade) {
        // Goal occurred during active trade (MONITORING phase) - min price already captured before goal
        // Do NOT update min_post_entry_price to prevent corruption from post-goal drift
        this.logger.log(`[strategy:epl_under25] 🔒 Min price FROZEN for ${eventName} (goal during live trade) - preserving ${state.min_post_entry_price || 'N/A'}, ignoring current ${currentLayPrice}`);
        return;
      }
      
      if (state.shadow_goal_detected) {
        // Goal confirmed during shadow monitoring - min price is frozen at pre-goal value
        this.logger.log(`[strategy:epl_under25] 🔒 Min price FROZEN for ${eventName} (shadow goal confirmed) - preserving ${state.min_post_entry_price || 'N/A'}, ignoring current ${currentLayPrice}`);
        return;
      }
      
      // --- Spike Detection: Check for 30% price increase (potential goal) ---
      const minPrice = state.min_post_entry_price;
      if (minPrice && currentLayPrice > (minPrice * 1.30)) {
        // Potential goal spike detected (30% above recorded minimum)
        const GOAL_CONFIRMATION_WAIT_MS = 90000; // 90 seconds guardrail
        
        if (!state.shadow_spike_start_ts) {
          // First spike detection - start confirmation timer
          state.shadow_spike_start_ts = pollCheckTime;
          this.logger.log(`[strategy:epl_under25] 🎯 Shadow spike detected: ${currentLayPrice} > ${(minPrice * 1.30).toFixed(2)} (30% above min) for ${eventName} - waiting 90s to confirm goal`);
        } else {
          // Spike already in progress - check if confirmation period elapsed
          const spikeElapsed = pollCheckTime - state.shadow_spike_start_ts;
          
          if (spikeElapsed >= GOAL_CONFIRMATION_WAIT_MS) {
            // Spike persisted for 90 seconds - confirm goal and FREEZE min price
            state.shadow_goal_detected = true;
            state.shadow_goal_detected_at = pollCheckTime;
            this.logger.log(`[strategy:epl_under25] 🎯 SHADOW GOAL CONFIRMED (spike persisted 90s) for ${eventName} - FREEZING min_post_entry_price at ${minPrice}`);
            
            await this.logEvent(trade.id, 'SHADOW_GOAL_DETECTED', {
              min_price_frozen_at: minPrice,
              spike_price: currentLayPrice,
              spike_pct: ((currentLayPrice - minPrice) / minPrice * 100).toFixed(1),
              timestamp: new Date().toISOString(),
            });
          } else {
            this.logger.log(`[strategy:epl_under25] Shadow spike ongoing: ${(spikeElapsed / 1000).toFixed(0)}s / ${(GOAL_CONFIRMATION_WAIT_MS / 1000)}s for ${eventName}`);
          }
        }
      } else {
        // Price is normal (no spike) - reset spike tracking if it was active
        if (state.shadow_spike_start_ts) {
          this.logger.log(`[strategy:epl_under25] Shadow spike reset (false alarm) for ${eventName}`);
          state.shadow_spike_start_ts = null;
        }
        
        // Update min price if lower (only when no goal detected)
        if (state.min_post_entry_price === null || currentLayPrice < state.min_post_entry_price) {
          state.min_post_entry_price = currentLayPrice;
          state.time_at_min_price = Math.floor((pollCheckTime - (state.monitor_started_at || pollCheckTime)) / 1000);
          this.logger.log(`[strategy:epl_under25] 📊 Shadow min price updated: ${currentLayPrice} for ${eventName}`);
        }
      }
    }
    
    // --- Persist state (fire-and-forget style - don't await in hot path) ---
    // Using setImmediate to avoid blocking the main loop
    setImmediate(async () => {
      try {
        await this.updateTrade(trade.id, {
          state_data: state,
          min_post_entry_price: state.min_post_entry_price,
        });
      } catch (err) {
        this.logger.warn(`[strategy:epl_under25] Shadow monitor state persist failed: ${err.message}`);
      }
    });
  }

  /**
   * Finalize shadow monitoring and persist final analytics data.
   */
  async finalizeShadowMonitoring(trade, state, reason) {
    const eventName = trade.event_name || trade.fixture_name || trade.event_id || 'Unknown';
    
    this.logger.log(`[strategy:epl_under25] Finalizing shadow monitoring for ${eventName} (reason: ${reason})`);
    
    state.phase = 'COMPLETED';
    state.monitor_ended_at = Date.now();
    state.monitor_end_reason = reason;
    
    const updatePayload = {
      status: 'hedged',  // Final status for completed trades
      state_data: state,
      min_post_entry_price: state.min_post_entry_price,
    };
    
    // For shadow trades (skipped), use 'cancelled' as final status
    if (state.is_shadow_trade) {
      updatePayload.status = 'cancelled';
      updatePayload.theoretical_entry_price = state.theoretical_entry_price;
    }
    
    await this.updateTrade(trade.id, updatePayload);
    
    await this.logEvent(trade.id, 'SHADOW_MONITORING_COMPLETED', {
      reason,
      is_shadow_trade: state.is_shadow_trade,
      skip_reason: state.skip_reason || null,
      theoretical_entry_price: state.theoretical_entry_price || null,
      min_post_entry_price: state.min_post_entry_price,
      time_at_min_price: state.time_at_min_price,
      goal_detected_during_live_trade: state.goal_detected_during_live_trade || false,
      min_price_frozen_at_goal: state.min_price_frozen_at_goal || null,
      shadow_goal_detected: state.shadow_goal_detected || false,
      monitor_duration_seconds: state.monitor_started_at 
        ? Math.floor((Date.now() - state.monitor_started_at) / 1000) 
        : null,
      timestamp: new Date().toISOString(),
    });
    
    const tradeType = state.is_shadow_trade ? 'SHADOW' : 'COMPLETED';
    this.logger.log(`[strategy:epl_under25] 📊 Shadow monitoring complete [${tradeType}]: ${eventName} | min_price=${state.min_post_entry_price || 'N/A'}`);
  }

  /**
   * Capture back_price_at_kickoff 1 minute before kickoff (data logging only).
   * This is purely for post-trade analysis - does NOT affect strategy logic.
   * Runs for ALL active trades regardless of status.
   */
  async captureBackPriceAtKickoff(trade, now) {
    // Skip if already captured
    if (trade.back_price_at_kickoff) return;
    
    const kickoff = trade.kickoff_at ? new Date(trade.kickoff_at) : null;
    if (!kickoff) return;
    
    const minsToKickoff = (kickoff.getTime() - now.getTime()) / 60000;
    
    // Only capture in the window: 1 minute before kickoff (between 0 and 1 min to kick)
    if (minsToKickoff > 1 || minsToKickoff <= 0) return;
    
    const eventName = trade.event_name || trade.fixture_name || trade.event_id || 'Unknown';
    
    try {
      const sessionToken = await this.requireSessionWithRetry('back-price-at-kickoff');
      const market = await this.ensureMarket(trade, sessionToken);
      if (!market) return;
      
      const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'back-price-at-kickoff');
      const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
      const backPriceAtKickoff = runner?.ex?.availableToBack?.[0]?.price || null;
      
      if (backPriceAtKickoff) {
        this.logger.log(`[strategy:epl_under25] 📊 BACK PRICE AT KICKOFF captured: ${backPriceAtKickoff} for ${eventName} (${minsToKickoff.toFixed(1)} mins to kick, status: ${trade.status})`);
        await this.updateTrade(trade.id, { back_price_at_kickoff: backPriceAtKickoff });
        trade.back_price_at_kickoff = backPriceAtKickoff; // Update local object to prevent re-capture
        await this.logEvent(trade.id, 'BACK_PRICE_AT_KICKOFF', {
          back_price_at_kickoff: backPriceAtKickoff,
          mins_to_kickoff: minsToKickoff,
          trade_status: trade.status,
          timestamp: new Date().toISOString(),
        });
      } else {
        this.logger.warn(`[strategy:epl_under25] ⚠️ Could not capture back_price_at_kickoff for ${eventName} (no back price available)`);
      }
    } catch (err) {
      this.logger.warn(`[strategy:epl_under25] Failed to capture back_price_at_kickoff for ${eventName}: ${err.message}`);
    }
  }

  async updateTrade(id, patch) {
    const { error } = await this.supabase
      .from('strategy_trades')
      .update(patch)
      .eq('id', id);
    if (error) throw error;
  }

  async logEvent(tradeId, eventType, payload) {
    await this.supabase
      .from('strategy_trade_events')
      .insert({
        trade_id: tradeId,
        event_type: eventType,
        payload: payload || {},
      });
  }
}

module.exports = {
  STRATEGY_KEY,
  calculateLayStake,
  calculateHedgeStake,
  computeTargetLayPrice,
  createEplUnder25Strategy: (deps) => new EplUnder25Strategy(deps),
};
