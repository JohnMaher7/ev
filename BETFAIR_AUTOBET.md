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

## Testing

- Ping: `POST /api/betfair/ping` with optional `{ "sessionToken": "..." }` to validate connectivity.
- Locate: `POST /api/betfair/locate` with `{ "candidateId": "..." }` to resolve `marketId`/`selectionId` and inspect best back price.
- CI: `npm run test:ci` (unit tests cover odds/alerts; Betfair calls run only in server runtime with proper envs).

## Reference

- Betfair docs: [Non-Interactive (bot) login](https://betfair-developer-docs.atlassian.net/wiki/spaces/1smk3cen4v3yomq5qye0ni/pages/2687915/Non-Interactive+bot+login#Non-Interactive(bot)login-CreatingaSelfSignedCertificate)

