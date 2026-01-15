/*
  Persistent Betfair Bot: certificate login + keepAlive
  - Performs cert login on startup to obtain sessionToken
  - Schedules keepAlive every 15 minutes using node-cron
  - On keepAlive failure, immediately re-logins and replaces the in-memory token
  - Reads secrets from environment variables
*/

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '.env.local'),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    const result = dotenv.config({ path: envPath, override: true });
    if (result.error) {
      console.warn(`[bot] Failed to load ${envPath}:`, result.error.message);
    }
  }
}
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const crypto = require('node:crypto');

const {
  initializeSessionManager,
  ensureLogin,
  keepAlive,
  getSessionToken,
  setSessionToken,
  invalidateSession,
  betfairRpc,
  getLoginDiagnostics,
} = require('./lib/betfair-session');
const { roundToBetfairTick, findBestMatch } = require('./lib/betfair-utils');
const { createEplUnder25Strategy } = require('./lib/strategies/epl-under25');
const { createEplUnder25GoalReactStrategy } = require('./lib/strategies/epl-under25-goalreact');
const { createEplOver25BreakoutStrategy } = require('./lib/strategies/epl-over25-breakout');

initializeSessionManager({ logger: console });


// --- Betfair JSON-RPC helpers ---
function mapMarketKeyToTypeCode(marketKey) {
  const m = String(marketKey || '').match(/^(.*?)(?: \(line: ([0-9.]+)\))?$/);
  const base = m ? m[1] : marketKey;
  const line = m && m[2] ? parseFloat(m[2]) : undefined;
  if (base === 'h2h') return { typeCode: 'MATCH_ODDS', lineText: undefined };
  if (base === 'totals' && typeof line === 'number') {
    const codeNum = Math.round(line * 10);
    return { typeCode: `OVER_UNDER_${codeNum}`, lineText: `${line.toFixed(1)} Goals` };
  }
  return { typeCode: 'MATCH_ODDS', lineText: undefined };
}

function resolveSportKeyToEventTypeName(sportKey) {
  const sk = String(sportKey || '');
  if (sk.startsWith('soccer')) return 'Soccer';
  if (sk.startsWith('tennis')) return 'Tennis';
  return null;
}

async function betfairRpcWithToken(sessionToken, method, params) {
  return betfairRpc(sessionToken, method, params);
}

async function locateMarketAndRunner(sessionToken, ev, marketKey, selection) {
  const sportName = resolveSportKeyToEventTypeName(ev.sport_key);
  if (!sportName) throw new Error(`Unsupported sport_key: ${ev.sport_key}`);
  const eventTypes = await betfairRpcWithToken(sessionToken, 'SportsAPING/v1.0/listEventTypes', { filter: {} });
  const eventType = (eventTypes || []).find(et => et.eventType && et.eventType.name === sportName);
  if (!eventType) throw new Error(`Betfair event type not found: ${sportName}`);
  const eventTypeId = eventType.eventType.id;

  const { typeCode, lineText } = mapMarketKeyToTypeCode(marketKey);
  const start = new Date(new Date(ev.commence_time).getTime() - 12 * 60 * 60 * 1000).toISOString();
  const end = new Date(new Date(ev.commence_time).getTime() + 12 * 60 * 60 * 1000).toISOString();
  const filter = {
    eventTypeIds: [eventTypeId],
    marketTypeCodes: [typeCode],
    marketStartTime: { from: start, to: end },
  };
  const catalogues = await betfairRpcWithToken(sessionToken, 'SportsAPING/v1.0/listMarketCatalogue', {
    filter,
    maxResults: 200,
    marketProjection: ['RUNNER_DESCRIPTION', 'EVENT'],
  });

  const oddsEventName = `${ev.home} vs ${ev.away}`;
  const uniqueEvents = [...new Map((catalogues || []).map(c => [c.event?.name, c.event])).values()];
  const matchedEventName = findBestMatch(oddsEventName, uniqueEvents.map(e => e?.name || ''), { logger: console });
  if (!matchedEventName) {
    throw new Error(`Fuzzy match failed for event: ${oddsEventName}`);
  }

  const candidates = (catalogues || []).filter(c => c.event?.name === matchedEventName);

  const wantedRunnerName = (() => {
    if (typeCode === 'MATCH_ODDS') {
      if (selection === ev.home) return ev.home;
      if (selection === ev.away) return ev.away;
      if (/draw/i.test(selection)) return 'The Draw';
      return selection;
    }
    const lt = lineText || `${selection} Goals`;
    if (/over/i.test(selection)) return `Over ${lt}`;
    if (/under/i.test(selection)) return `Under ${lt}`;
    return selection;
  })();

  for (const market of candidates) {
    const runnerNames = (market.runners || []).map(r => r.runnerName);
    const matchedRunner = findBestMatch(wantedRunnerName, runnerNames, { logger: console });
    if (!matchedRunner) continue;
    const hit = market.runners.find(r => r.runnerName === matchedRunner);
    if (hit) {
      return { marketId: market.marketId, selectionId: hit.selectionId, runnerName: hit.runnerName };
    }
  }

  throw new Error(`No matching market/runner found on Betfair for event ${matchedEventName}`);
}

// --- Login orchestration with backoff/ban handling ---
async function main() {
  console.log('[bot] Starting Betfair bot...');
  // Kick off login (non-fatal if it fails; backoff handles retries)
  ensureLogin('startup');

  async function requireSession(trigger) {
    let token = getSessionToken();
    if (token) return token;
    await ensureLogin(trigger);
    token = getSessionToken();
    if (!token) {
      throw new Error('Betfair session unavailable after ensureLogin');
    }
    return token;
  }

  // --- Supabase connection & candidate loop ---
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let eplStrategy = null;
  if (!supabaseUrl || !supabaseKey) {
    console.warn('[bot] Supabase envs missing (SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY). Subscriber will not start.');
  } else {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });

    const strategyDeps = {
      supabase,
      betfair: {
        requireSession,
        rpc: betfairRpcWithToken,
        invalidateSession,
      },
      logger: console,
    };

    // Strategy 1: Pre-match hedge (back at lay price, immediate lay 2 ticks below)
    if (process.env.ENABLE_EPL_UNDER25_STRATEGY === 'true') {
      eplStrategy = createEplUnder25Strategy(strategyDeps);
      eplStrategy.start().catch((err) => {
        console.error('[strategy:epl_under25] failed to start:', err && err.message ? err.message : err);
      });
    } else {
      console.log('[strategy:epl_under25] disabled (ENABLE_EPL_UNDER25_STRATEGY != true)');
    }

    // Strategy 2: Goal-reactive (wake at kickoff, detect goals, enter post-goal)
    let goalReactStrategy = null;
    if (process.env.ENABLE_EPL_UNDER25_GOALREACT_STRATEGY === 'true') {
      goalReactStrategy = createEplUnder25GoalReactStrategy(strategyDeps);
      goalReactStrategy.start().catch((err) => {
        console.error('[strategy:epl_under25_goalreact] failed to start:', err && err.message ? err.message : err);
      });
    } else {
      console.log('[strategy:epl_under25_goalreact] disabled (ENABLE_EPL_UNDER25_GOALREACT_STRATEGY != true)');
    }

    // Strategy 3: Over 2.5 Breakout (wake at kickoff, detect 1st goal, back Over 2.5)
    let over25BreakoutStrategy = null;
    if (process.env.ENABLE_EPL_OVER25_BREAKOUT_STRATEGY === 'true') {
      over25BreakoutStrategy = createEplOver25BreakoutStrategy(strategyDeps);
      over25BreakoutStrategy.start().catch((err) => {
        console.error('[strategy:epl_over25_breakout] failed to start:', err && err.message ? err.message : err);
      });
    } else {
      console.log('[strategy:epl_over25_breakout] disabled (ENABLE_EPL_OVER25_BREAKOUT_STRATEGY != true)');
    }

    const seenCandidateIds = [];
    const seenCandidateSet = new Set();
    let lastSeenCreatedAt = null;

    async function handleCandidateChange(candidate) {
      try {
        const c = candidate;
        if (!c) return;
        console.log(`[bot] Candidate received: ${c.id} ${c.selection} @ ${c.offered_price}`);

        // Rate limit dedupe: skip if we recently placed bet on same selection
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: existing, error: exErr } = await supabase
          .from('bets')
          .select('id')
          .eq('event_id', c.event_id)
          .eq('market_key', c.market_key)
          .eq('selection', c.selection)
          .eq('source', 'betfair_ex_uk')
          .gte('created_at', oneHourAgo)
          .limit(1);
        if (exErr) console.warn('[bot] dedupe query error:', exErr.message);
        if (existing && existing.length > 0) {
          console.log('[bot] Dedupe: recent bet exists, skipping');
          return;
        }

        // Load event details
        const { data: evRows, error: evErr } = await supabase
          .from('events')
          .select('event_id, sport_key, commence_time, home, away')
          .eq('event_id', c.event_id)
          .limit(1);
        if (evErr || !evRows || evRows.length === 0) {
          console.warn('[bot] Event not found for candidate, skipping');
          return;
        }
        const ev = evRows[0];

        // Time guard
        const cutoffMin = parseInt(process.env.CUTOFF_MINUTES_BEFORE_START || '10');
        const startMs = new Date(ev.commence_time).getTime();
        const minsToStart = (startMs - Date.now()) / 60000;
        if (minsToStart <= cutoffMin) {
          console.log(`[bot] Time guard: event starts in ${minsToStart.toFixed(1)}m <= ${cutoffMin}m, skipping`);
          return;
        }

        // Ensure logged in
        const sessionToken = await requireSession('candidate');

        // Locate market and runner
        const loc = await locateMarketAndRunner(sessionToken, ev, c.market_key, c.selection);

        // Fetch live best back
        const books = await betfairRpcWithToken(sessionToken, 'SportsAPING/v1.0/listMarketBook', {
          marketIds: [loc.marketId],
          priceProjection: { priceData: ['EX_BEST_OFFERS'] },
        });
        const marketBook = books && books[0];
        const rb = (marketBook?.runners || []).find(r => r.selectionId === loc.selectionId);
        const bestBack = rb?.ex?.availableToBack?.[0] || null;
        if (!bestBack || !bestBack.price || !bestBack.size) {
          console.log('[bot] No back offers available, skipping');
          return;
        }

        // Safety checks
        const minEdge = parseFloat(process.env.AUTO_BET_MIN_EDGE || '0.008');
        const slippagePctMax = parseFloat(process.env.SLIPPAGE_PCT_MAX || '0.005'); // 0.5%
        const minLiquidity = parseFloat(process.env.MIN_LIQUIDITY || '25');
        const bankroll = parseFloat(process.env.AUTO_BET_BANKROLL || '1000');
        const minStake = parseFloat(process.env.AUTO_BET_MIN_STAKE || '2');
        const bankCap = parseFloat(process.env.STAKE_BANK_CAP || '0.02');
        const rateLimitMs = parseInt(process.env.ORDER_RATE_LIMIT_MS || '1000');

        if (bestBack.size < minLiquidity) {
          console.log(`[bot] Liquidity guard: ${bestBack.size} < ${minLiquidity}, skipping`);
          return;
        }

        // Edge check
        const livePrice = bestBack.price;
        const implied = 1 / livePrice;
        const edge = c.fair_prob - implied;
        if (edge < minEdge) {
          console.log(`[bot] Edge guard: ${edge.toFixed(6)} < ${minEdge}, skipping`);
          return;
        }

        // Slippage vs candidate price if the candidate came from Betfair
        if (String(c.best_source) === 'betfair_ex_uk') {
          const slippageOk = livePrice >= c.offered_price * (1 - slippagePctMax);
          if (!slippageOk) {
            console.log('[bot] Slippage guard: live price below tolerance vs candidate, skipping');
            return;
          }
        }

        // Rate limit
        if (!main.lastOrderAt) main.lastOrderAt = 0;
        const now = Date.now();
        const elapsed = now - main.lastOrderAt;
        if (elapsed < rateLimitMs) {
          const wait = rateLimitMs - elapsed;
          console.log(`[bot] Order rate limit: waiting ${Math.ceil(wait)}ms`);
          await new Promise(r => setTimeout(r, wait));
        }

        // Stake sizing: quarter Kelly with 2% cap
        const b = livePrice - 1;
        const kelly = b > 0 ? (c.fair_prob * (b + 1) - 1) / b : 0;
        const stakeFraction = Math.max(0, kelly) * 0.25;
        const cappedFraction = Math.min(stakeFraction, bankCap);
        const rawStake = bankroll * cappedFraction;
        const size = Math.max(minStake, Math.round(rawStake * 100) / 100);

        const executionPrice = roundToBetfairTick(livePrice);

        // Place order
        const placeRes = await betfairRpcWithToken(sessionToken, 'SportsAPING/v1.0/placeOrders', {
          marketId: loc.marketId,
          instructions: [
            {
              selectionId: loc.selectionId,
              side: 'BACK',
              orderType: 'LIMIT',
              limitOrder: {
                size,
                price: executionPrice,
                persistenceType: 'LAPSE',
              },
            },
          ],
          customerRef: c.id.substring(0, 32),
        });

        const ir = placeRes.instructionReports && placeRes.instructionReports[0];
        if (!ir || ir.status !== 'SUCCESS') {
          const reason = ir?.errorCode || placeRes.errorCode || placeRes.status || 'UNKNOWN_ERROR';
          console.warn(`[bot] placeOrders failed: ${reason}`);
          return;
        }

        // Log bet in bets table
        const { error: betErr } = await supabase
          .from('bets')
          .insert({
            id: crypto.randomUUID(),
            event_id: c.event_id,
            sport_key: c.sport_key,
            market_key: c.market_key,
            selection: c.selection,
            source: 'betfair_ex_uk',
            odds: executionPrice,
            stake: size,
            accepted_fair_prob: c.fair_prob,
            accepted_fair_price: c.fair_price,
            status: 'pending',
          });
        if (betErr) {
          console.error('[bot] Failed to insert bet:', betErr.message);
        } else {
          console.log(`[bot] Bet placed: market=${loc.marketId} sel=${loc.selectionId} price=${executionPrice} size=${size} edge=${edge.toFixed(6)}`);
        }

        main.lastOrderAt = Date.now();
      } catch (e) {
        console.error('[bot] Candidate handling error:', e && e.message ? e.message : e);
      }
    }

    async function pollPendingCandidates() {
      try {
        console.log('[bot] Polling for new candidates...');
        let query = supabase
          .from('candidates')
          .select('*')
          .eq('best_source', 'betfair_ex_uk')
          .order('created_at', { ascending: true })
          .limit(50);

        if (lastSeenCreatedAt) {
          query = query.gt('created_at', lastSeenCreatedAt);
        }

        const { data, error } = await query;
        if (error) {
          console.error('[bot] Error polling Supabase:', error.message);
          return;
        }

        console.log(`[bot] Poll found ${data ? data.length : 0} new candidates.`);

        for (const candidate of data || []) {
          if (seenCandidateSet.has(candidate.id)) {
            continue;
          }

          await handleCandidateChange(candidate);

          seenCandidateSet.add(candidate.id);
          seenCandidateIds.push(candidate.id);

          if (!lastSeenCreatedAt || candidate.created_at > lastSeenCreatedAt) {
            lastSeenCreatedAt = candidate.created_at;
          }

          if (seenCandidateIds.length > 500) {
            const oldest = seenCandidateIds.shift();
            if (oldest) seenCandidateSet.delete(oldest);
          }
        }
      } catch (pollErr) {
        console.error('[bot] Poll loop failed:', pollErr.message || pollErr);
      }
    }

    const pollIntervalMs = parseInt(process.env.SUPABASE_POLL_INTERVAL_MS || '600000', 10);
    console.log(`[bot] Supabase polling loop started (interval ${pollIntervalMs} ms)`);
    pollPendingCandidates();
    setInterval(pollPendingCandidates, pollIntervalMs);
  }

  const scheduleExpr = process.env.KEEPALIVE_CRON || '*/15 * * * *';
  console.log(`[bot] Scheduling keepAlive: ${scheduleExpr}`);

  cron.schedule(scheduleExpr, async () => {
    try {
      let sessionToken = getSessionToken();
      if (!sessionToken) {
        console.log('[bot] keepAlive: no session token yet; attempting login');
        sessionToken = await requireSession('keepalive-missing-token');
        return;
      }
      const res = await keepAlive(sessionToken);
      if (!res.ok) {
        throw new Error('keepAlive returned not ok');
      }
      if (res.token && res.token !== sessionToken) {
        setSessionToken(res.token);
      }
      console.log('[bot] keepAlive ok');
    } catch (e) {
      console.warn('[bot] keepAlive failed; attempting re-login:', e.message || e);
      setSessionToken(null);
      await ensureLogin('keepalive-fail');
    }
  });

  // Keep process alive
  // Optional small HTTP server for Railway health/status and logs
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  let publicInfoCache = { ts: 0, data: null };
  async function getPublicInfo() {
    const now = Date.now();
    if (publicInfoCache.data && now - publicInfoCache.ts < 5 * 60 * 1000) return publicInfoCache.data;
    try {
      const [ipRes, geoRes] = await Promise.all([
        fetch('https://api.ipify.org?format=json').then(r => r.json()).catch(() => ({ ip: null })),
        fetch('https://ipapi.co/json').then(r => r.json()).catch(() => ({})),
      ]);
      publicInfoCache = { ts: now, data: { ip: ipRes.ip || null, geo: geoRes || {} } };
    } catch {
      publicInfoCache = { ts: now, data: { ip: null, geo: {} } };
    }
    return publicInfoCache.data;
  }
  const server = http.createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/health') {
      const net = await getPublicInfo();
      const diag = getLoginDiagnostics();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'betfair-bot',
        keepAliveCron: scheduleExpr,
        hasSessionToken: Boolean(getSessionToken()),
        loginBlockedUntil: diag.blockedUntil ? new Date(diag.blockedUntil).toISOString() : null,
        lastLoginError: diag.lastError || null,
        publicIp: net.ip || null,
        publicGeo: net.geo || {},
        platformRegion: process.env.FLY_REGION || process.env.RAILWAY_REGION || null,
      }));
      return;
    }
    if (req.url === '/ip') {
      const net = await getPublicInfo();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(net));
      return;
    }
    if (req.url === '/version') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('betfair-bot:1');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
  server.listen(port, () => {
    console.log(`[bot] Health server listening on :${port}`);
  });

  const handleShutdown = (signal) => {
    console.log(`\n[bot] Caught ${signal}, exiting.`);
    try {
      if (eplStrategy) {
        eplStrategy.stop().catch((err) => {
          console.warn('[strategy:epl_under25] stop error:', err && err.message ? err.message : err);
        });
      }
      if (goalReactStrategy) {
        goalReactStrategy.stop().catch((err) => {
          console.warn('[strategy:epl_under25_goalreact] stop error:', err && err.message ? err.message : err);
        });
      }
      if (over25BreakoutStrategy) {
        over25BreakoutStrategy.stop().catch((err) => {
          console.warn('[strategy:epl_over25_breakout] stop error:', err && err.message ? err.message : err);
        });
      }
      server.close();
    } catch { }
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

async function start() {
  await main();
}

start().catch((e) => {
  console.error('[bot] Fatal error:', e);
  process.exit(1);
});

module.exports = {
  start,
};


