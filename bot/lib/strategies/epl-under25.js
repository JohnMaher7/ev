const { addDays } = require('date-fns');

const { roundToBetfairTick } = require('../betfair-utils');

const STRATEGY_KEY = 'epl_under25';
const SOCCER_EVENT_TYPE_ID = '1';
const UNDER_RUNNER_NAME = 'Under 2.5 Goals';
const COMPETITION_MATCHERS = [/english premier league/i, /premier league/i];
const EPL_COMPETITION_IDS = ['10932509'];

function getDefaultSettings() {
  return {
    default_stake: parseFloat(process.env.EPL_UNDER25_DEFAULT_STAKE || '10'),
    min_back_price: parseFloat(process.env.EPL_UNDER25_MIN_BACK_PRICE || '2.0'),
    lay_target_price: parseFloat(process.env.EPL_UNDER25_LAY_TARGET_PRICE || '1.9'),
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

function computeTargetLayPrice(backPrice, settings) {
  const target = settings?.lay_target_price || 1.9;
  const price = backPrice ? Math.min(target, backPrice) : target;
  return roundToBetfairTick(price);
}

class EplUnder25Strategy {
  constructor({ supabase, betfair, logger = console }) {
    this.supabase = supabase;
    this.betfair = betfair;
    this.logger = logger;
    this.settings = null;
    this.defaults = getDefaultSettings();

    this.processingTrades = false;
    this.syncingFixtures = false;

    this.timers = [];
  }

  async start() {
    await this.ensureSettings();
    await this.syncFixtures('startup');
    await this.processTrades('startup');

    this.watchSettings();
    // Sync fixtures every 6 hours
    this.timers.push(setInterval(() => this.syncFixtures('interval').catch(this.logError('syncFixtures')), 6 * 60 * 60 * 1000));
    // Process trades every 45 seconds
    this.timers.push(setInterval(() => this.processTrades('interval').catch(this.logError('processTrades')), 45 * 1000));

    this.logger.log('[strategy:epl_under25] started');
  }

  async stop() {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }

  logError(method) {
    return (err) => {
      this.logger.error(`[strategy:epl_under25] ${method} error:`, err && err.message ? err.message : err);
    };
  }

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

      const sessionToken = await this.betfair.requireSession(`fixtures-${trigger}`);
      const competitionsRes = await this.betfair.rpc(sessionToken, 'SportsAPING/v1.0/listCompetitions', {
        filter: { eventTypeIds: [SOCCER_EVENT_TYPE_ID] },
      });

      const matchedCompetitionIds = (competitionsRes || [])
        .filter((c) => COMPETITION_MATCHERS.some((rx) => rx.test(c.competition?.name || '')))
        .map((c) => c.competition?.id)
        .filter(Boolean);

      const competitionIds = EPL_COMPETITION_IDS;

      this.logger.log('[strategy:epl_under25] competitions', {
        totalReturned: competitionsRes ? competitionsRes.length : 0,
        matchedByName: matchedCompetitionIds.length,
        usingIds: competitionIds,
      });

      if (!competitionIds.length) {
        this.logger.warn('[strategy:epl_under25] no EPL competition ids found');
        return;
      }

      const eventsRes = await this.betfair.rpc(sessionToken, 'SportsAPING/v1.0/listEvents', {
        filter: {
          eventTypeIds: [SOCCER_EVENT_TYPE_ID],
          competitionIds,
          marketStartTime: {
            from: now.toISOString(),
            to: windowEnd.toISOString(),
          },
        },
        maxResults: 200,
      });

      const fixtures = (eventsRes || []).map((evt) => {
        const parts = (evt.event?.name || '').split(' v ');
        const home = parts[0] || null;
        const away = parts[1] || null;
        return {
          strategy_key: STRATEGY_KEY,
          betfair_event_id: evt.event.id,
          event_id: evt.event.id,
          competition: evt.event?.countryCode || 'EPL',
          home,
          away,
          kickoff_at: evt.event?.openDate,
          metadata: evt,
        };
      });

      this.logger.log('[strategy:epl_under25] events', {
        totalReturned: eventsRes ? eventsRes.length : 0,
        fixturesPrepared: fixtures.length,
        windowStart: now.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });

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

      for (const fixture of fixtures) {
        await this.ensureTradeRecord(fixture);
      }
    } finally {
      this.syncingFixtures = false;
    }
  }

  async ensureTradeRecord(fixture) {
    const { data: existing, error } = await this.supabase
      .from('strategy_trades')
      .select('id')
      .eq('strategy_key', STRATEGY_KEY)
      .eq('betfair_event_id', fixture.betfair_event_id)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    if (existing) return existing.id;

    const insert = {
      strategy_key: STRATEGY_KEY,
      betfair_event_id: fixture.betfair_event_id,
      event_id: fixture.event_id,
      runner_name: UNDER_RUNNER_NAME,
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

  async processTrades(trigger = 'manual') {
    if (this.processingTrades) return;
    this.processingTrades = true;
    try {
      if (!this.settings?.enabled) return;

      const { data: trades, error } = await this.supabase
        .from('strategy_trades')
        .select('*')
        .eq('strategy_key', STRATEGY_KEY)
        .in('status', ['scheduled', 'back_pending', 'back_matched', 'hedge_pending'])
        .order('kickoff_at', { ascending: true });
      if (error) throw error;

      if (!trades || trades.length === 0) return;

      const now = new Date();
      for (const trade of trades) {
        try {
          switch (trade.status) {
            case 'scheduled':
              await this.handleScheduledTrade(trade, now, trigger);
              break;
            case 'back_pending':
              await this.checkBackOrder(trade, now);
              break;
            case 'back_matched':
              await this.handleHedge(trade, now);
              break;
            case 'hedge_pending':
              await this.checkLayOrder(trade, now);
              break;
            default:
              break;
          }
        } catch (err) {
          this.logger.error('[strategy:epl_under25] trade processing error:', err.message || err);
        }
      }
    } finally {
      this.processingTrades = false;
    }
  }

  async handleScheduledTrade(trade, now, trigger) {
    const kickoff = trade.kickoff_at ? new Date(trade.kickoff_at) : null;
    if (!kickoff) return;
    const minsToKick = (kickoff.getTime() - now.getTime()) / 60000;

    if (minsToKick < -10) {
      await this.updateTrade(trade.id, { status: 'cancelled', last_error: 'Missed pre-match window' });
      await this.logEvent(trade.id, 'MISSED_WINDOW', { now: now.toISOString(), kickoff: kickoff.toISOString() });
      return;
    }

    if (minsToKick <= (this.settings.back_lead_minutes || this.defaults.back_lead_minutes) && minsToKick > 0) {
      await this.placeBackOrder(trade, trigger);
    }
  }

  async placeBackOrder(trade, trigger) {
    const sessionToken = await this.betfair.requireSession(`back-order-${trigger}`);
    const market = await this.ensureMarket(trade, sessionToken);
    if (!market) return;

    const bookRes = await this.betfair.rpc(sessionToken, 'SportsAPING/v1.0/listMarketBook', {
      marketIds: [market.marketId],
      priceProjection: { priceData: ['EX_BEST_OFFERS'] },
    });
    const runner = (bookRes?.[0]?.runners || []).find((r) => r.selectionId === market.selectionId);
    const lay = runner?.ex?.availableToLay?.[0];
    if (!lay || !lay.price) {
      this.logger.log('[strategy:epl_under25] no lay offers available');
      return;
    }
    if (lay.price < (this.settings.min_back_price || this.defaults.min_back_price)) {
      this.logger.log('[strategy:epl_under25] lay price below threshold', lay.price);
      return;
    }

    const stake = this.settings.default_stake || this.defaults.default_stake;
    const price = roundToBetfairTick(lay.price);
    const instructions = [
      {
        selectionId: market.selectionId,
        side: 'BACK',
        orderType: 'LIMIT',
        limitOrder: {
          size: stake,
          price,
          persistenceType: 'LAPSE',
        },
      },
    ];

    const placeRes = await this.betfair.rpc(sessionToken, 'SportsAPING/v1.0/placeOrders', {
      marketId: market.marketId,
      customerRef: `epl-under25-${trade.event_id}-${Date.now()}`,
      instructions,
    });

    const report = placeRes?.instructionReports?.[0];
    if (!report || report.status !== 'SUCCESS') {
      const reason = report?.errorCode || placeRes?.errorCode || 'UNKNOWN_ERROR';
      await this.updateTrade(trade.id, { last_error: `BACK_PLACE_FAILED:${reason}` });
      await this.logEvent(trade.id, 'BACK_PLACE_FAILED', { reason, payload: placeRes });
      return;
    }

    const hedgePrice = computeTargetLayPrice(price, this.settings);
    const update = {
      status: report.sizeMatched && report.sizeMatched >= stake ? 'back_matched' : 'back_pending',
      betfair_market_id: market.marketId,
      runner_name: UNDER_RUNNER_NAME,
      back_order_ref: report.betId,
      back_price: price,
      back_size: stake,
      back_matched_size: report.sizeMatched || 0,
      hedge_target_price: hedgePrice,
      last_error: null,
    };
    await this.updateTrade(trade.id, update);
    await this.logEvent(trade.id, 'BACK_PLACED', { price, stake, hedgePrice, report });

    if (update.status === 'back_matched') {
      await this.logEvent(trade.id, 'BACK_MATCHED', { price: report.averagePriceMatched || price, size: report.sizeMatched });
    }
  }

  async ensureMarket(trade, sessionToken) {
    if (trade.betfair_market_id && trade.selection_id) {
      return { marketId: trade.betfair_market_id, selectionId: trade.selection_id };
    }

    const catalogue = await this.betfair.rpc(sessionToken, 'SportsAPING/v1.0/listMarketCatalogue', {
      filter: {
        marketTypeCodes: ['OVER_UNDER_25'],
        eventIds: [trade.betfair_event_id],
      },
      maxResults: 5,
      marketProjection: ['RUNNER_DESCRIPTION'],
    });

    const market = (catalogue || []).find(Boolean);
    if (!market) {
      this.logger.warn('[strategy:epl_under25] market not found for event', trade.betfair_event_id);
      return null;
    }
    const runner = (market.runners || []).find((r) => r.runnerName === UNDER_RUNNER_NAME);
    if (!runner) {
      this.logger.warn('[strategy:epl_under25] runner not found for market', market.marketId);
      return null;
    }
    await this.updateTrade(trade.id, {
      betfair_market_id: market.marketId,
      selection_id: runner.selectionId,
    });
    return { marketId: market.marketId, selectionId: runner.selectionId };
  }

  async checkBackOrder(trade, now) {
    const sessionToken = await this.betfair.requireSession('back-order-check');
    const res = await this.betfair.rpc(sessionToken, 'SportsAPING/v1.0/listCurrentOrders', {
      betIds: [trade.back_order_ref],
      orderProjection: 'ALL',
    });
    const order = res?.currentOrders?.[0];
    if (!order) {
      // Assume matched if already cleared
      await this.updateTrade(trade.id, { status: 'back_matched', back_matched_size: trade.back_size, last_error: null });
      await this.logEvent(trade.id, 'BACK_ASSUMED_MATCHED', {});
      return;
    }

    if (order.status === 'EXECUTION_COMPLETE' || order.sizeMatched >= (trade.back_size || 0)) {
      await this.updateTrade(trade.id, {
        status: 'back_matched',
        back_matched_size: order.sizeMatched,
        back_price: order.averagePriceMatched || order.price,
        last_error: null,
      });
      await this.logEvent(trade.id, 'BACK_MATCHED', { order });
      return;
    }

    const kickoff = trade.kickoff_at ? new Date(trade.kickoff_at) : null;
    if (kickoff && now > kickoff) {
      // cancel order once event in-play
      await this.betfair.rpc(sessionToken, 'SportsAPING/v1.0/cancelOrders', {
        marketId: trade.betfair_market_id,
        instructions: [{ betId: trade.back_order_ref }],
      });
      await this.updateTrade(trade.id, { status: 'cancelled', last_error: 'BACK_UNMATCHED_AT_KICKOFF' });
      await this.logEvent(trade.id, 'BACK_CANCELLED', { order });
    }
  }

  async handleHedge(trade, now) {
    const kickoff = trade.kickoff_at ? new Date(trade.kickoff_at) : null;
    if (!kickoff || now < kickoff) {
      return;
    }
    const sessionToken = await this.betfair.requireSession('hedge-check');
    const market = await this.ensureMarket(trade, sessionToken);
    if (!market) return;

    const books = await this.betfair.rpc(sessionToken, 'SportsAPING/v1.0/listMarketBook', {
      marketIds: [market.marketId],
      priceProjection: { priceData: ['EX_BEST_OFFERS'] },
    });
    const marketBook = books?.[0];
    if (!marketBook || !marketBook.inplay) {
      return; // wait until in-play
    }
    const runner = (marketBook.runners || []).find((r) => r.selectionId === market.selectionId);
    if (!runner) return;

    const targetPrice = computeTargetLayPrice(trade.back_price, this.settings);
    const bestBack = runner.ex?.availableToBack?.[0];
    if (!bestBack || bestBack.price > targetPrice) {
      // wait until price <= target price
      return;
    }

    const { layStake } = calculateLayStake({
      backStake: trade.back_matched_size || trade.back_size,
      backPrice: trade.back_price,
      layPrice: targetPrice,
      commission: this.settings.commission_rate || this.defaults.commission_rate,
    });
    if (layStake <= 0.0) {
      await this.updateTrade(trade.id, { last_error: 'LAY_STAKE_ZERO' });
      return;
    }

    const placeRes = await this.betfair.rpc(sessionToken, 'SportsAPING/v1.0/placeOrders', {
      marketId: market.marketId,
      customerRef: `epl-under25-hedge-${trade.event_id}-${Date.now()}`,
      instructions: [
        {
          selectionId: market.selectionId,
          side: 'LAY',
          orderType: 'LIMIT',
          limitOrder: {
            size: layStake,
            price: targetPrice,
            persistenceType: 'LAPSE',
          },
        },
      ],
    });

    const report = placeRes?.instructionReports?.[0];
    if (!report || report.status !== 'SUCCESS') {
      const reason = report?.errorCode || placeRes?.errorCode || 'UNKNOWN_ERROR';
      await this.updateTrade(trade.id, { last_error: `LAY_PLACE_FAILED:${reason}` });
      await this.logEvent(trade.id, 'LAY_PLACE_FAILED', { reason, payload: placeRes });
      return;
    }

    const nextStatus = report.sizeMatched && report.sizeMatched >= layStake ? 'hedged' : 'hedge_pending';
    const update = {
      status: nextStatus,
      lay_order_ref: report.betId,
      lay_price: targetPrice,
      lay_size: layStake,
      lay_matched_size: report.sizeMatched || 0,
      last_error: null,
    };
    await this.updateTrade(trade.id, update);
    await this.logEvent(trade.id, 'LAY_PLACED', { price: targetPrice, stake: layStake, report });

    if (nextStatus === 'hedged') {
      await this.finaliseHedge(trade.id, targetPrice, layStake, report.averagePriceMatched || targetPrice);
    }
  }

  async checkLayOrder(trade) {
    const sessionToken = await this.betfair.requireSession('hedge-order-check');
    const res = await this.betfair.rpc(sessionToken, 'SportsAPING/v1.0/listCurrentOrders', {
      betIds: [trade.lay_order_ref],
      orderProjection: 'ALL',
    });
    const order = res?.currentOrders?.[0];
    if (!order) {
      await this.finaliseHedge(trade.id, trade.lay_price, trade.lay_size, trade.lay_price);
      return;
    }

    if (order.status === 'EXECUTION_COMPLETE' || order.sizeMatched >= (trade.lay_size || 0)) {
      await this.finaliseHedge(trade.id, order.price, order.sizeMatched, order.averagePriceMatched || order.price);
    }
  }

  async finaliseHedge(tradeId, layPrice, layMatchedSize, avgLayPrice) {
    const { data: trade, error } = await this.supabase
      .from('strategy_trades')
      .select('back_size, back_price, back_matched_size, lay_size, lay_price, commission_paid, target_stake')
      .eq('id', tradeId)
      .maybeSingle();
    if (error) throw error;
    if (!trade) return;

    const backStake = trade.back_matched_size || trade.back_size;
    const { profitBack, profitLay } = calculateLayStake({
      backStake,
      backPrice: trade.back_price,
      layPrice: avgLayPrice || layPrice,
      commission: this.settings.commission_rate || this.defaults.commission_rate,
    });
    const pnl = Number(((profitBack + profitLay) / 2).toFixed(2));
    const margin = backStake ? Number((pnl / backStake).toFixed(6)) : 0;

    await this.updateTrade(tradeId, {
      status: 'hedged',
      lay_matched_size: layMatchedSize,
      pnl,
      margin,
      commission_paid: Number(((trade.lay_size || 0) * (this.settings.commission_rate || this.defaults.commission_rate)).toFixed(2)),
      last_error: null,
    });
    await this.logEvent(tradeId, 'LAY_MATCHED', { layPrice: avgLayPrice || layPrice, layMatchedSize, pnl, margin });
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
  computeTargetLayPrice,
  createEplUnder25Strategy: (deps) => new EplUnder25Strategy(deps),
};

