const { addDays } = require('date-fns');

const { roundToBetfairTick } = require('../betfair-utils');

const STRATEGY_KEY = 'epl_under25';
const SOCCER_EVENT_TYPE_ID = '1';
const UNDER_RUNNER_NAME = 'Under 2.5 Goals';
// Strict matching for English Premier League ONLY
const COMPETITION_MATCHERS = [/^English Premier League$/i];
const EPL_COMPETITION_IDS = ['10932509']; // Betfair's EPL competition ID

function getDefaultSettings() {
  return {
    default_stake: parseFloat(process.env.EPL_UNDER25_DEFAULT_STAKE || '10'),
    min_back_price: parseFloat(process.env.EPL_UNDER25_MIN_BACK_PRICE || '2.0'),
    lay_target_price: parseFloat(process.env.EPL_UNDER25_LAY_TARGET_PRICE || '1.9'), // Fallback if profit pct not used
    min_profit_pct: parseFloat(process.env.EPL_UNDER25_MIN_PROFIT_PCT || '10'),
    back_lead_minutes: parseInt(process.env.EPL_UNDER25_BACK_LEAD_MINUTES || '30', 10),
    fixture_lookahead_days: parseInt(process.env.EPL_UNDER25_FIXTURE_LOOKAHEAD_DAYS || '7', 10),
    commission_rate: parseFloat(process.env.EPL_UNDER25_COMMISSION_RATE || '0.02'),
  };
}

function calculateLayStake({ backStake, backPrice, layPrice, commission = 0.02 }) {
  if (!backStake || !backPrice || !layPrice) {
    return { layStake: 0, profitBack: 0, profitLay: 0 };
  }
  const denom = layPrice - commission;
  if (denom <= 0) {
    return { layStake: 0, profitBack: 0, profitLay: 0 };
  }
  const rawStake = (backStake * backPrice) / denom;
  const layStake = Math.max(0, Math.round(rawStake * 100) / 100);
  const grossWin = backStake * (backPrice - 1);
  const hedgeLoss = layStake * (layPrice - 1);
  const profitBack = Number((grossWin - hedgeLoss).toFixed(2));
  const profitLay = Number(((layStake * (1 - commission)) - backStake).toFixed(2));
  return {
    layStake,
    profitBack,
    profitLay,
  };
}

/**
 * Helper to calculate hedge stake from market book
 * @param {Object} book - Market book object
 * @param {string|number} selectionId - Runner selection ID
 * @param {number} backStake - Original back stake
 * @param {number} backPrice - Original back price
 * @param {number} commission - Commission rate (0.02 default)
 * @param {number} [overrideLayPrice] - Optional override for lay price (e.g. for limit orders at target)
 */
function calculateHedgeStake(book, selectionId, backStake, backPrice, commission = 0.02, overrideLayPrice = null) {
  const runner = book?.runners?.find(r => r.selectionId == selectionId);
  if (!runner) return { layStake: 0, layPrice: 0 };

  // Use best available lay price if not overridden
  const marketLayPrice = runner.ex?.availableToLay?.[0]?.price;
  const effectiveLayPrice = overrideLayPrice || marketLayPrice;

  if (!effectiveLayPrice) return { layStake: 0, layPrice: 0 };

  const result = calculateLayStake({
    backStake,
    backPrice,
    layPrice: effectiveLayPrice,
    commission
  });

  return {
    ...result,
    layPrice: effectiveLayPrice
  };
}

function computeTargetLayPrice(backPrice, settings) {
  // Profit locking logic: Target Price = Back Price / (1 + Profit%)
  // e.g. Back @ 2.0, 10% profit => 2.0 / 1.10 = 1.81
  const profitPct = settings?.min_profit_pct || 10;
  const target = backPrice / (1 + (profitPct / 100));
  return roundToBetfairTick(target);
}

function formatFixtureName(home, away, fallback = null) {
  if (home && away) {
    return `${home} v ${away}`;
  }
  return fallback || null;
}

function computeRealisedPnlSnapshot({ backStake, backPrice, layStake, layPrice, commission = 0.02 }) {
  if (!backStake || !backPrice || !layStake || !layPrice) {
    return null;
  }
  const profitBack = backStake * (backPrice - 1) - layStake * (layPrice - 1);
  const profitLay = (layStake * (1 - commission)) - backStake;
  const realised = Math.min(profitBack, profitLay);
  return Number(realised.toFixed(2));
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
    
    // Priority 1: Check for active in-play trades that need monitoring (5s polling)
    const { data: activeTrades } = await this.supabase
      .from('strategy_trades')
      .select('id, status')
      .eq('strategy_key', STRATEGY_KEY)
      .in('status', ['back_matched', 'hedge_pending'])  // Removed 'back_pending' - those sleep until kickoff
      .limit(1);
    
    if (activeTrades?.length > 0) {
      this.logger.log(`[strategy:epl_under25] Active trades detected (${activeTrades[0].status}) - need immediate attention`);
      return 0; // Wake now - active trades need 5s polling
    }
    
    // Priority 2: Check for back_pending orders that need verification at kickoff
    const { data: pendingOrders } = await this.supabase
      .from('strategy_trades')
      .select('needs_check_at, event_id, id')
      .eq('strategy_key', STRATEGY_KEY)
      .eq('status', 'back_pending')
      .not('needs_check_at', 'is', null)
      .order('needs_check_at', { ascending: true })
      .limit(1);
    
    if (pendingOrders?.length > 0) {
      const checkTime = new Date(pendingOrders[0].needs_check_at).getTime();
      const delay = checkTime - now;
      
      // Check if order needs verification NOW (at or past kickoff time)
      if (delay <= 60000) {  // Within 1 minute of kickoff (allows for clock drift)
        this.logger.log(`[strategy:epl_under25] ⚠️ PENDING ORDER NEEDS VERIFICATION NOW (kickoff reached)`);
        return 0; // Check now - trigger processActiveTrades
      }
      
      // Wake up at kickoff to verify if order matched
      const cappedDelay = Math.max(60 * 1000, Math.min(delay, 24 * 60 * 60 * 1000));
      this.logger.log(`[strategy:epl_under25] Pending order check at kickoff (wake in ${(cappedDelay/60000).toFixed(1)} min)`);
      return cappedDelay;
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
      const wakeTime = kickoff - leadTime - (60 * 1000); // Wake 1min before window opens
      const delay = wakeTime - now;
      
      if (delay <= 0) {
        this.logger.log(`[strategy:epl_under25] Trade window is open - process scheduled trades now`);
        return 0; // Trade window is open
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
        // Immediate action needed
        
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
        
        // Check again in 5s (tight loop when action needed)
        this.smartSchedulerTimer = setTimeout(() => this.smartSchedulerLoop(), 5000);
        
      } else if (nextWake < 5 * 60 * 1000) {
        // Less than 5 minutes until next action - frequent checks
        this.logger.log(`[strategy:epl_under25] Smart scheduler: ${(nextWake/1000).toFixed(0)}s until next action - checking frequently`);
        
        // Process scheduled trades to catch any in window
        await this.processScheduledTrades('smart-scheduler');
        
        // Check again in 30s
        this.smartSchedulerTimer = setTimeout(() => this.smartSchedulerLoop(), 30000);
        
      } else {
        // More than 5 minutes away - go to sleep
        const wakeMinutes = (nextWake / 60000).toFixed(1);
        this.logger.log(`[strategy:epl_under25] Smart scheduler: SLEEPING for ${wakeMinutes} minutes (no games need attention)`);
        
        // Stop active polling if running (no in-play games)
        this.stopActivePolling();
        
        // Sleep until calculated wake time
        this.smartSchedulerTimer = setTimeout(() => {
          this.logger.log(`[strategy:epl_under25] Smart scheduler: WAKING UP - checking for work`);
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
   * Start active 5-second polling for in-play games
   * Only called when games are actually in-play
   */
  startActivePolling() {
    if (this.activePollingTimer) return; // Already running
    
    this.logger.log('[strategy:epl_under25] ▶ STARTING active 5s polling (in-play games detected)');
    
    this.activePollingTimer = setInterval(() => {
      this.processActiveTrades('smart-active').catch(this.logError('processActiveTrades'));
    }, 5 * 1000);
    
    // Run immediately
    this.processActiveTrades('smart-active-immediate').catch(this.logError('processActiveTrades'));
  }

  /**
   * Stop active 5-second polling when no in-play games
   * Saves database queries
   */
  stopActivePolling() {
    if (this.activePollingTimer) {
      this.logger.log('[strategy:epl_under25] ⏸ STOPPING active 5s polling (no in-play games)');
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
    try {
      return await this.betfair.rpc(sessionToken, method, params);
    } catch (err) {
      this.logger.warn(`[strategy:epl_under25] RPC retry needed for ${label} (${method}): ${err.message}`);
      try {
        // Refresh session on retry if needed, or just retry call
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

  async cancelOrderSafe(betId, sessionToken, label) {
    if (!betId) return;
    try {
      await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/cancelOrders', {
        instructions: [{ betId }],
      }, label);
    } catch (err) {
      // Logged in rpcWithRetry
    }
  }

  async placeLimitLaySafe(marketId, selectionId, size, price, sessionToken, label) {
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
              persistenceType: 'LAPSE',
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
        min_back_price: this.defaults.min_back_price,
        lay_target_price: this.defaults.lay_target_price,
        min_profit_pct: this.defaults.min_profit_pct,
        back_lead_minutes: this.defaults.back_lead_minutes,
        fixture_lookahead_days: this.defaults.fixture_lookahead_days,
        commission_rate: this.defaults.commission_rate,
      };
      const { data: created, error: insertErr } = await this.supabase
        .from('strategy_settings')
        .insert(insert)
        .select()
        .single();
      if (insertErr) throw insertErr;
      this.settings = created;
    } else {
      this.settings = data;
      // Patch missing columns if needed
      if (this.settings.min_profit_pct === undefined) {
        this.logger.log('[strategy:epl_under25] patching missing min_profit_pct setting');
        await this.supabase
          .from('strategy_settings')
          .update({ min_profit_pct: this.defaults.min_profit_pct })
          .eq('strategy_key', STRATEGY_KEY);
        this.settings.min_profit_pct = this.defaults.min_profit_pct;
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
      this.settings = data;
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

      // 1. Get competitions - find EPL competition ID
      const competitionsRes = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCompetitions', {
        filter: { eventTypeIds: [SOCCER_EVENT_TYPE_ID] },
      }, 'listCompetitions');

      this.logger.log(`[strategy:epl_under25] Fetched ${competitionsRes?.length || 0} soccer competitions from Betfair`);
      // Match competitions by name using regex
      const matchedCompetitions = (competitionsRes || [])
        .filter((c) => COMPETITION_MATCHERS.some((rx) => rx.test(c.competition?.name || '')));

      if (matchedCompetitions.length > 0) {
        this.logger.log(`[strategy:epl_under25] ✓ Matched EPL competitions: ${matchedCompetitions.map(c => `"${c.competition?.name}" (ID: ${c.competition?.id})`).join(', ')}`);
      } else {
        this.logger.warn(`[strategy:epl_under25] ⚠️ No competitions matched regex patterns: ${COMPETITION_MATCHERS.map(r => r.toString()).join(', ')}`);
        this.logger.log(`[strategy:epl_under25] Available competitions (first 15): ${(competitionsRes || []).slice(0,15).map(c => `"${c.competition?.name}" (ID: ${c.competition?.id})`).join(', ')}`);
      }

      const matchedCompetitionIds = matchedCompetitions
        .map((c) => c.competition?.id)
        .filter(Boolean);

      // Use matched IDs, fallback to hardcoded EPL ID if no regex match
      let competitionIds = matchedCompetitionIds;
      if (competitionIds.length === 0) {
        this.logger.warn(`[strategy:epl_under25] Using hardcoded EPL competition ID: ${EPL_COMPETITION_IDS.join(', ')}`);
        competitionIds = EPL_COMPETITION_IDS;
      }

      if (!competitionIds.length) {
        this.logger.error(`[strategy:${STRATEGY_KEY}] CRITICAL: No EPL competition IDs available - cannot proceed`);
        return;
      }

      this.logger.log(`[strategy:epl_under25] Using competition IDs for event sync: ${competitionIds.join(', ')}`);

      // 2. Get events - Betfair API filters by competitionIds, ensuring only EPL events
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
      
      // Build fixture map - all events are from EPL because of competitionIds filter
      const fixtureMap = new Map();
      
      (eventsRes || []).forEach((evt) => {
        if (!evt?.event?.id) return;
        
        const eventName = evt.event.name || '';
        const parts = eventName.split(' v ');
        const home = parts[0]?.trim() || null;
        const away = parts[1]?.trim() || null;
        
        this.logger.log(`[strategy:epl_under25] Adding EPL fixture: ${eventName} (kickoff: ${evt.event?.openDate})`);
        
        fixtureMap.set(evt.event.id, {
          strategy_key: STRATEGY_KEY,
          betfair_event_id: evt.event.id,
          event_id: evt.event.id,
          competition: 'English Premier League',
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
        await this.pruneFixtures(validEventIds);
        await this.pruneStaleTrades(validEventIds);
        return;
      }

      const { error: upsertErr } = await this.supabase
        .from('strategy_fixtures')
        .upsert(fixtures, { onConflict: 'strategy_key,betfair_event_id' });
      if (upsertErr) throw upsertErr;

      await this.pruneFixtures(validEventIds);
      await this.pruneStaleTrades(validEventIds);

      // Drop fixtures that have already kicked off
      const { error: pruneErr } = await this.supabase
        .from('strategy_fixtures')
        .delete()
        .eq('strategy_key', STRATEGY_KEY)
        .lt('kickoff_at', now.toISOString());
      if (pruneErr && pruneErr.code !== 'PGRST204') throw pruneErr;

      // Ensure trade records exist for all fixtures (creates or reactivates)
      for (const fixture of fixtures) {
        await this.ensureTradeRecord(fixture);
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

    const competitionName = fixture.competition || 'English Premier League';
    const eventName = formatFixtureName(fixture.home, fixture.away, fixture.event_id || fixture.betfair_event_id);

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
      hedge_target_price: this.settings.lay_target_price,
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
      this.logger.log('[strategy:epl_under25] Fixture prune skipped (no EPL ids fetched).');
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

    this.logger.log(`[strategy:epl_under25] Pruned ${staleIds.length} stale fixtures outside EPL scope.`);
  }

  async pruneStaleTrades(validEventIds = new Set()) {
    const keepSet = validEventIds instanceof Set ? validEventIds : new Set(validEventIds || []);
    if (!keepSet.size) {
      this.logger.log('[strategy:epl_under25] Trade prune skipped (no EPL ids fetched).');
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
      .update({ status: 'cancelled', last_error: 'PRUNED_NON_EPL' })
      .in('id', staleIds);
    if (updateErr) throw updateErr;

    for (const trade of stale) {
      await this.logEvent(trade.id, 'TRADE_PRUNED', { reason: 'NOT_EPL', betfair_event_id: trade.betfair_event_id });
    }

    this.logger.warn(`[strategy:epl_under25] Cancelled ${staleIds.length} scheduled trades outside EPL scope.`);
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
        .in('status', ['back_pending', 'back_matched', 'hedge_pending'])
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

      const counts = { back_pending: 0, back_matched: 0, hedge_pending: 0 };
      trades.forEach(t => { if(counts[t.status] !== undefined) counts[t.status]++ });
      this.logger.log(`[strategy:epl_under25] Active tick: ${trades.length} trades (states: back_pending=${counts.back_pending}, back_matched=${counts.back_matched}, hedge_pending=${counts.hedge_pending})`);

      const now = new Date();
      for (const trade of trades) {
        try {
          if (trade.status === 'back_pending') {
            await this.checkBackOrder(trade, now);
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

    // --- PHASE 1: INITIALIZATION & ORDER PLACEMENT ---
    if (phase === 'INITIAL') {
      const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'phase1-book');
      if (!book || !book.inplay) return; // Wait for in-play

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

    // --- PHASE 2: MONITORING LOOP ---
    else if (phase === 'MONITORING') {
      // Check Profit Order Status
      const orderStatus = await this.getOrderStatusSafe(state.profit_order_id, sessionToken, 'phase2-status');
      if (orderStatus === 'EXECUTION_COMPLETE') {
        state.phase = 'COMPLETED';
        await this.settleTradeWithPnl(trade, state);
        this.logger.log(`[strategy:epl_under25] Trade Completed: Profit Target Reached`);
        
        // Trigger smart scheduler to recalculate (trade completed)
        if (process.env.EPL_UNDER25_SCHEDULER_MODE === 'smart' || !process.env.EPL_UNDER25_SCHEDULER_MODE) {
          setImmediate(() => this.smartSchedulerLoop());
        }
        return;
      }

      const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'phase2-book');
      const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
      const currentBackPrice = runner?.ex?.availableToBack?.[0]?.price;

      if (currentBackPrice) {
        if (currentBackPrice > (state.last_stable_price * 1.30)) {
          // SPIKE DETECTED - 30% price movement indicates possible goal
          this.logger.log(`[strategy:epl_under25] Goal Detected (Price: ${currentBackPrice.toFixed(2)} > ${(state.last_stable_price * 1.30).toFixed(2)}) - Cancelling profit order`);
          
          await this.cancelOrderSafe(state.profit_order_id, sessionToken, 'phase2-cancel');
          // Verify cancellation (best effort)
          const verifyStatus = await this.getOrderStatusSafe(state.profit_order_id, sessionToken, 'phase2-cancel-verify');
          if (verifyStatus === 'EXECUTION_COMPLETE') {
              // Order matched during cancel? Treat as success
              this.logger.log('[strategy:epl_under25] Profit order matched during cancellation - Success!');
              state.phase = 'COMPLETED';
              await this.settleTradeWithPnl(trade, state);
              
              // Trigger smart scheduler to recalculate (trade completed)
              if (process.env.EPL_UNDER25_SCHEDULER_MODE === 'smart' || !process.env.EPL_UNDER25_SCHEDULER_MODE) {
                setImmediate(() => this.smartSchedulerLoop());
              }
              return;
          }

          state.phase = 'EVENT_WAIT';
          state.spike_start_ts = Date.now();
          state.peak_price = currentBackPrice;
          updatedState = true;
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
      const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'phase3-book');
      const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
      const currentBackPrice = runner?.ex?.availableToBack?.[0]?.price;

      if (currentBackPrice && currentBackPrice > (state.peak_price || 0)) {
        state.peak_price = currentBackPrice;
        updatedState = true;
      }

      if (elapsed >= 180) { // 3 minutes
        this.logger.log(`[strategy:epl_under25] Phase 3 Decision Time (180s elapsed). Current: ${currentBackPrice?.toFixed(2)}, Stable: ${state.last_stable_price?.toFixed(2)}`);

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
          
          // Capture baseline price for drift calculation
          const baselineLayPrice = runner?.ex?.availableToLay?.[0]?.price;
          if (!baselineLayPrice) {
            this.logger.error('[strategy:epl_under25] No lay price available for recovery, staying in wait');
            return;
          }
          
          // Calculate target hedge price: 85% of current price (15% drift down)
          const targetHedgePrice = roundToBetfairTick(baselineLayPrice * 0.85);
          const { layStake } = this.calculateHedgeStakeFromBook(book, market.selectionId, trade, targetHedgePrice);
          
          if (layStake > 0) {
            // Place limit order at target immediately
            const placeRes = await this.placeLimitLaySafe(market.marketId, market.selectionId, layStake, targetHedgePrice, sessionToken, 'phase4-place');
            
            if (placeRes.status === 'SUCCESS') {
              this.logger.log(`[strategy:epl_under25] Recovery order placed: Lay @ ${targetHedgePrice} (15% below ${baselineLayPrice.toFixed(2)}) - bet ID: ${placeRes.betId}`);
              state.phase = 'RECOVERY_PENDING';
              state.recovery_order_id = placeRes.betId;
              state.recovery_target_price = targetHedgePrice;
              state.lay_snapshot = { stake: layStake, price: targetHedgePrice };
              await this.recordLaySnapshot(trade, { layStake, layPrice: targetHedgePrice, betId: placeRes.betId });
              updatedState = true;
            } else {
              this.logger.error(`[strategy:epl_under25] Failed to place recovery order: ${placeRes.errorCode}`);
            }
          }
        }
      }
    }

    // --- PHASE 4: RECOVERY PENDING (Wait for Drift Order to Match) ---
    else if (phase === 'RECOVERY_PENDING') {
      // Check if recovery order has been matched
      const orderStatus = await this.getOrderStatusSafe(state.recovery_order_id, sessionToken, 'phase4-status');
      
      if (orderStatus === 'EXECUTION_COMPLETE') {
        this.logger.log('[strategy:epl_under25] Recovery order matched - Drift Target Reached');
        state.phase = 'COMPLETED';
        await this.settleTradeWithPnl(trade, state, {
          layStakeOverride: trade.lay_size || trade.lay_matched_size,
          layPriceOverride: state.recovery_target_price || trade.lay_price,
        });
        
        // Trigger smart scheduler to recalculate (trade completed)
        if (process.env.EPL_UNDER25_SCHEDULER_MODE === 'smart' || !process.env.EPL_UNDER25_SCHEDULER_MODE) {
          setImmediate(() => this.smartSchedulerLoop());
        }
        return;
      }
      
      // Order is still pending - log status periodically
      this.logger.log(`[strategy:epl_under25] Recovery: Waiting for drift to ${state.recovery_target_price} (Order: ${state.recovery_order_id})`);
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
    
    // Get BOTH back and lay prices for logging
    const bestBackPrice = runner?.ex?.availableToBack?.[0]?.price;
    const bestLayPrice = runner?.ex?.availableToLay?.[0]?.price;

    if (!bestLayPrice) {
      this.logger.log(`[strategy:epl_under25] No lay price available for ${trade.fixture_name}`);
      return;
    }

    const minPrice = this.settings.min_back_price || this.defaults.min_back_price;
    if (bestLayPrice < minPrice) {
      this.logger.log(`[strategy:epl_under25] Lay price ${bestLayPrice} too low (min: ${minPrice}) for ${trade.fixture_name}`);
      return;
    }

    const stake = trade.target_stake || this.settings.default_stake;
    const customerRef = `BACK-${Date.now()}`;
    
    try {
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
            total_stake: stake,
        });

        trade.back_price = bestLayPrice;
        trade.back_size = stake;
        trade.back_stake = stake;
        trade.back_price_snapshot = trade.back_price_snapshot || bestLayPrice;
        trade.total_stake = stake;
        trade.back_order_ref = report.betId;
        trade.betfair_market_id = market.marketId;
        trade.selection_id = market.selectionId;

        await this.logEvent(trade.id, 'BACK_PLACED', { price: bestLayPrice, stake, betId: report.betId, backPrice: bestBackPrice });
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
    
    // This is now only called at/after kickoff for back_pending orders
    const kickoff = trade.kickoff_at ? new Date(trade.kickoff_at) : null;
    if (!kickoff) {
      this.logger.warn(`[strategy:epl_under25] checkBackOrder called but no kickoff time for trade ${trade.id}`);
      return;
    }
    
    this.logger.log(`[strategy:epl_under25] Checking back order at kickoff for ${trade.event_id}`);
    
    try {
        const res = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCurrentOrders', {
            betIds: [trade.back_order_ref],
            orderProjection: 'ALL',
        }, 'checkBackOrder-details');
        const order = res?.currentOrders?.[0];
        
        if (!order) {
            // Order not found - assume matched and cleared
            this.logger.log(`[strategy:epl_under25] Order not found (likely matched and cleared) - proceeding to in-play`);
            const assumedStake = trade.back_size || trade.back_stake || trade.target_stake || 0;
            await this.updateTrade(trade.id, { 
              status: 'back_matched', 
              back_matched_size: trade.back_size, 
              back_stake: assumedStake,
              total_stake: assumedStake + (trade.lay_size || 0),
              last_error: null 
            });
            trade.status = 'back_matched';
            trade.back_matched_size = trade.back_size;
            trade.back_stake = assumedStake;
            trade.total_stake = assumedStake + (trade.lay_size || 0);
            await this.logEvent(trade.id, 'BACK_ASSUMED_MATCHED', {});
            return;
        }

        // Check if order matched (fully or partially)
        if (order.status === 'EXECUTION_COMPLETE' || order.sizeMatched >= (trade.back_size || 0)) {
            this.logger.log(`[strategy:epl_under25] ✓ Back bet MATCHED @ ${order.averagePriceMatched || order.price} - proceeding to in-play monitoring`);
            const matchedStake = order.sizeMatched || trade.back_size || trade.target_stake || 0;
            await this.updateTrade(trade.id, {
                status: 'back_matched',
                back_matched_size: order.sizeMatched,
                back_price: order.averagePriceMatched || order.price,
                back_stake: matchedStake,
                total_stake: matchedStake + (trade.lay_size || 0),
                last_error: null,
            });
            trade.status = 'back_matched';
            trade.back_matched_size = order.sizeMatched;
            trade.back_price = order.averagePriceMatched || order.price;
            trade.back_stake = matchedStake;
            trade.total_stake = matchedStake + (trade.lay_size || 0);
            await this.logEvent(trade.id, 'BACK_MATCHED', { order });
            return;
        }

        // Order still unmatched at/after kickoff - cancel it
        if (now >= kickoff) {
            this.logger.log(`[strategy:epl_under25] ✗ Back bet UNMATCHED at kickoff - cancelling and terminating trade`);
            
            await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/cancelOrders', {
                marketId: trade.betfair_market_id,
                instructions: [{ betId: trade.back_order_ref }],
            }, 'cancelBack-kickoff');
            
            await this.updateTrade(trade.id, { 
              status: 'cancelled', 
              back_stake: 0,
              total_stake: trade.lay_size || 0,
              last_error: 'BACK_UNMATCHED_AT_KICKOFF - bet placed at lay price did not match' 
            });
            trade.status = 'cancelled';
            trade.back_stake = 0;
            trade.total_stake = trade.lay_size || 0;
            await this.logEvent(trade.id, 'BACK_CANCELLED', { 
              order, 
              reason: 'Unmatched at kickoff' 
            });
            
            this.logger.log(`[strategy:epl_under25] Trade cancelled - no exposure`);
        }
    } catch (err) {
        this.logger.error(`[strategy:epl_under25] checkBackOrder error: ${err.message}`);
    }
  }

  async handleScheduledTrade(trade, now, trigger) {
    const kickoff = trade.kickoff_at ? new Date(trade.kickoff_at) : null;
    if (!kickoff) return;
    const minsToKick = (kickoff.getTime() - now.getTime()) / 60000;
    const leadTime = this.settings.back_lead_minutes || this.defaults.back_lead_minutes;

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

    if (minsToKick <= leadTime && minsToKick > 0) {
      await this.placeBackOrder(trade, trigger);
    } else if (minsToKick > leadTime) {
      // Trade not in window yet - smart scheduler will wake us later
      // Don't process this trade now (avoids checking tomorrow's games during today's window)
      return;
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
    } = options;

    const commission = this.settings?.commission_rate ?? this.defaults.commission_rate;
    const backStake = Number(
      trade.back_matched_size ||
      trade.back_stake ||
      trade.back_size ||
      trade.target_stake ||
      0,
    );
    const backPrice = trade.back_price || trade.back_price_snapshot || trade.hedge_target_price;
    const layStake = Number(
      layStakeOverride ??
      trade.lay_matched_size ??
      trade.lay_size ??
      0,
    );
    const layPrice = layPriceOverride ?? trade.lay_price ?? trade.hedge_target_price;
    const realised = computeRealisedPnlSnapshot({
      backStake,
      backPrice,
      layStake,
      layPrice,
      commission,
    });

    const patch = {
      status: 'hedged',
      lay_matched_size: layStake || null,
      realised_pnl: realised,
      pnl: realised,
      settled_at: new Date().toISOString(),
      total_stake: backStake + layStake,
      state_data: state,
      ...additionalPatch,
    };

    await this.updateTrade(trade.id, patch);

    trade.status = 'hedged';
    trade.lay_matched_size = layStake;
    trade.realised_pnl = realised;
    trade.pnl = realised;
    trade.total_stake = backStake + layStake;
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
