/*
  Persistent Betfair Bot: certificate login + keepAlive
  - Performs cert login on startup to obtain sessionToken
  - Schedules keepAlive every 15 minutes using node-cron
  - On keepAlive failure, immediately re-logins and replaces the in-memory token
  - Reads secrets from environment variables

  Required environment variables:
    BETFAIR_APP_KEY
    BETFAIR_USERNAME
    BETFAIR_PASSWORD
    (one of) BETFAIR_PFX_PATH or BETFAIR_PFX_BASE64
    BETFAIR_PFX_PASSWORD

  Optional environment variables:
    KEEPALIVE_CRON (default: every 15 minutes)
*/

const path = require('path');
const dotenv = require('dotenv');
// Load .env first, then .env.local (overrides)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
const fs = require('fs');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const { URL } = require('url');
const cron = require('node-cron');

function readPfxBuffer() {
  const base64 = process.env.BETFAIR_PFX_BASE64;
  const filePath = process.env.BETFAIR_PFX_PATH;

  if (base64 && base64.trim().length > 0) {
    try {
      return Buffer.from(base64, 'base64');
    } catch (e) {
      console.error('Failed to decode BETFAIR_PFX_BASE64');
      throw e;
    }
  }
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath);
  }
  throw new Error('Missing PFX input. Provide BETFAIR_PFX_BASE64 or BETFAIR_PFX_PATH');
}

function postFormWithClientCert(targetUrl, formObj, pfxBuffer, passphrase, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const formBody = Object.entries(formObj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + (urlObj.search || ''),
      port: urlObj.port || 443,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
        ...extraHeaders,
      },
      pfx: pfxBuffer,
      passphrase,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: json });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.write(formBody);
    req.end();
  });
}

function postJson(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + (urlObj.search || ''),
      port: urlObj.port || 443,
      method: 'POST',
      headers,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: json });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function requireEnvs(required) {
  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
  if (missing.length > 0) {
    throw new Error(`Missing required envs: ${missing.join(', ')}`);
  }
}

function resolveSsoEndpoints() {
  const j = (process.env.BETFAIR_JURISDICTION || 'GLOBAL').toUpperCase();
  switch (j) {
    case 'AUS':
    case 'AU':
    case 'ANZ':
      return {
        certLogin: 'https://identitysso-cert.betfair.com.au/api/certlogin',
        keepAlive: 'https://identitysso.betfair.com.au/api/keepAlive',
      };
    case 'IT':
      return {
        certLogin: 'https://identitysso-cert.betfair.it/api/certlogin',
        keepAlive: 'https://identitysso.betfair.it/api/keepAlive',
      };
    case 'ES':
      return {
        certLogin: 'https://identitysso-cert.betfair.es/api/certlogin',
        keepAlive: 'https://identitysso.betfair.es/api/keepAlive',
      };
    case 'RO':
      return {
        certLogin: 'https://identitysso-cert.betfair.ro/api/certlogin',
        keepAlive: 'https://identitysso.betfair.ro/api/keepAlive',
      };
    default:
      return {
        certLogin: 'https://identitysso-cert.betfair.com/api/certlogin',
        keepAlive: 'https://identitysso.betfair.com/api/keepAlive',
      };
  }
}

async function certLogin() {
  const appKey = process.env.BETFAIR_APP_KEY;
  const username = process.env.BETFAIR_USERNAME;
  const password = process.env.BETFAIR_PASSWORD;
  const pfxPass = process.env.BETFAIR_PFX_PASSWORD;

  requireEnvs(['BETFAIR_APP_KEY', 'BETFAIR_USERNAME', 'BETFAIR_PASSWORD', 'BETFAIR_PFX_PASSWORD']);

  const pfx = readPfxBuffer();
  const headers = {
    'X-Application': appKey,
  };

  const { certLogin } = resolveSsoEndpoints();
  const { statusCode, body } = await postFormWithClientCert(
    certLogin,
    { username, password },
    pfx,
    pfxPass,
    headers
  );

  if (statusCode !== 200) {
    const reason = typeof body === 'object' ? JSON.stringify(body) : String(body);
    throw new Error(`certLogin failed HTTP ${statusCode}: ${reason}`);
  }
  if (!body || !body.sessionToken || body.loginStatus !== 'SUCCESS') {
    throw new Error(`certLogin unexpected response: ${JSON.stringify(body)}`);
  }
  return body.sessionToken;
}

async function keepAlive(sessionToken) {
  const appKey = process.env.BETFAIR_APP_KEY;
  if (!appKey || !sessionToken) {
    throw new Error('keepAlive missing appKey or sessionToken');
  }
  const { keepAlive } = resolveSsoEndpoints();
  const { statusCode, body } = await postJson(keepAlive, {
    'X-Application': appKey,
    'X-Authentication': sessionToken,
  });
  if (statusCode !== 200) {
    const reason = typeof body === 'object' ? JSON.stringify(body) : String(body);
    throw new Error(`keepAlive failed HTTP ${statusCode}: ${reason}`);
  }
  if (typeof body === 'object' && body.token) {
    // Betfair keepAlive returns the same token in "token"
    return { ok: true, token: body.token };
  }
  return { ok: true, token: sessionToken };
}

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

function roundToBetfairTick(price) {
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
  const p = Math.max(1.01, Math.min(price, 1000));
  const band = bands.find(b => p <= b.max) || bands[bands.length - 1];
  const ticks = Math.floor((p - 1.0) / band.step);
  const rounded = 1.0 + ticks * band.step;
  return Math.max(1.01, Math.min(rounded, 1000));
}

async function betfairRpc(sessionToken, method, params) {
  const appKey = process.env.BETFAIR_APP_KEY;
  if (!appKey || !sessionToken) throw new Error('betfairRpc missing credentials');
  const payload = [{ jsonrpc: '2.0', method, params, id: 1 }];
  const res = await fetch('https://api.betfair.com/exchange/betting/json-rpc/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Application': appKey,
      'X-Authentication': sessionToken,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Betfair RPC HTTP ${res.status}: ${JSON.stringify(data)}`);
  if (!Array.isArray(data) || !data[0]) throw new Error('Betfair RPC unexpected response');
  if (data[0].error) throw new Error(`Betfair RPC method error: ${JSON.stringify(data[0].error)}`);
  return data[0].result;
}

async function locateMarketAndRunner(sessionToken, ev, marketKey, selection) {
  const sportName = resolveSportKeyToEventTypeName(ev.sport_key);
  if (!sportName) throw new Error(`Unsupported sport_key: ${ev.sport_key}`);
  const eventTypes = await betfairRpc(sessionToken, 'SportsAPING/v1.0/listEventTypes', { filter: {} });
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
    textQuery: `${ev.home} ${ev.away}`,
  };
  const catalogues = await betfairRpc(sessionToken, 'SportsAPING/v1.0/listMarketCatalogue', {
    filter,
    maxResults: 50,
    marketProjection: ['RUNNER_DESCRIPTION'],
  });

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

  for (const m of catalogues || []) {
    const rn = m.runners || [];
    const hit = rn.find(r => r.runnerName === wantedRunnerName);
    if (hit) {
      return { marketId: m.marketId, selectionId: hit.selectionId, runnerName: hit.runnerName };
    }
  }
  throw new Error('No matching market/runner found on Betfair');
}

// --- Login orchestration with backoff/ban handling ---
let sessionToken = null;
const loginState = {
  lastError: null,
  blockedUntil: 0, // epoch ms
  retryDelayMs: 60_000, // start at 60s
};

function ms(humanMs) {
  return humanMs;
}

function formatDelay(msValue) {
  const s = Math.ceil(msValue / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  return `${m}m`;
}

async function ensureLogin(trigger = 'manual') {
  const now = Date.now();
  if (sessionToken) return;
  if (now < loginState.blockedUntil) {
    const waitMs = loginState.blockedUntil - now;
    console.warn(`[bot] Login blocked until ${new Date(loginState.blockedUntil).toISOString()} (waiting ${formatDelay(waitMs)})`);
    return;
  }

  try {
    console.log(`[bot] Attempting certLogin (trigger=${trigger})...`);
    const token = await certLogin();
    sessionToken = token;
    process.env.BETFAIR_SESSION_TOKEN = sessionToken;
    loginState.lastError = null;
    loginState.retryDelayMs = 60_000; // reset backoff
    console.log('[bot] certLogin SUCCESS');
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    loginState.lastError = msg;
    // Handle temporary ban (rate limit) explicitly
    if (/TEMPORARY_BAN_TOO_MANY_REQUESTS/i.test(msg)) {
      // Betfair bans are typically short; wait 15 minutes before retrying
      loginState.blockedUntil = Date.now() + ms(15 * 60 * 1000);
      console.warn('[bot] TEMPORARY_BAN_TOO_MANY_REQUESTS → pausing logins for 15 minutes');
    } else {
      // Generic backoff (exponential up to 10 minutes)
      const next = Math.min(loginState.retryDelayMs * 2, 10 * 60 * 1000);
      console.warn(`[bot] certLogin failed: ${msg}. Retrying in ${formatDelay(loginState.retryDelayMs)} (max 10m)`);
      const delay = loginState.retryDelayMs;
      loginState.retryDelayMs = next;
      setTimeout(() => {
        ensureLogin('backoff');
      }, delay);
    }
  }
}

async function main() {
  console.log('[bot] Starting Betfair bot...');
  // Kick off login (non-fatal if it fails; backoff handles retries)
  ensureLogin('startup');

  // --- Supabase connection & candidate subscriber ---
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.warn('[bot] Supabase envs missing (SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY). Subscriber will not start.');
  } else {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });

    async function handleCandidateChange(payload) {
      try {
        const c = payload.new || payload.record || payload;
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
        if (!sessionToken) {
          await ensureLogin('candidate');
          if (!sessionToken) {
            console.log('[bot] No session after ensureLogin, skipping candidate');
            return;
          }
        }

        // Locate market and runner
        const loc = await locateMarketAndRunner(sessionToken, ev, c.market_key, c.selection);

        // Fetch live best back
        const books = await betfairRpc(sessionToken, 'SportsAPING/v1.0/listMarketBook', {
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
        const placeRes = await betfairRpc(sessionToken, 'SportsAPING/v1.0/placeOrders', {
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
          customerRef: `ev-${c.event_id}-${Date.now()}`,
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

    supabase
      .channel('candidates-inserts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'candidates' }, handleCandidateChange)
      .subscribe((status) => {
        console.log('[bot] Supabase channel status:', status);
      });
  }

  const scheduleExpr = process.env.KEEPALIVE_CRON || '*/15 * * * *';
  console.log(`[bot] Scheduling keepAlive: ${scheduleExpr}`);

  cron.schedule(scheduleExpr, async () => {
    try {
      if (!sessionToken) {
        console.log('[bot] keepAlive: no session token yet; attempting login');
        await ensureLogin('keepalive-missing-token');
        return;
      }
      const res = await keepAlive(sessionToken);
      if (!res.ok) {
        throw new Error('keepAlive returned not ok');
      }
      if (res.token && res.token !== sessionToken) {
        sessionToken = res.token;
        process.env.BETFAIR_SESSION_TOKEN = sessionToken;
      }
      console.log('[bot] keepAlive ok');
    } catch (e) {
      console.warn('[bot] keepAlive failed; attempting re-login:', e.message || e);
      sessionToken = null;
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'betfair-bot',
        keepAliveCron: scheduleExpr,
        hasSessionToken: Boolean(sessionToken && sessionToken.length > 0),
        loginBlockedUntil: loginState.blockedUntil ? new Date(loginState.blockedUntil).toISOString() : null,
        lastLoginError: loginState.lastError || null,
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

  process.on('SIGINT', () => {
    console.log('\n[bot] Caught SIGINT, exiting.');
    try { server.close(); } catch {}
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('\n[bot] Caught SIGTERM, exiting.');
    try { server.close(); } catch {}
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[bot] Fatal error:', e);
  process.exit(1);
});


