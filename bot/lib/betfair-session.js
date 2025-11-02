const fs = require('fs');
const https = require('https');
const { URL } = require('url');

const sessionState = {
  token: null,
};

const loginState = {
  lastError: null,
  blockedUntil: 0,
  retryDelayMs: 60_000,
  retryTimer: null,
};

let logger = console;
let fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null;

function initializeSessionManager(options = {}) {
  if (options.logger) {
    logger = options.logger;
  }
  if (options.fetch) {
    fetchImpl = options.fetch;
  }
  if (!fetchImpl) {
    throw new Error('Betfair session manager requires fetch implementation');
  }
}

function readPfxBuffer() {
  const base64 = process.env.BETFAIR_PFX_BASE64;
  const filePath = process.env.BETFAIR_PFX_PATH;

  if (base64 && base64.trim().length > 0) {
    try {
      return Buffer.from(base64, 'base64');
    } catch (e) {
      logger.error('Failed to decode BETFAIR_PFX_BASE64');
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
        } catch {
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
        } catch {
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

function ms(humanMs) {
  return humanMs;
}

function formatDelay(msValue) {
  const s = Math.ceil(msValue / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  return `${m}m`;
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
    headers,
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

function setSessionToken(token) {
  sessionState.token = token;
  if (token) {
    process.env.BETFAIR_SESSION_TOKEN = token;
  } else {
    delete process.env.BETFAIR_SESSION_TOKEN;
  }
}

function getSessionToken() {
  return sessionState.token;
}

function clearRetryTimer() {
  if (loginState.retryTimer) {
    clearTimeout(loginState.retryTimer);
    loginState.retryTimer = null;
  }
}

async function ensureLogin(trigger = 'manual') {
  const now = Date.now();
  if (sessionState.token) return sessionState.token;
  if (now < loginState.blockedUntil) {
    const waitMs = loginState.blockedUntil - now;
    logger.warn(`[bot] Login blocked until ${new Date(loginState.blockedUntil).toISOString()} (waiting ${formatDelay(waitMs)})`);
    return null;
  }

  try {
    logger.log(`[bot] Attempting certLogin (trigger=${trigger})...`);
    const token = await certLogin();
    setSessionToken(token);
    loginState.lastError = null;
    loginState.retryDelayMs = 60_000;
    clearRetryTimer();
    logger.log('[bot] certLogin SUCCESS');
    return token;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    loginState.lastError = msg;
    if (/TEMPORARY_BAN_TOO_MANY_REQUESTS/i.test(msg)) {
      loginState.blockedUntil = Date.now() + ms(15 * 60 * 1000);
      logger.warn('[bot] TEMPORARY_BAN_TOO_MANY_REQUESTS → pausing logins for 15 minutes');
    } else {
      const delay = loginState.retryDelayMs;
      const next = Math.min(loginState.retryDelayMs * 2, 10 * 60 * 1000);
      loginState.retryDelayMs = next;
      logger.warn(`[bot] certLogin failed: ${msg}. Retrying in ${formatDelay(delay)} (max 10m)`);
      clearRetryTimer();
      loginState.retryTimer = setTimeout(() => {
        ensureLogin('backoff').catch((err) => {
          logger.error('[bot] ensureLogin backoff error:', err.message || err);
        });
      }, delay);
    }
    return null;
  }
}

async function keepAlive(sessionToken = getSessionToken()) {
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
    return { ok: true, token: body.token };
  }
  return { ok: true, token: sessionToken };
}

async function betfairRpc(sessionTokenOrMethod, maybeMethod, maybeParams) {
  let sessionToken;
  let method;
  let params;

  if (typeof maybeMethod === 'string') {
    sessionToken = sessionTokenOrMethod;
    method = maybeMethod;
    params = maybeParams;
  } else {
    sessionToken = getSessionToken();
    method = sessionTokenOrMethod;
    params = maybeMethod;
  }

  if (!sessionToken) throw new Error('betfairRpc missing credentials');
  if (!fetchImpl) throw new Error('betfairRpc missing fetch implementation');

  const payload = [{ jsonrpc: '2.0', method, params, id: 1 }];
  const res = await fetchImpl('https://api.betfair.com/exchange/betting/json-rpc/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Application': process.env.BETFAIR_APP_KEY,
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

async function withSession(trigger, fn) {
  await ensureLogin(trigger);
  const token = getSessionToken();
  if (!token) {
    throw new Error('No Betfair session token available after ensureLogin');
  }
  return fn(token);
}

function invalidateSession() {
  setSessionToken(null);
}

function getLoginDiagnostics() {
  return {
    lastError: loginState.lastError,
    blockedUntil: loginState.blockedUntil,
    retryDelayMs: loginState.retryDelayMs,
  };
}

module.exports = {
  initializeSessionManager,
  ensureLogin,
  keepAlive,
  betfairRpc,
  getSessionToken,
  setSessionToken,
  invalidateSession,
  withSession,
  getLoginDiagnostics,
};


