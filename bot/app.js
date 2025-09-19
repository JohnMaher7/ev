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

  const { statusCode, body } = await postFormWithClientCert(
    'https://identitysso-cert.betfair.com/api/certlogin',
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
  const { statusCode, body } = await postJson('https://identitysso.betfair.com/api/keepAlive', {
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

async function main() {
  console.log('[bot] Starting Betfair bot...');
  let sessionToken = null;
  try {
    sessionToken = await certLogin();
    process.env.BETFAIR_SESSION_TOKEN = sessionToken;
    console.log('[bot] certLogin SUCCESS');
  } catch (e) {
    console.error('[bot] certLogin ERROR:', e.message || e);
    process.exit(1);
  }

  const scheduleExpr = process.env.KEEPALIVE_CRON || '*/15 * * * *';
  console.log(`[bot] Scheduling keepAlive: ${scheduleExpr}`);

  cron.schedule(scheduleExpr, async () => {
    try {
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
      try {
        sessionToken = await certLogin();
        process.env.BETFAIR_SESSION_TOKEN = sessionToken;
        console.log('[bot] Re-login SUCCESS');
      } catch (e2) {
        console.error('[bot] Re-login ERROR:', e2.message || e2);
      }
    }
  });

  // Keep process alive
  // Optional small HTTP server for Railway health/status and logs
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'betfair-bot',
        keepAliveCron: scheduleExpr,
        hasSessionToken: Boolean(sessionToken && sessionToken.length > 0),
      }));
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


