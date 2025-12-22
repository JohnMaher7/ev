# Betfair Exchange Auto-Betting: Plan, Setup, and Flow

This document explains how our app places automated bets on the Betfair Exchange, the configuration required, and the safeguards used.

## Prerequisites

- Live Betfair App Key set in server env: `BETFAIR_APP_KEY`
- Valid Betfair session token set in server env: `BETFAIR_SESSION_TOKEN`
- Auto-bet feature flags (see Environment below)

Obtain the session token via Betfair Non-Interactive (bot) login using a client certificate. Follow Betfair’s guide to create a certificate, link it to your account, and call the cert login endpoint to receive `sessionToken`:

- Reference: [Betfair Non-Interactive (bot) login](https://betfair-developer-docs.atlassian.net/wiki/spaces/1smk3cen4v3yomq5qye0ni/pages/2687915/Non-Interactive+bot+login#Non-Interactive(bot)login-CreatingaSelfSignedCertificate)
- Endpoint: `https://identitysso-cert.betfair.com/api/certlogin`
- Required header: `X-Application: <your App Key>`; body fields: `username`, `password` (URL-encoded); provide your client certificate and key (or `.pfx` on Windows PowerShell).

Store the returned token in server runtime as `BETFAIR_SESSION_TOKEN`.

## High-Level Flow

1) Polling (`POST /api/poll`) ingests odds from The Odds API, stores snapshots, and generates alert candidates.
2) If `config.autoBet.enabled` and a candidate’s edge ≥ `config.autoBet.minEdge`:
   - If the best source is the Betfair exchange (`betfair_ex_uk`), we proceed to placement.
   - Otherwise, we try the most recent Betfair snapshot for that selection and only proceed if the edge still meets threshold.
3) Placement (`src/lib/betting/betfair.ts` → `placeBetOnBetfair`):
   - Resolve sport to Betfair event type (`Soccer` or `Tennis`).
   - Map our market to Betfair type:
     - `h2h` → `MATCH_ODDS`
     - `totals (line: X.Y)` → `OVER_UNDER_<10*X.Y>` (e.g., 2.5 → `OVER_UNDER_25`, with runner names `Over <line> Goals` / `Under <line> Goals`)
   - Search markets via `listMarketCatalogue` near event start using `textQuery` with `home` and `away`.
   - Identify the correct runner (`home`, `away`, `The Draw`, or `Over/Under <line>`).
   - Fetch live best back price via `listMarketBook`.
   - Re-check edge using accepted fair probability; abort if below threshold.
   - Round price to Betfair tick and place a BACK LIMIT order via `placeOrders`.
   - On success, log the bet in `bets`.

## Stake Sizing (Professional Best Practices)

- We use fractional Kelly sizing with a conservative multiplier and a bank cap:
  - Kelly fraction: `0.25` (quarter Kelly)
  - Bank cap: `2%` of bankroll
  - Minimum stake: `AUTO_BET_MIN_STAKE`
- Kelly uses `p = fair_prob`, `b = odds - 1`. Stake = `bankroll × min(0.25 × Kelly(p,b), 0.02)`; then clamped to minimum stake.

## Safeguards

- Edge re-check against live Betfair price before placement (must be ≥ `AUTO_BET_MIN_EDGE`).
- 1-hour dedupe per event/market/selection to avoid duplicate automated bets.
- Price rounding to the Betfair tick ladder (rounded down, conservative).
- Persistence type: `LAPSE` (order will cancel if unmatched when market goes in-play or is suspended).

## Supported Markets

- Soccer and Tennis
- `MATCH_ODDS` (3-way for soccer, 2-way for tennis)
- Soccer totals: `OVER_UNDER_<line>` where the line is derived from our market key (e.g., 2.5 → `OVER_UNDER_25`).

## Components

- `src/lib/betting/betfair.ts` — Places orders via Betfair JSON-RPC (listEventTypes, listMarketCatalogue, listMarketBook, placeOrders)
- `src/app/api/betfair/locate/route.ts` — Locates Betfair market and runner, returns live best back price (for diagnostics)
- `src/app/api/betfair/ping/route.ts` — Validates App Key and session token via `listEventTypes`
- `src/app/api/poll/route.ts` — Generates candidates and triggers auto-bet with dedupe and stake logic

## Environment

Set these variables in your server environment (e.g., Vercel Project → Settings → Environment Variables):

```
# Betfair
BETFAIR_APP_KEY=your_live_app_key
BETFAIR_SESSION_TOKEN=your_session_token

# Auto-bet
AUTO_BET_ENABLED=true
AUTO_BET_MIN_EDGE=0.008
AUTO_BET_MIN_STAKE=2
AUTO_BET_BANKROLL=1000
```

## New Architecture (Vercel UI + UK VPS Bot)

- UI & Alerts Engine runs on Vercel (Next.js). It polls The Odds API on schedule and serves the dashboard.
- Betfair Bot runs on a UK VPS (Node, `bot/app.js`). It logs in with client cert, keeps the session alive, subscribes to `candidates` via Supabase realtime, re-validates prices/edge, and places exchange orders.
- The two services communicate asynchronously via Supabase tables.

### Required Environment Variables

```
BETFAIR_APP_KEY=...
BETFAIR_USERNAME=...
BETFAIR_PASSWORD=...
BETFAIR_PFX_PASSWORD=...

# Provide either a base64-encoded PFX or a filesystem path inside the container
BETFAIR_PFX_BASE64=...     # recommended
# or
BETFAIR_PFX_PATH=/app/certs/client.pfx

# Optional
KEEPALIVE_CRON=*/15 * * * *
```

### Run Locally

```bash
npm install
npm start
```

### Deployment

- Vercel (UI): set envs in the Vercel dashboard. `vercel.json` configures cron for `/api/discovery` and `/api/poll`.
- VPS Bot: use `bot/Dockerfile` (or Node directly). Provide envs via an `.env.bot` on the VPS and run the container with `--env-file`.

### Bot Health/Status URL (optional)

- The bot now exposes a tiny HTTP server (for platforms like Railway that expect a listening port).
- It binds to `PORT` (default 3000) and provides:
  - `GET /health` → `{ ok: true, service: 'betfair-bot', keepAliveCron: '*/15 * * * *', hasSessionToken: true }`
  - `GET /version` → `betfair-bot:1`
- On the VPS, expose port 3000 if needed. Hitting `/health` confirms the bot is live and has a session.

## EPL Under 2.5 Strategies

The bot includes two automated strategies for trading Under 2.5 Goals markets:

### Strategy 1: Pre-Match Hedge (`epl_under25`)

Places a back bet 30 minutes before kickoff at the lay price, then immediately places a lay order 2 ticks below to lock in profit if matched in-play.

**Environment Variables:**
```
ENABLE_EPL_UNDER25_STRATEGY=true
EPL_UNDER25_DEFAULT_STAKE=150
EPL_UNDER25_MIN_BACK_PRICE=1.8
EPL_UNDER25_BACK_LEAD_MINUTES=30
EPL_UNDER25_LAY_TICKS_BELOW=2
EPL_UNDER25_LAY_PERSISTENCE=PERSIST  # Keep lay order in-play

# Goal spike recovery (stop-loss style drift exit after confirmed goal)
EPL_UNDER25_STOP_LOSS_WAIT_SECONDS=180
EPL_UNDER25_STOP_LOSS_PCT=15
```

### Strategy 2: Goal Reactive (`epl_under25_goalreact`)

Wakes at kickoff, monitors in-play games for 1st goal (30% price spike), waits 90 seconds for price to settle, then enters a back position if price is between 2.5-5.0. Exits on 10% profit or 15% stop-loss after 2nd goal.

**Flow:**
1. **WATCHING** - Poll every 30s, detect 30% price spike
2. **GOAL_WAIT** - Wait 90s for price to settle, skip if goal after 45 mins
3. **LIVE** - Exit on 10% profit drop or 2nd goal detection
4. **STOP_LOSS_WAIT** - Wait 90s after 2nd goal
5. **STOP_LOSS_ACTIVE** - Exit when price drops 15% below settled price

**Environment Variables:**
```
ENABLE_EPL_UNDER25_GOALREACT_STRATEGY=true
GOALREACT_DEFAULT_STAKE=100
GOALREACT_WAIT_AFTER_GOAL=90
GOALREACT_GOAL_CUTOFF=45
GOALREACT_MIN_ENTRY_PRICE=2.5
GOALREACT_MAX_ENTRY_PRICE=5.0
GOALREACT_GOAL_DETECTION_PCT=30
GOALREACT_PROFIT_TARGET_PCT=10
GOALREACT_STOP_LOSS_PCT=15
GOALREACT_POLL_INTERVAL=30
```

### Dashboard

Both strategies appear in the EPL Under 2.5 dashboard (`/strategies/epl-under25`) with:
- Strategy tag (Pre-Match Hedge / Goal Reactive)
- Expandable event log per trade showing timestamps, prices, and state transitions
- Filter by strategy and status

## Testing

- CI: `npm run test:ci` (unit tests cover odds/alerts; network calls require proper envs when executed).

## Reference

- Betfair docs: [Non-Interactive (bot) login](https://betfair-developer-docs.atlassian.net/wiki/spaces/1smk3cen4v3yomq5qye0ni/pages/2687915/Non-Interactive+bot+login#Non-Interactive(bot)login-CreatingaSelfSignedCertificate)

