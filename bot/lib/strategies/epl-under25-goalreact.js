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
  isWithinTicks,
  getMiddlePrice,
  createSafeApiWrappers,
  ensureMarket,
} = require('./shared');

const STRATEGY_KEY = 'epl_under25_goalreact';

// --- Strategy Parameters ---
function getDefaultSettings() {
  return {
    // Entry Rules
    default_stake: parseFloat(process.env.GOALREACT_DEFAULT_STAKE || '100'),
    wait_after_goal_seconds: parseInt(process.env.GOALREACT_WAIT_AFTER_GOAL || '90', 10),
    goal_cutoff_minutes: parseInt(process.env.GOALREACT_GOAL_CUTOFF || '45', 10),
    min_entry_price: parseFloat(process.env.GOALREACT_MIN_ENTRY_PRICE || '2.5'),
    max_entry_price: parseFloat(process.env.GOALREACT_MAX_ENTRY_PRICE || '5.0'),
    goal_detection_pct: parseFloat(process.env.GOALREACT_GOAL_DETECTION_PCT || '30'),
    
    // Exit Rules
    profit_target_pct: parseFloat(process.env.GOALREACT_PROFIT_TARGET_PCT || '10'),
    stop_loss_pct: parseFloat(process.env.GOALREACT_STOP_LOSS_PCT || '15'),
    
    // Polling
    in_play_poll_interval_seconds: parseInt(process.env.GOALREACT_POLL_INTERVAL || '30', 10),
    
    // General
    fixture_lookahead_days: parseInt(process.env.GOALREACT_FIXTURE_LOOKAHEAD_DAYS || '7', 10),
    commission_rate: parseFloat(process.env.GOALREACT_COMMISSION_RATE || '0.0175'),
  };
}

// --- Trade Phases ---
const PHASE = {
  WATCHING: 'WATCHING',
  GOAL_WAIT: 'GOAL_WAIT',
  LIVE: 'LIVE',
  STOP_LOSS_WAIT: 'STOP_LOSS_WAIT',
  STOP_LOSS_ACTIVE: 'STOP_LOSS_ACTIVE',
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
    
    // Priority 1: Check for active trades that need monitoring
    const { data: activeTrades } = await this.supabase
      .from('strategy_trades')
      .select('id, status, state_data')
      .eq('strategy_key', STRATEGY_KEY)
      .in('status', ['watching', 'goal_wait', 'live', 'stop_loss_wait', 'stop_loss_active'])
      .limit(1);
    
    if (activeTrades?.length > 0) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] Active trades detected - need immediate polling`);
      return 0;
    }
    
    // Priority 2: Check for games about to kick off
    const { data: upcomingGames } = await this.supabase
      .from('strategy_trades')
      .select('kickoff_at, event_id')
      .eq('strategy_key', STRATEGY_KEY)
      .eq('status', 'scheduled')
      .gt('kickoff_at', new Date().toISOString())
      .order('kickoff_at', { ascending: true })
      .limit(1);
    
    if (upcomingGames?.length > 0) {
      const kickoff = new Date(upcomingGames[0].kickoff_at).getTime();
      const delay = kickoff - now;
      
      // Wake up at kickoff time (delay <= 0 means game has started or starting now)
      if (delay <= 0) {
        this.logger.log(`[strategy:${STRATEGY_KEY}] Game KICKOFF - begin watching for goals`);
        return 0;
      }
      
      // Sleep until kickoff, capped between 1 minute and 24 hours
      const cappedDelay = Math.max(60 * 1000, Math.min(delay, 24 * 60 * 60 * 1000));
      this.logger.log(`[strategy:${STRATEGY_KEY}] Next kickoff in ${(cappedDelay / 60000).toFixed(1)} min - sleeping until then`);
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

  startActivePolling() {
    if (this.activePollingTimer) return;
    
    const pollInterval = (this.settings?.in_play_poll_interval_seconds || this.defaults.in_play_poll_interval_seconds) * 1000;
    this.logger.log(`[strategy:${STRATEGY_KEY}] ▶ STARTING active ${pollInterval / 1000}s polling`);
    
    this.activePollingTimer = setInterval(() => {
      this.processInPlayGames('poll').catch(this.logError('processInPlayGames'));
    }, pollInterval);
    
    // Run immediately
    this.processInPlayGames('immediate').catch(this.logError('processInPlayGames'));
  }

  stopActivePolling() {
    if (this.activePollingTimer) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] ⏸ STOPPING active polling`);
      clearInterval(this.activePollingTimer);
      this.activePollingTimer = null;
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
      this.settings = { ...data, ...data.extra };
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

      let competitionIds = matchedCompetitions.map((c) => c.competition?.id).filter(Boolean);
      if (competitionIds.length === 0) {
        competitionIds = COMPETITION_IDS;
      }

      // Get events
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

      this.logger.log(`[strategy:${STRATEGY_KEY}] Fixtures sync found ${eventsRes?.length || 0} events`);

      // Build competition name map
      const competitionIdToName = new Map();
      matchedCompetitions.forEach(c => {
        if (c.competition?.id && c.competition?.name) {
          competitionIdToName.set(String(c.competition.id), c.competition.name);
        }
      });

      const fixtures = (eventsRes || []).map((evt) => {
        const eventName = evt.event?.name || '';
        const parts = eventName.split(' v ');
        return {
          strategy_key: STRATEGY_KEY,
          betfair_event_id: evt.event?.id,
          event_id: evt.event?.id,
          competition: 'Multiple Leagues',
          home: parts[0]?.trim() || null,
          away: parts[1]?.trim() || null,
          kickoff_at: evt.event?.openDate,
          metadata: evt,
        };
      }).filter(f => f.betfair_event_id);

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
    const { data: existing } = await this.supabase
      .from('strategy_trades')
      .select('id, status')
      .eq('strategy_key', STRATEGY_KEY)
      .eq('betfair_event_id', fixture.betfair_event_id)
      .maybeSingle();
    
    if (existing) return existing.id;

    const competitionName = fixture.competition || 'Unknown';
    const eventName = formatFixtureName(fixture.home, fixture.away, fixture.event_id);

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
      
      // Get all games that should be monitored (scheduled + in-play phases)
      const { data: trades, error } = await this.supabase
        .from('strategy_trades')
        .select('*')
        .eq('strategy_key', STRATEGY_KEY)
        .in('status', ['scheduled', 'watching', 'goal_wait', 'live', 'stop_loss_wait', 'stop_loss_active'])
        .order('kickoff_at', { ascending: true });

      if (error) throw error;

      if (!trades || trades.length === 0) {
        this.logger.log(`[strategy:${STRATEGY_KEY}] No trades in database - stopping polling`);
        this.stopActivePolling();
        setImmediate(() => this.smartSchedulerLoop());
        return;
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
    
    const sessionToken = await this.requireSessionWithRetry(`sm-${phase}`);
    const market = await this.ensureMarketForTrade(trade, sessionToken);
    if (!market) return;

    const book = await this.getMarketBookSafe(market.marketId, sessionToken, `${phase}-book`);
    if (!book) return;

    // Check if market closed
    if (book.status === 'CLOSED') {
      await this.settleTradeWithPnl(trade, state, 'MARKET_CLOSED');
      return;
    }

    const runner = book.runners?.find(r => r.selectionId == market.selectionId);
    const currentBackPrice = runner?.ex?.availableToBack?.[0]?.price;
    const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;

    if (!currentBackPrice || !currentLayPrice) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] No prices available for ${trade.event_name}`);
      return;
    }

    switch (phase) {
      case PHASE.WATCHING:
        await this.handleWatching(trade, state, currentBackPrice, currentLayPrice, minsFromKickoff, sessionToken, market);
        break;
      case PHASE.GOAL_WAIT:
        await this.handleGoalWait(trade, state, currentBackPrice, currentLayPrice, sessionToken, market);
        break;
      case PHASE.LIVE:
        await this.handleLive(trade, state, currentBackPrice, currentLayPrice, sessionToken, market);
        break;
      case PHASE.STOP_LOSS_WAIT:
        await this.handleStopLossWait(trade, state, currentBackPrice, currentLayPrice, sessionToken, market);
        break;
      case PHASE.STOP_LOSS_ACTIVE:
        await this.handleStopLossActive(trade, state, currentBackPrice, currentLayPrice, sessionToken, market);
        break;
    }
  }

  // --- Phase Handlers ---

  async handleWatching(trade, state, backPrice, layPrice, minsFromKickoff, sessionToken, market) {
    const goalCutoff = this.settings?.goal_cutoff_minutes || this.defaults.goal_cutoff_minutes;
    const goalDetectionPct = this.settings?.goal_detection_pct || this.defaults.goal_detection_pct;

    // Initialize baseline if not set - this is the transition from scheduled → watching
    if (!state.baseline_price) {
      state.baseline_price = backPrice;
      state.last_price = backPrice;
      
      const eventName = trade.event_name || trade.event_id || 'Unknown';
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

    // Check for goal (30% price spike)
    const priceChange = ((backPrice - state.baseline_price) / state.baseline_price) * 100;
    
    if (priceChange >= goalDetectionPct) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] 🎯 GOAL DETECTED! Price spike: ${priceChange.toFixed(1)}% (${state.baseline_price} → ${backPrice})`);
      
      // Check if goal is after cutoff
      if (minsFromKickoff > goalCutoff) {
        this.logger.log(`[strategy:${STRATEGY_KEY}] Goal after ${goalCutoff}min cutoff (at ${minsFromKickoff.toFixed(0)}min) - SKIPPING`);
        state.phase = PHASE.SKIPPED;
        await this.updateTrade(trade.id, { 
          status: 'skipped',
          state_data: state,
          last_error: `Goal after ${goalCutoff}min cutoff`,
        });
        await this.logEvent(trade.id, 'GOAL_AFTER_CUTOFF', { 
          mins_from_kickoff: minsFromKickoff,
          cutoff: goalCutoff,
          spike_price: backPrice,
          baseline_price: state.baseline_price,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Move to GOAL_WAIT
      state.phase = PHASE.GOAL_WAIT;
      state.spike_detected_at = Date.now();
      state.spike_price = backPrice;
      state.goal_number = 1;
      
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
        price_change_pct: priceChange,
        mins_from_kickoff: minsFromKickoff,
        timestamp: goalDetectedAt,
      });
      return;
    }

    // Update baseline slowly (to track gradual drift)
    state.last_price = backPrice;
    await this.updateTrade(trade.id, { state_data: state });
  }

  async handleGoalWait(trade, state, backPrice, layPrice, sessionToken, market) {
    const waitSeconds = this.settings?.wait_after_goal_seconds || this.defaults.wait_after_goal_seconds;
    const goalDetectionPct = this.settings?.goal_detection_pct || this.defaults.goal_detection_pct;
    const minEntryPrice = this.settings?.min_entry_price || this.defaults.min_entry_price;
    const maxEntryPrice = this.settings?.max_entry_price || this.defaults.max_entry_price;
    
    const elapsed = (Date.now() - state.spike_detected_at) / 1000;
    
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
    if (backPrice < minEntryPrice || backPrice > maxEntryPrice) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] Price ${backPrice} outside range [${minEntryPrice}, ${maxEntryPrice}] - SKIPPING`);
      state.phase = PHASE.SKIPPED;
      await this.updateTrade(trade.id, { 
        status: 'skipped',
        state_data: state,
        last_error: `Price ${backPrice} outside entry range`,
      });
      await this.logEvent(trade.id, 'PRICE_OUT_OF_RANGE', { 
        current_price: backPrice,
        min_price: minEntryPrice,
        max_price: maxEntryPrice,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check spread (lay should be within 1 tick of back)
    if (!isWithinTicks(backPrice, layPrice, 1)) {
      // Use middle price if spread is wider
      this.logger.log(`[strategy:${STRATEGY_KEY}] Wide spread detected (back: ${backPrice}, lay: ${layPrice}) - using middle price`);
    }

    // Determine entry price
    const entryPrice = isWithinTicks(backPrice, layPrice, 1) ? layPrice : getMiddlePrice(backPrice, layPrice);
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
      this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ ENTERED @ ${entryPrice} - betId: ${placeRes.betId}`);
      
      state.phase = PHASE.LIVE;
      state.entry_price = entryPrice;
      state.entry_time = Date.now();
      state.back_bet_id = placeRes.betId;
      
      await this.updateTrade(trade.id, {
        status: 'live',
        state_data: state,
        back_price: entryPrice,
        back_size: stake,
        back_stake: stake,
        back_order_ref: placeRes.betId,
        back_placed_at: new Date().toISOString(),
        betfair_market_id: market.marketId,
        selection_id: market.selectionId,
      });
      const positionEnteredAt = new Date().toISOString();
      await this.logEvent(trade.id, 'POSITION_ENTERED', { 
        price_entered: entryPrice,
        entry_price: entryPrice,
        stake,
        back_price: backPrice,
        lay_price: layPrice,
        bet_id: placeRes.betId,
        timestamp: positionEnteredAt,
      });
    } else {
      this.logger.error(`[strategy:${STRATEGY_KEY}] Entry failed: ${placeRes.errorCode}`);
      await this.logEvent(trade.id, 'ENTRY_FAILED', { errorCode: placeRes.errorCode });
    }
  }

  async handleLive(trade, state, backPrice, layPrice, sessionToken, market) {
    const profitTargetPct = this.settings?.profit_target_pct || this.defaults.profit_target_pct;
    const goalDetectionPct = this.settings?.goal_detection_pct || this.defaults.goal_detection_pct;
    
    const entryPrice = state.entry_price;
    const priceDropPct = ((entryPrice - backPrice) / entryPrice) * 100;
    
    // Check for WIN (price dropped 10% from entry)
    if (priceDropPct >= profitTargetPct) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] 🏆 WIN! Price dropped ${priceDropPct.toFixed(1)}% (${entryPrice} → ${backPrice})`);
      
      // Exit position - place LAY to close
      const stake = trade.back_stake || trade.back_size;
      const { layStake } = calculateLayStake({
        backStake: stake,
        backPrice: entryPrice,
        layPrice: backPrice,
        commission: this.settings?.commission_rate || this.defaults.commission_rate,
      });
      
      const layRes = await this.placeLimitOrderSafe(
        market.marketId,
        market.selectionId,
        'LAY',
        layStake,
        backPrice,
        sessionToken,
        'goalreact-win-exit'
      );
      
      if (layRes.status === 'SUCCESS') {
        state.phase = PHASE.COMPLETED;
        state.exit_price = backPrice;
        state.exit_time = Date.now();
        state.exit_reason = 'PROFIT_TARGET';
        
        const exitAt = new Date().toISOString();
        await this.settleTradeWithPnl(trade, state, 'WIN', { layPrice: backPrice, layStake });
        await this.logEvent(trade.id, 'PROFIT_TARGET_HIT', { 
          price_entered: entryPrice,
          price_exited: backPrice,
          entry_price: entryPrice,
          exit_price: backPrice,
          profit_pct: priceDropPct,
          lay_bet_id: layRes.betId,
          timestamp: exitAt,
        });
      }
      return;
    }

    // Check for 2nd goal (30% spike from current stable price)
    const lastStablePrice = state.last_stable_price || entryPrice;
    const spikeFromStable = ((backPrice - lastStablePrice) / lastStablePrice) * 100;
    
    if (spikeFromStable >= goalDetectionPct) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] ⚠️ 2ND GOAL DETECTED! Spike: ${spikeFromStable.toFixed(1)}%`);
      
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
    const dropFromBaseline = ((baseline - backPrice) / baseline) * 100;
    
    // Exit when price drops 15% below settled price
    if (dropFromBaseline >= stopLossPct) {
      this.logger.log(`[strategy:${STRATEGY_KEY}] 🛑 STOP LOSS EXIT! Price dropped ${dropFromBaseline.toFixed(1)}% from baseline`);
      
      const stake = trade.back_stake || trade.back_size;
      const entryPrice = state.entry_price;
      const { layStake } = calculateLayStake({
        backStake: stake,
        backPrice: entryPrice,
        layPrice: backPrice,
        commission: this.settings?.commission_rate || this.defaults.commission_rate,
      });
      
      const layRes = await this.placeLimitOrderSafe(
        market.marketId,
        market.selectionId,
        'LAY',
        layStake,
        backPrice,
        sessionToken,
        'goalreact-stoploss-exit'
      );
      
      if (layRes.status === 'SUCCESS') {
        state.phase = PHASE.COMPLETED;
        state.exit_price = backPrice;
        state.exit_time = Date.now();
        state.exit_reason = 'STOP_LOSS';
        
        const stopLossExitAt = new Date().toISOString();
        await this.settleTradeWithPnl(trade, state, 'STOP_LOSS', { layPrice: backPrice, layStake });
        await this.logEvent(trade.id, 'STOP_LOSS_EXIT', { 
          price_entered: state.entry_price,
          price_exited: backPrice,
          entry_price: state.entry_price,
          exit_price: backPrice,
          stop_loss_baseline: baseline,
          drop_pct: dropFromBaseline,
          stop_loss_pct: stopLossPct,
          lay_bet_id: layRes.betId,
          timestamp: stopLossExitAt,
        });
      }
      return;
    }

    this.logger.log(`[strategy:${STRATEGY_KEY}] STOP_LOSS_ACTIVE: waiting for ${stopLossPct}% drop (current: ${dropFromBaseline.toFixed(1)}%)`);
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
    const { layPrice, layStake } = options;
    
    const commission = this.settings?.commission_rate || this.defaults.commission_rate;
    const backStake = trade.back_stake || trade.back_size || 0;
    const backPrice = state.entry_price || trade.back_price || 0;
    
    const realised = computeRealisedPnlSnapshot({
      backStake,
      backPrice,
      layStake: layStake || 0,
      layPrice: layPrice || 0,
      commission,
    });

    await this.updateTrade(trade.id, {
      status: 'completed',
      state_data: state,
      lay_price: layPrice || null,
      lay_size: layStake || null,
      lay_matched_size: layStake || null,
      realised_pnl: realised,
      pnl: realised,
      settled_at: new Date().toISOString(),
      total_stake: backStake + (layStake || 0),
      last_error: reason === 'MARKET_CLOSED' ? reason : null,
    });

    this.logger.log(`[strategy:${STRATEGY_KEY}] Trade settled: ${reason}, P&L: ${realised}`);
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

