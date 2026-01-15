/**
 * EPL Over 2.5 Breakout Strategy
 * 
 * FLOW:
 * 1. WATCHING - Poll games in-play every 15s, detect 1st goal (30% price spike)
 *    - Skip if goal after 70 mins
 *    - Otherwise → GOAL_WAIT
 * 
 * 2. GOAL_WAIT - Wait 60s for price to settle
 *    - ENTER position: BACK at price * (1 + entry_buffer_pct)
 *    - Place STOP LOSS LAY at entry * (1 + stop_loss_drift_pct)
 * 
 * 3. LIVE - Monitor position
 *    - If Stop Loss LAY matches (price drifted up) → LOSS
 *    - If 2nd goal detected (30% spike) → WIN path
 * 
 * 4. WIN PATH - 2nd goal detected
 *    - Check stop loss status (should be auto-cancelled by Betfair on suspension)
 *    - If price > green_up_threshold_price: Green up with LAY
 *    - Otherwise: Let it ride to settlement
 */

const { addDays } = require('date-fns');
const { roundToBetfairTick } = require('../betfair-utils');
const {
    SOCCER_EVENT_TYPE_ID,
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
} = require('./shared');

const STRATEGY_KEY = 'epl_over25_breakout';
const OVER_RUNNER_NAME = 'Over 2.5 Goals';

/**
 * Format timestamp to HH:mm:ss for logging
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
        default_stake: 10,
        wait_after_goal_seconds: 60,
        goal_cutoff_minutes: 75,
        min_entry_price: 1.5,
        max_entry_price: 5,
        goal_detection_pct: 30,

        // Over 2.5 specific settings
        entry_buffer_pct: 2,           // Enter 2% above market price
        stop_loss_drift_pct: 10,       // Stop out if price drifts 10% higher
        green_up_threshold_price: 1.2, // Don't green up below this price

        // Rolling baseline settings
        baseline_stability_pct: 5,
        baseline_stable_readings: 4,

        // Polling
        in_play_poll_interval_seconds: 15,
        post_goal_poll_interval_seconds: 5,
        post_goal_poll_boost_seconds: 120,

        // General
        fixture_lookahead_days: 2,
        commission_rate: 0.0175,
        min_market_liquidity: 1000,

        // Post-trade monitoring
        post_trade_monitor_poll_interval_seconds: 60,
        post_trade_monitor_max_duration_minutes: 100,
    };
}

// --- Trade Phases ---
const PHASE = {
    WATCHING: 'WATCHING',
    GOAL_WAIT: 'GOAL_WAIT',
    LIVE: 'LIVE',
    POST_TRADE_MONITOR: 'POST_TRADE_MONITOR',
    COMPLETED: 'COMPLETED',
    SKIPPED: 'SKIPPED',
};

class EplOver25BreakoutStrategy {
    constructor({ supabase, betfair, logger = console }) {
        this.supabase = supabase;
        this.betfair = betfair;
        this.logger = logger;
        this.settings = null;
        this.defaults = getDefaultSettings();

        // Scheduler state
        this.smartSchedulerTimer = null;
        this.activePollingTimer = null;
        this.currentPollIntervalMs = null;
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

    // --- Cancel Order with Confirmation ---
    async cancelOrderAndConfirm(betId, marketId, sessionToken, label, opts = {}) {
        const confirmMs = typeof opts.confirmMs === 'number' ? opts.confirmMs : 20000;
        const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : 500;
        const maxCancelAttempts = typeof opts.maxCancelAttempts === 'number' ? opts.maxCancelAttempts : 3;
        const notFoundThreshold = typeof opts.notFoundThreshold === 'number' ? opts.notFoundThreshold : 3;

        if (!betId) {
            return { closed: true, attempts: 0, elapsed_ms: 0, last_details: null, reason: 'NO_BET_ID' };
        }

        if (!marketId) {
            this.logger.error(`[strategy:${STRATEGY_KEY}] cancelOrderAndConfirm: marketId required for bet ${betId}`);
            return { closed: false, attempts: 0, elapsed_ms: 0, last_details: null, reason: 'NO_MARKET_ID', errorCode: 'NO_MARKET_ID' };
        }

        const start = Date.now();
        const deadline = start + confirmMs;
        let attempts = 0;
        let consecutiveNotFound = 0;
        let lastDetails = null;

        while (Date.now() < deadline && attempts < maxCancelAttempts) {
            attempts += 1;

            const cancelRes = await this.cancelOrderSafe(betId, marketId, sessionToken, `${label}-cancel-${attempts}`);

            if (cancelRes && cancelRes.status === 'FAILED') {
                this.logger.error(`[strategy:${STRATEGY_KEY}] Cancel API FAILED for bet ${betId}: ${cancelRes.errorCode}`);

                const checkDetails = await this.getOrderDetailsSafe(betId, sessionToken, `${label}-post-fail-check`);
                if (!checkDetails || checkDetails.status !== 'EXECUTABLE' || (checkDetails.sizeRemaining || 0) === 0) {
                    return {
                        closed: true,
                        attempts,
                        elapsed_ms: Date.now() - start,
                        last_details: checkDetails,
                        reason: 'ALREADY_CLOSED_AFTER_FAIL',
                    };
                }

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

                await new Promise((r) => setTimeout(r, pollMs));
                continue;
            }

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

                if (lastDetails && lastDetails.status === 'EXECUTABLE' && (lastDetails.sizeRemaining || 0) > 0) {
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

        this.logger.log(`[strategy:${STRATEGY_KEY}] Starting Over 2.5 Breakout strategy (enabled=${this.settings?.enabled})`);

        await this.syncFixtures('startup');

        this.timers.push(setInterval(() => this.syncFixtures('interval').catch(this.logError('syncFixtures')), 24 * 60 * 60 * 1000));

        this.logger.log(`[strategy:${STRATEGY_KEY}] ⚡ Smart scheduler active`);
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

    // Part 2 will contain: Smart Scheduler, Settings, Fixtures
    // Part 3 will contain: processInPlayGames, processTradeStateMachine
    // Part 4 will contain: Phase handlers (WATCHING, GOAL_WAIT, LIVE)
    // Part 5 will contain: Settlement, helpers

    // --- Smart Scheduler ---

    async calculateNextWakeTime() {
        const now = Date.now();
        const nowIso = new Date().toISOString();

        const { data: activeTrades } = await this.supabase
            .from('strategy_trades')
            .select('id, status, state_data')
            .eq('strategy_key', STRATEGY_KEY)
            .in('status', ['watching', 'goal_wait', 'live', 'post_trade_monitor'])
            .limit(1);

        if (activeTrades?.length > 0) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] Active trades detected - need immediate polling`);
            return 0;
        }

        const ninetyMinsAgo = new Date(now - 90 * 60 * 1000).toISOString();
        const { data: kickedOffGames } = await this.supabase
            .from('strategy_trades')
            .select('kickoff_at, event_id, event_name')
            .eq('strategy_key', STRATEGY_KEY)
            .eq('status', 'scheduled')
            .lte('kickoff_at', nowIso)
            .gte('kickoff_at', ninetyMinsAgo)
            .order('kickoff_at', { ascending: true })
            .limit(1);

        if (kickedOffGames?.length > 0) {
            const eventName = kickedOffGames[0].event_name || kickedOffGames[0].event_id;
            this.logger.log(`[strategy:${STRATEGY_KEY}] ⚽ GAME IN PLAY: ${eventName} - BEGIN WATCHING`);
            return 0;
        }

        const { data: upcomingGames } = await this.supabase
            .from('strategy_trades')
            .select('kickoff_at, event_id, event_name')
            .eq('strategy_key', STRATEGY_KEY)
            .eq('status', 'scheduled')
            .gt('kickoff_at', nowIso)
            .order('kickoff_at', { ascending: true })
            .limit(1);

        if (upcomingGames?.length > 0) {
            const kickoff = new Date(upcomingGames[0].kickoff_at).getTime();
            const delay = kickoff - now;
            const eventName = upcomingGames[0].event_name || upcomingGames[0].event_id;
            const cappedDelay = Math.max(60 * 1000, Math.min(delay, 24 * 60 * 60 * 1000));
            this.logger.log(`[strategy:${STRATEGY_KEY}] Next kickoff: ${eventName} in ${(cappedDelay / 60000).toFixed(1)} min`);
            return cappedDelay;
        }

        this.logger.log(`[strategy:${STRATEGY_KEY}] No scheduled games - sleeping 24h`);
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
                if (!this.activePollingTimer) {
                    this.startActivePolling();
                }
                this.smartSchedulerTimer = setTimeout(() => this.smartSchedulerLoop(), 5000);
            } else {
                this.stopActivePolling();
                this.smartSchedulerTimer = setTimeout(() => {
                    this.logger.log(`[strategy:${STRATEGY_KEY}] Smart scheduler: WAKING UP`);
                    this.smartSchedulerLoop();
                }, nextWake);
            }

        } catch (err) {
            this.logger.error(`[strategy:${STRATEGY_KEY}] Smart scheduler error: ${err.message}`);
            this.smartSchedulerTimer = setTimeout(() => this.smartSchedulerLoop(), 60000);
        }
    }

    startActivePolling(intervalMs = null, runImmediately = true) {
        const basePollInterval = (this.settings?.in_play_poll_interval_seconds || this.defaults.in_play_poll_interval_seconds) * 1000;
        const pollInterval = intervalMs || basePollInterval;

        if (this.activePollingTimer && this.currentPollIntervalMs === pollInterval) {
            return;
        }

        if (this.activePollingTimer) {
            clearInterval(this.activePollingTimer);
            this.activePollingTimer = null;
        }

        this.currentPollIntervalMs = pollInterval;
        this.logger.log(`[strategy:${STRATEGY_KEY}] ▶ STARTING active ${pollInterval / 1000}s polling`);

        this.activePollingTimer = setInterval(() => {
            this.processInPlayGames('poll').catch(this.logError('processInPlayGames'));
        }, pollInterval);

        if (runImmediately) {
            this.processInPlayGames('immediate').catch(this.logError('processInPlayGames'));
        }
    }

    updatePollInterval(intervalMs) {
        if (!this.activePollingTimer) {
            this.startActivePolling(intervalMs, false);
            return;
        }

        if (this.currentPollIntervalMs === intervalMs) {
            return;
        }

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
                    entry_buffer_pct: this.defaults.entry_buffer_pct,
                    stop_loss_drift_pct: this.defaults.stop_loss_drift_pct,
                    green_up_threshold_price: this.defaults.green_up_threshold_price,
                    in_play_poll_interval_seconds: this.defaults.in_play_poll_interval_seconds,
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
            this.settings = { ...data, ...(data.extra || {}) };
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

            const competitionsRes = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCompetitions', {
                filter: { eventTypeIds: [SOCCER_EVENT_TYPE_ID] },
            }, 'listCompetitions');

            const matchedCompetitions = (competitionsRes || [])
                .filter((c) => COMPETITION_MATCHERS.some((rx) => rx.test(c.competition?.name || '')));

            let competitionIds = matchedCompetitions.map((c) => c.competition?.id).filter(Boolean);
            if (competitionIds.length === 0) {
                competitionIds = COMPETITION_IDS;
            }

            const competitionIdToName = new Map();
            matchedCompetitions.forEach((c) => {
                if (c.competition?.id && c.competition?.name) {
                    competitionIdToName.set(String(c.competition.id), c.competition.name);
                }
            });

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
                    this.logger.warn(`[strategy:${STRATEGY_KEY}] Failed to fetch competition info: ${err.message}`);
                }
            }

            this.logger.log(`[strategy:${STRATEGY_KEY}] Fixtures sync found ${eventsRes?.length || 0} events`);

            const fixtures = (eventsRes || [])
                .map((evt) => {
                    const eventId = evt.event?.id;
                    const eventName = evt.event?.name || '';
                    const parts = eventName.split(' v ');

                    let competitionName = eventId ? eventIdToCompetition.get(eventId) : null;
                    if (!competitionName) {
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
            const shouldFixCompetition =
                (!existing.competition_name || existing.competition_name === 'Multiple Leagues') &&
                competitionName && competitionName !== 'Multiple Leagues';

            const shouldFixEventName =
                (!existing.event_name || existing.event_name === fixture.event_id) && !!eventName;

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
            runner_name: OVER_RUNNER_NAME,
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

            const { data: trades, error } = await this.supabase
                .from('strategy_trades')
                .select('*')
                .eq('strategy_key', STRATEGY_KEY)
                .in('status', ['scheduled', 'watching', 'goal_wait', 'live', 'post_trade_monitor'])
                .order('kickoff_at', { ascending: true });

            if (error) throw error;

            if (!trades || trades.length === 0) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] No trades in database - stopping polling`);
                this.stopActivePolling();
                setImmediate(() => this.smartSchedulerLoop());
                return;
            }

            const now = new Date();
            let pendingCount = 0;

            // Build array of trade processing promises for PARALLEL execution
            const tradePromises = [];
            for (const trade of trades) {
                const kickoff = trade.kickoff_at ? new Date(trade.kickoff_at) : null;
                if (!kickoff) continue;

                const minsFromKickoff = (now.getTime() - kickoff.getTime()) / 60000;

                if (minsFromKickoff < 0) {
                    pendingCount++;
                    continue;
                }

                if (minsFromKickoff > 120) {
                    if (trade.status !== 'completed' && trade.status !== 'skipped') {
                        tradePromises.push(
                            this.updateTrade(trade.id, { status: 'completed', last_error: 'GAME_ENDED' })
                                .catch(err => this.logger.error(`[strategy:${STRATEGY_KEY}] Game end update failed: ${err.message}`))
                        );
                    }
                    continue;
                }

                // Process trade in parallel - wrap in error handler to prevent one failure affecting others
                tradePromises.push(
                    this.processTradeStateMachine(trade, now, minsFromKickoff)
                        .catch(err => {
                            this.logger.error(`[strategy:${STRATEGY_KEY}] Trade processing error (ID:${trade.id}): ${err.message}`);
                        })
                );
            }

            // Execute all trade processing in parallel
            if (tradePromises.length > 0) {
                await Promise.allSettled(tradePromises);
            }

            const activeCount = tradePromises.length;
            this.logger.log(`[strategy:${STRATEGY_KEY}] <<< Processed ${activeCount} trades in PARALLEL (${pendingCount} pending kickoff)`);

            if (activeCount === 0) {
                const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
                const { data: upcomingGames } = await this.supabase
                    .from('strategy_trades')
                    .select('kickoff_at, event_id')
                    .eq('strategy_key', STRATEGY_KEY)
                    .eq('status', 'scheduled')
                    .lte('kickoff_at', tenMinutesFromNow.toISOString())
                    .gt('kickoff_at', new Date(now.getTime() - 5 * 60 * 1000).toISOString())
                    .limit(1);

                if (!upcomingGames?.length) {
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

        this.logger.log(`[strategy:${STRATEGY_KEY}] Processing: ${eventName} | phase=${phase} | status=${trade.status} | min=${minsFromKickoff.toFixed(0)}`);

        const sessionToken = await this.requireSessionWithRetry(`sm-${phase}`);
        const market = await this.ensureMarketForTrade(trade, sessionToken);
        if (!market) {
            this.logger.warn(`[strategy:${STRATEGY_KEY}] ⚠️ No market found for ${eventName} - skipping`);
            return;
        }

        const book = await this.getMarketBookSafe(market.marketId, sessionToken, `${phase}-book`);
        if (!book) {
            this.logger.warn(`[strategy:${STRATEGY_KEY}] ⚠️ No market book for ${eventName} - skipping`);
            return;
        }

        if (book.status === 'CLOSED') {
            this.logger.log(`[strategy:${STRATEGY_KEY}] Market CLOSED for ${eventName}`);
            if (phase === PHASE.POST_TRADE_MONITOR) {
                await this.finalizeShadowMonitoring(trade, state, 'MARKET_CLOSED');
                return;
            }
            await this.settleTradeWithPnl(trade, state, 'MARKET_CLOSED');
            return;
        }

        // Capture actual kickoff time when market first goes in-play
        // This is more accurate than scheduled kickoff for delayed games
        if (book.inplay === true && !state.actual_kickoff_time) {
            state.actual_kickoff_time = Date.now();
            this.logger.log(`[strategy:${STRATEGY_KEY}] ⚽ Match STARTED! Recording actual kickoff time for ${eventName}`);
            await this.updateTrade(trade.id, {
                state_data: state,
                actual_kickoff_time: new Date(state.actual_kickoff_time).toISOString(),
            });
        }

        const runner = book.runners?.find(r => r.selectionId == market.selectionId);
        const bestBackPrice = runner?.ex?.availableToBack?.[0]?.price;
        const bestLayPrice = runner?.ex?.availableToLay?.[0]?.price;
        const lastTradedPrice = runner?.lastPriceTraded;
        const signalBackPrice = bestBackPrice || lastTradedPrice;

        if (phase === PHASE.WATCHING) {
            if (!signalBackPrice) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] ⚠️ No usable price for ${eventName} - waiting`);
                return;
            }
            await this.handleWatching(trade, state, signalBackPrice, bestLayPrice, minsFromKickoff, sessionToken, market);
            return;
        }

        if (!bestBackPrice || !bestLayPrice) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] ⚠️ No prices for ${eventName} - waiting`);
            return;
        }

        switch (phase) {
            case PHASE.GOAL_WAIT:
                await this.handleGoalWait(trade, state, bestBackPrice, bestLayPrice, sessionToken, market);
                break;
            case PHASE.LIVE:
                await this.handleLive(trade, state, bestBackPrice, bestLayPrice, sessionToken, market);
                break;
            case PHASE.POST_TRADE_MONITOR:
                await this.handlePostTradeMonitor(trade, state, bestBackPrice, bestLayPrice, sessionToken, market);
                break;
        }
    }

    // --- Phase Handlers ---

    async handleWatching(trade, state, backPrice, layPrice, minsFromKickoff, sessionToken, market) {
        const goalCutoff = this.settings?.goal_cutoff_minutes || this.defaults.goal_cutoff_minutes;
        const goalDetectionPct = this.settings?.goal_detection_pct || this.defaults.goal_detection_pct;
        const stabilityPct = this.settings?.baseline_stability_pct || this.defaults.baseline_stability_pct;
        const stableReadingsRequired = this.settings?.baseline_stable_readings || this.defaults.baseline_stable_readings;
        const eventName = trade.event_name || trade.event_id || 'Unknown';

        // Initialize baseline
        if (!state.baseline_price) {
            const minLiquidity = this.settings?.min_market_liquidity || this.defaults.min_market_liquidity;
            const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'liquidity-check');

            if (book && typeof book.totalMatched === 'number' && book.totalMatched < minLiquidity) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] Market liquidity too low for ${eventName} - skipping`);
                state.phase = PHASE.POST_TRADE_MONITOR;
                state.is_shadow_trade = true;
                state.skip_reason = 'MARKET_LIQUIDITY_TOO_LOW';
                state.monitor_started_at = Date.now();

                await this.updateTrade(trade.id, {
                    status: 'post_trade_monitor',
                    state_data: state,
                    last_error: 'MARKET_LIQUIDITY_TOO_LOW',
                });
                return;
            }

            state.baseline_price = backPrice;
            state.last_price = backPrice;
            state.recent_prices = [backPrice];

            // Log baseline price BEFORE 1st goal for Over strategy
            await this.updateTrade(trade.id, {
                status: 'watching',
                state_data: state,
                over_price_before_1st_goal: backPrice,
            });
            await this.logEvent(trade.id, 'WATCHING_STARTED', {
                baseline_price: backPrice,
                mins_from_kickoff: minsFromKickoff,
            });
            return;
        }

        // Rolling baseline update
        if (!state.recent_prices) {
            state.recent_prices = [state.last_price || state.baseline_price];
        }

        state.recent_prices.push(backPrice);
        if (state.recent_prices.length > stableReadingsRequired) {
            state.recent_prices.shift();
        }

        if (state.recent_prices.length >= stableReadingsRequired) {
            const sorted = [...state.recent_prices].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];

            const allStable = state.recent_prices.every(p => {
                const deviation = Math.abs((p - median) / median) * 100;
                return deviation <= stabilityPct;
            });

            if (allStable) {
                const oldBaseline = state.baseline_price;
                const baselineDrift = Math.abs((backPrice - oldBaseline) / oldBaseline) * 100;

                if (baselineDrift > 1) {
                    state.baseline_price = backPrice;
                    this.logger.log(`[strategy:${STRATEGY_KEY}] 📊 BASELINE UPDATED: ${oldBaseline.toFixed(2)} → ${backPrice.toFixed(2)}`);
                }
            }
        }

        // Goal Detection - price DROPS for Over market (inverse of Under)
        // For Over 2.5: 1st goal causes price to DROP (becomes more likely to go over)
        const priceChangeFromBaseline = ((state.baseline_price - backPrice) / state.baseline_price) * 100;

        this.logger.log(`[strategy:${STRATEGY_KEY}]   WATCHING ${eventName}: price=${backPrice} | baseline=${state.baseline_price.toFixed(2)} | drop=${priceChangeFromBaseline.toFixed(1)}%`);

        if (priceChangeFromBaseline >= goalDetectionPct) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] 🎯 GOAL DETECTED! Price drop: ${priceChangeFromBaseline.toFixed(1)}%`);

            // Capture Over 3.5 price at 1st goal for telemetry
            const over35Data = await this.getOver35Price(trade, sessionToken, 'goal1-detected');
            const over35Price = over35Data?.backPrice || null;
            if (over35Price) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] 📊 Over 3.5 price at 1st goal: ${over35Price}`);
            }

            if (minsFromKickoff > goalCutoff) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] Goal after ${goalCutoff}min cutoff - skipping to shadow monitoring`);
                state.phase = PHASE.POST_TRADE_MONITOR;
                state.is_shadow_trade = true;
                state.skip_reason = 'GOAL_AFTER_CUTOFF';
                state.monitor_started_at = Date.now();

                await this.updateTrade(trade.id, {
                    status: 'post_trade_monitor',
                    state_data: state,
                    over35_price_before_1st_goal: over35Price,
                });
                return;
            }

            state.phase = PHASE.GOAL_WAIT;
            state.spike_detected_at = Date.now();
            state.spike_price = backPrice;
            state.goal_number = 1;
            state.recent_prices = [];
            // Store Over 3.5 market info in state for future lookups
            if (over35Data) {
                state.over35_market_id = over35Data.marketId;
                state.over35_selection_id = over35Data.selectionId;
            }

            await this.updateTrade(trade.id, {
                status: 'goal_wait',
                state_data: state,
                over35_price_before_1st_goal: over35Price,
            });
            await this.logEvent(trade.id, 'GOAL_DETECTED', {
                goal_number: 1,
                price_after_goal: backPrice,
                baseline_price: state.baseline_price,
                price_change_pct: priceChangeFromBaseline,
                mins_from_kickoff: minsFromKickoff,
                over35_price: over35Price,
            });
            return;
        }

        state.last_price = backPrice;
        await this.updateTrade(trade.id, { state_data: state });
    }

    // Continued in next replacement...

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

        // Find OVER runner (not Under)
        const runner = market.runners.find(r => r.runnerName === OVER_RUNNER_NAME || r.runnerName === 'Over 2.5 Goals');
        if (!runner) {
            this.logger.warn(`[strategy:${STRATEGY_KEY}] Over runner not found in market ${market.marketId}`);
            return null;
        }

        await this.updateTrade(trade.id, {
            betfair_market_id: market.marketId,
            selection_id: runner.selectionId,
        });

        return { marketId: market.marketId, selectionId: runner.selectionId };
    }

    /**
     * Fetch Over 3.5 Goals market price for telemetry.
     * This is purely for data collection - failures are non-fatal.
     * @returns {Promise<{marketId: string, selectionId: string, backPrice: number, layPrice: number} | null>}
     */
    async getOver35Price(trade, sessionToken, label = 'over35-price') {
        try {
            // Check if we've already cached the market info in state
            const state = trade.state_data || {};
            let marketId = state.over35_market_id;
            let selectionId = state.over35_selection_id;

            // Fetch market catalogue if not cached
            if (!marketId || !selectionId) {
                const markets = await this.rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listMarketCatalogue', {
                    filter: {
                        eventIds: [trade.betfair_event_id],
                        marketTypeCodes: ['OVER_UNDER_35'],
                    },
                    maxResults: 1,
                    marketProjection: ['RUNNER_METADATA'],
                }, `${label}-catalogue`);

                const market = markets?.[0];
                if (!market) {
                    // Over 3.5 market may not exist for all events - this is expected
                    return null;
                }

                const runner = market.runners?.find(r =>
                    r.runnerName === 'Over 3.5 Goals' || r.runnerName?.includes('Over 3.5')
                );
                if (!runner) {
                    return null;
                }

                marketId = market.marketId;
                selectionId = runner.selectionId;

                // Cache in state for future calls (will be persisted on next updateTrade)
                state.over35_market_id = marketId;
                state.over35_selection_id = selectionId;
            }

            // Fetch current price
            const book = await this.getMarketBookSafe(marketId, sessionToken, `${label}-book`);
            if (!book) return null;

            const runner = book.runners?.find(r => r.selectionId == selectionId);
            const backPrice = runner?.ex?.availableToBack?.[0]?.price || runner?.lastPriceTraded || null;
            const layPrice = runner?.ex?.availableToLay?.[0]?.price || null;

            if (!backPrice) return null;

            return { marketId, selectionId, backPrice, layPrice };
        } catch (err) {
            // Telemetry failures should never break trading logic
            this.logger.warn(`[strategy:${STRATEGY_KEY}] Over 3.5 price fetch failed (non-fatal): ${err.message}`);
            return null;
        }
    }

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

    // --- GOAL_WAIT: Entry after 1st goal + Stop Loss placement ---
    async handleGoalWait(trade, state, backPrice, layPrice, sessionToken, market) {
        const waitSeconds = this.settings?.wait_after_goal_seconds || this.defaults.wait_after_goal_seconds;
        const goalDetectionPct = this.settings?.goal_detection_pct || this.defaults.goal_detection_pct;
        const minEntryPrice = this.settings?.min_entry_price || this.defaults.min_entry_price;
        const maxEntryPrice = this.settings?.max_entry_price || this.defaults.max_entry_price;
        const entryBufferPct = this.settings?.entry_buffer_pct || this.defaults.entry_buffer_pct;
        const stopLossDriftPct = this.settings?.stop_loss_drift_pct || this.defaults.stop_loss_drift_pct;

        // Guard: Already placed back bet - resume monitoring
        if (state.back_bet_id) {
            await this.verifyBackAndPlaceStopLoss(trade, state, sessionToken, market);
            return;
        }

        const elapsed = (Date.now() - state.spike_detected_at) / 1000;

        // Check for false alarm (price returned to baseline)
        const priceChange = ((state.baseline_price - backPrice) / state.baseline_price) * 100;
        if (priceChange < goalDetectionPct * 0.5) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] Price returned to normal - FALSE ALARM`);
            state.phase = PHASE.WATCHING;
            state.baseline_price = backPrice;
            delete state.spike_detected_at;
            delete state.spike_price;

            await this.updateTrade(trade.id, { status: 'watching', state_data: state });
            await this.logEvent(trade.id, 'GOAL_DISALLOWED', { current_price: backPrice });
            return;
        }

        // Wait for settle time
        if (elapsed < waitSeconds) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] GOAL_WAIT: ${elapsed.toFixed(0)}s / ${waitSeconds}s, price: ${backPrice}`);
            return;
        }

        // Price range check
        if (backPrice > maxEntryPrice || backPrice < minEntryPrice) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] Price ${backPrice} outside range [${minEntryPrice}, ${maxEntryPrice}] - shadow monitoring`);
            state.phase = PHASE.POST_TRADE_MONITOR;
            state.is_shadow_trade = true;
            state.skip_reason = backPrice > maxEntryPrice ? 'PRICE_ABOVE_MAX' : 'PRICE_BELOW_MIN';
            state.monitor_started_at = Date.now();
            state.theoretical_entry_price = backPrice;

            await this.updateTrade(trade.id, {
                status: 'post_trade_monitor',
                state_data: state,
                theoretical_entry_price: backPrice,
            });
            return;
        }

        // Calculate entry price with buffer (2% ABOVE current back price)
        const entryPrice = roundToBetfairTick(backPrice * (1 + entryBufferPct / 100));
        const stake = trade.target_stake || this.settings?.default_stake || this.defaults.default_stake;

        // Capture Over 3.5 price after 1st goal settles (at entry)
        const over35Data = await this.getOver35Price(trade, sessionToken, 'entry');
        const over35Price = over35Data?.backPrice || null;
        if (over35Price) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] 📊 Over 3.5 price at entry: ${over35Price}`);
        }

        // Calculate match minute at entry using actual kickoff time (not scheduled)
        let matchMinuteAtEntry = null;
        if (state.actual_kickoff_time) {
            matchMinuteAtEntry = Math.floor((Date.now() - state.actual_kickoff_time) / 60000);
            this.logger.log(`[strategy:${STRATEGY_KEY}] ⏱️ Match minute at entry: ${matchMinuteAtEntry}`);
        }

        this.logger.log(`[strategy:${STRATEGY_KEY}] Placing BACK @ ${entryPrice} (${entryBufferPct}% above ${backPrice})`);

        const placeRes = await this.placeLimitOrderSafe(
            market.marketId,
            market.selectionId,
            'BACK',
            stake,
            entryPrice,
            sessionToken,
            'over25-entry'
        );

        if (placeRes.status === 'SUCCESS') {
            this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ BACK PLACED @ ${entryPrice} - betId: ${placeRes.betId}`);

            state.entry_price = entryPrice;
            state.entry_time = Date.now();
            state.back_bet_id = placeRes.betId;
            state.target_stake = stake;

            // Persist Over 3.5 market info for 2nd goal capture
            if (over35Data) {
                state.over35_market_id = over35Data.marketId;
                state.over35_selection_id = over35Data.selectionId;
            }

            await this.updateTrade(trade.id, {
                state_data: state,
                over35_price_after_1st_goal: over35Price,
                match_minute_at_entry: matchMinuteAtEntry,
            });

            await this.logEvent(trade.id, 'BACK_PLACED', {
                bet_id: placeRes.betId,
                stake,
                price: entryPrice,
                buffer_pct: entryBufferPct,
                over35_price: over35Price,
                match_minute_at_entry: matchMinuteAtEntry,
            });

            // Verify back matches then place stop loss
            await this.verifyBackAndPlaceStopLoss(trade, state, sessionToken, market);
        } else {
            this.logger.error(`[strategy:${STRATEGY_KEY}] Entry failed: ${placeRes.errorCode}`);
            await this.logEvent(trade.id, 'ENTRY_FAILED', { errorCode: placeRes.errorCode });
        }
    }

    async verifyBackAndPlaceStopLoss(trade, state, sessionToken, market) {
        const maxWaitMs = 30000;
        const pollIntervalMs = 500;
        let elapsed = 0;
        const backBetId = state.back_bet_id;
        const stake = state.target_stake || trade.target_stake;
        const entryPrice = state.entry_price;
        const stopLossDriftPct = this.settings?.stop_loss_drift_pct || this.defaults.stop_loss_drift_pct;

        while (elapsed < maxWaitMs) {
            const details = await this.getOrderDetailsSafe(backBetId, sessionToken, 'verify-back');

            if (!details) {
                this.logger.warn(`[strategy:${STRATEGY_KEY}] Back order disappeared - shadow monitoring`);
                state.phase = PHASE.POST_TRADE_MONITOR;
                state.is_shadow_trade = true;
                state.skip_reason = 'BACK_ORDER_DISAPPEARED';
                state.monitor_started_at = Date.now();
                await this.updateTrade(trade.id, { status: 'post_trade_monitor', state_data: state });
                return;
            }

            if (details.status === 'EXECUTION_COMPLETE' || (details.sizeMatched >= stake * 0.99)) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ Back MATCHED: £${details.sizeMatched} @ ${details.averagePriceMatched}`);

                const matchedPrice = details.averagePriceMatched || entryPrice;
                const matchedSize = details.sizeMatched || stake;

                // Calculate stop loss price: entry * (1 + drift_pct)
                const stopLossPrice = roundToBetfairTick(matchedPrice * (1 + stopLossDriftPct / 100));

                // Calculate lay stake for stop loss
                const commission = this.settings?.commission_rate || this.defaults.commission_rate;
                const { layStake } = calculateLayStake({
                    backStake: matchedSize,
                    backPrice: matchedPrice,
                    layPrice: stopLossPrice,
                    commission,
                });

                this.logger.log(`[strategy:${STRATEGY_KEY}] Placing STOP LOSS LAY @ ${stopLossPrice} (${stopLossDriftPct}% above entry)`);

                // Place stop loss with LAPSE persistence (auto-cancel on suspension)
                const layRes = await this.placeLimitOrderSafe(
                    market.marketId,
                    market.selectionId,
                    'LAY',
                    layStake,
                    stopLossPrice,
                    sessionToken,
                    'over25-stoploss',
                    'LAPSE'
                );

                if (layRes.status === 'SUCCESS') {
                    this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ STOP LOSS PLACED @ ${stopLossPrice} - betId: ${layRes.betId}`);

                    state.phase = PHASE.LIVE;
                    state.stop_loss_bet_id = layRes.betId;
                    state.stop_loss_price = stopLossPrice;
                    state.stop_loss_stake = layStake;
                    state.back_matched_size = matchedSize;
                    state.back_matched_price = matchedPrice;
                    state.position_entered_at = Date.now();
                    state.max_price_post_entry = matchedPrice;

                    await this.updateTrade(trade.id, {
                        status: 'live',
                        state_data: state,
                        back_price: matchedPrice,
                        back_stake: matchedSize,
                        back_matched_size: matchedSize,
                        back_order_ref: backBetId,
                        lay_order_ref: layRes.betId,
                        lay_price: stopLossPrice,
                        lay_size: layStake,
                    });

                    await this.logEvent(trade.id, 'POSITION_ENTERED', {
                        entry_price: matchedPrice,
                        stake: matchedSize,
                        stop_loss_price: stopLossPrice,
                        stop_loss_stake: layStake,
                    });
                } else {
                    // CRITICAL: Stop loss failed - position is EXPOSED! Place emergency exit immediately
                    this.logger.error(`[strategy:${STRATEGY_KEY}] 🚨 Stop loss placement FAILED: ${layRes.errorCode} - PLACING EMERGENCY EXIT!`);

                    state.stop_loss_failed = true;
                    state.back_matched_size = matchedSize;
                    state.back_matched_price = matchedPrice;

                    await this.logEvent(trade.id, 'STOP_LOSS_PLACEMENT_FAILED', {
                        errorCode: layRes.errorCode,
                        back_exposure: matchedSize,
                        attempted_price: stopLossPrice,
                    });

                    // Place emergency hedge at current market price
                    await this.placeEmergencyHedge(trade, state, matchedSize, sessionToken, market);
                }
                return;
            }

            await new Promise(r => setTimeout(r, pollIntervalMs));
            elapsed += pollIntervalMs;
        }

        // Timeout - cancel unmatched and go to shadow monitoring
        this.logger.warn(`[strategy:${STRATEGY_KEY}] Back not matched after ${maxWaitMs / 1000}s - cancelling`);
        await this.cancelOrderAndConfirm(backBetId, market.marketId, sessionToken, 'cancel-unmatched-back');

        state.phase = PHASE.POST_TRADE_MONITOR;
        state.is_shadow_trade = true;
        state.skip_reason = 'BACK_NOT_MATCHED_TIMEOUT';
        state.monitor_started_at = Date.now();
        await this.updateTrade(trade.id, { status: 'post_trade_monitor', state_data: state });
    }

    // --- LIVE: Monitor for stop loss hit OR 2nd goal ---
    async handleLive(trade, state, backPrice, layPrice, sessionToken, market) {
        const goalDetectionPct = this.settings?.goal_detection_pct || this.defaults.goal_detection_pct;
        const greenUpThreshold = this.settings?.green_up_threshold_price || this.defaults.green_up_threshold_price;
        const eventName = trade.event_name || trade.event_id || 'Unknown';

        // Track max price drift (for telemetry)
        if (!state.max_price_post_entry || backPrice > state.max_price_post_entry) {
            state.max_price_post_entry = backPrice;
        }

        // Check stop loss bet status
        if (state.stop_loss_bet_id) {
            const details = await this.getOrderDetailsSafe(state.stop_loss_bet_id, sessionToken, 'check-stoploss');

            if (details && details.status === 'EXECUTION_COMPLETE') {
                // LOSS: Stop loss matched (price drifted up against us)
                this.logger.log(`[strategy:${STRATEGY_KEY}] 🛑 STOP LOSS HIT - trade closed as LOSS`);

                state.phase = PHASE.COMPLETED;
                state.exit_reason = 'STOP_LOSS_HIT';
                state.exit_price = details.averagePriceMatched || state.stop_loss_price;

                await this.updateTrade(trade.id, {
                    status: 'completed',
                    state_data: state,
                    over_max_price_reached_post_entry: state.max_price_post_entry,
                });

                await this.settleTradeWithPnl(trade, state, 'STOP_LOSS_HIT', {
                    layPrice: state.exit_price,
                    layStake: details.sizeMatched || state.stop_loss_stake,
                });
                return;
            }

            // Check if stop loss was cancelled (suspension)
            if (!details || (details.status !== 'EXECUTABLE' && details.sizeMatched === 0)) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] Stop loss cancelled/not found - market likely suspended`);
                state.stop_loss_cancelled = true;
            }
        }

        // Check for 2nd goal (price DROP from last stable - inverse direction)
        const lastStablePrice = state.last_stable_price || state.back_matched_price || state.entry_price;
        const priceDropFromStable = ((lastStablePrice - backPrice) / lastStablePrice) * 100;

        if (priceDropFromStable >= goalDetectionPct) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] 🎯 2ND GOAL DETECTED! Price drop: ${priceDropFromStable.toFixed(1)}%`);

            // Capture Over 3.5 price at 2nd goal detection (before settle)
            const over35Data = await this.getOver35Price(trade, sessionToken, 'goal2-detected');
            const over35PriceBefore2ndGoal = over35Data?.backPrice || null;
            if (over35PriceBefore2ndGoal) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] 📊 Over 3.5 price at 2nd goal: ${over35PriceBefore2ndGoal}`);
            }

            // Record time between goals
            const secondsTillNextGoal = state.spike_detected_at
                ? Math.floor((Date.now() - state.spike_detected_at) / 1000)
                : null;

            // Check stop loss status ONCE (should be auto-cancelled on suspension)
            if (state.stop_loss_bet_id && !state.stop_loss_cancelled) {
                const slDetails = await this.getOrderDetailsSafe(state.stop_loss_bet_id, sessionToken, 'check-stoploss-after-goal');

                if (slDetails && slDetails.status === 'EXECUTABLE') {
                    // Rare: still executable - fire-and-forget cancel
                    this.logger.log(`[strategy:${STRATEGY_KEY}] Stop loss still executable - firing cancel`);
                    this.cancelOrderSafe(state.stop_loss_bet_id, market.marketId, sessionToken, 'cancel-stoploss-2nd-goal');
                }
            }

            // Green up decision
            if (backPrice <= greenUpThreshold) {
                // Price too low to green up - let it ride
                this.logger.log(`[strategy:${STRATEGY_KEY}] Price ${backPrice} <= ${greenUpThreshold} - no green up, ride to settlement`);

                state.phase = PHASE.POST_TRADE_MONITOR;
                state.exit_reason = 'WIN_NO_GREENUP';
                state.goal_number = 2;
                state.monitor_started_at = Date.now();

                await this.updateTrade(trade.id, {
                    status: 'post_trade_monitor',
                    state_data: state,
                    seconds_till_next_goal: secondsTillNextGoal,
                    over_price_after_2nd_goal_settled: backPrice,
                    over35_price_before_2nd_goal: over35PriceBefore2ndGoal,
                });
                await this.logEvent(trade.id, 'SECOND_GOAL_NO_GREENUP', {
                    price: backPrice,
                    threshold: greenUpThreshold,
                    over35_price: over35PriceBefore2ndGoal,
                });
            } else {
                // Green up: place LAY at 1 tick below current lay
                this.logger.log(`[strategy:${STRATEGY_KEY}] Price ${backPrice} > ${greenUpThreshold} - placing green up LAY`);

                // Store Over 3.5 price in state for later capture at green up completion
                state.over35_price_before_2nd_goal = over35PriceBefore2ndGoal;

                await this.placeGreenUpLay(trade, state, backPrice, layPrice, sessionToken, market, secondsTillNextGoal);
            }
            return;
        }

        // Update stable price
        state.last_stable_price = backPrice;
        await this.updateTrade(trade.id, {
            state_data: state,
            over_max_price_reached_post_entry: state.max_price_post_entry,
        });

        this.logger.log(`[strategy:${STRATEGY_KEY}] LIVE ${eventName}: back=${backPrice} | last_stable=${lastStablePrice.toFixed(2)} | max_drift=${state.max_price_post_entry?.toFixed(2)}`);
    }

    async placeGreenUpLay(trade, state, backPrice, layPrice, sessionToken, market, secondsTillNextGoal) {
        const commission = this.settings?.commission_rate || this.defaults.commission_rate;
        const backMatchedSize = state.back_matched_size || trade.back_matched_size || trade.back_stake;
        const backMatchedPrice = state.back_matched_price || trade.back_price;

        const greenUpPrice = ticksBelow(layPrice, 1);
        const { layStake } = calculateLayStake({
            backStake: backMatchedSize,
            backPrice: backMatchedPrice,
            layPrice: greenUpPrice,
            commission,
        });

        this.logger.log(`[strategy:${STRATEGY_KEY}] Placing GREEN UP LAY @ ${greenUpPrice} for £${layStake}`);

        const placeRes = await this.placeLimitOrderSafe(
            market.marketId,
            market.selectionId,
            'LAY',
            layStake,
            greenUpPrice,
            sessionToken,
            'over25-greenup'
        );

        if (placeRes.status === 'SUCCESS') {
            state.green_up_bet_id = placeRes.betId;
            state.green_up_price = greenUpPrice;
            state.green_up_stake = layStake;
            state.green_up_placed_at = Date.now();
            state.goal_number = 2;

            await this.updateTrade(trade.id, {
                state_data: state,
                seconds_till_next_goal: secondsTillNextGoal,
                over_price_after_2nd_goal_settled: backPrice,
            });

            await this.logEvent(trade.id, 'GREEN_UP_PLACED', {
                bet_id: placeRes.betId,
                price: greenUpPrice,
                stake: layStake,
            });

            // Wait for green up to match (with retry logic)
            await this.waitForGreenUpMatch(trade, state, sessionToken, market);
        } else {
            this.logger.error(`[strategy:${STRATEGY_KEY}] Green up placement failed: ${placeRes.errorCode}`);
            state.phase = PHASE.POST_TRADE_MONITOR;
            state.exit_reason = 'GREEN_UP_FAILED';
            state.monitor_started_at = Date.now();
            await this.updateTrade(trade.id, { status: 'post_trade_monitor', state_data: state });
        }
    }

    async waitForGreenUpMatch(trade, state, sessionToken, market) {
        const maxWaitMs = 30000;
        const pollIntervalMs = 1000;
        let elapsed = 0;
        const greenUpBetId = state.green_up_bet_id;

        while (elapsed < maxWaitMs) {
            const details = await this.getOrderDetailsSafe(greenUpBetId, sessionToken, 'check-greenup');

            if (!details) {
                this.logger.warn(`[strategy:${STRATEGY_KEY}] Green up bet not found`);
                break;
            }

            if (details.status === 'EXECUTION_COMPLETE' || details.sizeMatched >= state.green_up_stake * 0.99) {
                this.logger.log(`[strategy:${STRATEGY_KEY}] ✓ GREEN UP MATCHED: £${details.sizeMatched} @ ${details.averagePriceMatched}`);

                // Capture Over 3.5 price after 2nd goal settles (at green up)
                const over35Data = await this.getOver35Price(trade, sessionToken, 'greenup-complete');
                const over35PriceAfter2ndGoal = over35Data?.backPrice || null;
                if (over35PriceAfter2ndGoal) {
                    this.logger.log(`[strategy:${STRATEGY_KEY}] 📊 Over 3.5 price after 2nd goal: ${over35PriceAfter2ndGoal}`);
                }

                // Persist Over 3.5 price after 2nd goal
                await this.updateTrade(trade.id, {
                    over35_price_before_2nd_goal: state.over35_price_before_2nd_goal || null,
                    over35_price_after_2nd_goal: over35PriceAfter2ndGoal,
                });

                state.phase = PHASE.COMPLETED;
                state.exit_reason = 'WIN_GREEN_UP';
                state.exit_price = details.averagePriceMatched;

                await this.settleTradeWithPnl(trade, state, 'WIN_GREEN_UP', {
                    layPrice: details.averagePriceMatched,
                    layStake: details.sizeMatched,
                });
                return;
            }

            await new Promise(r => setTimeout(r, pollIntervalMs));
            elapsed += pollIntervalMs;
        }

        // Timeout - cancel and retry
        this.logger.log(`[strategy:${STRATEGY_KEY}] Green up not matched after ${maxWaitMs / 1000}s - cancelling and retrying`);
        await this.cancelOrderAndConfirm(greenUpBetId, market.marketId, sessionToken, 'cancel-greenup-retry');

        // Get fresh price and retry
        const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'greenup-retry-book');
        const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
        const newLayPrice = runner?.ex?.availableToLay?.[0]?.price;
        const newBackPrice = runner?.ex?.availableToBack?.[0]?.price;

        if (newLayPrice) {
            await this.placeGreenUpLay(trade, state, newBackPrice, newLayPrice, sessionToken, market, null);
        } else {
            state.phase = PHASE.POST_TRADE_MONITOR;
            state.exit_reason = 'GREEN_UP_TIMEOUT';
            state.monitor_started_at = Date.now();
            await this.updateTrade(trade.id, { status: 'post_trade_monitor', state_data: state });
        }
    }

    // --- POST_TRADE_MONITOR ---
    async handlePostTradeMonitor(trade, state, backPrice, layPrice, sessionToken, market) {
        const maxDurationMins = this.settings?.post_trade_monitor_max_duration_minutes || this.defaults.post_trade_monitor_max_duration_minutes;
        const elapsedMins = state.monitor_started_at ? (Date.now() - state.monitor_started_at) / 60000 : 0;
        const eventName = trade.event_name || trade.event_id || 'Unknown';

        // For REAL trades riding to settlement (not shadow trades), wait for MARKET CLOSE
        const isRealHeldTrade = !state.is_shadow_trade && state.back_matched_size > 0 && state.exit_reason === 'WIN_NO_GREENUP';

        if (isRealHeldTrade) {
            // Real trade riding to settlement - LOG IT and track P&L
            this.logger.log(`[strategy:${STRATEGY_KEY}] 🎯 HOLDING TRADE: ${eventName} | price=${backPrice} | waiting for market close`);

            // Track price movement for logging
            if (!state.min_held_price || backPrice < state.min_held_price) {
                state.min_held_price = backPrice;
            }

            await this.updateTrade(trade.id, { state_data: state });

            // Note: Market close is handled in processTradeStateMachine (book.status === 'CLOSED')
            // which calls settleTradeWithPnl for proper P&L calculation
            return;
        }

        // Shadow trade timeout logic (for skipped/theoretical trades only)
        if (elapsedMins >= maxDurationMins) {
            await this.finalizeShadowMonitoring(trade, state, 'MAX_DURATION_REACHED');
            return;
        }

        // Track max price after 2nd goal (for telemetry)
        if (state.goal_number === 2) {
            if (!state.max_price_after_2nd_goal || backPrice > state.max_price_after_2nd_goal) {
                state.max_price_after_2nd_goal = backPrice;
                await this.updateTrade(trade.id, {
                    state_data: state,
                    max_price_over_reached_after_2nd_goal: backPrice,
                });
            }
        }

        this.logger.log(`[strategy:${STRATEGY_KEY}] POST_TRADE_MONITOR: ${eventName} | elapsed=${elapsedMins.toFixed(1)}min`);
    }

    async finalizeShadowMonitoring(trade, state, reason) {
        state.phase = PHASE.COMPLETED;
        await this.updateTrade(trade.id, { status: 'completed', state_data: state });
        await this.logEvent(trade.id, 'SHADOW_MONITORING_COMPLETED', { reason });
    }

    async settleTradeWithPnl(trade, state, reason, options = {}) {
        const { layPrice, layStake } = options;
        const commission = this.settings?.commission_rate || this.defaults.commission_rate;
        const backStake = state.back_matched_size || trade.back_matched_size || trade.back_stake || 0;
        const backPrice = state.back_matched_price || trade.back_price || state.entry_price || 0;
        const eventName = trade.event_name || trade.event_id || 'Unknown';

        const realised = computeRealisedPnlSnapshot({
            backStake,
            backPrice,
            layStake: layStake || 0,
            layPrice: layPrice || 0,
            commission,
        });

        state.phase = PHASE.COMPLETED;
        state.realised_pnl = realised;

        await this.updateTrade(trade.id, {
            status: 'completed',
            state_data: state,
            realised_pnl: realised,
            pnl: realised,
            settled_at: new Date().toISOString(),
        });

        const symbol = realised >= 0 ? '✓ PROFIT' : '✗ LOSS';
        this.logger.log(`[strategy:${STRATEGY_KEY}] ═══════════════════════════════════════`);
        this.logger.log(`[strategy:${STRATEGY_KEY}] ${symbol}: £${realised?.toFixed(2) || 'N/A'} | ${eventName}`);
        this.logger.log(`[strategy:${STRATEGY_KEY}]   Reason: ${reason}`);
        this.logger.log(`[strategy:${STRATEGY_KEY}]   Back: £${backStake.toFixed(2)} @ ${backPrice.toFixed(2)}`);
        if (layStake && layPrice) {
            this.logger.log(`[strategy:${STRATEGY_KEY}]   Lay: £${layStake.toFixed(2)} @ ${layPrice.toFixed(2)}`);
        }
        this.logger.log(`[strategy:${STRATEGY_KEY}] ═══════════════════════════════════════`);

        await this.logEvent(trade.id, 'TRADE_SETTLED', { reason, realised_pnl: realised, ...options });
    }

    // --- Emergency Hedge ---
    async placeEmergencyHedge(trade, state, backMatched, sessionToken, market) {
        const backPrice = state.back_matched_price || state.entry_price || trade.back_price;
        const eventName = trade.event_name || trade.event_id || 'Unknown';

        if (backMatched <= 0) {
            this.logger.log(`[strategy:${STRATEGY_KEY}] No back exposure - no emergency hedge needed`);
            return;
        }

        const book = await this.getMarketBookSafe(market.marketId, sessionToken, 'emergency-hedge-book');
        const runner = book?.runners?.find(r => r.selectionId == market.selectionId);
        const currentLayPrice = runner?.ex?.availableToLay?.[0]?.price;

        if (!currentLayPrice) {
            this.logger.error(`[strategy:${STRATEGY_KEY}] ❌ CRITICAL: No lay price for ${eventName} - POSITION FULLY EXPOSED!`);
            state.phase = PHASE.LIVE;
            state.emergency_hedge_failed = true;

            await this.updateTrade(trade.id, {
                status: 'live',
                state_data: state,
                last_error: 'EMERGENCY_HEDGE_FAILED_NO_PRICE',
            });
            await this.logEvent(trade.id, 'EMERGENCY_HEDGE_FAILED', {
                reason: 'NO_LAY_PRICE',
                back_exposure: backMatched,
            });
            return;
        }

        // Calculate emergency lay stake
        const commission = this.settings?.commission_rate || this.defaults.commission_rate;
        const { layStake } = calculateLayStake({
            backStake: backMatched,
            backPrice,
            layPrice: currentLayPrice,
            commission,
        });

        this.logger.log(`[strategy:${STRATEGY_KEY}] 🚨 EMERGENCY HEDGE: Laying £${layStake.toFixed(2)} @ ${currentLayPrice} to cover £${backMatched} exposure`);

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

            state.phase = PHASE.LIVE;
            state.stop_loss_bet_id = placeRes.betId;
            state.stop_loss_price = currentLayPrice;
            state.stop_loss_stake = layStake;
            state.emergency_hedge = true;

            await this.updateTrade(trade.id, {
                status: 'live',
                state_data: state,
                lay_order_ref: placeRes.betId,
                lay_price: currentLayPrice,
                lay_size: layStake,
                last_error: null,
            });

            await this.logEvent(trade.id, 'EMERGENCY_HEDGE_PLACED', {
                betId: placeRes.betId,
                lay_price: currentLayPrice,
                lay_stake: layStake,
                reason: 'STOP_LOSS_FAILED',
            });
        } else {
            this.logger.error(`[strategy:${STRATEGY_KEY}] ❌ Emergency hedge FAILED: ${placeRes.errorCode}`);
            state.phase = PHASE.LIVE;
            state.emergency_hedge_failed = true;

            await this.updateTrade(trade.id, {
                status: 'live',
                state_data: state,
                last_error: `EMERGENCY_HEDGE_FAILED: ${placeRes.errorCode}`,
            });
            await this.logEvent(trade.id, 'EMERGENCY_HEDGE_FAILED', {
                errorCode: placeRes.errorCode,
                back_exposure: backMatched,
            });
        }
    }
}

module.exports = {
    STRATEGY_KEY,
    PHASE,
    getDefaultSettings,
    createEplOver25BreakoutStrategy: (deps) => new EplOver25BreakoutStrategy(deps),
};

