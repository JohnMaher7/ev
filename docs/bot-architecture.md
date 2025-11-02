# Betfair Bot Architecture Overview
## Runtime Entry Points
- `bot/index.js`
  - Loads environment variables (`.env`, `.env.local`).
  - Exports `start()` from `bot/app.js` so the process host can require the bot without auto-running it.
- `bot/app.js`
  - Orchestrates the runtime: ensures login, runs Supabase polling, optionally boots the EPL Under 2.5 strategy, and exposes a health server / keep-alive cron.
  - Delegates all Betfair session state to the shared session manager module.
## Shared Infrastructure
- `bot/lib/betfair-session.js`
  - Certificate login + keepAlive, backoff/ban handling, JSON-RPC wrapper, and in-memory token cache.
  - Provides `initializeSessionManager`, `ensureLogin`, `betfairRpc`, `getSessionToken`, etc.
- `bot/lib/betfair-utils.js`
  - Utility helpers (tick rounding, fuzzy matching) used by both `app.js` and strategy modules.
## EPL Under 2.5 Strategy
- `bot/lib/strategies/epl-under25.js`
  - Encapsulates fixture discovery, pre-match back execution, in-play lay hedge, and PnL logging.
  - Accepts dependencies via `{ supabase, betfair, logger }` for easier testing and reuse.
  - Internal timers:
    - Fixture sync every 6 hours (writes to `strategy_fixtures`).
    - Settings refresh every 5 minutes (keeps runtime edits live).
    - Trade lifecycle every 45 seconds (scheduled → back → hedge).
  - Emits audit breadcrumbs to `strategy_trade_events`.
### Database Tables
| Table | Purpose |
|-------|---------|
| `strategy_settings` | Feature toggle + runtime knobs (stake, back lead minutes, lay target, commission). |
| `strategy_fixtures` | Cached EPL fixtures discovered via Betfair competitions API. |
| `strategy_trades` | One logical position per event; tracks back/lay order refs, fills, pnl/margin, errors. |
| `strategy_trade_events` | Append-only audit log (BACK_PLACED, LAY_MATCHED, MISSED_WINDOW, etc.). |
## Supabase Polling Loop
- `app.js` polls `candidates` on a fixed interval (`SUPABASE_POLL_INTERVAL_MS`, default 5000 ms) rather than using realtime channels.
- Deduplication keeps an in-memory window (~500 IDs) to avoid reprocessing without leaking memory.
## Adding New Strategies
1. Create a new module under `bot/lib/strategies/` similar to `epl-under25.js`.
2. Extend `src/lib/config.ts` with defaults + env overrides.
3. Add migrations for any new tables / columns.
4. Import and gate the strategy in `bot/app.js` behind an environment flag.
## Deploying to Vultr (or other hosts)
When shipping updates, the following files must be copied to the remote host:
- `bot/app.js`
- `bot/index.js`
- `bot/lib/` directory (session manager, utils, strategies)

Environment variables to configure:
- `ENABLE_EPL_UNDER25_STRATEGY`
- `EPL_UNDER25_DEFAULT_STAKE`, `EPL_UNDER25_MIN_BACK_PRICE`, `EPL_UNDER25_LAY_TARGET_PRICE`, etc.

Recommended workflow:
1. Run `npm run lint` and `npm run test` locally.
2. Package or sync the `bot/` directory to the Vultr instance.
3. Restart the process and watch `/health` for `hasSessionToken` and strategy status.
4. Monitor logs for Supabase polling and Betfair order placement events.
## Future Iteration Tips
- Treat Supabase tables as the source of truth; avoid duplicating trade state in memory.
- Keep new strategies modular by passing dependencies explicitly.
- Update this document whenever new configuration knobs or workflows are added.
