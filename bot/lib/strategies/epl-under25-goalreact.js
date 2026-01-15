/**
 * EPL Under 2.5 Goal-Reactive Strategy (Strategy 2)
 * 
 * FLOW:
 * 1. WATCHING - Poll games in-play every 30s, detect 1st goal (30% price spike)
 *    - Skip if goal after 45 mins
 *    - Otherwise → GOAL_WAIT
 * 
 * 2. GOAL_WAIT - Wait 90s for price to settle
 *    - Price must remain above 30% for 90s
 *    - Check price is 2.5-5.0
 *    - ENTER position at Back Price (check lay is 1 tick away)
 * 
 * 3. LIVE - Monitor position
 *    - If price drops 10% from entry → WIN (exit)
 *    - If 2nd goal detected (30% spike) → STOP_LOSS_WAIT
 * 
 * 4. STOP_LOSS_WAIT - Wait 90s for price to settle
 *    - Record settled price → STOP_LOSS_ACTIVE
 * 
 * 5. STOP_LOSS_ACTIVE - Exit when price falls 15% below settled price
 */

const { addDays } = require('date-fns');
const { roundToBetfairTick } = require('../betfair-utils');
const {
  SOCCER_EVENT_TYPE_ID,
  UNDER_RUNNER_NAME,
  COMPETITION_MATCHERS,
  COMPETITION_IDS,
  calculateLayStake,
  computeRealisedPnlSnapshot,
  formatFixtureName,
  ticksAbove,
  ticksBelow,
  isWithinTicks,
  getMiddlePrice,
  createSafeApiWrappers,
  ensureMarket,
} = require('./shared');

const STRATEGY_KEY = 'epl_under25_goalreact';

/**
 * Format timestamp to HH:mm:ss for logging (includes seconds)
 * @param {string|number|Date} timestamp - ISO string, unix ms, or Date object
 * @returns {string} - Formatted time string (HH:mm:ss)
 */
function formatTimeWithSeconds(timestamp) {
  if (!timestamp) return 'N/A';
  const date = typeof timestamp === 'string' ? new Date(timestamp) : 
               typeof timestamp === 'number' ? new Date(timestamp) : timestamp;
  if (isNaN(date.getTime())) return 'N/A';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// --- Strategy Parameters ---
function getDefaultSettings() {
  return {
    // Entry Rules
    // Code is the source of truth for this strategy's settings.
    // (Avoid env overrides here to prevent accidental config drift / Supabase "reverts".)
    default_stake: 250,
    wait_after_goal_seconds: 60,
    goal_cutoff_minutes: 70,
    min_entry_price: 1.7,
    max_entry_price: 5.5,
    goal_detection_pct: 30,
    
    // Rolling baseline settings (detect goals vs updated baseline, not kickoff baseline)
    // Baseline updates when N consecutive polls are within X% of each other (stable market)
    baseline_stability_pct: 5,        // Prices must be within 5% of each other to be "stable"
    baseline_stable_readings: 4,      // Need 4 consecutive stable readings (~60s at 15s poll) to update baseline
    
    // Exit Rules
    profit_target_pct: 12,
    stop_loss_pct: 20,
    
    // Polling
    in_play_poll_interval_seconds: 15,
    
    // Post-goal polling boost: increase poll frequency after goal detection for better reactivity
    post_goal_poll_interval_seconds: 5,   // Poll every 5s during boost window
    post_goal_poll_boost_seconds: 120,    // Boost lasts 120s after goal detection
    
    // General
    fixture_lookahead_days: 2,
    commission_rate: 0.0175,
    
    // Market liquidity threshold - skip trades if total matched volume is below this when game goes in-play
    min_market_liquidity: 1000,
    
    // Post-trade monitoring (shadow monitoring for analytics)
    post_trade_monitor_poll_interval_seconds: 60,  // Lazy polling during shadow monitoring
    post_trade_monitor_max_duration_minutes: 100,  // Stop monitoring after 100 mins
  };
}

// --- Trade Phases ---
const PHASE = {
  WATCHING: 'WATCHING',
  GOAL_WAIT: 'GOAL_WAIT',
  LIVE: 'LIVE',
  STOP_LOSS_WAIT: 'STOP_LOSS_WAIT',
  STOP_LOSS_ACTIVE: 'STOP_LOSS_ACTIVE',
  POST_TRADE_MONITOR: 'POST_TRADE_MONITOR',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED',
};

class EplUnder25GoalReactStrategy {
  constructor({ supabase, betfair, logger = console }) {
    this.supabase = supabase;
    this.betfair = betfair;
    this.logger = logger;
    this.settings = null;
    this.defaults = getDefaultSettings();

    // Scheduler state
    this.smartSchedulerTimer = null;
    this.activePollingTimer = null;
    this.currentPollIntervalMs = null;  // Track current interval to avoid redundant timer restarts
    this.syncingFixtures = false;
    this.processingActive = false;

    this.timers = [];

    // Safe API wrappers
    const wrappers = createSafeApiWrappers(betfair, logger);
    this.requireSessionWithRetry = wrappers.requireSessionWithRetry;
    this.rpcWithRetry = wrappers.rpcWithRetry;
    this.getMarketBookSafe = wrappers.getMarketBookSafe;
    this.getOrderStatusSafe = wrappers.getOrderStatusSafe;
    this.cancelOrderSafe = wrappers.cancelOrderSafe;
    this.placeLimitOrderSafe = wrappers.placeLimitOrderSafe;

    // Bind methods
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);
    this.syncFixtures = this.syncFixtures.bind(this);
    this.smartSchedulerLoop = this.smartSchedulerLoop.bind(this);
    this.processInPlayGames = this.processInPlayGames.bind(this);
  }

  /**
   * Cancel an order and CONFIRM it is no longer executable (prevents double-exposure).
   *
   * Betfair cancellation is fast but not always immediately reflected in listCurrentOrders,
   * so we poll for confirmation and only treat "NOT_FOUND" as success after N consecutive reads.
   *
   * @param {string} betId - The bet ID to cancel
   * @param {string} marketId - The market ID (REQUIRED by Betfair API)
   * @param {string} sessionToken - Session token
   * @param {string} label - Label for logging
   * @param {Object} opts - Options: confirmMs, pollMs, maxCancelAttempts, notFoundThreshold
   * @returns {Promise<{closed: boolean, attempts: number, elapsed_ms: number, last_details: any, reason: string, errorCode?: string}>}
   */
  async cancelOrderAndConfirm(betId, marketId, sessionToken, label, opts = {}) {
    const confirmMs = typeof opts.confirmMs === 'number' ? opts.confirmMs : 20000;
    const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : 500;
    const maxCancelAttempts = typeof opts.maxCancelAttempts === 'number' ? opts.maxCancelAttempts : 3;
    const notFoundThreshold = typeof opts.notFoundThreshold === 'number' ? opts.notFoundThreshold : 3;

    if (!betId) {
      return { closed: true, attempts: 0, elapsed_ms: 0, last_details: null, reason: 'NO_BET_ID' };
    }
    
    if (!marketId) {
      this.logger.error(`[strategy:${STRATEGY_KEY}] cancelOrderAndConfirm: marketId is required for bet ${betId}`);
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
        this.logger.error(`[strategy:${STRATEGY_KEY}] Cancel API FAILED for bet ${betId}: ${cancelRes.errorCode}`);
        
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

  async start() {
    await this.ensureSettings();
    
    this.logger.log(`[strategy:${STRATEGY_KEY}] Starting goal-reactive strategy (enabled=${this.settings?.enabled})`);
    
    // Initial fixture sync
    await this.syncFixtures('startup');

    // Sync fixtures every 24 hours
    this.timers.push(setInterval(() => this.syncFixtures('interval').catch(this.logError('syncFixtures')), 24 * 60 * 60 * 1000));

    // Start smart scheduler (wake at kickoff, poll in-play, sleep when done)
    this.logger.log(`[strategy:${STRATEGY_KEY}] ⚡ Smart scheduler active (fixture-aware, efficient)`);
    this.logger.log(`[strategy:${STRATEGY_KEY}] - Will wake at kickoff times`);
    this.logger.log(`[strategy:${STRATEGY_KEY}] - Will poll in-play games every ${this.defaults.in_play_poll_interval_seconds}s`);
    this.logger.log(`[strategy:${STRATEGY_KEY}] - Will sleep when no games active`);
    
    this.smartSchedulerLoop();
    
    this.logger.log(`[strategy:${STRATEGY_KEY}] Started successfully`);
  }

  async stop() {
    this.logger.log(`[strategy:${STRATEGY_KEY}] Stopping strategy...`);
    
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    if (this.smartSchedulerTimer) {
      clearTimeout(this.smartSchedulerTimer);
      this.smartSchedulerTimer = null;
    }
    if (this.activePollingTimer) {
      clearInterval(this.activePollingTimer);
      this.activePollingTimer = null;
    }
    
    this.timers = [];
    this.logger.log(`[strategy:${STRATEGY_KEY}] Strategy stopped`);
  }

  logError(method) {
    return (err) => {
      this.logger.error(`[strategy:${STRATEGY_KEY}] ${method} error:`, err && err.message ? err.message : err);
    };
  }

  // --- Smart Scheduler ---

  async calculateNextWakeTime() {
    const now = Date.now();
    const nowIso = new Date().toISOString();
    
    // Priority 1: Check for active trades that need monitoring
    const { data: activeTrades } = await this.supabase
      .from('strategy_trades')
      .select('id, status, state_data')
      .eq('strategy_key', STRATEGY_KEY)
      .in('status', ['watching', 'goal_wait', 'live', 'stop_loss_wait', 'stop_loss_active', 'post_trade_monitor'])
      .limit(1);
    
    if (activeTrades?.length > 0) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] Active trades detected (status: ${activeTrades[0].status}) - need immediate polling`);
      return 0;
    }
    
    // Priority 2: Check for scheduled games that have ALREADY kicked off (need to start watching!)
    // These are games with status='scheduled' but kickoff_at <= now (up to 90 mins ago)
    const ninetyMinsAgo = new Date(now - 90 * 60 * 1000).toISOString();
    const { data: kickedOffGames } = await this.supabase
      .from('strategy_trades')
      .select('kickoff_at, event_id, event_name')
      .eq('strategy_key', STRATEGY_KEY)
      .eq('status', 'scheduled')
      .lte('kickoff_at', nowIso)  // Kickoff has passed
      .gte('kickoff_at', ninetyMinsAgo)  // But not more than 90 mins ago (still in play)
      .order('kickoff_at', { ascending: true })
      .limit(1);
    
    if (kickedOffGames?.length > 0) {
      const eventName = kickedOffGames[0].event_name || kickedOffGames[0].event_id;
      const kickoffTime = new Date(kickedOffGames[0].kickoff_at);
      const minsFromKickoff = Math.round((now - kickoffTime.getTime()) / 60000);
      this.logger.log(`[strategy:${STRATEGY_KEY}] ⚽ GAME IN PLAY: ${eventName} (kicked off ${minsFromKickoff} mins ago) - BEGIN WATCHING`);
      return 0;  // Wake immediately to start watching
    }
    
    // Priority 3: Check for games about to kick off (future kickoff times)
    const { data: upcomingGames } = await this.supabase
      .from('strategy_trades')
      .select('kickoff_at, event_id, event_name')
      .eq('strategy_key', STRATEGY_KEY)
      .eq('status', 'scheduled')
      .gt('kickoff_at', nowIso)  // Kickoff in the future
      .order('kickoff_at', { ascending: true })
      .limit(1);
    
    if (upcomingGames?.length > 0) {
      const kickoff = new Date(upcomingGames[0].kickoff_at).getTime();
      const delay = kickoff - now;
      const eventName = upcomingGames[0].event_name || upcomingGames[0].event_id;
      
      // Sleep until kickoff, capped between 1 minute and 24 hours
      const cappedDelay = Math.max(60 * 1000, Math.min(delay, 24 * 60 * 60 * 1000));
      this.logger.log(`[strategy:${STRATEGY_KEY}] Next kickoff: ${eventName} in ${(cappedDelay / 60000).toFixed(1)} min - sleeping until then`);
      return cappedDelay;
    }
    
    // No games scheduled - sleep until fixture resync
    this.logger.log(`[strategy:${STRATEGY_KEY}] No scheduled games - sleeping until fixture resync (24h)`);
    return 24 * 60 * 60 * 1000;
  }

  async smartSchedulerLoop() {
    if (this.syncingFixtures || this.processingActive) {
      this.smartSchedulerTimer = setTimeout(() => this.smartSchedulerLoop(), 10000);
      return;
    }
    
    try {
      const nextWake = await this.calculateNextWakeTime();
      
      if (nextWake === 0) {
        // Immediate action needed - games are in-play or starting
        if (!this.activePollingTimer) {
          this.startActivePolling();
        }
        
        // Recalculate soon
        this.smartSchedulerTimer = setTimeout(() => this.smartSchedulerLoop(), 5000);
        
      } else {
        // Sleep until next kickoff
        const wakeMinutes = (nextWake / 60000).toFixed(1);
        this.logger.log(`[strategy:${STRATEGY_KEY}] Smart scheduler: SLEEPING for ${wakeMinutes} minutes`);
        
        this.stopActivePolling();
        
        this.smartSchedulerTimer = setTimeout(() => {
          this.logger.log(`[strategy:${STRATEGY_KEY}] Smart scheduler: WAKING UP`);
          this.smartSchedulerLoop();
        }, nextWake);
      }
      
    } catch (err) {
      this.logger.error(`[strategy:${STRATEGY_KEY}] Smart scheduler error: ${err.message}`, err);
      this.smartSchedulerTimer = setTimeout(() => this.smartSchedulerLoop(), 60000);
    }
  }

  /**
   * Start active polling with optional custom interval
   * @param {number|null} intervalMs - Optional custom interval in milliseconds (defaults to base poll interval)
   * @param {boolean} runImmediately - Whether to run processInPlayGames immediately (default true on initial start)
   */
  startActivePolling(intervalMs = null, runImmediately = true) {
    const basePollInterval = (this.settings?.in_play_poll_interval_seconds || this.defaults.in_play_poll_interval_seconds) * 1000;
    const pollInterval = intervalMs || basePollInterval;
    
    // If timer already running at the same interval, do nothing
    if (this.activePollingTimer && this.currentPollIntervalMs === pollInterval) {
      return;
    }
    
    // Stop existing timer if running (will restart with new interval)
    if (this.activePollingTimer) {
      clearInterval(this.activePollingTimer);
      this.activePollingTimer = null;
    }
    
    this.currentPollIntervalMs = pollInterval;
    this.logger.log(`[strategy:${STRATEGY_KEY}] ▶ STARTING active ${pollInterval / 1000}s polling`);
    
    this.activePollingTimer = setInterval(() => {
      this.processInPlayGames('poll').catch(this.logError('processInPlayGames'));
    }, pollInterval);
    
    // Run immediately on initial start
    if (runImmediately) {
      this.processInPlayGames('immediate').catch(this.logError('processInPlayGames'));
    }
  }

  /**
   * Update poll interval dynamically (restarts timer only if interval changed)
   * @param {number} intervalMs - New interval in milliseconds
   */
  updatePollInterval(intervalMs) {
    if (!this.activePollingTimer) {
      // No active polling - start with the new interval
      this.startActivePolling(intervalMs, false);
      return;
    }
    
    if (this.currentPollIntervalMs === intervalMs) {
      // Already at this interval - no change needed
      return;
    }
    
    // Restart with new interval (don't run immediately - we just polled)
    this.logger.log(`[strategy:${STRATEGY_KEY}] 🔄 Changing poll interval: ${this.currentPollIntervalMs / 1000}s → ${intervalMs / 1000}s`);
    this.startActivePolling(intervalMs, false);
  }

  stopActivePolling() {
    if (this.activePollingTimer) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] ⏸ STOPPING active polling`);
      clearInterval(this.activePollingTimer);
      this.activePollingTimer = null;
      this.currentPollIntervalMs = null;
    }
  }

  // --- Settings Management ---

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
          wait_after_goal_seconds: this.defaults.wait_after_goal_seconds,
          goal_cutoff_minutes: this.defaults.goal_cutoff_minutes,
          min_entry_price: this.defaults.min_entry_price,
          max_entry_price: this.defaults.max_entry_price,
          goal_detection_pct: this.defaults.goal_detection_pct,
          profit_target_pct: this.defaults.profit_target_pct,
          stop_loss_pct: this.defaults.stop_loss_pct,
          in_play_poll_interval_seconds: this.defaults.in_play_poll_interval_seconds,
          post_goal_poll_interval_seconds: this.defaults.post_goal_poll_interval_seconds,
          post_goal_poll_boost_seconds: this.defaults.post_goal_poll_boost_seconds,
          min_market_liquidity: this.defaults.min_market_liquidity,
        },
      };
      const { data: created, error: insertErr } = await this.supabase
        .from('strategy_settings')
        .insert(insert)
        .select()
        .single();
      if (insertErr) throw insertErr;
      this.settings = { ...created, ...created.extra };
    } else {
      // Merge top-level and extra fields (extra takes precedence)
      this.settings = { ...data, ...(data.extra || {}) };

      // Code/env defaults are the source of truth: auto-sync to database (one-way).
      const updates = {};
      const extraUpdates = {};
      let needsUpdate = false;

      // Top-level columns
      if (this.settings.default_stake !== this.defaults.default_stake) {
        this.logger.log(`[strategy:${STRATEGY_KEY}] Syncing default_stake: ${this.settings.default_stake} → ${this.defaults.default_stake} (from env/code defaults)`);
        updates.default_stake = this.defaults.default_stake;
        needsUpdate = true;
      }
      if (this.settings.fixture_lookahead_days !== this.defaults.fixture_lookahead_days) {
        updates.fixture_lookahead_days = this.defaults.fixture_lookahead_days;
        needsUpdate = true;
      }
      if (this.settings.commission_rate !== this.defaults.commission_rate) {
        updates.commission_rate = this.defaults.commission_rate;
        needsUpdate = true;
      }

      // Strategy-specific settings in `extra` JSON
      const extraKeys = [
        'wait_after_goal_seconds',
        'goal_cutoff_minutes',
        'min_entry_price',
        'max_entry_price',
        'goal_detection_pct',
        'profit_target_pct',
        'stop_loss_pct',
        'in_play_poll_interval_seconds',
        'post_goal_poll_interval_seconds',
        'post_goal_poll_boost_seconds',
        'min_market_liquidity',
      ];

      for (const k of extraKeys) {
        if (this.settings[k] !== this.defaults[k]) {
          extraUpdates[k] = this.defaults[k];
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        if (Object.keys(extraUpdates).length > 0) {
          const currentExtra = data.extra || {};
          updates.extra = { ...currentExtra, ...extraUpdates };
        }

        await this.supabase
          .from('strategy_settings')
          .update(updates)
          .eq('strategy_key', STRATEGY_KEY);

        // Update local settings too
        Object.assign(this.settings, updates);
        if (updates.extra) {
          Object.assign(this.settings, updates.extra);
        }
      }
    }
  }

  // --- Fixture Sync ---

  async syncFixtures(trigger = 'manual') {
    if (this.syncingFixtures) return;
    this.syncingFixtures = true;
    
    try {
      if (!this.settings?.enabled) return;

      const now = new Date();
      const lookaheadDays = this.settings.fixture_lookahead_days || this.defaults.fixture_lookahead_days;
      const windowEnd = addDays(now, lookaheadDays);

      const sessionToken = await this.requireSessionWithRetry(`fixtures-${trigger}`);

      // Get competitions
      const competitionsRes = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCompetitions', {
        filter: { eventTypeIds: [SOCCER_EVENT_TYPE_ID] },
      }, 'listCompetitions');

      const matchedCompetitions = (competitionsRes || [])
        .filter((c) => COMPETITION_MATCHERS.some((rx) => rx.test(c.competition?.name || '')));

      const matchedCompetitionIds = matchedCompetitions.map((c) => c.competition?.id).filter(Boolean);

      // Build competition ID -> name map for later use (and safe fallbacks)
      const competitionIdToName = new Map();
      matchedCompetitions.forEach((c) => {
        if (c.competition?.id && c.competition?.name) {
          competitionIdToName.set(String(c.competition.id), c.competition.name);
        }
      });

      // Use matched IDs, fallback to hardcoded competition IDs if no regex match
      let competitionIds = matchedCompetitionIds;
      if (competitionIds.length === 0) {
        competitionIds = COMPETITION_IDS;

        // Add hardcoded names for fallback (keeps data correct even if listCompetitions regex fails)
        competitionIds.forEach((id) => {
          if (competitionIdToName.has(id)) return;
          if (id === '10932509') competitionIdToName.set(id, 'English Premier League');
          else if (id === '59') competitionIdToName.set(id, 'German Bundesliga');
          else if (id === '117') competitionIdToName.set(id, 'Spanish La Liga');
          else if (id === '81') competitionIdToName.set(id, 'Italian Serie A');
          else if (id === '228') competitionIdToName.set(id, 'UEFA Champions League');
          else if (id === '2005') competitionIdToName.set(id, 'UEFA Europa League');
          else if (id === '2134') competitionIdToName.set(id, 'English Football League Cup');
        });
      }

      // Get events (scoped to competitionIds)
      const eventsRes = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listEvents', {
        filter: {
          eventTypeIds: [SOCCER_EVENT_TYPE_ID],
          competitionIds,
          marketStartTime: {
            from: now.toISOString(),
            to: windowEnd.toISOString(),
          },
        },
        maxResults: 100,
      }, 'listEvents');

      // listEvents does not include competition, so fetch it from market catalogues
      const eventIds = (eventsRes || []).map((evt) => evt.event?.id).filter(Boolean);
      const eventIdToCompetition = new Map();

      if (eventIds.length > 0) {
        try {
          const marketCatalogues = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listMarketCatalogue', {
            filter: {
              eventIds,
              marketTypeCodes: ['OVER_UNDER_25'],
            },
            maxResults: 1000,
            marketProjection: ['EVENT', 'COMPETITION'],
          }, 'listMarketCatalogue-competition');

          (marketCatalogues || []).forEach((market) => {
            const evtId = market.event?.id;
            const compId = market.competition?.id;
            const compName = market.competition?.name;
            if (evtId && compId && compName) {
              eventIdToCompetition.set(evtId, competitionIdToName.get(String(compId)) || compName);
            }
          });
        } catch (err) {
          this.logger.warn(`[strategy:${STRATEGY_KEY}] Failed to fetch competition info from markets: ${err.message}`);
        }
      }

      this.logger.log(`[strategy:${STRATEGY_KEY}] Fixtures sync found ${eventsRes?.length || 0} events`);

      const fixtures = (eventsRes || [])
        .map((evt) => {
          const eventId = evt.event?.id;
          const eventName = evt.event?.name || '';
          const parts = eventName.split(' v ');

          // Prefer market-derived competition name (avoids Betfair placeholder like "Multiple Leagues")
          let competitionName = eventId ? eventIdToCompetition.get(eventId) : null;
          if (!competitionName) {
            // Fallback: if only one competition is in-scope, use it; otherwise keep generic
            competitionName = competitionIdToName.size === 1 ? Array.from(competitionIdToName.values())[0] : 'Multiple Leagues';
          }

          return {
            strategy_key: STRATEGY_KEY,
            betfair_event_id: eventId,
            event_id: eventId,
            competition: competitionName,
            home: parts[0]?.trim() || null,
            away: parts[1]?.trim() || null,
            kickoff_at: evt.event?.openDate,
            metadata: evt,
          };
        })
        .filter((f) => f.betfair_event_id);

      if (fixtures.length > 0) {
        const { error: upsertErr } = await this.supabase
          .from('strategy_fixtures')
          .upsert(fixtures, { onConflict: 'strategy_key,betfair_event_id' });
        if (upsertErr) throw upsertErr;

        // Ensure trade records exist
        for (const fixture of fixtures) {
          await this.ensureTradeRecord(fixture);
        }
      }

    } catch (err) {
      this.logger.error(`[strategy:${STRATEGY_KEY}] Fixtures sync error: ${err.message}`);
    } finally {
      this.syncingFixtures = false;
    }
  }

  async ensureTradeRecord(fixture) {
    const competitionName = fixture.competition || 'Unknown';
    const eventName = formatFixtureName(fixture.home, fixture.away, fixture.event_id);

    const { data: existing } = await this.supabase
      .from('strategy_trades')
      .select('id, status, competition_name, event_name')
      .eq('strategy_key', STRATEGY_KEY)
      .eq('betfair_event_id', fixture.betfair_event_id)
      .maybeSingle();
    
    if (existing) {
      // Fix legacy placeholder competition names ("Multiple Leagues") by syncing from fixtures
      const existingCompetition = existing.competition_name;
      const shouldFixCompetition =
        (!existingCompetition || existingCompetition === 'Multiple Leagues' || existingCompetition === 'Unknown') &&
        competitionName &&
        competitionName !== 'Multiple Leagues' &&
        competitionName !== 'Unknown';

      const shouldFixEventName =
        (!existing.event_name || existing.event_name === fixture.event_id || existing.event_name === fixture.betfair_event_id) &&
        !!eventName;

      if (shouldFixCompetition || shouldFixEventName) {
        const patch = {};
        if (shouldFixCompetition) patch.competition_name = competitionName;
        if (shouldFixEventName) patch.event_name = eventName;
        await this.updateTrade(existing.id, patch);
      }

      return existing.id;
    }

    const insert = {
      strategy_key: STRATEGY_KEY,
      betfair_event_id: fixture.betfair_event_id,
      event_id: fixture.event_id,
      runner_name: UNDER_RUNNER_NAME,
      competition_name: competitionName,
      event_name: eventName,
      kickoff_at: fixture.kickoff_at,
      status: 'scheduled',
      target_stake: this.settings?.default_stake || this.defaults.default_stake,
      state_data: { phase: PHASE.WATCHING },
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

  // --- In-Play Processing ---

  async processInPlayGames(trigger = 'manual') {
    if (this.processingActive) return;
    this.processingActive = true;
    
    try {
      this.logger.log(`[strategy:${STRATEGY_KEY}] >>> Processing in-play games (trigger=${trigger})`);
      
      // Get all games that should be monitored (scheduled + in-play phases + post-trade monitor)
      const { data: trades, error } = await this.supabase
        .from('strategy_trades')
        .select('*')
        .eq('strategy_key', STRATEGY_KEY)
        .in('status', ['scheduled', 'watching', 'goal_wait', 'live', 'stop_loss_wait', 'stop_loss_active', 'post_trade_monitor'])
        .order('kickoff_at', { ascending: true });

      if (error) throw error;

      if (!trades || trades.length === 0) {
        this.logger.log(`[strategy:${STRATEGY_KEY}] No trades in database - stopping polling`);
        this.stopActivePolling();
        setImmediate(() => this.smartSchedulerLoop());
        return;
      }

      // --- Priority Sorting: Process real-money trades FIRST ---
      // Priority 1 (Critical): Trades with money at risk or imminent entry
      // Priority 2 (Standard): Waiting for a signal
      // Priority 3 (Background): Data collection only
      const phasePriority = {
        // Priority 1 - Critical (money at risk)
        'GOAL_WAIT': 1,
        'LIVE': 1,
        'STOP_LOSS_WAIT': 1,
        'STOP_LOSS_ACTIVE': 1,
        // Priority 2 - Standard (watching for signal)
        'WATCHING': 2,
        // Priority 3 - Background (shadow monitoring / data collection)
        'POST_TRADE_MONITOR': 3,
        'COMPLETED': 4,
        'SKIPPED': 4,
      };
      
      trades.sort((a, b) => {
        const phaseA = a.state_data?.phase || 'WATCHING';
        const phaseB = b.state_data?.phase || 'WATCHING';
        const priorityA = phasePriority[phaseA] ?? 5;
        const priorityB = phasePriority[phaseB] ?? 5;
        return priorityA - priorityB;
      });
      
      // Log priority breakdown for diagnostics
      const priorityCounts = { critical: 0, standard: 0, background: 0 };
      for (const t of trades) {
        const phase = t.state_data?.phase || 'WATCHING';
        const priority = phasePriority[phase] ?? 5;
        if (priority === 1) priorityCounts.critical++;
        else if (priority === 2) priorityCounts.standard++;
        else priorityCounts.background++;
      }
      
      if (priorityCounts.critical > 0 || priorityCounts.background > 0) {
        this.logger.log(`[strategy:${STRATEGY_KEY}] 🚦 Traffic Control: ${priorityCounts.critical} critical | ${priorityCounts.standard} standard | ${priorityCounts.background} background`);
      }

      const now = new Date();
      let activeCount = 0;
      let pendingCount = 0;  // Games not yet started

      for (const trade of trades) {
        try {
          const kickoff = trade.kickoff_at ? new Date(trade.kickoff_at) : null;
          if (!kickoff) continue;

          const minsFromKickoff = (now.getTime() - kickoff.getTime()) / 60000;

          // Track games not yet started
          if (minsFromKickoff < 0) {
            pendingCount++;
            continue;
          }

          // Skip games that are too old (> 120 mins from kickoff = game over)
          if (minsFromKickoff > 120) {
            if (trade.status !== 'completed' && trade.status !== 'skipped') {
              await this.updateTrade(trade.id, { status: 'completed', last_error: 'GAME_ENDED' });
            }
            continue;
          }

          activeCount++;
          await this.processTradeStateMachine(trade, now, minsFromKickoff);
          
        } catch (err) {
          this.logger.error(`[strategy:${STRATEGY_KEY}] Trade processing error (ID:${trade.id}): ${err.message}`);
        }
      }

      this.logger.log(`[strategy:${STRATEGY_KEY}] <<< Processed ${activeCount} active trades (${pendingCount} pending kickoff)`);

      // --- Adaptive Polling: Check if any trade is in post-goal boost window ---
      const basePollIntervalMs = (this.settings?.in_play_poll_interval_seconds || this.defaults.in_play_poll_interval_seconds) * 1000;
      const boostPollIntervalMs = (this.settings?.post_goal_poll_interval_seconds || this.defaults.post_goal_poll_interval_seconds) * 1000;
      const lazyPollIntervalMs = (this.settings?.post_trade_monitor_poll_interval_seconds || this.defaults.post_trade_monitor_poll_interval_seconds) * 1000;
      const boostWindowMs = (this.settings?.post_goal_poll_boost_seconds || this.defaults.post_goal_poll_boost_seconds) * 1000;
      const nowMs = now.getTime();
      
      let needsBoost = false;
      let allPostTradeMonitor = true;  // Track if ALL active trades are in post_trade_monitor
      
      for (const trade of trades) {
        const state = trade.state_data || {};
        const phase = state.phase || 'WATCHING';
        
        // Check if this trade is NOT in post_trade_monitor
        if (phase !== 'POST_TRADE_MONITOR') {
          allPostTradeMonitor = false;
        }
        
        // Boost applies to phases after goal detection (goal_wait, live, stop_loss_wait, stop_loss_active)
        const boostEligiblePhases = ['GOAL_WAIT', 'LIVE', 'STOP_LOSS_WAIT', 'STOP_LOSS_ACTIVE'];
        if (!boostEligiblePhases.includes(phase)) continue;
        
        // Check first goal boost window
        if (state.spike_detected_at && (nowMs - state.spike_detected_at) < boostWindowMs) {
          needsBoost = true;
        }
        
        // Check second goal boost window
        if (state.second_goal_spike_at && (nowMs - state.second_goal_spike_at) < boostWindowMs) {
          needsBoost = true;
        }
      }
      
      // Update poll interval if needed (only when activeCount > 0, otherwise we stop polling below)
      if (activeCount > 0) {
        let targetIntervalMs;
        if (needsBoost) {
          targetIntervalMs = boostPollIntervalMs;
        } else if (allPostTradeMonitor) {
          // All active trades are in lazy post-trade monitoring
          targetIntervalMs = lazyPollIntervalMs;
        } else {
          targetIntervalMs = basePollIntervalMs;
        }
        this.updatePollInterval(targetIntervalMs);
      }

      // If no active trades, check if games are starting soon before stopping polling
      if (activeCount === 0) {
        // Check for scheduled games within next 10 minutes
        const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
        const { data: upcomingGames } = await this.supabase
          .from('strategy_trades')
          .select('kickoff_at, event_id')
          .eq('strategy_key', STRATEGY_KEY)
          .eq('status', 'scheduled')
          .lte('kickoff_at', tenMinutesFromNow.toISOString())
          .gt('kickoff_at', new Date(now.getTime() - 5 * 60 * 1000).toISOString())  // Not more than 5 mins in past
          .limit(1);

        if (upcomingGames?.length > 0) {
          // Games starting soon - keep polling active
          this.logger.log(`[strategy:${STRATEGY_KEY}] No active trades but games starting soon - keeping polling active`);
        } else {
          // No games starting soon - safe to stop polling
          this.logger.log(`[strategy:${STRATEGY_KEY}] No active trades and no games starting soon - stopping polling`);
          this.stopActivePolling();
          setImmediate(() => this.smartSchedulerLoop());
        }
      }

    } catch (err) {
      this.logger.error(`[strategy:${STRATEGY_KEY}] processInPlayGames error: ${err.message}`);
    } finally {
      this.processingActive = false;
    }
  }

  async processTradeStateMachine(trade, now, minsFromKickoff) {
    let state = trade.state_data || { phase: PHASE.WATCHING };
    const phase = state.phase || PHASE.WATCHING;
    const eventName = trade.event_name || trade.event_id || 'Unknown';
    
    // Diagnostic: Log trade being processed
    this.logger.log(`[strategy:${STRATEGY_KEY}] Processing: ${eventName} | phase=${phase} | status=${trade.status} | min=${minsFromKickoff.toFixed(0)}`);
    
    const sessionToken = await this.requireSessionWithRetry(`sm-${phase}`);
    const market = await this.ensureMarketForTrade(trade, sessionToken);
    if (!market) {
      this.logger.warn(`[strategy:${STRATEGY_KEY}] ⚠️ No market found for ${eventName} - skipping`);
      return;
    }

    const book = await this.getMarketBookSafe(market.marketId, sessionToken, `${phase}-book`);
    if (!book) {
      this.logger.warn(`[strategy:${STRATEGY_KEY}] ⚠️ No market book for ${eventName} (marketId: ${market.marketId}) - skipping`);
      return;
    }

    // Diagnostic: Log market status (critical for debugging)
    const marketStatus = book.status || 'UNKNOWN';
    const isInPlay = book.inplay === true;
    this.logger.log(`[strategy:${STRATEGY_KEY}]   Market: ${market.marketId} | status=${marketStatus} | inplay=${isInPlay}`);

    // Check if market closed
    if (book.status === 'CLOSED') {
      this.logger.log(`[strategy:${STRATEGY_KEY}] Market CLOSED for ${eventName}`);
      
      // If already in POST_TRADE_MONITOR, finalize monitoring
      if (phase === PHASE.POST_TRADE_MONITOR) {
        await this.finalizeShadowMonitoring(trade, state, 'MARKET_CLOSED');
        return;
      }
      
      // Otherwise settle the trade (which will transition to POST_TRADE_MONITOR, then immediately finalize)
      await this.settleTradeWithPnl(trade, state, 'MARKET_CLOSED');
      await this.finalizeShadowMonitoring(trade, trade.state_data || state, 'MARKET_CLOSED');
      return;
    }

    const runner = book.runners?.find(r => r.selectionId == market.selectionId);
    const bestBackPrice = runner?.ex?.availableToBack?.[0]?.price;
    const bestLayPrice = runner?.ex?.availableToLay?.[0]?.price;
    const lastTradedPrice = runner?.lastPriceTraded;
    const signalBackPrice = bestBackPrice || lastTradedPrice; // Use last traded as fallback (e.g. market suspended)

    // WATCHING must be able to set baseline + detect goal even when the market is suspended.
    // Recent behaviour: requiring both best back + best lay can delay baseline until AFTER the goal.
    if (phase === PHASE.WATCHING) {
      if (!signalBackPrice) {
        this.logger.log(
          `[strategy:${STRATEGY_KEY}] ⚠️ No usable price for ${eventName} (bestBack=${bestBackPrice}, lastTraded=${lastTradedPrice}) - waiting`
        );
        return;
      }

      const spread = (bestBackPrice && bestLayPrice) ? (bestLayPrice - bestBackPrice) : null;
      this.logger.log(
        `[strategy:${STRATEGY_KEY}]   Prices: bestBack=${bestBackPrice || 'N/A'} | bestLay=${bestLayPrice || 'N/A'} | lastTraded=${lastTradedPrice || 'N/A'} | spread=${spread != null ? spread.toFixed(2) : 'N/A'}`
      );

      await this.handleWatching(trade, state, signalBackPrice, bestLayPrice, minsFromKickoff, sessionToken, market);
      return;
    }

    // For all other phases (order placement / spread checks), we require a firm back+lay.
    if (!bestBackPrice || !bestLayPrice) {
      this.logger.log(
        `[strategy:${STRATEGY_KEY}] ⚠️ No prices for ${eventName} (back=${bestBackPrice}, lay=${bestLayPrice}, lastTraded=${lastTradedPrice}) - waiting`
      );
      return;
    }

    // Diagnostic: Log current prices
    this.logger.log(`[strategy:${STRATEGY_KEY}]   Prices: back=${bestBackPrice} | lay=${bestLayPrice} | spread=${(bestLayPrice - bestBackPrice).toFixed(2)}`);

    switch (phase) {
      case PHASE.GOAL_WAIT:
        await this.handleGoalWait(trade, state, bestBackPrice, bestLayPrice, sessionToken, market);
        break;
      case PHASE.LIVE:
        await this.handleLive(trade, state, bestBackPrice, bestLayPrice, sessionToken, market);
        break;
      case PHASE.STOP_LOSS_WAIT:
        await this.handleStopLossWait(trade, state, bestBackPrice, bestLayPrice, sessionToken, market);
        break;
      case PHASE.STOP_LOSS_ACTIVE:
        await this.handleStopLossActive(trade, state, bestBackPrice, bestLayPrice, sessionToken, market);
        break;
      case PHASE.POST_TRADE_MONITOR:
        await this.handlePostTradeMonitor(trade, state, bestBackPrice, bestLayPrice, sessionToken, market);
        break;
    }
  }

  // --- Phase Handlers ---

  /**
   * Log goal price snapshots at t+30/60/90/120 seconds after goal detection.
   * Called from handleGoalWait and handleLive to capture price drift over time.
   * Each snapshot logs once per threshold (uses flags in state.goal_snapshot_flags).
   * 
   * @param {Object} trade - The trade record
   * @param {Object} state - The state_data object (will be mutated with flags)
   * @param {number} backPrice - Current back price
   * @param {number} layPrice - Current lay price
   * @param {number|null} minsFromKickoff - Minutes from kickoff (optional context)
   * @returns {boolean} - True if any snapshot was logged (caller should persist state)
   */
  async logGoalPriceSnapshots(trade, state, backPrice, layPrice, minsFromKickoff = null) {
    // Only run if we have a spike_detected_at timestamp
    if (!state.spike_detected_at) return false;
    
    // Initialize flags if missing (safety for existing trades)
    if (!state.goal_snapshot_flags) {
      state.goal_snapshot_flags = { s30: false, s60: false, s90: false, s120: false };
    }
    
    const elapsed = (Date.now() - state.spike_detected_at) / 1000;
    const thresholds = [
      { key: 's30', target: 30 },
      { key: 's60', target: 60 },
      { key: 's90', target: 90 },
      { key: 's120', target: 120 },
    ];
    
    let logged = false;
    
    for (const { key, target } of thresholds) {
      if (elapsed >= target && !state.goal_snapshot_flags[key]) {
        // Log snapshot
        const spread = layPrice && backPrice ? (layPrice - backPrice) : null;
        await this.logEvent(trade.id, 'GOAL_PRICE_SNAPSHOT', {
          goal_number: state.goal_number || 1,
          seconds_after_goal_target: target,
          seconds_after_goal_actual: Math.round(elapsed),
          back_price: backPrice,
          lay_price: layPrice,
          spread: spread ? Number(spread.toFixed(2)) : null,
          baseline_price: state.baseline_price,
          spike_price: state.spike_price,
          mins_from_kickoff: minsFromKickoff != null ? Number(minsFromKickoff.toFixed(1)) : null,
          timestamp: new Date().toISOString(),
        });
        
        this.logger.log(`[strategy:${STRATEGY_KEY}] 📸 SNAPSHOT t+${target}s: back=${backPrice} | lay=${layPrice} | spread=${spread?.toFixed(2) || 'N/A'}`);
        
        state.goal_snapshot_flags[key] = true;
        logged = true;
      }
    }
    
    return logged;
  }

  /**
   * Initialize shadow monitoring state for POST_TRADE_MONITOR phase.
   * Called when transitioning from any phase (completed or skipped) to monitoring.
   * 
   * @param {Object} state - The state_data object (will be mutated)
   * @param {Object} options - Configuration options
   * @param {number} options.theoreticalEntryPrice - The price to use as theoretical entry
   * @param {boolean} options.isSkippedTrade - Whether this is a skipped trade (vs completed)
   * @param {string} options.skipReason - Reason for skip (if skipped)
   * @returns {Object} - The mutated state object
   */
  initializeShadowMonitoring(state, options = {}) {
    const { theoreticalEntryPrice, isSkippedTrade = false, skipReason = null } = options;
    
    state.phase = PHASE.POST_TRADE_MONITOR;
    state.monitor_started_at = Date.now();
    state.is_shadow_trade = isSkippedTrade;
    
    if (isSkippedTrade) {
      state.theoretical_entry_price = theoreticalEntryPrice;
      state.theoretical_entry_time = Date.now();
      state.skip_reason = skipReason;
    }
    
    // Initialize milestone tracking
    state.shadow_milestones = {};
    
    // Preserve existing values if already calculated during LIVE phase
    // This ensures we don't lose min price data when transitioning from LIVE → STOP_LOSS → POST_TRADE_MONITOR
    state.min_post_entry_price = state.min_post_entry_price || null;
    state.time_at_min_price = state.time_at_min_price || null;
    state.max_potential_profit_pct = state.max_potential_profit_pct || 0;
    
    return state;
  }

  async handleWatching(trade, state, backPrice, layPrice, minsFromKickoff, sessionToken, market) {
    const goalCutoff = this.settings?.goal_cutoff_minutes || this.defaults.goal_cutoff_minutes;
    const goalDetectionPct = this.settings?.goal_detection_pct || this.defaults.goal_detection_pct;
    const stabilityPct = this.settings?.baseline_stability_pct || this.defaults.baseline_stability_pct;
    const stableReadingsRequired = this.settings?.baseline_stable_readings || this.defaults.baseline_stable_readings;
    const eventName = trade.event_name || trade.event_id || 'Unknown';

    // Initialize baseline and price history if not set - transition from scheduled → watching
    if (!state.baseline_price) {
      // Check market liquidity when game goes in-play (only check once)
      const minLiquidity = this.settings?.min_market_liquidity || this.defaults.min_market_liquidity;
      const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'liquidity-check-inplay');
      
      if (book && typeof book.totalMatched === 'number') {
        if (book.totalMatched < minLiquidity) {
          this.logger.log(`[strategy:${STRATEGY_KEY}] Market liquidity too low (${book.totalMatched} < ${minLiquidity}) for ${eventName} - transitioning to shadow monitoring`);
          
          this.initializeShadowMonitoring(state, {
            theoreticalEntryPrice: backPrice,
            isSkippedTrade: true,
            skipReason: 'MARKET_LIQUIDITY_TOO_LOW',
          });
          
          await this.updateTrade(trade.id, {
            status: 'post_trade_monitor',
            state_data: state,
            theoretical_entry_price: backPrice,
            last_error: `MARKET_LIQUIDITY_TOO_LOW: ${book.totalMatched} < ${minLiquidity}`,
          });
          await this.logEvent(trade.id, 'SHADOW_MONITORING_STARTED', {
            reason: 'MARKET_LIQUIDITY_TOO_LOW',
            theoretical_entry_price: backPrice,
            total_matched: book.totalMatched,
            min_liquidity: minLiquidity,
            mins_from_kickoff: minsFromKickoff,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }
      // If totalMatched is not available, skip the check (graceful fallback)
      
      state.baseline_price = backPrice;
      state.last_price = backPrice;
      state.recent_prices = [backPrice];  // Start tracking price history
      
      this.logger.log(`[strategy:${STRATEGY_KEY}] 👀 WATCHING STARTED: ${eventName} (baseline: ${backPrice}, min: ${minsFromKickoff.toFixed(0)})`);
      
      await this.updateTrade(trade.id, { 
        status: 'watching',
        state_data: state 
      });
      await this.logEvent(trade.id, 'WATCHING_STARTED', { 
        baseline_price: backPrice,
        mins_from_kickoff: minsFromKickoff,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // --- Rolling Baseline Update Logic ---
    // Track recent prices to detect stable market (no goal) vs spike (goal)
    // If N consecutive readings are within X% of each other, update baseline to current price
    if (!state.recent_prices) {
      state.recent_prices = [state.last_price || state.baseline_price];
    }
    
    // Add current price to history (keep last N readings)
    state.recent_prices.push(backPrice);
    if (state.recent_prices.length > stableReadingsRequired) {
      state.recent_prices.shift();  // Remove oldest, keep last N
    }
    
    // Check if market is stable: all recent prices within stabilityPct% of the median
    let baselineUpdated = false;
    if (state.recent_prices.length >= stableReadingsRequired) {
      const sorted = [...state.recent_prices].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      
      // Check if ALL prices are within stabilityPct% of the median
      const allStable = state.recent_prices.every(p => {
        const deviation = Math.abs((p - median) / median) * 100;
        return deviation <= stabilityPct;
      });
      
      if (allStable) {
        const oldBaseline = state.baseline_price;
        // Only log update if baseline actually changed meaningfully (>1% difference)
        const baselineDrift = Math.abs((backPrice - oldBaseline) / oldBaseline) * 100;
        
        if (baselineDrift > 1) {
          state.baseline_price = backPrice;
          baselineUpdated = true;
          this.logger.log(`[strategy:${STRATEGY_KEY}] 📊 BASELINE UPDATED: ${eventName} | ${oldBaseline.toFixed(2)} → ${backPrice.toFixed(2)} (drift: ${baselineDrift.toFixed(1)}%, stable for ${stableReadingsRequired} readings)`);
          
          await this.logEvent(trade.id, 'BASELINE_UPDATED', {
            old_baseline: oldBaseline,
            new_baseline: backPrice,
            drift_pct: Number(baselineDrift.toFixed(1)),
            recent_prices: [...state.recent_prices],
            mins_from_kickoff: minsFromKickoff,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // --- Goal Detection (vs updated baseline) ---
    const priceChangeFromBaseline = ((backPrice - state.baseline_price) / state.baseline_price) * 100;
    
    // Calculate change from PREVIOUS poll (for logging clarity)
    const previousPrice = state.last_price || state.baseline_price;
    const priceChangeFromPrevious = ((backPrice - previousPrice) / previousPrice) * 100;
    
    // Diagnostic log (include baseline status)
    const baselineStatus = baselineUpdated ? ' [BASELINE_UPDATED]' : '';
    this.logger.log(`[strategy:${STRATEGY_KEY}]   WATCHING ${eventName}: price=${backPrice} | baseline=${state.baseline_price.toFixed(2)} | vs_baseline=${priceChangeFromBaseline.toFixed(1)}% | threshold=${goalDetectionPct}%${baselineStatus}`);
    
    if (priceChangeFromBaseline >= goalDetectionPct) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] 🎯 GOAL DETECTED! Price spike: ${priceChangeFromBaseline.toFixed(1)}% from baseline (${state.baseline_price} → ${backPrice})`);
      
      // Check if goal is after cutoff - transition to shadow monitoring
      if (minsFromKickoff > goalCutoff) {
        this.logger.log(`[strategy:${STRATEGY_KEY}] Goal after ${goalCutoff}min cutoff (at ${minsFromKickoff.toFixed(0)}min) - transitioning to shadow monitoring`);
        
        this.initializeShadowMonitoring(state, {
          theoreticalEntryPrice: backPrice,
          isSkippedTrade: true,
          skipReason: 'GOAL_AFTER_CUTOFF',
        });
        
        await this.updateTrade(trade.id, { 
          status: 'post_trade_monitor',
          state_data: state,
          theoretical_entry_price: backPrice,
          last_error: `Goal after ${goalCutoff}min cutoff`,
        });
        await this.logEvent(trade.id, 'SHADOW_MONITORING_STARTED', { 
          reason: 'GOAL_AFTER_CUTOFF',
          theoretical_entry_price: backPrice,
          mins_from_kickoff: minsFromKickoff,
          cutoff: goalCutoff,
          spike_price: backPrice,
          baseline_price: state.baseline_price,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Move to GOAL_WAIT - clear recent_prices (not needed during GOAL_WAIT)
      state.phase = PHASE.GOAL_WAIT;
      state.spike_detected_at = Date.now();
      state.spike_price = backPrice;
      state.goal_number = 1;
      state.recent_prices = [];  // Reset price history
      // Initialize snapshot flags for price logging at t+30/60/90/120 seconds
      state.goal_snapshot_flags = { s30: false, s60: false, s90: false, s120: false };
      
      await this.updateTrade(trade.id, { 
        status: 'goal_wait',
        state_data: state,
      });
      const goalDetectedAt = new Date().toISOString();
      await this.logEvent(trade.id, 'GOAL_DETECTED', { 
        goal_number: 1,
        price_after_goal: backPrice,
        spike_price: backPrice,
        baseline_price: state.baseline_price,
        price_change_pct: priceChangeFromBaseline,
        mins_from_kickoff: minsFromKickoff,
        timestamp: goalDetectedAt,
      });
      return;
    }

    // Update last_price for next poll comparison
    state.last_price = backPrice;
    await this.updateTrade(trade.id, { state_data: state });
  }

  async handleGoalWait(trade, state, backPrice, layPrice, sessionToken, market) {
    const waitSeconds = this.settings?.wait_after_goal_seconds || this.defaults.wait_after_goal_seconds;
    const goalDetectionPct = this.settings?.goal_detection_pct || this.defaults.goal_detection_pct;
    const minEntryPrice = this.settings?.min_entry_price || this.defaults.min_entry_price;
    const maxEntryPrice = this.settings?.max_entry_price || this.defaults.max_entry_price;
    
    // ===== GUARD CLAUSE: Prevent duplicate initial bets =====
    // If we already placed a back bet (back_bet_id exists), we should resume monitoring
    // instead of placing another full-stake bet. This handles re-entry after timeout.
    if (state.back_bet_id) {
      const existingBetId = state.back_bet_id;
      const existingStake = state.target_stake || trade.target_stake || this.defaults.default_stake;
      const existingEntryPrice = state.entry_price || trade.back_price || backPrice;
      
      this.logger.log(`[strategy:${STRATEGY_KEY}] GOAL_WAIT: Resuming monitor for existing bet ${existingBetId} (stake: £${existingStake}, entry: ${existingEntryPrice})`);
      
      // Jump directly to the verification/retry flow - do NOT place a new bet
      await this.waitAndVerifyBackThenPlaceLay(trade, state, existingBetId, existingStake, existingEntryPrice, sessionToken, market);
      return;
    }
    
    const elapsed = (Date.now() - state.spike_detected_at) / 1000;
    
    // Log price snapshots at t+30/60/90/120 (for entry timing analysis)
    const snapshotLogged = await this.logGoalPriceSnapshots(trade, state, backPrice, layPrice);
    if (snapshotLogged) {
      await this.updateTrade(trade.id, { state_data: state });
    }
    
    // Check if price has fallen back (false alarm - VAR?)
    const priceChange = ((backPrice - state.baseline_price) / state.baseline_price) * 100;
    if (priceChange < goalDetectionPct * 0.5) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] Price returned to normal (${priceChange.toFixed(1)}% < ${goalDetectionPct * 0.5}%) - FALSE ALARM`);
      state.phase = PHASE.WATCHING;
      state.baseline_price = backPrice;
      delete state.spike_detected_at;
      delete state.spike_price;
      
      await this.updateTrade(trade.id, { 
        status: 'watching',
        state_data: state,
      });
      await this.logEvent(trade.id, 'GOAL_DISALLOWED', { 
        current_price: backPrice,
        baseline_price: state.baseline_price,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Wait for settle time
    if (elapsed < waitSeconds) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] GOAL_WAIT: ${elapsed.toFixed(0)}s / ${waitSeconds}s elapsed, price: ${backPrice}`);
      return;
    }

    // Time to enter - check price range
    // TASK 2: If price is below min, wait 30s and re-check before skipping
    // This handles the case where goal spike is lower than where price settles
    const priceRecheckWaitSeconds = 30;
    
    if (backPrice > maxEntryPrice) {
      // Price too high - transition to shadow monitoring
      this.logger.log(`[strategy:${STRATEGY_KEY}] Price ${backPrice} above max ${maxEntryPrice} - transitioning to shadow monitoring`);
      
      this.initializeShadowMonitoring(state, {
        theoreticalEntryPrice: backPrice,
        isSkippedTrade: true,
        skipReason: 'PRICE_ABOVE_MAX',
      });
      
      await this.updateTrade(trade.id, { 
        status: 'post_trade_monitor',
        state_data: state,
        theoretical_entry_price: backPrice,
        last_error: `Price ${backPrice} above max entry ${maxEntryPrice}`,
      });
      await this.logEvent(trade.id, 'SHADOW_MONITORING_STARTED', { 
        reason: 'PRICE_ABOVE_MAX',
        theoretical_entry_price: backPrice,
        current_price: backPrice,
        min_price: minEntryPrice,
        max_price: maxEntryPrice,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    
    if (backPrice < minEntryPrice) {
      // Price below minimum - check if we should wait for a re-check
      if (!state.price_below_min_first_check_at) {
        // First time price is below min - start the 30s re-check timer
        state.price_below_min_first_check_at = Date.now();
        state.price_below_min_initial_price = backPrice;
        
        this.logger.log(`[strategy:${STRATEGY_KEY}] ⏳ Price ${backPrice} below min ${minEntryPrice} - waiting ${priceRecheckWaitSeconds}s for price to rise before skipping`);
        await this.updateTrade(trade.id, { state_data: state });
        await this.logEvent(trade.id, 'PRICE_BELOW_MIN_WAITING', { 
          current_price: backPrice,
          min_price: minEntryPrice,
          recheck_wait_seconds: priceRecheckWaitSeconds,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      
      // We already started the re-check timer - check if 30s has elapsed
      const elapsedSinceFirstCheck = (Date.now() - state.price_below_min_first_check_at) / 1000;
      
      if (elapsedSinceFirstCheck < priceRecheckWaitSeconds) {
        // Still waiting for 30s to elapse - check if price has risen above min
        if (backPrice >= minEntryPrice) {
          // Price has risen - clear the timer and proceed to entry
          this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ Price rose from ${state.price_below_min_initial_price} to ${backPrice} (above min ${minEntryPrice}) - proceeding with entry`);
          delete state.price_below_min_first_check_at;
          delete state.price_below_min_initial_price;
          await this.updateTrade(trade.id, { state_data: state });
          await this.logEvent(trade.id, 'PRICE_ROSE_ABOVE_MIN', { 
            initial_price: state.price_below_min_initial_price,
            current_price: backPrice,
            min_price: minEntryPrice,
            elapsed_seconds: elapsedSinceFirstCheck,
            timestamp: new Date().toISOString(),
          });
          // Fall through to entry logic below
        } else {
          // Still waiting - log progress
          this.logger.log(`[strategy:${STRATEGY_KEY}] ⏳ Price ${backPrice} still below min ${minEntryPrice} - waiting (${elapsedSinceFirstCheck.toFixed(0)}s / ${priceRecheckWaitSeconds}s)`);
          return;
        }
      } else {
        // 30s has elapsed and price is still below min - transition to shadow monitoring
        this.logger.log(`[strategy:${STRATEGY_KEY}] Price ${backPrice} still below min ${minEntryPrice} after ${priceRecheckWaitSeconds}s re-check - transitioning to shadow monitoring`);
        
        this.initializeShadowMonitoring(state, {
          theoreticalEntryPrice: backPrice,
          isSkippedTrade: true,
          skipReason: 'PRICE_BELOW_MIN',
        });
        
        await this.updateTrade(trade.id, { 
          status: 'post_trade_monitor',
          state_data: state,
          theoretical_entry_price: backPrice,
          last_error: `Price ${backPrice} below min entry ${minEntryPrice} after ${priceRecheckWaitSeconds}s recheck`,
        });
        await this.logEvent(trade.id, 'SHADOW_MONITORING_STARTED', { 
          reason: 'PRICE_BELOW_MIN',
          theoretical_entry_price: backPrice,
          initial_price: state.price_below_min_initial_price,
          current_price: backPrice,
          min_price: minEntryPrice,
          max_price: maxEntryPrice,
          recheck_wait_seconds: priceRecheckWaitSeconds,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    } else {
      // Price is within range - clear any pending re-check timer (if it rose above min)
      if (state.price_below_min_first_check_at) {
        this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ Price ${backPrice} now within range [${minEntryPrice}, ${maxEntryPrice}] - proceeding with entry`);
        delete state.price_below_min_first_check_at;
        delete state.price_below_min_initial_price;
        await this.updateTrade(trade.id, { state_data: state });
      }
    }

    // GUARDRAIL: Check spread before placing back
    // Only place at back price if lay is within 1 tick (tight spread = good liquidity)
    const isTightSpread = isWithinTicks(backPrice, layPrice, 1);
    let entryPrice;
    
    if (isTightSpread) {
      // Tight spread - place at back price for better value
      entryPrice = backPrice;
      this.logger.log(`[strategy:${STRATEGY_KEY}] Tight spread (back: ${backPrice}, lay: ${layPrice}) - placing BACK @ back price ${entryPrice}`);
    } else {
      // Wide spread - use middle price to improve fill probability
      entryPrice = getMiddlePrice(backPrice, layPrice);
      this.logger.log(`[strategy:${STRATEGY_KEY}] Wide spread (back: ${backPrice}, lay: ${layPrice}) - placing BACK @ middle price ${entryPrice}`);
    }
    
    const stake = trade.target_stake || this.settings?.default_stake || this.defaults.default_stake;

    // Place BACK order
    const placeRes = await this.placeLimitOrderSafe(
      market.marketId,
      market.selectionId,
      'BACK',
      stake,
      entryPrice,
      sessionToken,
      'goalreact-entry'
    );

    if (placeRes.status === 'SUCCESS') {
      const placedAt = new Date().toISOString();
      this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ BACK PLACED @ ${entryPrice} - betId: ${placeRes.betId}`);
      
      state.entry_price = entryPrice;
      state.entry_time = Date.now();
      state.back_bet_id = placeRes.betId;
      state.target_stake = stake;
      
      // TASK 1: Initialize bet history to track all bets placed with timestamps
      state.back_bets_history = [{
        betId: placeRes.betId,
        type: 'ORIGINAL',
        placedAt,
        requestedStake: stake,
        requestedPrice: entryPrice,
        matchedSize: 0,  // Will be updated after verification
        matchedPrice: null,
        matchedAt: null,
        status: 'PENDING',
      }];
      
      // Emit distinct event for original back placement (for log visibility)
      await this.logEvent(trade.id, 'BACK_PLACED', {
        bet_id: placeRes.betId,
        bet_type: 'ORIGINAL',
        stake,
        price: entryPrice,
        spread_tight: isTightSpread,
        timestamp: placedAt,
      });
      
      // CRITICAL FIX: Wait to verify back order actually matched BEFORE placing lay
      // Goal reactions can cause market suspensions - back might not match
      await this.waitAndVerifyBackThenPlaceLay(trade, state, placeRes.betId, stake, entryPrice, sessionToken, market);
      
    } else {
      this.logger.error(`[strategy:${STRATEGY_KEY}] Entry failed: ${placeRes.errorCode}`);
      await this.logEvent(trade.id, 'ENTRY_FAILED', { errorCode: placeRes.errorCode });
    }
  }

  /**
   * CRITICAL: Verify back order matched before placing lay
   * Handles: suspensions, partial matches, cancellations
   * 
   * NEW LOGIC (v2):
   * - Wait 30s for back to match (up from 15s)
   * - If any unmatched portion after 30s: cancel unmatched first, then re-bet
   * - Re-bet only the unmatched amount at current back price
   * - GUARDRAIL: Only place at back price if lay is within 1 tick (tight spread)
   */
  async waitAndVerifyBackThenPlaceLay(trade, state, backBetId, stake, entryPrice, sessionToken, market) {
    const maxWaitMs = 30000; // Wait up to 30 seconds for back to match
    const pollIntervalMs = 500;
    let elapsed = 0;
    let backMatchedSize = 0;
    let backMatchedPrice = entryPrice;
    let backRemainingSize = stake;
    let orderStatus = null;
    
    // ===== TASK 2 FIX: Check for pending retry bets FIRST =====
    // If we re-entered this function and there's already a pending retry, handle it before placing lay
    if (state.retry_back_bet_ids && state.retry_back_bet_ids.length > 0) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] Found ${state.retry_back_bet_ids.length} pending retry bet(s) - resolving before placing lay`);
      
      // Get the original matched amount from state (already processed in previous call)
      const originalMatchedSize = state.back_bets_history?.[0]?.matchedSize || 0;
      const originalMatchedPrice = state.back_bets_history?.[0]?.matchedPrice || entryPrice;
      
      backMatchedSize = originalMatchedSize;
      backMatchedPrice = originalMatchedPrice;
      
      this.logger.log(`[strategy:${STRATEGY_KEY}] Original back matched: £${originalMatchedSize} @ ${originalMatchedPrice}`);
      
      // Process each pending retry bet
      for (const retryBet of [...state.retry_back_bet_ids]) {
        const retryWaitMs = 60000; // 60 seconds for retry
        const retryPollMs = 1000;
        let retryElapsed = 0;
        let retryMatchedSize = 0;
        let retryMatchedPrice = retryBet.price;
        
        this.logger.log(`[strategy:${STRATEGY_KEY}] Checking pending retry bet ${retryBet.betId} (£${retryBet.amount} @ ${retryBet.price})`);
        
        // Calculate how long this retry has been in the market
        const retryAge = Date.now() - retryBet.placedAt;
        const remainingWait = Math.max(0, retryWaitMs - retryAge);
        
        this.logger.log(`[strategy:${STRATEGY_KEY}] Retry bet age: ${(retryAge/1000).toFixed(0)}s, remaining wait: ${(remainingWait/1000).toFixed(0)}s`);
        
        // Wait for remaining time (if any) for retry to match
        while (retryElapsed < remainingWait) {
          const retryDetails = await this.getOrderDetailsSafe(retryBet.betId, sessionToken, 'verify-pending-retry');
          
          if (!retryDetails) {
            this.logger.warn(`[strategy:${STRATEGY_KEY}] Pending retry bet ${retryBet.betId} not found - likely cancelled`);
            break;
          }
          
          retryMatchedSize = retryDetails.sizeMatched || 0;
          retryMatchedPrice = retryDetails.averagePriceMatched || retryBet.price;
          
          if (retryDetails.status === 'EXECUTION_COMPLETE' || (retryMatchedSize > 0 && retryDetails.sizeRemaining === 0)) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ Pending retry FULLY MATCHED: £${retryMatchedSize} @ ${retryMatchedPrice}`);
            
            // Update bet history
            const historyEntry = state.back_bets_history?.find(b => b.betId === retryBet.betId);
            if (historyEntry) {
              historyEntry.matchedSize = retryMatchedSize;
              historyEntry.matchedPrice = retryMatchedPrice;
              historyEntry.matchedAt = new Date().toISOString();
              historyEntry.status = 'FULLY_MATCHED';
            }
            break;
          }
          
          // Log progress every 15s
          if (retryElapsed > 0 && retryElapsed % 15000 === 0) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] Pending retry wait: ${retryElapsed/1000}s/${remainingWait/1000}s - matched £${retryMatchedSize}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, retryPollMs));
          retryElapsed += retryPollMs;
        }
        
        // Check final status after wait
        const finalCheck = await this.getOrderDetailsSafe(retryBet.betId, sessionToken, 'final-pending-retry-check');
        if (finalCheck) {
          retryMatchedSize = finalCheck.sizeMatched || retryMatchedSize;
          retryMatchedPrice = finalCheck.averagePriceMatched || retryMatchedPrice;
          
          // Cancel any unmatched portion
          if (finalCheck.sizeRemaining > 0 && finalCheck.status === 'EXECUTABLE') {
            this.logger.log(`[strategy:${STRATEGY_KEY}] Cancelling unmatched pending retry: £${finalCheck.sizeRemaining}`);
            
            const cancelRes = await this.cancelOrderAndConfirm(retryBet.betId, market.marketId, sessionToken, 'cancel-pending-retry', {
              confirmMs: 10000,
              pollMs: 500,
              maxCancelAttempts: 3,
              notFoundThreshold: 3,
            });
            
            // Update matched amounts from cancel result
            if (cancelRes.last_details) {
              retryMatchedSize = cancelRes.last_details.sizeMatched || retryMatchedSize;
              retryMatchedPrice = cancelRes.last_details.averagePriceMatched || retryMatchedPrice;
            }
            
            // Update bet history
            const historyEntry = state.back_bets_history?.find(b => b.betId === retryBet.betId);
            if (historyEntry) {
              historyEntry.matchedSize = retryMatchedSize;
              historyEntry.matchedPrice = retryMatchedSize > 0 ? retryMatchedPrice : null;
              historyEntry.matchedAt = retryMatchedSize > 0 ? new Date().toISOString() : null;
              historyEntry.status = retryMatchedSize > 0 ? 'PARTIAL_MATCH_CANCELLED' : 'CANCELLED';
              historyEntry.cancelledSize = cancelRes.last_details?.sizeRemaining || finalCheck.sizeRemaining;
            }
          }
        }
        
        // Aggregate matched amounts
        if (retryMatchedSize > 0) {
          const prevTotal = backMatchedSize;
          const newTotal = prevTotal + retryMatchedSize;
          const weightedAvg = newTotal > 0 
            ? (prevTotal * backMatchedPrice + retryMatchedSize * retryMatchedPrice) / newTotal
            : entryPrice;
          
          this.logger.log(`[strategy:${STRATEGY_KEY}] Aggregating: £${prevTotal} + £${retryMatchedSize} = £${newTotal} @ ${weightedAvg.toFixed(2)}`);
          
          backMatchedSize = newTotal;
          backMatchedPrice = weightedAvg;
        }
        
        // Remove from pending list
        state.retry_back_bet_ids = state.retry_back_bet_ids.filter(b => b.betId !== retryBet.betId);
      }
      
      // Log aggregation event
      await this.logEvent(trade.id, 'PENDING_RETRY_RESOLVED', {
        original_matched: originalMatchedSize,
        original_price: originalMatchedPrice,
        total_matched: backMatchedSize,
        weighted_avg_price: backMatchedPrice,
        timestamp: new Date().toISOString(),
      });
      
      // Skip the original bet checking loop - go straight to lay placement
      // (Original was already processed in a previous call)
      this.logger.log(`[strategy:${STRATEGY_KEY}] All pending retries resolved - total matched: £${backMatchedSize} @ ${backMatchedPrice.toFixed(2)}`);
      
      // Jump to lay placement (after the retry handling block below)
      // We set orderStatus to skip the partial match handling
      orderStatus = 'ALREADY_PROCESSED';
      
    } else {
      // ===== Normal flow: No pending retries, process the original bet =====
      this.logger.log(`[strategy:${STRATEGY_KEY}] Verifying back order ${backBetId} matches before placing lay (30s timeout)...`);
      
      // Poll for up to 30s to check if back order matches
      while (elapsed < maxWaitMs) {
        const orderDetails = await this.getOrderDetailsSafe(backBetId, sessionToken, 'verify-back-match');
        
        if (!orderDetails) {
          // Order not found - might be matched and cleared, or cancelled due to suspension
          this.logger.warn(`[strategy:${STRATEGY_KEY}] Back order ${backBetId} not found after ${elapsed}ms - transitioning to shadow monitoring`);
          
          // SAFE: Order disappeared, likely cancelled - no exposure, but shadow monitor
          this.initializeShadowMonitoring(state, {
            theoreticalEntryPrice: entryPrice,
            isSkippedTrade: true,
            skipReason: 'BACK_ORDER_DISAPPEARED',
          });
          
          await this.updateTrade(trade.id, {
            status: 'post_trade_monitor',
            state_data: state,
            theoretical_entry_price: entryPrice,
            back_order_ref: backBetId,
            back_matched_size: 0,
            last_error: 'BACK_NOT_MATCHED_ORDER_DISAPPEARED',
          });
          
          await this.logEvent(trade.id, 'SHADOW_MONITORING_STARTED', {
            reason: 'BACK_ORDER_DISAPPEARED',
            theoretical_entry_price: entryPrice,
            betId: backBetId,
            elapsed_ms: elapsed,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        
        orderStatus = orderDetails.status;
        backMatchedSize = orderDetails.sizeMatched || 0;
        backRemainingSize = orderDetails.sizeRemaining || 0;
        backMatchedPrice = orderDetails.averagePriceMatched || entryPrice;
        
        // TASK 2 FIX: EXECUTION_COMPLETE doesn't always mean "fully matched"
        // It could be a cancelled partial match. Check sizeMatched vs expected stake.
        if (orderStatus === 'EXECUTION_COMPLETE') {
          const isFullyMatched = backMatchedSize >= stake * 0.99; // Allow 1% tolerance for rounding
          
          if (isFullyMatched) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ Back FULLY MATCHED: £${backMatchedSize} @ ${backMatchedPrice}`);
            
            // Update bet history with matched details
            if (state.back_bets_history?.[0]?.betId === backBetId) {
              state.back_bets_history[0].matchedSize = backMatchedSize;
              state.back_bets_history[0].matchedPrice = backMatchedPrice;
              state.back_bets_history[0].matchedAt = new Date().toISOString();
              state.back_bets_history[0].status = 'FULLY_MATCHED';
            }
            break;
          } else {
            // EXECUTION_COMPLETE but not fully matched = was cancelled after partial match
            this.logger.log(`[strategy:${STRATEGY_KEY}] ⚠️ Back PARTIALLY MATCHED then cancelled: £${backMatchedSize} of £${stake} @ ${backMatchedPrice}`);
            
            // Update bet history
            if (state.back_bets_history?.[0]?.betId === backBetId) {
              state.back_bets_history[0].matchedSize = backMatchedSize;
              state.back_bets_history[0].matchedPrice = backMatchedPrice;
              state.back_bets_history[0].matchedAt = backMatchedSize > 0 ? new Date().toISOString() : null;
              state.back_bets_history[0].status = backMatchedSize > 0 ? 'PARTIAL_MATCH_CANCELLED' : 'CANCELLED';
              state.back_bets_history[0].cancelledSize = stake - backMatchedSize;
            }
            
            // Set backRemainingSize to trigger the retry flow below (if not already retried)
            backRemainingSize = stake - backMatchedSize;
            break;
          }
        }
        
        // Wait and retry
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        elapsed += pollIntervalMs;
      }
    }
    
    // After 30s: Handle any unmatched portion (only if we didn't already process pending retries)
    if (orderStatus !== 'ALREADY_PROCESSED' && backRemainingSize > 0 && !state.retry_back_attempted) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] ⚠️ Back partially matched after ${maxWaitMs/1000}s: £${backMatchedSize} matched, £${backRemainingSize} unmatched`);
      
      // TASK 1: Update bet history with partial match details
      if (state.back_bets_history?.[0]?.betId === backBetId) {
        state.back_bets_history[0].matchedSize = backMatchedSize;
        state.back_bets_history[0].matchedPrice = backMatchedPrice;
        state.back_bets_history[0].matchedAt = backMatchedSize > 0 ? new Date().toISOString() : null;
        state.back_bets_history[0].status = backMatchedSize > 0 ? 'PARTIAL_MATCH_CANCELLED' : 'CANCELLED';
        state.back_bets_history[0].cancelledSize = backRemainingSize;
      }
      
      // Track the pre-cancel remaining size for retry calculation
      const preCancelRemainingSize = backRemainingSize;

      // ===== STEP 1: Cancel unmatched portion with CONFIRMATION (prevents "original still in market") =====
      this.logger.log(`[strategy:${STRATEGY_KEY}] Cancelling unmatched back portion (£${backRemainingSize}) and waiting for confirmation...`);
      const cancelRes = await this.cancelOrderAndConfirm(backBetId, market.marketId, sessionToken, 'cancel-unmatched-back', {
        // 10s is sufficient: Betfair cancellations are typically <1s; we poll every 500ms (20 polls).
        // If not confirmed in 10s, likely a real issue - do not place retry to avoid double exposure.
        confirmMs: 10000,
        pollMs: 500,
        maxCancelAttempts: 5,
        notFoundThreshold: 3,
      });

      // Refresh the latest view of matched/remaining from the last known details (if present)
      if (cancelRes.last_details) {
        backMatchedSize = cancelRes.last_details.sizeMatched || backMatchedSize;
        backMatchedPrice = cancelRes.last_details.averagePriceMatched || backMatchedPrice;
        backRemainingSize = cancelRes.last_details.sizeRemaining || 0;
      }

      if (!cancelRes.closed) {
        // HARD SAFETY: Do NOT place a retry while the original may still be executable.
        this.logger.error(
          `[strategy:${STRATEGY_KEY}] ❌ Cancel NOT CONFIRMED for original back ${backBetId} (elapsed=${Math.round(cancelRes.elapsed_ms/1000)}s, attempts=${cancelRes.attempts}, remaining≈£${backRemainingSize}). ` +
          `Will NOT place retry to avoid double exposure.`
        );
        await this.logEvent(trade.id, 'BACK_CANCEL_NOT_CONFIRMED', {
          betId: backBetId,
          attempts: cancelRes.attempts,
          elapsed_ms: cancelRes.elapsed_ms,
          last_status: cancelRes.last_details?.status || null,
          last_remaining: cancelRes.last_details?.sizeRemaining || backRemainingSize || null,
          timestamp: new Date().toISOString(),
        });

        // We must not continue to hedge/retry while an executable back might still fill later.
        // Best-effort: stop here; next poll will re-evaluate state and continue monitoring.
        // (We keep existing matched amounts; if nothing matched we will skip below.)
        return;
      }

      // Cancellation confirmed: calculate the ACTUAL unmatched amount to retry.
      // This is the VERIFIED remaining size from the cancel confirmation (not the pre-cancel estimate).
      // If last_details shows sizeRemaining (cancelled amount), use that; otherwise use pre-cancel value.
      const confirmedCancelledSize = cancelRes.last_details?.sizeRemaining != null 
        ? preCancelRemainingSize  // Amount that was cancelled (original remaining before cancel)
        : preCancelRemainingSize;
      
      // The intendedRetrySize is the amount that was NOT matched and was successfully cancelled
      const intendedRetrySize = confirmedCancelledSize;
      
      // Reset remaining to 0 since we confirmed cancellation
      backRemainingSize = 0;
      
      this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ Cancel confirmed - intendedRetrySize: £${intendedRetrySize} (original stake: £${stake}, matched: £${backMatchedSize})`);
      
      // ===== STEP 2: HARD STOP CHECK - Only ONE retry allowed =====
      if (state.retry_back_attempted) {
        this.logger.log(`[strategy:${STRATEGY_KEY}] HARD STOP: Retry already attempted - no second retry allowed`);
      } else {
        // ===== STEP 3: Get current market prices for retry =====
        const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'get-retry-back-price');
        const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
        const currentBackPrice = runner?.ex?.availableToBack?.[0]?.price;
        const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;
        
        if (!currentBackPrice || !currentLayPrice) {
          this.logger.warn(`[strategy:${STRATEGY_KEY}] No prices for retry (back=${currentBackPrice}, lay=${currentLayPrice}) - proceeding with matched portion only (£${backMatchedSize})`);
        } else {
          // ===== STEP 4: Entry Price Guardrail =====
          // Place at back price only if spread is tight (1 tick)
          // Otherwise place 1 tick below lay price (aggressive but controlled)
          const isTightSpread = isWithinTicks(currentBackPrice, currentLayPrice, 1);
          let retryPrice;
          
          if (isTightSpread) {
            retryPrice = currentBackPrice;
            this.logger.log(`[strategy:${STRATEGY_KEY}] Tight spread detected - using back price ${retryPrice}`);
          } else {
            // GUARDRAIL: Use 1 tick below lay price (not raw lay price)
            retryPrice = ticksBelow(currentLayPrice, 1);
            this.logger.log(`[strategy:${STRATEGY_KEY}] Wide spread detected - using 1 tick below lay: ${retryPrice} (back=${currentBackPrice}, lay=${currentLayPrice})`);
          }
          
          // Mark retry as attempted BEFORE placing (prevents race condition on re-entry)
          state.retry_back_attempted = true;
          
          this.logger.log(`[strategy:${STRATEGY_KEY}] Placing RETRY back @ ${retryPrice} for £${intendedRetrySize}`);
          
          const retryRes = await this.placeLimitOrderSafe(
            market.marketId,
            market.selectionId,
            'BACK',
            intendedRetrySize,
            retryPrice,
            sessionToken,
            'goalreact-entry-retry'
          );
          
          if (retryRes.status === 'SUCCESS') {
            const retryPlacedAt = new Date().toISOString();
            this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ RETRY BACK PLACED @ ${retryPrice} - betId: ${retryRes.betId}`);
            
            // Track retry bet for cleanup
            if (!state.retry_back_bet_ids) {
              state.retry_back_bet_ids = [];
            }
            state.retry_back_bet_ids.push({
              betId: retryRes.betId,
              placedAt: Date.now(),
              amount: intendedRetrySize,
              price: retryPrice,
            });
            
            // TASK 1: Add retry bet to history
            if (!state.back_bets_history) {
              state.back_bets_history = [];
            }
            state.back_bets_history.push({
              betId: retryRes.betId,
              type: 'RETRY',
              placedAt: retryPlacedAt,
              requestedStake: intendedRetrySize,
              requestedPrice: retryPrice,
              matchedSize: 0,  // Will be updated after verification
              matchedPrice: null,
              matchedAt: null,
              status: 'PENDING',
              spreadGuardrail: isTightSpread ? 'TIGHT_SPREAD' : 'ONE_TICK_BELOW_LAY',
            });
            
            // Emit distinct event for retry back placement (for log visibility)
            await this.logEvent(trade.id, 'BACK_RETRY_PLACED', {
              bet_id: retryRes.betId,
              bet_type: 'RETRY',
              stake: intendedRetrySize,
              price: retryPrice,
              spread_guardrail: isTightSpread ? 'TIGHT_SPREAD' : 'ONE_TICK_BELOW_LAY',
              original_bet_id: backBetId,
              original_matched: backMatchedSize,
              timestamp: retryPlacedAt,
            });
            
            // TASK 2 FIX: Persist state IMMEDIATELY after placing retry
            // This ensures pending retry is tracked even if function is interrupted
            await this.updateTrade(trade.id, { 
              state_data: state,
              back_matched_size: backMatchedSize,  // Record what's matched so far
              back_price: backMatchedPrice,
            });
            
            // ===== STEP 5: Wait up to 60s for retry to match =====
            const retryWaitMs = 60000; // 60 seconds (up from 5s)
            const pollIntervalMs = 1000;
            let retryElapsed = 0;
            let retryMatchedSize = 0;
            let retryMatchedPrice = retryPrice;
            let retryOrderStatus = null;
            
            this.logger.log(`[strategy:${STRATEGY_KEY}] Waiting up to ${retryWaitMs/1000}s for retry to match...`);
            
            while (retryElapsed < retryWaitMs) {
              const retryDetails = await this.getOrderDetailsSafe(retryRes.betId, sessionToken, 'verify-retry-back');
              
              if (!retryDetails) {
                this.logger.warn(`[strategy:${STRATEGY_KEY}] Retry order ${retryRes.betId} not found - likely cancelled`);
                break;
              }
              
              retryOrderStatus = retryDetails.status;
              retryMatchedSize = retryDetails.sizeMatched || 0;
              retryMatchedPrice = retryDetails.averagePriceMatched || retryPrice;
              
              if (retryDetails.status === 'EXECUTION_COMPLETE' || (retryMatchedSize > 0 && retryDetails.sizeRemaining === 0)) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ RETRY FULLY MATCHED: £${retryMatchedSize} @ ${retryMatchedPrice}`);
                // Remove from tracking since fully matched
                state.retry_back_bet_ids = state.retry_back_bet_ids.filter(b => b.betId !== retryRes.betId);
                
                // TASK 1: Update retry bet history with matched details
                const retryHistoryEntry = state.back_bets_history?.find(b => b.betId === retryRes.betId);
                if (retryHistoryEntry) {
                  retryHistoryEntry.matchedSize = retryMatchedSize;
                  retryHistoryEntry.matchedPrice = retryMatchedPrice;
                  retryHistoryEntry.matchedAt = new Date().toISOString();
                  retryHistoryEntry.status = 'FULLY_MATCHED';
                }
                break;
              }
              
              // Log progress every 15s
              if (retryElapsed > 0 && retryElapsed % 15000 === 0) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] Retry wait: ${retryElapsed/1000}s/${retryWaitMs/1000}s - matched £${retryMatchedSize} of £${intendedRetrySize}`);
              }
              
              await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
              retryElapsed += pollIntervalMs;
            }
            
            // ===== STEP 6: HARD STOP - Cancel unmatched retry, NO second retry =====
            if (retryElapsed >= retryWaitMs || (retryOrderStatus && retryOrderStatus !== 'EXECUTION_COMPLETE')) {
              const finalRetryCheck = await this.getOrderDetailsSafe(retryRes.betId, sessionToken, 'final-retry-check');

              if (finalRetryCheck && finalRetryCheck.sizeRemaining > 0) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] ⏱️ Retry timeout (${retryWaitMs/1000}s) - cancelling unmatched £${finalRetryCheck.sizeRemaining} and confirming...`);

                const retryCancelRes = await this.cancelOrderAndConfirm(retryRes.betId, market.marketId, sessionToken, 'cancel-unmatched-retry-timeout', {
                  confirmMs: 20000,
                  pollMs: 500,
                  maxCancelAttempts: 4,
                  notFoundThreshold: 3,
                });

                // Use the best available final view
                const finalView = retryCancelRes.last_details || finalRetryCheck;
                retryMatchedSize = finalView?.sizeMatched || retryMatchedSize || 0;
                retryMatchedPrice = finalView?.averagePriceMatched || retryMatchedPrice || retryPrice;

                if (!retryCancelRes.closed) {
                  this.logger.error(`[strategy:${STRATEGY_KEY}] ❌ Retry cancel NOT CONFIRMED for ${retryRes.betId} (remaining≈£${finalView?.sizeRemaining || 'unknown'})`);
                  await this.logEvent(trade.id, 'RETRY_BACK_CANCEL_NOT_CONFIRMED', {
                    betId: retryRes.betId,
                    attempts: retryCancelRes.attempts,
                    elapsed_ms: retryCancelRes.elapsed_ms,
                    last_status: finalView?.status || null,
                    last_remaining: finalView?.sizeRemaining || null,
                    timestamp: new Date().toISOString(),
                  });
                } else {
                  this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ Retry cancelled/closed confirmed - final matched: £${retryMatchedSize}`);
                }
                
                // TASK 1: Update retry bet history with final status
                const retryHistoryEntry = state.back_bets_history?.find(b => b.betId === retryRes.betId);
                if (retryHistoryEntry) {
                  retryHistoryEntry.matchedSize = retryMatchedSize;
                  retryHistoryEntry.matchedPrice = retryMatchedSize > 0 ? retryMatchedPrice : null;
                  retryHistoryEntry.matchedAt = retryMatchedSize > 0 ? new Date().toISOString() : null;
                  retryHistoryEntry.status = retryMatchedSize > 0 ? 'PARTIAL_MATCH_CANCELLED' : 'CANCELLED';
                  retryHistoryEntry.cancelledSize = finalView?.sizeRemaining || 0;
                }
              }

              // Clean up tracking
              state.retry_back_bet_ids = (state.retry_back_bet_ids || []).filter(b => b.betId !== retryRes.betId);
            }
            
            // ===== STEP 7: Aggregate matched amounts =====
            if (retryMatchedSize > 0) {
              const originalMatched = backMatchedSize;
              const totalMatched = originalMatched + retryMatchedSize;
              const avgPrice = totalMatched > 0 
                ? (originalMatched * backMatchedPrice + retryMatchedSize * retryMatchedPrice) / totalMatched
                : entryPrice;
              
              // TASK 1: Log detailed breakdown of ALL bets placed (with timestamps to the second)
              const originalBet = state.back_bets_history?.[0];
              const retryBet = state.back_bets_history?.[1];
              
              this.logger.log(`[strategy:${STRATEGY_KEY}] ═══════════════════════════════════════════════════════════`);
              this.logger.log(`[strategy:${STRATEGY_KEY}] 📊 ENTRY COMPLETE - ALL BETS BREAKDOWN:`);
              this.logger.log(`[strategy:${STRATEGY_KEY}] ───────────────────────────────────────────────────────────`);
              this.logger.log(`[strategy:${STRATEGY_KEY}]   BET 1 (ORIGINAL): ${backBetId}`);
              this.logger.log(`[strategy:${STRATEGY_KEY}]     • Placed:    ${formatTimeWithSeconds(originalBet?.placedAt)} | £${stake.toFixed(2)} @ ${entryPrice}`);
              this.logger.log(`[strategy:${STRATEGY_KEY}]     • Matched:   ${formatTimeWithSeconds(originalBet?.matchedAt)} | £${originalMatched.toFixed(2)} @ ${backMatchedPrice.toFixed(2)}`);
              this.logger.log(`[strategy:${STRATEGY_KEY}]     • Status:    ${originalBet?.status || 'PARTIAL_MATCH_CANCELLED'}`);
              this.logger.log(`[strategy:${STRATEGY_KEY}]   BET 2 (RETRY):    ${retryRes.betId}`);
              this.logger.log(`[strategy:${STRATEGY_KEY}]     • Placed:    ${formatTimeWithSeconds(retryBet?.placedAt)} | £${intendedRetrySize.toFixed(2)} @ ${retryPrice}`);
              this.logger.log(`[strategy:${STRATEGY_KEY}]     • Matched:   ${formatTimeWithSeconds(retryBet?.matchedAt)} | £${retryMatchedSize.toFixed(2)} @ ${retryMatchedPrice.toFixed(2)}`);
              this.logger.log(`[strategy:${STRATEGY_KEY}]     • Status:    ${retryBet?.status || 'FULLY_MATCHED'}`);
              this.logger.log(`[strategy:${STRATEGY_KEY}] ───────────────────────────────────────────────────────────`);
              this.logger.log(`[strategy:${STRATEGY_KEY}]   TOTAL MATCHED: £${totalMatched.toFixed(2)} @ weighted avg ${avgPrice.toFixed(2)}`);
              this.logger.log(`[strategy:${STRATEGY_KEY}] ═══════════════════════════════════════════════════════════`);
              
              backMatchedSize = totalMatched;
              backMatchedPrice = avgPrice;
            }
            
            await this.logEvent(trade.id, 'BACK_RETRY', {
              original_bet_id: backBetId,
              original_matched: backMatchedSize - (retryMatchedSize || 0),
              original_price: state.back_bets_history?.[0]?.matchedPrice,
              retry_bet_id: retryRes.betId,
              retry_price: retryPrice,
              retry_amount: intendedRetrySize,
              retry_matched: retryMatchedSize,
              retry_matched_price: retryMatchedPrice,
              total_matched: backMatchedSize,
              weighted_avg_price: backMatchedPrice,
              spread_guardrail: isTightSpread ? 'TIGHT_SPREAD' : 'ONE_TICK_BELOW_LAY',
              retry_timeout_seconds: retryWaitMs / 1000,
              hard_stop_applied: true,
              back_bets_history: state.back_bets_history,
              timestamp: new Date().toISOString(),
            });
          } else {
            this.logger.warn(`[strategy:${STRATEGY_KEY}] Retry back failed: ${retryRes.errorCode} - proceeding with original matched portion (£${backMatchedSize})`);
            await this.logEvent(trade.id, 'BACK_RETRY_FAILED', {
              original_bet_id: backBetId,
              original_matched: backMatchedSize,
              retry_error: retryRes.errorCode,
              attempted_price: retryPrice,
              attempted_amount: intendedRetrySize,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    }
    
    // If nothing matched at all, transition to shadow monitoring - no exposure
    if (backMatchedSize === 0) {
      this.logger.warn(`[strategy:${STRATEGY_KEY}] ⚠️ Back did NOT match at all after ${maxWaitMs/1000}s - transitioning to shadow monitoring (no exposure)`);
      
      this.initializeShadowMonitoring(state, {
        theoreticalEntryPrice: entryPrice,
        isSkippedTrade: true,
        skipReason: 'BACK_NOT_MATCHED_TIMEOUT',
      });
      
      await this.updateTrade(trade.id, {
        status: 'post_trade_monitor',
        state_data: state,
        theoretical_entry_price: entryPrice,
        back_order_ref: backBetId,
        back_matched_size: 0,
        last_error: 'BACK_NOT_MATCHED_TIMEOUT',
      });
      
      await this.logEvent(trade.id, 'SHADOW_MONITORING_STARTED', {
        reason: 'BACK_NOT_MATCHED_TIMEOUT',
        theoretical_entry_price: entryPrice,
        betId: backBetId,
        timeout_seconds: maxWaitMs / 1000,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    
    // We have matched back - now place lay for green-up
    this.logger.log(`[strategy:${STRATEGY_KEY}] Back verified matched: £${backMatchedSize} @ ${backMatchedPrice} - placing lay hedge`);
    
    const profitTargetPct = this.settings?.profit_target_pct || this.defaults.profit_target_pct;
    const targetLayPrice = roundToBetfairTick(backMatchedPrice / (1 + profitTargetPct / 100));
    const { layStake } = calculateLayStake({
      backStake: backMatchedSize,  // Use ACTUAL matched size
      backPrice: backMatchedPrice,
      layPrice: targetLayPrice,
      commission: this.settings?.commission_rate || this.defaults.commission_rate,
    });
    
    this.logger.log(`[strategy:${STRATEGY_KEY}] Placing LAY hedge @ ${targetLayPrice} (${profitTargetPct}% profit target) - stake: £${layStake}`);
    
    const layRes = await this.placeLimitOrderSafe(
      market.marketId,
      market.selectionId,
      'LAY',
      layStake,
      targetLayPrice,
      sessionToken,
      'goalreact-hedge',
      'PERSIST'  // Keep in-play
    );
    
    if (layRes.status === 'SUCCESS') {
      this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ LAY HEDGE PLACED @ ${targetLayPrice} - betId: ${layRes.betId}`);
      
      state.phase = PHASE.LIVE;
      state.lay_bet_id = layRes.betId;
      state.target_lay_price = targetLayPrice;
      
      // Store position entered timestamp for exposure time calculation
      const positionEnteredAt = Date.now();
      state.position_entered_at = positionEnteredAt;
      
      // Initialize min price tracking (for post-trade analytics)
      // Track the best price achieved during LIVE phase, even if trade exits early due to 2nd goal
      state.min_post_entry_price = backMatchedPrice;
      state.max_potential_profit_pct = 0;
      state.time_at_min_price = 0;
      
      // Calculate exposure time (can't be negative)
      const exposureTimeSeconds = state.spike_detected_at 
        ? Math.max(0, Math.floor((positionEnteredAt - state.spike_detected_at) / 1000))
        : null;
      
      await this.updateTrade(trade.id, {
        status: 'live',
        state_data: state,
        back_price: backMatchedPrice,
        back_size: backMatchedSize,
        back_stake: backMatchedSize,
        back_matched_size: backMatchedSize,
        back_order_ref: backBetId,
        back_placed_at: state.back_bets_history?.[0]?.placedAt || new Date().toISOString(),
        lay_price: targetLayPrice,
        lay_size: layStake,
        lay_order_ref: layRes.betId,
        lay_placed_at: new Date().toISOString(),
        betfair_market_id: market.marketId,
        selection_id: market.selectionId,
      });
      
      // TASK 3: Detailed logging for each back bet step
      this.logger.log(`[strategy:${STRATEGY_KEY}] ═══════════════════════════════════════════════════════════`);
      this.logger.log(`[strategy:${STRATEGY_KEY}] 📊 POSITION ENTERED - SUMMARY:`);
      this.logger.log(`[strategy:${STRATEGY_KEY}] ───────────────────────────────────────────────────────────`);
      
      // Log each back bet in history
      const betHistory = state.back_bets_history || [];
      for (let i = 0; i < betHistory.length; i++) {
        const bet = betHistory[i];
        const betNum = i + 1;
        const typeLabel = bet.type === 'ORIGINAL' ? 'ORIGINAL BACK' : 'RETRY BACK';
        
        this.logger.log(`[strategy:${STRATEGY_KEY}]   BET ${betNum} (${typeLabel}): ${bet.betId}`);
        this.logger.log(`[strategy:${STRATEGY_KEY}]     • Placed:    ${formatTimeWithSeconds(bet.placedAt)} | stake: £${bet.requestedStake?.toFixed(2) || 'N/A'} | price: ${bet.requestedPrice || 'N/A'}`);
        
        if (bet.matchedSize > 0) {
          this.logger.log(`[strategy:${STRATEGY_KEY}]     • Matched:   ${formatTimeWithSeconds(bet.matchedAt)} | £${bet.matchedSize?.toFixed(2)} @ ${bet.matchedPrice?.toFixed(2)}`);
        }
        
        if (bet.status === 'CANCELLED' || bet.status === 'PARTIAL_MATCH_CANCELLED') {
          this.logger.log(`[strategy:${STRATEGY_KEY}]     • Cancelled: £${bet.cancelledSize?.toFixed(2) || '0.00'} unmatched`);
        }
        
        this.logger.log(`[strategy:${STRATEGY_KEY}]     • Status:    ${bet.status || 'UNKNOWN'}`);
      }
      
      this.logger.log(`[strategy:${STRATEGY_KEY}] ───────────────────────────────────────────────────────────`);
      this.logger.log(`[strategy:${STRATEGY_KEY}]   TOTAL BACK MATCHED: £${backMatchedSize.toFixed(2)} @ ${backMatchedPrice.toFixed(2)} (weighted avg)`);
      this.logger.log(`[strategy:${STRATEGY_KEY}] ───────────────────────────────────────────────────────────`);
      this.logger.log(`[strategy:${STRATEGY_KEY}]   LAY PLACED: £${layStake.toFixed(2)} @ ${targetLayPrice} (profit target hedge)`);
      this.logger.log(`[strategy:${STRATEGY_KEY}] ═══════════════════════════════════════════════════════════`);
      
      await this.logEvent(trade.id, 'POSITION_ENTERED', { 
        entry_price: backMatchedPrice,
        stake: backMatchedSize,
        back_bet_id: backBetId,
        back_matched_verified: true,
        lay_price: targetLayPrice,
        lay_stake: layStake,
        lay_bet_id: layRes.betId,
        exposure_time_seconds: exposureTimeSeconds,
        // Include full bet history for audit trail
        back_bets_count: state.back_bets_history?.length || 1,
        back_bets_history: state.back_bets_history || [{
          betId: backBetId,
          type: 'ORIGINAL',
          matchedSize: backMatchedSize,
          matchedPrice: backMatchedPrice,
          status: 'FULLY_MATCHED',
        }],
        timestamp: new Date(positionEnteredAt).toISOString(),
      });
    } else {
      // Lay failed - position is exposed, flag critical error
      this.logger.error(`[strategy:${STRATEGY_KEY}] ⚠️ LAY HEDGE FAILED: ${layRes.errorCode} - POSITION EXPOSED!`);
      
      state.phase = PHASE.LIVE;
      state.lay_failed = true;
      state.lay_error = layRes.errorCode;
      
      await this.updateTrade(trade.id, {
        status: 'live',
        state_data: state,
        back_price: backMatchedPrice,
        back_size: backMatchedSize,
        back_stake: backMatchedSize,
        back_matched_size: backMatchedSize,
        back_order_ref: backBetId,
        back_placed_at: new Date().toISOString(),
        betfair_market_id: market.marketId,
        selection_id: market.selectionId,
        last_error: `LAY_HEDGE_FAILED: ${layRes.errorCode} - EXPOSED`,
      });
      
      await this.logEvent(trade.id, 'LAY_HEDGE_FAILED', { 
        entry_price: backMatchedPrice,
        back_matched: backMatchedSize,
        target_lay_price: targetLayPrice,
        error: layRes.errorCode,
        exposed: true,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get full order details including matched/remaining sizes
   */
  async getOrderDetailsSafe(betId, sessionToken, label) {
    if (!betId) return null;
    try {
      const res = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCurrentOrders', {
        betIds: [betId],
        orderProjection: 'ALL',
      }, label);
      const order = res?.currentOrders?.[0];
      if (!order) return null;
      return {
        status: order.status,
        sizeMatched: order.sizeMatched || 0,
        sizeRemaining: order.sizeRemaining || 0,
        averagePriceMatched: order.averagePriceMatched || order.price,
        betId: order.betId,
      };
    } catch (err) {
      this.logger.error(`[strategy:${STRATEGY_KEY}] getOrderDetailsSafe error: ${err.message}`);
      return null;
    }
  }

  async handleLive(trade, state, backPrice, layPrice, sessionToken, market) {
    const goalDetectionPct = this.settings?.goal_detection_pct || this.defaults.goal_detection_pct;
    
    // --- Track min price during LIVE phase (lightweight, in-memory only) ---
    // This ensures we capture the best price even if trade exits early due to 2nd goal
    if (backPrice && state.entry_price) {
      // Update min price if current price is better
      if (!state.min_post_entry_price || backPrice < state.min_post_entry_price) {
        state.min_post_entry_price = backPrice;
        
        // Calculate time since entry (seconds)
        if (state.position_entered_at) {
          state.time_at_min_price = Math.floor((Date.now() - state.position_entered_at) / 1000);
        }
        
        // Calculate max potential profit %
        // Profit % = ((entry_price - current_price) / current_price) * 100
        const maxProfit = ((state.entry_price - backPrice) / backPrice) * 100;
        if (maxProfit > (state.max_potential_profit_pct || 0)) {
          state.max_potential_profit_pct = maxProfit;
        }
      }
    }
    
    // Continue logging price snapshots at t+90/120 (may have started in GOAL_WAIT)
    const snapshotLogged = await this.logGoalPriceSnapshots(trade, state, backPrice, layPrice);
    if (snapshotLogged) {
      await this.updateTrade(trade.id, { state_data: state });
    }
    
    // CRITICAL FIX (ISSUE 1): Cancel unmatched back bets after timeout period
    const unmatchedBetTimeoutMs = 60000; // 60 seconds timeout for unmatched bets
    const now = Date.now();
    
    // Check original back bet
    const originalBackBetId = state.back_bet_id || trade.back_order_ref;
    if (originalBackBetId && state.entry_time) {
      const backBetAge = now - state.entry_time;
      if (backBetAge > unmatchedBetTimeoutMs) {
        const backOrderDetails = await this.getOrderDetailsSafe(originalBackBetId, sessionToken, 'check-unmatched-back');
        if (backOrderDetails && backOrderDetails.sizeRemaining > 0) {
          this.logger.log(`[strategy:${STRATEGY_KEY}] ⚠️ Original back bet ${originalBackBetId} still has unmatched portion (£${backOrderDetails.sizeRemaining}) after ${(backBetAge/1000).toFixed(0)}s - cancelling`);
          const cancelRes = await this.cancelOrderAndConfirm(originalBackBetId, market.marketId, sessionToken, 'cancel-unmatched-back-timeout', {
            confirmMs: 20000,
            pollMs: 500,
            maxCancelAttempts: 4,
            notFoundThreshold: 3,
          });
          if (!cancelRes.closed) {
            this.logger.error(`[strategy:${STRATEGY_KEY}] ❌ Cancel NOT CONFIRMED for original back ${originalBackBetId} (remaining≈£${cancelRes.last_details?.sizeRemaining || backOrderDetails.sizeRemaining})`);
            await this.logEvent(trade.id, 'BACK_CANCEL_NOT_CONFIRMED_TIMEOUT', {
              bet_id: originalBackBetId,
              attempts: cancelRes.attempts,
              elapsed_ms: cancelRes.elapsed_ms,
              last_status: cancelRes.last_details?.status || backOrderDetails.status || null,
              last_remaining: cancelRes.last_details?.sizeRemaining || backOrderDetails.sizeRemaining || null,
              timestamp: new Date().toISOString(),
            });
          }
          await this.logEvent(trade.id, 'BACK_CANCELLED_TIMEOUT', {
            bet_id: originalBackBetId,
            unmatched_size: backOrderDetails.sizeRemaining,
            age_seconds: Math.round(backBetAge / 1000),
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
    
    // Check retry back bets
    if (state.retry_back_bet_ids && Array.isArray(state.retry_back_bet_ids)) {
      const betsToRemove = [];
      for (const retryBet of state.retry_back_bet_ids) {
        const retryBetAge = now - retryBet.placedAt;
        if (retryBetAge > unmatchedBetTimeoutMs) {
          const retryOrderDetails = await this.getOrderDetailsSafe(retryBet.betId, sessionToken, 'check-unmatched-retry');
          if (retryOrderDetails) {
            if (retryOrderDetails.sizeRemaining > 0) {
              this.logger.log(`[strategy:${STRATEGY_KEY}] ⚠️ Retry back bet ${retryBet.betId} still has unmatched portion (£${retryOrderDetails.sizeRemaining}) after ${(retryBetAge/1000).toFixed(0)}s - cancelling`);
              const retryCancelRes = await this.cancelOrderAndConfirm(retryBet.betId, market.marketId, sessionToken, 'cancel-unmatched-retry-timeout', {
                confirmMs: 20000,
                pollMs: 500,
                maxCancelAttempts: 4,
                notFoundThreshold: 3,
              });
              if (!retryCancelRes.closed) {
                this.logger.error(`[strategy:${STRATEGY_KEY}] ❌ Cancel NOT CONFIRMED for retry back ${retryBet.betId} (remaining≈£${retryCancelRes.last_details?.sizeRemaining || retryOrderDetails.sizeRemaining})`);
                await this.logEvent(trade.id, 'RETRY_BACK_CANCEL_NOT_CONFIRMED_TIMEOUT', {
                  bet_id: retryBet.betId,
                  attempts: retryCancelRes.attempts,
                  elapsed_ms: retryCancelRes.elapsed_ms,
                  last_status: retryCancelRes.last_details?.status || retryOrderDetails.status || null,
                  last_remaining: retryCancelRes.last_details?.sizeRemaining || retryOrderDetails.sizeRemaining || null,
                  timestamp: new Date().toISOString(),
                });
              }
              await this.logEvent(trade.id, 'RETRY_BACK_CANCELLED_TIMEOUT', {
                bet_id: retryBet.betId,
                unmatched_size: retryOrderDetails.sizeRemaining,
                age_seconds: Math.round(retryBetAge / 1000),
                timestamp: new Date().toISOString(),
              });
            }
            // Remove from tracking if fully matched or cancelled
            if (retryOrderDetails.status === 'EXECUTION_COMPLETE' || retryOrderDetails.sizeRemaining === 0) {
              betsToRemove.push(retryBet.betId);
            }
          } else {
            // Order not found - remove from tracking
            betsToRemove.push(retryBet.betId);
          }
        }
      }
      // Clean up tracked bets
      if (betsToRemove.length > 0) {
        state.retry_back_bet_ids = state.retry_back_bet_ids.filter(b => !betsToRemove.includes(b.betId));
        await this.updateTrade(trade.id, { state_data: state });
      }
    }
    
    const entryPrice = state.entry_price;
    const layBetId = state.lay_bet_id || trade.lay_order_ref;
    
    // Check if lay order has matched (profit target reached)
    if (layBetId) {
      // CRITICAL FIX: Verify ACTUAL matched size, not just status
      const orderDetails = await this.getOrderDetailsSafe(layBetId, sessionToken, 'live-verify-lay');
      
      if (!orderDetails) {
        // Lay order not found - might be cancelled due to suspension
        this.logger.warn(`[strategy:${STRATEGY_KEY}] ⚠️ Lay order ${layBetId} NOT FOUND - checking exposure`);
        
        const backMatched = trade.back_matched_size || trade.back_stake || trade.back_size || 0;
        if (backMatched > 0 && !state.emergency_hedge_attempted) {
          this.logger.warn(`[strategy:${STRATEGY_KEY}] ⚠️ EXPOSED: £${backMatched} back matched, lay disappeared - placing emergency hedge`);
          state.emergency_hedge_attempted = true;
          await this.placeEmergencyHedge(trade, state, backMatched, sessionToken, market);
        }
        return;
      }
      
      // Check if lay was cancelled/lapsed
      if (orderDetails.status !== 'EXECUTABLE' && orderDetails.status !== 'EXECUTION_COMPLETE') {
        this.logger.warn(`[strategy:${STRATEGY_KEY}] Lay order status: ${orderDetails.status} - may have been cancelled`);
        
        if (orderDetails.sizeMatched > 0) {
          // Partial lay match - settle with what matched
          this.logger.log(`[strategy:${STRATEGY_KEY}] Lay partially matched £${orderDetails.sizeMatched} before cancel`);
          await this.settleTradeWithPnl(trade, state, 'PARTIAL_LAY', {
            layPrice: orderDetails.averagePriceMatched,
            layStake: orderDetails.sizeMatched,
          });
        } else if (!state.emergency_hedge_attempted) {
          // No lay matched - need emergency hedge
          const backMatched = trade.back_matched_size || trade.back_stake || 0;
          state.emergency_hedge_attempted = true;
          await this.placeEmergencyHedge(trade, state, backMatched, sessionToken, market);
        }
        return;
      }
      
      if (orderDetails.status === 'EXECUTION_COMPLETE' || (orderDetails.sizeMatched > 0 && orderDetails.sizeRemaining === 0)) {
        // Verify actual matched size
        const actualMatchedSize = orderDetails.sizeMatched || 0;
        const layMatchedPrice = orderDetails.averagePriceMatched || state.target_lay_price || trade.lay_price;
        
        const layMatchedAt = Date.now();
        
        // Calculate exposure time: time from back matched to lay matched (can't be negative)
        // For goalreact, both are in-play so it's simply: lay_matched - back_matched
        const exposureSeconds = state.position_entered_at 
          ? Math.max(0, Math.floor((layMatchedAt - state.position_entered_at) / 1000))
          : null;
        
        this.logger.log(`[strategy:${STRATEGY_KEY}] 🏆 WIN! Lay verified matched: £${actualMatchedSize} @ ${layMatchedPrice}`);
        this.logger.log(`[strategy:${STRATEGY_KEY}]   📊 EXPOSURE TIME: ${exposureSeconds != null ? `${exposureSeconds}s (${(exposureSeconds / 60).toFixed(1)} mins)` : 'N/A'}`);
        
        state.phase = PHASE.COMPLETED;
        state.exit_price = layMatchedPrice;
        state.exit_time = layMatchedAt;
        state.exit_reason = 'PROFIT_TARGET';
        state.exposure_time_seconds = exposureSeconds;
        
        await this.settleTradeWithPnl(trade, state, 'WIN', { 
          layPrice: layMatchedPrice, 
          layStake: actualMatchedSize,
          exposureTimeSeconds: exposureSeconds,
        });
        await this.logEvent(trade.id, 'PROFIT_TARGET_HIT', { 
          entry_price: entryPrice,
          exit_price: layMatchedPrice,
          lay_matched_verified: actualMatchedSize,
          lay_bet_id: layBetId,
          exposure_time_seconds: exposureSeconds,
          timestamp: new Date(layMatchedAt).toISOString(),
        });
        return;
      }
    } else if (state.lay_failed) {
      // Lay placement failed earlier - try emergency hedge
      const backMatched = trade.back_matched_size || trade.back_stake || 0;
      if (backMatched > 0 && !state.emergency_hedge_attempted) {
        this.logger.warn(`[strategy:${STRATEGY_KEY}] Retrying hedge for exposed position (£${backMatched})`);
        state.emergency_hedge_attempted = true;
        await this.placeEmergencyHedge(trade, state, backMatched, sessionToken, market);
        return;
      }
    }

    // Check for 2nd goal (30% spike from current stable price)
    const lastStablePrice = state.last_stable_price || entryPrice;
    const spikeFromStable = ((backPrice - lastStablePrice) / lastStablePrice) * 100;
    
    if (spikeFromStable >= goalDetectionPct) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] ⚠️ 2ND GOAL DETECTED! Spike: ${spikeFromStable.toFixed(1)}%`);
      
      // CRITICAL FIX (ISSUE 2): Cancel existing lay order and verify cancellation succeeded
      if (layBetId) {
        this.logger.log(`[strategy:${STRATEGY_KEY}] Cancelling profit lay order ${layBetId} due to 2nd goal`);
        
        // Cancel the lay order
        await this.cancelOrderSafe(layBetId, market.marketId, sessionToken, 'cancel-lay-2nd-goal');
        
        // CRITICAL: Wait briefly then verify cancellation succeeded
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for cancellation to process
        
        const orderDetails = await this.getOrderDetailsSafe(layBetId, sessionToken, 'verify-lay-after-2nd-goal');
        const expectedLaySize = state.lay_snapshot?.stake || trade.lay_size || 0;
        
        if (orderDetails) {
          const matchedSize = orderDetails.sizeMatched || 0;
          const matchedPrice = orderDetails.averagePriceMatched || state.target_lay_price || trade.lay_price;
          
          // Check if cancellation actually succeeded
          if (orderDetails.status === 'EXECUTABLE' && orderDetails.sizeRemaining > 0) {
            // Cancellation failed - retry cancellation
            this.logger.warn(`[strategy:${STRATEGY_KEY}] ⚠️ Lay order ${layBetId} still executable after cancel - retrying cancellation`);
            await this.cancelOrderSafe(layBetId, market.marketId, sessionToken, 'cancel-lay-2nd-goal-retry');
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Check again
            const retryCheck = await this.getOrderDetailsSafe(layBetId, sessionToken, 'verify-lay-after-retry-cancel');
            if (retryCheck && retryCheck.status === 'EXECUTABLE' && retryCheck.sizeRemaining > 0) {
              this.logger.error(`[strategy:${STRATEGY_KEY}] ❌ CRITICAL: Lay order ${layBetId} FAILED to cancel after 2 attempts - manual intervention required!`);
              await this.logEvent(trade.id, 'LAY_CANCEL_FAILED', {
                lay_bet_id: layBetId,
                remaining_size: retryCheck.sizeRemaining,
                timestamp: new Date().toISOString(),
              });
            }
          }
          
          // Scenario 1: Fully matched - trade is complete with profit!
          if (orderDetails.status === 'EXECUTION_COMPLETE' || (matchedSize > 0 && orderDetails.sizeRemaining === 0)) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] 🏆 LAY WAS FULLY MATCHED during 2nd goal! £${matchedSize} @ ${matchedPrice} - settling as WIN`);
            
            state.phase = PHASE.COMPLETED;
            state.exit_price = matchedPrice;
            state.exit_time = Date.now();
            state.exit_reason = 'PROFIT_TARGET_DURING_GOAL';
            
            await this.settleTradeWithPnl(trade, state, 'WIN', { layPrice: matchedPrice, layStake: matchedSize });
            await this.logEvent(trade.id, 'LAY_MATCHED_DURING_GOAL', {
              lay_bet_id: layBetId,
              matched_size: matchedSize,
              matched_price: matchedPrice,
              goal_number: 2,
              timestamp: new Date().toISOString(),
            });
            return;
          }
          
          // Scenario 2: Partially matched - record partial match, continue to stop-loss for remaining
          if (matchedSize > 0 && matchedSize < expectedLaySize) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] ⚠️ LAY PARTIALLY MATCHED: £${matchedSize} of £${expectedLaySize} @ ${matchedPrice}`);
            this.logger.log(`[strategy:${STRATEGY_KEY}]   Remaining unhedged exposure: £${(expectedLaySize - matchedSize).toFixed(2)} - proceeding to stop-loss`);
            
            // Store partial match info for stop-loss calculation
            state.partial_lay_matched = matchedSize;
            state.partial_lay_price = matchedPrice;
            
            await this.logEvent(trade.id, 'LAY_PARTIAL_MATCH_ON_GOAL', {
              lay_bet_id: layBetId,
              matched_size: matchedSize,
              expected_size: expectedLaySize,
              matched_price: matchedPrice,
              remaining_exposure: expectedLaySize - matchedSize,
              goal_number: 2,
              timestamp: new Date().toISOString(),
            });
            // Continue to stop-loss below
          } else {
            // Scenario 3: Not matched at all - full exposure remains
            this.logger.log(`[strategy:${STRATEGY_KEY}] Lay order cancelled successfully (no matches) - full exposure remains`);
          }
        } else {
          // Order not found - likely cancelled successfully
          this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ Lay order ${layBetId} not found after cancel - cancellation verified`);
        }
      }
      
      // CRITICAL FIX (ISSUE 2): Move to STOP_LOSS_WAIT to wait 90s for market to settle
      // After 90s wait, we'll set baseline and place stop loss bet at calculated price (20% below baseline)
      this.logger.log(`[strategy:${STRATEGY_KEY}] ⚠️ 2ND GOAL DETECTED - waiting 90s for market to settle before placing stop loss`);
      
      state.phase = PHASE.STOP_LOSS_WAIT;
      state.second_goal_spike_at = Date.now();
      state.second_goal_spike_price = backPrice;
      state.goal_number = 2;
      
      await this.updateTrade(trade.id, { 
        status: 'stop_loss_wait',
        state_data: state,
      });
      await this.logEvent(trade.id, 'SECOND_GOAL_DETECTED', { 
        spike_price: backPrice,
        last_stable_price: lastStablePrice,
        spike_pct: spikeFromStable,
        partial_lay_matched: state.partial_lay_matched || 0,
        partial_lay_price: state.partial_lay_price || 0,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Update stable price (gradual drift tracking)
    state.last_stable_price = backPrice;
    await this.updateTrade(trade.id, { state_data: state });
  }

  async handleStopLossWait(trade, state, backPrice, layPrice, sessionToken, market) {
    const waitSeconds = this.settings?.wait_after_goal_seconds || this.defaults.wait_after_goal_seconds;
    
    const elapsed = (Date.now() - state.second_goal_spike_at) / 1000;
    
    if (elapsed < waitSeconds) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] STOP_LOSS_WAIT: ${elapsed.toFixed(0)}s / ${waitSeconds}s, price: ${backPrice}`);
      return;
    }

    // Record settled price and move to STOP_LOSS_ACTIVE
    state.phase = PHASE.STOP_LOSS_ACTIVE;
    state.stop_loss_baseline = backPrice;
    
    await this.updateTrade(trade.id, { 
      status: 'stop_loss_active',
      state_data: state,
    });
    await this.logEvent(trade.id, 'STOP_LOSS_BASELINE_SET', { 
      settled_price: backPrice,
      timestamp: new Date().toISOString(),
    });
    
    this.logger.log(`[strategy:${STRATEGY_KEY}] Stop loss baseline set @ ${backPrice}`);
  }

  async handleStopLossActive(trade, state, backPrice, layPrice, sessionToken, market) {
    const stopLossPct = this.settings?.stop_loss_pct || this.defaults.stop_loss_pct;
    const baseline = state.stop_loss_baseline;
    
    if (!baseline) {
      this.logger.warn(`[strategy:${STRATEGY_KEY}] ⚠️ No stop loss baseline set - cannot place stop loss bet`);
      return;
    }
    
    // CRITICAL FIX (ISSUE 2): Place stop loss bet immediately at calculated price (20% below baseline)
    // After 90s wait, baseline is set - now place stop loss bet at baseline * (1 - stopLossPct/100)
    if (!state.stop_loss_lay_placed) {
      // Calculate stop loss price: baseline * (1 - stopLossPct/100)
      // Example: baseline=3.0, stopLossPct=20% → stopLossPrice = 3.0 * 0.8 = 2.4
      const stopLossPrice = roundToBetfairTick(baseline * (1 - stopLossPct / 100));
      
      this.logger.log(`[strategy:${STRATEGY_KEY}] 🛑 Placing stop loss bet at calculated price: ${stopLossPrice} (baseline: ${baseline}, ${stopLossPct}% below)`);
      
      const fullBackStake = trade.back_stake || trade.back_size;
      const entryPrice = state.entry_price;
      const commission = this.settings?.commission_rate || this.defaults.commission_rate;
      
      // Check for partial lay match from cancelled profit target (2nd goal scenario)
      const partialLayMatched = state.partial_lay_matched || 0;
      const partialLayPrice = state.partial_lay_price || 0;
      
      // Calculate remaining unhedged back exposure
      let remainingBackExposure = fullBackStake;
      if (partialLayMatched > 0 && partialLayPrice > 0) {
        const hedgedBackAmount = (partialLayMatched * partialLayPrice) / entryPrice;
        remainingBackExposure = fullBackStake - hedgedBackAmount;
        this.logger.log(`[strategy:${STRATEGY_KEY}] Partial lay already hedged £${hedgedBackAmount.toFixed(2)} of back`);
        this.logger.log(`[strategy:${STRATEGY_KEY}] Remaining unhedged exposure: £${remainingBackExposure.toFixed(2)} (of £${fullBackStake})`);
      }
      
      // Calculate lay stake for remaining exposure at stop loss price
      const { layStake } = calculateLayStake({
        backStake: remainingBackExposure,
        backPrice: entryPrice,
        layPrice: stopLossPrice,
        commission,
      });
      
      this.logger.log(`[strategy:${STRATEGY_KEY}] Placing stop-loss LAY: £${layStake.toFixed(2)} @ ${stopLossPrice} (${stopLossPct}% below baseline ${baseline})`);
      
      const layRes = await this.placeLimitOrderSafe(
        market.marketId,
        market.selectionId,
        'LAY',
        layStake,
        stopLossPrice,
        sessionToken,
        'goalreact-stoploss'
      );
      
      if (layRes.status === 'SUCCESS') {
        state.stop_loss_lay_placed = true;
        state.stop_loss_lay_bet_id = layRes.betId;
        state.stop_loss_lay_stake = layStake;
        state.stop_loss_lay_price = stopLossPrice;
        
        await this.updateTrade(trade.id, {
          state_data: state,
          lay_order_ref: layRes.betId,
          lay_price: stopLossPrice,
          lay_size: layStake,
          lay_placed_at: new Date().toISOString(),
        });
        
        await this.logEvent(trade.id, 'STOP_LOSS_LAY_PLACED', {
          lay_bet_id: layRes.betId,
          lay_price: stopLossPrice,
          lay_stake: layStake,
          baseline_price: baseline,
          stop_loss_pct: stopLossPct,
          remaining_exposure: remainingBackExposure,
          full_back_stake: fullBackStake,
          partial_lay_matched: partialLayMatched,
          timestamp: new Date().toISOString(),
        });
        
        this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ Stop loss lay placed: ${layRes.betId} @ ${stopLossPrice} (${stopLossPct}% below baseline)`);
      } else {
        this.logger.error(`[strategy:${STRATEGY_KEY}] ❌ Stop-loss LAY FAILED: ${layRes.errorCode} - POSITION STILL EXPOSED!`);
        await this.logEvent(trade.id, 'STOP_LOSS_LAY_FAILED', {
          errorCode: layRes.errorCode,
          attempted_stake: layStake,
          attempted_price: stopLossPrice,
          baseline: baseline,
          stop_loss_pct: stopLossPct,
          timestamp: new Date().toISOString(),
        });
        // Don't return - continue to monitor and retry if needed
      }
    }
    
    // Check if stop loss lay has matched (exit condition)
    if (state.stop_loss_lay_bet_id) {
      const stopLossLayDetails = await this.getOrderDetailsSafe(state.stop_loss_lay_bet_id, sessionToken, 'check-stop-loss-lay');
      if (stopLossLayDetails) {
        if (stopLossLayDetails.status === 'EXECUTION_COMPLETE' || (stopLossLayDetails.sizeMatched > 0 && stopLossLayDetails.sizeRemaining === 0)) {
          // Stop loss lay matched - trade complete
          const matchedSize = stopLossLayDetails.sizeMatched || state.stop_loss_lay_stake || 0;
          const matchedPrice = stopLossLayDetails.averagePriceMatched || state.stop_loss_lay_price || backPrice;
          
          const layMatchedAt = Date.now();
          
          // Calculate exposure time: time from back matched to lay matched (can't be negative)
          const exposureSeconds = state.position_entered_at 
            ? Math.max(0, Math.floor((layMatchedAt - state.position_entered_at) / 1000))
            : null;
          
          this.logger.log(`[strategy:${STRATEGY_KEY}] 🏁 Stop loss lay MATCHED: £${matchedSize} @ ${matchedPrice} - trade complete`);
          this.logger.log(`[strategy:${STRATEGY_KEY}]   📊 EXPOSURE TIME: ${exposureSeconds != null ? `${exposureSeconds}s (${(exposureSeconds / 60).toFixed(1)} mins)` : 'N/A'}`);
          
          state.phase = PHASE.COMPLETED;
          state.exit_price = matchedPrice;
          state.exit_time = layMatchedAt;
          state.exit_reason = 'STOP_LOSS';
          state.exposure_time_seconds = exposureSeconds;
          
          const partialLayMatched = state.partial_lay_matched || 0;
          const partialLayPrice = state.partial_lay_price || 0;
          
          await this.settleTradeWithPnl(trade, state, 'STOP_LOSS', {
            layPrice: matchedPrice,
            layStake: matchedSize,
            partialLayMatched,
            partialLayPrice,
            exposureTimeSeconds: exposureSeconds,
          });
          
          await this.logEvent(trade.id, 'STOP_LOSS_COMPLETE', {
            lay_bet_id: state.stop_loss_lay_bet_id,
            matched_size: matchedSize,
            matched_price: matchedPrice,
            exposure_time_seconds: exposureSeconds,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }
    }
    
    // Monitor stop loss bet - log status
    if (baseline) {
      const dropFromBaseline = ((baseline - backPrice) / baseline) * 100;
      const stopLossPrice = state.stop_loss_lay_price || roundToBetfairTick(baseline * (1 - stopLossPct / 100));
      this.logger.log(`[strategy:${STRATEGY_KEY}] STOP_LOSS_ACTIVE: monitoring (baseline: ${baseline}, current: ${backPrice}, stop_loss_price: ${stopLossPrice}, drop: ${dropFromBaseline.toFixed(1)}%)`);
    }
  }

  // --- Post-Trade Shadow Monitoring ---

  /**
   * POST_TRADE_MONITOR phase handler.
   * Monitors price after trade completion/skip to track potential profit milestones.
   * 
   * Tracks:
   * - Max potential profit % and time to reach it
   * - Milestone timestamps: 10%, 15%, 20%, 25%, 30% profit thresholds
   * 
   * Stop conditions:
   * - 2nd goal detected (spike) with 90s confirmation
   * - Market closed
   * - 100 mins elapsed since monitoring started
   */
  async handlePostTradeMonitor(trade, state, backPrice, layPrice, sessionToken, market) {
    const eventName = trade.event_name || trade.event_id || 'Unknown';
    
    // --- Throttle Gate: Shadow monitoring doesn't need high-frequency polling ---
    // During goal spikes, main loop runs every 5s. Shadow trades only need 60s resolution.
    // This prevents API rate limit exhaustion when many shadow trades are active.
    const SHADOW_POLL_COOLDOWN_MS = 60000; // 60 seconds
    const pollCheckTime = Date.now();
    
    if (state.last_shadow_poll_time && (pollCheckTime - state.last_shadow_poll_time) < SHADOW_POLL_COOLDOWN_MS) {
      // Throttled - skip this poll cycle for shadow monitoring
      return;
    }
    
    // Update last poll time (persisted to state for restart resilience)
    state.last_shadow_poll_time = pollCheckTime;
    
    const goalDetectionPct = this.settings?.goal_detection_pct || this.defaults.goal_detection_pct;
    const maxDurationMins = this.settings?.post_trade_monitor_max_duration_minutes || this.defaults.post_trade_monitor_max_duration_minutes;
    
    // --- Determine entry price and time (real vs theoretical) ---
    const entryPrice = state.is_shadow_trade 
      ? state.theoretical_entry_price 
      : (state.entry_price || trade.back_price);
    const entryTime = state.is_shadow_trade 
      ? state.theoretical_entry_time 
      : (state.entry_time || state.monitor_started_at);
    
    if (!entryPrice || !entryTime) {
      this.logger.warn(`[strategy:${STRATEGY_KEY}] POST_TRADE_MONITOR: Missing entry data (price=${entryPrice}, time=${entryTime}) - cannot monitor`);
      await this.finalizeShadowMonitoring(trade, state, 'MISSING_ENTRY_DATA');
      return;
    }
    
    const now = Date.now();
    const elapsedSinceMonitorStart = (now - state.monitor_started_at) / 1000 / 60; // minutes
    
    // --- Stop Condition: Max duration exceeded ---
    if (elapsedSinceMonitorStart >= maxDurationMins) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] POST_TRADE_MONITOR: ${maxDurationMins}min max duration reached - stopping monitoring`);
      await this.finalizeShadowMonitoring(trade, state, 'MAX_DURATION_REACHED');
      return;
    }
    
    // --- Calculate current profit % ---
    // Profit % = ((entry_price - current_price) / current_price) * 100
    // For Under 2.5 backing: price drops = profit
    const profitPct = ((entryPrice - backPrice) / backPrice) * 100;
    const elapsedSeconds = Math.floor((now - entryTime) / 1000);
    
    // --- Track min price (best potential profit) ---
    if (state.min_post_entry_price === null || backPrice < state.min_post_entry_price) {
      state.min_post_entry_price = backPrice;
      state.time_at_min_price = elapsedSeconds;
      
      const maxProfit = ((entryPrice - backPrice) / backPrice) * 100;
      if (maxProfit > state.max_potential_profit_pct) {
        state.max_potential_profit_pct = maxProfit;
      }
    }
    
    // --- Milestone tracking ---
    const milestones = [10, 15, 20, 25, 30];
    if (!state.shadow_milestones) {
      state.shadow_milestones = {};
    }
    
    for (const threshold of milestones) {
      if (profitPct >= threshold && state.shadow_milestones[threshold] === undefined) {
        state.shadow_milestones[threshold] = elapsedSeconds;
        this.logger.log(`[strategy:${STRATEGY_KEY}] 📊 MILESTONE: ${threshold}% profit reached in ${elapsedSeconds}s (price: ${backPrice}, entry: ${entryPrice})`);
        
        await this.logEvent(trade.id, 'SHADOW_MILESTONE_REACHED', {
          threshold_pct: threshold,
          seconds_to_reach: elapsedSeconds,
          current_price: backPrice,
          entry_price: entryPrice,
          profit_pct: Number(profitPct.toFixed(2)),
          is_shadow_trade: state.is_shadow_trade,
          timestamp: new Date().toISOString(),
        });
      }
    }
    
    // --- Check for 2nd goal (spike detection with 90s confirmation) ---
    const lastStablePrice = state.shadow_last_stable_price || entryPrice;
    const spikeFromStable = ((backPrice - lastStablePrice) / lastStablePrice) * 100;
    
    if (spikeFromStable >= goalDetectionPct) {
      // Potential 2nd goal detected
      if (!state.shadow_spike_detected_at) {
        state.shadow_spike_detected_at = now;
        state.shadow_spike_price = backPrice;
        this.logger.log(`[strategy:${STRATEGY_KEY}] POST_TRADE_MONITOR: Potential 2nd goal spike detected (${spikeFromStable.toFixed(1)}%) - waiting 90s to confirm`);
        
        await this.updateTrade(trade.id, { state_data: state });
        return;
      }
      
      // Check if 90s guardrail has passed
      const spikeElapsed = (now - state.shadow_spike_detected_at) / 1000;
      if (spikeElapsed >= 90) {
        // Check if price is still elevated (goal confirmed)
        const stillElevated = ((backPrice - lastStablePrice) / lastStablePrice) * 100 >= goalDetectionPct * 0.7;
        
        if (stillElevated) {
          this.logger.log(`[strategy:${STRATEGY_KEY}] POST_TRADE_MONITOR: 2nd goal confirmed after 90s guardrail - stopping monitoring`);
          await this.finalizeShadowMonitoring(trade, state, 'SECOND_GOAL_CONFIRMED');
          return;
        } else {
          // False alarm - reset spike detection
          this.logger.log(`[strategy:${STRATEGY_KEY}] POST_TRADE_MONITOR: Spike not confirmed (price returned) - continuing monitoring`);
          delete state.shadow_spike_detected_at;
          delete state.shadow_spike_price;
        }
      } else {
        // Still waiting for confirmation
        this.logger.log(`[strategy:${STRATEGY_KEY}] POST_TRADE_MONITOR: Waiting for spike confirmation (${spikeElapsed.toFixed(0)}s / 90s)`);
        await this.updateTrade(trade.id, { state_data: state });
        return;
      }
    } else {
      // No spike - update stable price and clear any pending spike detection
      state.shadow_last_stable_price = backPrice;
      if (state.shadow_spike_detected_at) {
        // Spike cleared before confirmation
        delete state.shadow_spike_detected_at;
        delete state.shadow_spike_price;
      }
    }
    
    // --- Log monitoring status ---
    const tradeType = state.is_shadow_trade ? 'SHADOW' : 'COMPLETED';
    this.logger.log(`[strategy:${STRATEGY_KEY}] POST_TRADE_MONITOR [${tradeType}]: ${eventName} | entry=${entryPrice.toFixed(2)} | current=${backPrice.toFixed(2)} | profit=${profitPct.toFixed(1)}% | max=${state.max_potential_profit_pct?.toFixed(1) || 0}% | elapsed=${elapsedSinceMonitorStart.toFixed(1)}min`);
    
    // --- Persist state ---
    await this.updateTrade(trade.id, { state_data: state });
  }

  /**
   * Finalize shadow monitoring and persist milestone data to flat columns.
   */
  async finalizeShadowMonitoring(trade, state, reason) {
    const eventName = trade.event_name || trade.event_id || 'Unknown';
    
    this.logger.log(`[strategy:${STRATEGY_KEY}] Finalizing shadow monitoring for ${eventName} (reason: ${reason})`);
    
    state.phase = PHASE.COMPLETED;
    state.monitor_ended_at = Date.now();
    state.monitor_end_reason = reason;
    
    // Prepare flat column updates
    const milestones = state.shadow_milestones || {};
    
    const updatePayload = {
      status: 'completed',
      state_data: state,
      // Flat columns for analytics
      min_post_entry_price: state.min_post_entry_price,
      max_potential_profit_pct: state.max_potential_profit_pct ? Number(state.max_potential_profit_pct.toFixed(2)) : null,
      seconds_to_max_profit: state.time_at_min_price,
      seconds_to_10_pct: milestones[10] !== undefined ? milestones[10] : null,
      seconds_to_15_pct: milestones[15] !== undefined ? milestones[15] : null,
      seconds_to_20_pct: milestones[20] !== undefined ? milestones[20] : null,
      seconds_to_25_pct: milestones[25] !== undefined ? milestones[25] : null,
      seconds_to_30_pct: milestones[30] !== undefined ? milestones[30] : null,
    };
    
    // Only set theoretical_entry_price for shadow trades
    if (state.is_shadow_trade && state.theoretical_entry_price) {
      updatePayload.theoretical_entry_price = state.theoretical_entry_price;
    }
    
    await this.updateTrade(trade.id, updatePayload);
    
    await this.logEvent(trade.id, 'SHADOW_MONITORING_COMPLETED', {
      reason,
      is_shadow_trade: state.is_shadow_trade,
      skip_reason: state.skip_reason || null,
      theoretical_entry_price: state.theoretical_entry_price || null,
      entry_price: state.entry_price || trade.back_price || null,
      min_post_entry_price: state.min_post_entry_price,
      max_potential_profit_pct: state.max_potential_profit_pct,
      seconds_to_max_profit: state.time_at_min_price,
      milestones: milestones,
      monitor_duration_seconds: state.monitor_started_at 
        ? Math.floor((Date.now() - state.monitor_started_at) / 1000) 
        : null,
      timestamp: new Date().toISOString(),
    });
    
    this.logger.log(`[strategy:${STRATEGY_KEY}] ═══════════════════════════════════════════════════════════`);
    this.logger.log(`[strategy:${STRATEGY_KEY}] 📊 SHADOW MONITORING COMPLETE: ${eventName}`);
    this.logger.log(`[strategy:${STRATEGY_KEY}] ───────────────────────────────────────────────────────────`);
    this.logger.log(`[strategy:${STRATEGY_KEY}]   Type: ${state.is_shadow_trade ? 'SHADOW (skipped)' : 'COMPLETED TRADE'}`);
    if (state.is_shadow_trade) {
      this.logger.log(`[strategy:${STRATEGY_KEY}]   Skip Reason: ${state.skip_reason || 'N/A'}`);
      this.logger.log(`[strategy:${STRATEGY_KEY}]   Theoretical Entry: ${state.theoretical_entry_price?.toFixed(2) || 'N/A'}`);
    } else {
      this.logger.log(`[strategy:${STRATEGY_KEY}]   Entry Price: ${state.entry_price?.toFixed(2) || trade.back_price?.toFixed(2) || 'N/A'}`);
      this.logger.log(`[strategy:${STRATEGY_KEY}]   Realised P&L: £${state.realised_pnl?.toFixed(2) || 'N/A'}`);
    }
    this.logger.log(`[strategy:${STRATEGY_KEY}]   Min Price: ${state.min_post_entry_price?.toFixed(2) || 'N/A'}`);
    this.logger.log(`[strategy:${STRATEGY_KEY}]   Max Profit: ${state.max_potential_profit_pct?.toFixed(1) || 0}%`);
    this.logger.log(`[strategy:${STRATEGY_KEY}]   Time to Max: ${state.time_at_min_price || 'N/A'}s`);
    this.logger.log(`[strategy:${STRATEGY_KEY}] ───────────────────────────────────────────────────────────`);
    this.logger.log(`[strategy:${STRATEGY_KEY}]   MILESTONES:`);
    for (const pct of [10, 15, 20, 25, 30]) {
      const time = milestones[pct];
      const status = time !== undefined ? `${time}s` : '---';
      this.logger.log(`[strategy:${STRATEGY_KEY}]     ${pct}%: ${status}`);
    }
    this.logger.log(`[strategy:${STRATEGY_KEY}] ═══════════════════════════════════════════════════════════`);
  }

  // --- Emergency Hedge ---

  /**
   * Emergency hedge when lay order fails/cancelled and we have back exposure
   * Places a market lay at current price to close exposure
   */
  async placeEmergencyHedge(trade, state, backMatched, sessionToken, market) {
    const backPrice = state.entry_price || trade.back_price;
    
    if (backMatched <= 0) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] No back exposure - no emergency hedge needed`);
      return;
    }
    
    const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'emergency-hedge-book');
    const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
    const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;
    
    if (!currentLayPrice) {
      this.logger.error(`[strategy:${STRATEGY_KEY}] ❌ CRITICAL: No lay price for emergency hedge - POSITION FULLY EXPOSED`);
      await this.updateTrade(trade.id, {
        last_error: 'EMERGENCY_HEDGE_FAILED_NO_PRICE',
        state_data: { ...state, emergency_hedge_failed: true },
      });
      await this.logEvent(trade.id, 'EMERGENCY_HEDGE_FAILED', {
        reason: 'NO_LAY_PRICE',
        back_exposure: backMatched,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    
    // Calculate emergency lay stake
    const { layStake } = calculateLayStake({
      backStake: backMatched,
      backPrice,
      layPrice: currentLayPrice,
      commission: this.settings?.commission_rate || this.defaults.commission_rate,
    });
    
    this.logger.log(`[strategy:${STRATEGY_KEY}] 🚨 EMERGENCY HEDGE: Laying £${layStake} @ ${currentLayPrice} to cover £${backMatched} back exposure`);
    
    const placeRes = await this.placeLimitOrderSafe(
      market.marketId,
      market.selectionId,
      'LAY',
      layStake,
      currentLayPrice,
      sessionToken,
      'emergency-hedge'
    );
    
    if (placeRes.status === 'SUCCESS') {
      this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ Emergency hedge placed: ${placeRes.betId}`);
      
      state.lay_bet_id = placeRes.betId;
      state.target_lay_price = currentLayPrice;
      state.emergency_hedge = true;
      
      await this.updateTrade(trade.id, {
        lay_order_ref: placeRes.betId,
        lay_price: currentLayPrice,
        lay_size: layStake,
        lay_placed_at: new Date().toISOString(),
        state_data: state,
        last_error: null,
      });
      
      await this.logEvent(trade.id, 'EMERGENCY_HEDGE_PLACED', {
        betId: placeRes.betId,
        lay_price: currentLayPrice,
        lay_stake: layStake,
        reason: 'ORIGINAL_LAY_FAILED_OR_CANCELLED',
        timestamp: new Date().toISOString(),
      });
    } else {
      this.logger.error(`[strategy:${STRATEGY_KEY}] ❌ Emergency hedge FAILED: ${placeRes.errorCode}`);
      await this.updateTrade(trade.id, {
        last_error: `EMERGENCY_HEDGE_FAILED: ${placeRes.errorCode}`,
        state_data: { ...state, emergency_hedge_failed: true },
      });
      await this.logEvent(trade.id, 'EMERGENCY_HEDGE_FAILED', {
        errorCode: placeRes.errorCode,
        back_exposure: backMatched,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // --- Helpers ---

  async ensureMarketForTrade(trade, sessionToken) {
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
      this.logger.warn(`[strategy:${STRATEGY_KEY}] Market not found for event ${trade.betfair_event_id}`);
      return null;
    }

    const runner = market.runners.find(r => r.runnerName === UNDER_RUNNER_NAME || r.runnerName === 'Under 2.5 Goals');
    if (!runner) {
      this.logger.warn(`[strategy:${STRATEGY_KEY}] Runner not found in market ${market.marketId}`);
      return null;
    }

    await this.updateTrade(trade.id, {
      betfair_market_id: market.marketId,
      selection_id: runner.selectionId,
    });

    return { marketId: market.marketId, selectionId: runner.selectionId };
  }

  async settleTradeWithPnl(trade, state, reason, options = {}) {
    const { layPrice, layStake, partialLayMatched = 0, partialLayPrice = 0, exposureTimeSeconds = null } = options;
    
    const commission = this.settings?.commission_rate || this.defaults.commission_rate;
    // FIX: Use matched sizes as source of truth (actual amounts that were matched)
    const backStake = trade.back_matched_size || trade.back_stake || trade.back_size || 0;
    // CRITICAL FIX: Prioritize trade.back_price (actual matched price) over state.entry_price (order placement price)
    // trade.back_price contains the verified matched price from Betfair, which is the source of truth for P&L
    const backPrice = trade.back_price || state.entry_price || 0;
    const eventName = trade.event_name || trade.event_id || 'Unknown';
    
    // Calculate aggregate lay position (partial match + main lay)
    // This handles the scenario where partial lay matched during 2nd goal cancellation
    // FIX: Use matched size as source of truth, fallback to parameter or trade record
    let aggregateLayStake = layStake || trade.lay_matched_size || trade.lay_size || 0;
    let aggregateLayPrice = layPrice || trade.lay_price || 0;
    
    if (partialLayMatched > 0 && partialLayPrice > 0) {
      // Combine partial match with stop-loss lay
      const totalLayStake = partialLayMatched + (layStake || 0);
      
      if (totalLayStake > 0) {
        // Weighted average price
        aggregateLayPrice = (
          (partialLayMatched * partialLayPrice) + ((layStake || 0) * (layPrice || 0))
        ) / totalLayStake;
        aggregateLayStake = totalLayStake;
      }
      
      this.logger.log(`[strategy:${STRATEGY_KEY}] Aggregating lay positions:`);
      this.logger.log(`[strategy:${STRATEGY_KEY}]   Partial: £${partialLayMatched.toFixed(2)} @ ${partialLayPrice.toFixed(2)}`);
      this.logger.log(`[strategy:${STRATEGY_KEY}]   Stop-loss: £${(layStake || 0).toFixed(2)} @ ${(layPrice || 0).toFixed(2)}`);
      this.logger.log(`[strategy:${STRATEGY_KEY}]   Aggregate: £${aggregateLayStake.toFixed(2)} @ ${aggregateLayPrice.toFixed(2)} (weighted avg)`);
    }
    
    // Validation logging
    this.logger.log(`[strategy:${STRATEGY_KEY}] Settlement calc for ${eventName}:`);
    this.logger.log(`[strategy:${STRATEGY_KEY}]   Back: £${backStake} @ ${backPrice}`);
    this.logger.log(`[strategy:${STRATEGY_KEY}]   Lay:  £${aggregateLayStake.toFixed(2)} @ ${aggregateLayPrice.toFixed(2)}`);
    this.logger.log(`[strategy:${STRATEGY_KEY}]   Reason: ${reason}`);
    
    const realised = computeRealisedPnlSnapshot({
      backStake,
      backPrice,
      layStake: aggregateLayStake,
      layPrice: aggregateLayPrice,
      commission,
    });

    // Handle null P&L (lay not matched)
    if (realised === null) {
      this.logger.warn(`[strategy:${STRATEGY_KEY}] ⚠️ Cannot calculate P&L - lay data missing`);
    }

    // Calculate final exposure time if not provided (can't be negative)
    const finalExposureTimeSeconds = exposureTimeSeconds ?? (
      state.position_entered_at 
        ? Math.max(0, Math.floor((Date.now() - state.position_entered_at) / 1000))
        : null
    );

    // Initialize shadow monitoring for post-trade analytics
    this.initializeShadowMonitoring(state, {
      theoreticalEntryPrice: backPrice,  // Use actual entry price for completed trades
      isSkippedTrade: false,
      skipReason: null,
    });
    state.exit_reason = reason;
    state.realised_pnl = realised;
    
    await this.updateTrade(trade.id, {
      status: 'post_trade_monitor',  // Continue to shadow monitoring
      state_data: state,
      lay_price: aggregateLayPrice || null,
      lay_size: aggregateLayStake || null,
      lay_matched_size: aggregateLayStake || null,
      realised_pnl: realised,  // May be null
      pnl: realised,
      settled_at: new Date().toISOString(),
      total_stake: backStake + aggregateLayStake,
      exposure_time_seconds: finalExposureTimeSeconds,
      last_error: reason === 'MARKET_CLOSED' ? reason : null,
    });

    // Log outcome handling null
    if (realised !== null) {
      const outcomeSymbol = realised >= 0 ? '✓ PROFIT' : '✗ LOSS';
      this.logger.log(`[strategy:${STRATEGY_KEY}] ${outcomeSymbol}: £${realised.toFixed(2)} on ${eventName} (${reason})`);
    } else {
      this.logger.log(`[strategy:${STRATEGY_KEY}] Trade settled: ${reason}, P&L: UNKNOWN (incomplete data)`);
    }
    
    // Log exposure time
    if (finalExposureTimeSeconds != null) {
      this.logger.log(`[strategy:${STRATEGY_KEY}]   📊 EXPOSURE TIME: ${finalExposureTimeSeconds}s (${(finalExposureTimeSeconds / 60).toFixed(1)} mins)`);
    }
    
    // Log trade settled event
    await this.logEvent(trade.id, 'TRADE_SETTLED', {
      realised_pnl: realised,
      back_stake: backStake,
      back_price: backPrice,
      lay_stake: aggregateLayStake,
      lay_price: aggregateLayPrice,
      exposure_time_seconds: finalExposureTimeSeconds,
      exit_reason: reason,
      timestamp: new Date().toISOString(),
    });
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
  PHASE,
  getDefaultSettings,
  createEplUnder25GoalReactStrategy: (deps) => new EplUnder25GoalReactStrategy(deps),
};

