/**
 * Shared utilities for EPL Under 2.5 strategies
 * Extracted for reuse across pre-match and goal-reactive strategies
 */

const { addDays } = require('date-fns');
const { roundToBetfairTick } = require('../betfair-utils');

// --- Constants ---
const SOCCER_EVENT_TYPE_ID = '1';
const UNDER_RUNNER_NAME = 'Under 2.5 Goals';

// Match multiple leagues: EPL, Bundesliga, La Liga, Serie A
const COMPETITION_MATCHERS = [
  /^English Premier League$/i,  // EPL
  /^German Bundesliga$/i,        // Bundesliga
  /^Spanish La Liga$/i,          // La Liga
  /^Italian Serie A$/i,          // Serie A
  /^UEFA Champions League$/i,    // Champions League
  /^UEFA Europa League$/i,  // UEFA Europa League
  /^Africa Cup of Nations$/i,  // Africa Cup of Nations
  /^English Football League Cup$/i,  // English Football League Cup
];

// Competition IDs from Betfair
const COMPETITION_IDS = [
  '10932509',  // English Premier League
  '59',        // German Bundesliga
  '117',       // Spanish La Liga
  '81',        // Italian Serie A
  '228',       //UEFA Champions League
  '2005',      // UEFA Europa League
  '12209528',  // Africa Cup of Nations
  '2134',      // English Football League Cup
];

// --- Stake/Price Calculations ---

/**
 * Calculate lay stake for balanced hedge
 */
function calculateLayStake({ backStake, backPrice, layPrice, commission = 0.02 }) {
  if (!backStake || !backPrice || !layPrice) {
    return { layStake: 0, profitBack: 0, profitLay: 0 };
  }
  
  const rawStake = (backStake * backPrice) / layPrice;
  const layStake = Math.max(0, Math.round(rawStake * 100) / 100);
  
  const profitBackBeforeComm = backStake * (backPrice - 1) - layStake * (layPrice - 1);
  const profitLayBeforeComm = layStake - backStake;
  
  const profitBack = Number((profitBackBeforeComm * (1 - commission)).toFixed(2));
  const profitLay = Number((profitLayBeforeComm * (1 - commission)).toFixed(2));
  
  return { layStake, profitBack, profitLay };
}

/**
 * Calculate hedge stake from market book
 */
function calculateHedgeStake(book, selectionId, backStake, backPrice, commission = 0.02, overrideLayPrice = null) {
  const runner = book?.runners?.find(r => r.selectionId == selectionId);
  if (!runner) return { layStake: 0, layPrice: 0 };

  const marketLayPrice = runner.ex?.availableToLay?.[0]?.price;
  const effectiveLayPrice = overrideLayPrice || marketLayPrice;

  if (!effectiveLayPrice) return { layStake: 0, layPrice: 0 };

  const result = calculateLayStake({
    backStake,
    backPrice,
    layPrice: effectiveLayPrice,
    commission
  });

  return { ...result, layPrice: effectiveLayPrice };
}

/**
 * Compute target lay price based on profit percentage
 */
function computeTargetLayPrice(backPrice, settings) {
  const profitPct = settings?.min_profit_pct || 10;
  const target = backPrice / (1 + (profitPct / 100));
  return roundToBetfairTick(target);
}

/**
 * Calculate realised P&L snapshot for a green-up/red-up trade.
 * 
 * IMPORTANT: Only returns a P&L value when BOTH back AND lay bets are matched.
 * Returns null if either back or lay data is missing - prevents storing incorrect
 * unhedged profits as realised P&L.
 * 
 * Green-up formula:
 * - Profit if selection wins:  backStake × (backPrice - 1) - layStake × (layPrice - 1)
 * - Profit if selection loses: layStake - backStake
 * - Realised P&L = min(profitIfWins, profitIfLoses)
 * 
 * Commission handling:
 * - Betfair charges commission only on net winnings (profitable markets)
 * - If the net result is negative (loss), no commission is charged
 * - If the net result is positive (profit), commission is deducted from winnings
 */
function computeRealisedPnlSnapshot({ backStake, backPrice, layStake, layPrice, commission = 0.02 }) {
  // Return null if back data is missing
  if (!backStake || !backPrice) {
    return null;
  }
  
  // CRITICAL FIX: Return null if lay data is missing
  // Do NOT calculate unhedged profit - the trade isn't complete yet
  if (!layStake || layStake <= 0 || !layPrice || layPrice <= 0) {
    return null;  // Trade not hedged - no P&L to report
  }
  
  // Both back and lay are present - calculate green-up P&L
  // Profit if selection WINS (back bet wins, lay bet loses)
  const profitIfWins = backStake * (backPrice - 1) - layStake * (layPrice - 1);
  
  // Profit if selection LOSES (back bet loses, lay bet wins)
  const profitIfLoses = layStake - backStake;
  
  // Realised P&L is the guaranteed minimum profit (or maximum loss)
  const grossRealised = Math.min(profitIfWins, profitIfLoses);
  
  // Apply commission only to profits (net winnings), not losses
  // Betfair charges commission at the overall market level only on profitable markets
  const realised = grossRealised >= 0 
    ? grossRealised * (1 - commission)  // Commission deducted from profits
    : grossRealised;  // No commission on losses
  
  return Number(realised.toFixed(2));
}

// --- Naming Helpers ---

function formatFixtureName(home, away, fallback = null) {
  if (home && away) {
    return `${home} v ${away}`;
  }
  return fallback || null;
}

// --- Betfair Tick Helpers ---

/**
 * Get N ticks below a price
 */
function ticksBelow(price, ticks = 1) {
  const bands = [
    { max: 2.0, step: 0.01 },
    { max: 3.0, step: 0.02 },
    { max: 4.0, step: 0.05 },
    { max: 6.0, step: 0.1 },
    { max: 10.0, step: 0.2 },
    { max: 20.0, step: 0.5 },
    { max: 30.0, step: 1.0 },
    { max: 50.0, step: 2.0 },
    { max: 100.0, step: 5.0 },
    { max: 1000.0, step: 10.0 },
  ];
  
  let current = price;
  for (let i = 0; i < ticks; i++) {
    const band = bands.find((b) => current <= b.max) || bands[bands.length - 1];
    current = current - band.step;
  }
  return roundToBetfairTick(Math.max(1.01, current));
}

/**
 * Get N ticks above a price
 */
function ticksAbove(price, ticks = 1) {
  const bands = [
    { max: 2.0, step: 0.01 },
    { max: 3.0, step: 0.02 },
    { max: 4.0, step: 0.05 },
    { max: 6.0, step: 0.1 },
    { max: 10.0, step: 0.2 },
    { max: 20.0, step: 0.5 },
    { max: 30.0, step: 1.0 },
    { max: 50.0, step: 2.0 },
    { max: 100.0, step: 5.0 },
    { max: 1000.0, step: 10.0 },
  ];
  
  let current = price;
  for (let i = 0; i < ticks; i++) {
    const band = bands.find((b) => current <= b.max) || bands[bands.length - 1];
    current = current + band.step;
  }
  return roundToBetfairTick(Math.min(1000, current));
}

/**
 * Check if two prices are within N ticks of each other
 */
function isWithinTicks(price1, price2, maxTicks = 1) {
  // Calculate how many ticks apart the prices are
  let tickCount = 0;
  let current = Math.min(price1, price2);
  const target = Math.max(price1, price2);
  
  while (current < target && tickCount <= maxTicks + 1) {
    current = ticksAbove(current, 1);
    tickCount++;
  }
  
  return tickCount <= maxTicks;
}

/**
 * Get middle price between back and lay (for tight spreads)
 */
function getMiddlePrice(backPrice, layPrice) {
  // If lay is only 1 tick above back, use lay price
  const oneTickAbove = ticksAbove(backPrice, 1);
  if (Math.abs(layPrice - oneTickAbove) < 0.001) {
    return layPrice;
  }
  
  // Otherwise calculate middle and round to valid tick
  const middle = (backPrice + layPrice) / 2;
  return roundToBetfairTick(middle);
}

// --- Safe API Wrappers ---

/**
 * Create safe API wrapper functions for a strategy instance
 */
function createSafeApiWrappers(betfair, logger) {
  function isInvalidSessionError(err) {
    const msg = err && err.message ? err.message : String(err);
    return /INVALID_SESSION_INFORMATION|ANGX-0003/i.test(msg);
  }

  async function requireSessionWithRetry(label) {
    try {
      return await betfair.requireSession(label);
    } catch (err) {
      logger.warn(`[shared] Session retry needed for ${label}: ${err.message}`);
      return await betfair.requireSession(label);
    }
  }

  async function rpcWithRetry(sessionToken, method, params, label) {
    try {
      return await betfair.rpc(sessionToken, method, params);
    } catch (err) {
      logger.warn(`[shared] RPC retry needed for ${label} (${method}): ${err.message}`);
      try {
        if (isInvalidSessionError(err) && typeof betfair.invalidateSession === 'function') {
          logger.warn(`[shared] Invalid session detected for ${label}; re-authenticating...`);
          betfair.invalidateSession();
          const newToken = await requireSessionWithRetry(`reauth-${label}`);
          return await betfair.rpc(newToken, method, params);
        }
        return await betfair.rpc(sessionToken, method, params);
      } catch (err2) {
        logger.error(`[shared] Emergency Exit: ${label} ${err2.message}`);
        throw err2;
      }
    }
  }

  async function getMarketBookSafe(marketId, sessionToken, label) {
    try {
      const books = await rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listMarketBook', {
        marketIds: [marketId],
        priceProjection: { priceData: ['EX_BEST_OFFERS'] },
      }, label);
      return books?.[0];
    } catch {
      return null;
    }
  }

  async function getOrderStatusSafe(betId, sessionToken, label) {
    if (!betId) return null;
    try {
      const res = await rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCurrentOrders', {
        betIds: [betId],
        orderProjection: 'ALL',
      }, label);
      return res?.currentOrders?.[0]?.status;
    } catch {
      return null;
    }
  }

  /**
   * Get full order details including matched/remaining sizes
   * CRITICAL: Use this to verify actual matched amounts before settling
   * 
   * Returns: { status, sizeMatched, sizeRemaining, averagePriceMatched, betId } or null
   */
  async function getOrderDetailsSafe(betId, sessionToken, label) {
    if (!betId) return null;
    try {
      const res = await rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listCurrentOrders', {
        betIds: [betId],
        orderProjection: 'ALL',
      }, label);
      const order = res?.currentOrders?.[0];
      if (!order) {
        // Order not found - might be fully matched and cleared, or cancelled
        // Check cleared orders
        try {
          const clearedRes = await rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listClearedOrders', {
            betIds: [betId],
            betStatus: 'SETTLED',
          }, `${label}-cleared`);
          const clearedOrder = clearedRes?.clearedOrders?.[0];
          if (clearedOrder) {
            return {
              status: 'EXECUTION_COMPLETE',
              sizeMatched: clearedOrder.sizeSettled || clearedOrder.priceMatched || 0,
              sizeRemaining: 0,
              averagePriceMatched: clearedOrder.priceMatched,
              betId,
              cleared: true,
            };
          }
        } catch {
          // Cleared orders check failed, order might be cancelled
        }
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
        persistenceType: order.persistenceType,
        cleared: false,
      };
    } catch (err) {
      logger.error(`[shared] getOrderDetailsSafe error for ${betId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Verify an order is ACTUALLY matched (not just status check)
   * Returns: { matched: boolean, sizeMatched: number, cancelled: boolean, lapsed: boolean }
   */
  async function verifyOrderMatched(betId, expectedSize, sessionToken, label) {
    const details = await getOrderDetailsSafe(betId, sessionToken, label);
    
    if (!details) {
      // Order not found anywhere - treat as cancelled/lapsed
      logger.warn(`[shared] Order ${betId} not found - treating as cancelled`);
      return { matched: false, sizeMatched: 0, cancelled: true, lapsed: false, details: null };
    }
    
    const sizeMatched = details.sizeMatched || 0;
    const sizeRemaining = details.sizeRemaining || 0;
    
    // EXECUTION_COMPLETE = fully matched
    if (details.status === 'EXECUTION_COMPLETE') {
      return { matched: true, sizeMatched, cancelled: false, lapsed: false, details };
    }
    
    // EXECUTABLE = partially matched, still open
    if (details.status === 'EXECUTABLE') {
      const partiallyMatched = sizeMatched > 0;
      return { 
        matched: false, 
        sizeMatched, 
        cancelled: false, 
        lapsed: false, 
        partiallyMatched,
        details 
      };
    }
    
    // Any other status (CANCELLED, etc.) - order is dead
    logger.warn(`[shared] Order ${betId} has unexpected status: ${details.status}`);
    return { matched: false, sizeMatched, cancelled: true, lapsed: false, details };
  }

  /**
   * Cancel an order on Betfair.
   * @param {string} betId - The bet ID to cancel
   * @param {string} marketId - The market ID (REQUIRED by Betfair API)
   * @param {string} sessionToken - Session token
   * @param {string} label - Label for logging
   * @returns {Promise<{status: string, errorCode?: string, sizeMatched?: number, sizeCancelled?: number}>}
   */
  async function cancelOrderSafe(betId, marketId, sessionToken, label) {
    if (!betId) {
      return { status: 'FAILED', errorCode: 'NO_BET_ID' };
    }
    if (!marketId) {
      logger.error(`[shared] cancelOrderSafe: marketId is required for bet ${betId}`);
      return { status: 'FAILED', errorCode: 'NO_MARKET_ID' };
    }
    try {
      const res = await rpcWithRetry(sessionToken, 'SportsAPING/v1.0/cancelOrders', {
        marketId,
        instructions: [{ betId }],
      }, label);
      
      const report = res?.instructionReports?.[0];
      if (report && report.status === 'SUCCESS') {
        return { 
          status: 'SUCCESS', 
          sizeMatched: report.instruction?.sizeReduction || 0,
          sizeCancelled: report.sizeCancelled || 0,
        };
      }
      
      // API returned failure
      const errorCode = report?.errorCode || res?.errorCode || 'UNKNOWN';
      logger.warn(`[shared] cancelOrderSafe failed for bet ${betId}: ${errorCode}`);
      return { status: 'FAILED', errorCode };
    } catch (err) {
      logger.error(`[shared] cancelOrderSafe exception for bet ${betId}: ${err.message}`);
      return { status: 'FAILED', errorCode: 'EXCEPTION' };
    }
  }

  async function placeLimitOrderSafe(marketId, selectionId, side, size, price, sessionToken, label, persistenceType = 'LAPSE') {
    const customerRef = `${side}-${Date.now()}`;
    try {
      const placeRes = await rpcWithRetry(sessionToken, 'SportsAPING/v1.0/placeOrders', {
        marketId,
        customerRef,
        instructions: [
          {
            selectionId,
            side,
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
    } catch {
      return { status: 'FAILED', errorCode: 'EXCEPTION' };
    }
  }

  return {
    requireSessionWithRetry,
    rpcWithRetry,
    getMarketBookSafe,
    getOrderStatusSafe,
    getOrderDetailsSafe,
    verifyOrderMatched,
    cancelOrderSafe,
    placeLimitOrderSafe,
  };
}

// --- Market/Runner Resolution ---

async function ensureMarket(supabase, betfair, trade, sessionToken, strategyKey, logger) {
  if (trade.betfair_market_id && trade.selection_id) {
    return { marketId: trade.betfair_market_id, selectionId: trade.selection_id };
  }

  const { rpcWithRetry } = createSafeApiWrappers(betfair, logger);
  
  const markets = await rpcWithRetry(sessionToken, 'SportsAPING/v1.0/listMarketCatalogue', {
    filter: {
      eventIds: [trade.betfair_event_id],
      marketTypeCodes: ['OVER_UNDER_25'],
    },
    maxResults: 1,
    marketProjection: ['RUNNER_METADATA'],
  }, 'ensureMarket');

  const market = markets?.[0];
  if (!market) {
    logger.warn(`[${strategyKey}] Market OVER_UNDER_25 not found for event ${trade.betfair_event_id}`);
    return null;
  }

  const runner = market.runners.find(r => r.runnerName === UNDER_RUNNER_NAME || r.runnerName === 'Under 2.5 Goals');
  if (!runner) {
    logger.warn(`[${strategyKey}] Runner ${UNDER_RUNNER_NAME} not found in market ${market.marketId}`);
    return null;
  }

  await supabase
    .from('strategy_trades')
    .update({
      betfair_market_id: market.marketId,
      selection_id: runner.selectionId,
    })
    .eq('id', trade.id);

  return { marketId: market.marketId, selectionId: runner.selectionId };
}

module.exports = {
  // Constants
  SOCCER_EVENT_TYPE_ID,
  UNDER_RUNNER_NAME,
  COMPETITION_MATCHERS,
  COMPETITION_IDS,
  
  // Calculations
  calculateLayStake,
  calculateHedgeStake,
  computeTargetLayPrice,
  computeRealisedPnlSnapshot,
  
  // Naming
  formatFixtureName,
  
  // Tick helpers
  ticksBelow,
  ticksAbove,
  isWithinTicks,
  getMiddlePrice,
  
  // API wrappers
  createSafeApiWrappers,
  
  // Market resolution
  ensureMarket,
};

