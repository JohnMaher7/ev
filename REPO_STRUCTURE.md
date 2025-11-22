# Repository Structure

**Last Updated:** November 22, 2025  
**Status:** ✅ Clean & Organized

---

## 📁 Documentation Files

### Root Documentation
- **README.md** - Main project documentation and setup guide
- **QUICKSTART.md** - Fast-track deployment guide (3 steps)
- **REPO_STRUCTURE.md** - This file - repository navigation guide

### Architecture & Technical (`docs/architecture/`)
- **EXECUTIVE_SUMMARY.md** - High-level project overview and metrics
- **ARCHITECTURE_COMPARISON.md** - Before/after architecture comparison
- **POLLING_OPTIMIZATION_GUIDE.md** - Detailed polling system technical guide

### Operational Guides (`docs/guides/`)
- **ADD_COMPETITIONS_GUIDE.md** - How to expand strategy to new leagues
- **HOW_TO_DISCOVER_COMPETITIONS.md** - Guide to find Betfair competition IDs
- **BOOKMAKER_COVERAGE_UPGRADE.md** - Bookmaker expansion guide
- **BETFAIR_AUTOBET.md** - Betfair autobet feature documentation

### System Documentation (`docs/`)
- **ALERTS.md** - Alerts system documentation
- **bot-architecture.md** - Bot architecture documentation

### Database (`docs/database/`)
- **supabase-schema-md.md** - Database schema reference (markdown)
- **supabase-schema.sql** - Complete consolidated database schema (root level)

---

## 🤖 Bot Services

### Main Bot (Betfair Trading)
Located in `bot/` directory:
- **app.js** - Main application entry
- **index.js** - Bot initialization
- **Dockerfile** - Container configuration

### Bot Libraries
Located in `bot/lib/`:
- **betfair-session.js** - Session management and authentication
- **betfair-utils.js** - Utility functions for Betfair API
- **strategies/epl-under25.js** - EPL Under 2.5 trading strategy

### Bot Scripts
Located in `bot/scripts/`:
- **check-schema.js** - Database schema verification utility

----

## 🌐 Web Application (Next.js)

### Frontend Pages
Located in `src/app/(app)/`:
- **alerts/** - Betting alerts dashboard
- **bets/** - Bet ledger and tracking
- **metrics/** - Performance analytics
- **admin/** - Operations console
- **logs/** - System logs viewer
- **strategies/epl-under25/** - Strategy configuration page

### API Routes
Located in `src/app/api/`:
- **discovery/** - Daily sports discovery
- **poll/** - Hourly odds polling
- **candidates/** - Alerts feed
- **bets/** - Bet logging and settlement
- **metrics/** - Performance data
- **strategies/epl-under25/** - Strategy settings and trades

### Core Libraries
Located in `src/lib/`:
- **alerts.ts** - Alert generation engine
- **consensus.ts** - Consensus probability calculation
- **odds-engine.ts** - EV calculation engine
- **prob.ts** - Probability utilities
- **odds-api.ts** - The Odds API integration
- **betting/betfair.ts** - Betfair API client
- **supabase.ts** - Database client
- **config.ts** - Application configuration

### Tests
Located in `src/lib/__tests__/`:
- alert-diagnostics.test.ts
- alerts.test.ts
- consensus.test.ts
- odds-engine.test.ts
- prob.test.ts
- logger.test.ts

---

## 🗄️ Database

### Schema
- **supabase-schema.sql** - Complete consolidated database schema (root level)
- **docs/database/supabase-schema-md.md** - Schema documentation (markdown)

**Note:** All migrations have been consolidated into `supabase-schema.sql`. The `supabase/migrations/` folder has been removed.

### Main Tables
- `sports` - Available sports and their enabled status
- `events` - Sporting events with metadata (includes `last_polled_at` for polling optimization)
- `odds_snapshots` - Historical odds data
- `candidates` - Generated alerts
- `bets` - Logged bets and their outcomes
- `closing_consensus` - Closing line data for CLV calculation
- `metrics_daily` - Daily performance metrics

### Strategy Tables
- `strategy_settings` - Strategy configuration (includes `min_profit_pct`)
- `strategy_trades` - Active trades (includes `state_data` for state machine)
- `strategy_trade_events` - Trade event history
- `strategy_fixtures` - Upcoming fixtures

---

## 🛠️ Utility Scripts

### Root Level Scripts
- **discover_competitions.js** - Find Betfair competition IDs and names
- **scripts/verify-polling-setup.ts** - Verify polling optimization setup

---

## 📦 Configuration Files

### Next.js & TypeScript
- next.config.ts
- tsconfig.json
- next-env.d.ts

### Build & Dependencies
- package.json
- package-lock.json

### Code Quality
- eslint.config.mjs
- jest.config.js
- jest.setup.js

### Styling
- postcss.config.mjs
- src/app/globals.css

### Deployment
- Dockerfile (web app)
- vercel.json (Vercel configuration)
- bot/Dockerfile (bot service)

---

## 🗑️ Cleaned Up (Removed)

### Diagnostic Files (9 files)
- ✅ bot/diagnosis_output.txt
- ✅ bot/diagnosis_output_v2.txt
- ✅ bot/diagnosis.log
- ✅ bot/scripts/diagnose-part1.js
- ✅ bot/scripts/diagnose-part2.js
- ✅ bot/scripts/diagnose-strategy.js
- ✅ bot/scripts/diagnose-strategy-v2.js
- ✅ bot/scripts/find-test-market.js
- ✅ bot/scripts/verify-ref.js

### Temporary Documentation (13 files)
- ✅ EPL_UNDER25_FIXES.md
- ✅ EPL_STRATEGY_ARCHITECTURE_REVIEW.md
- ✅ LOG_ALL_COMPETITIONS_TEMP.md
- ✅ SMART_SCHEDULING_IMPLEMENTATION.md
- ✅ FINAL_FIXES_SUMMARY.md
- ✅ IMPLEMENTATION_COMPLETE.md
- ✅ CHANGES_SUMMARY.md
- ✅ IMPROVEMENTS_SUMMARY.md
- ✅ IMPLEMENTATION_SUMMARY.md
- ✅ CRITICAL_BUG_FIX_NOV22.md
- ✅ DEPLOY_OPTIMIZATION_CHANGES.md
- ✅ DEPLOY_SMART_SCHEDULING.md
- ✅ EXAMPLE_MULTI_LEAGUE_MODIFICATION.js

### SQL Files & Artifacts (6 files)
- ✅ supabase-migration-add-last-polled.sql
- ✅ ADD_COLUMNS_FOR_OPTIMIZATION.sql
- ✅ bot-bundle.tar.gz
- ✅ supabase/migrations/20251121_clean_slate.sql (consolidated into main schema)
- ✅ supabase/migrations/20251121_add_state_data.sql (consolidated into main schema)
- ✅ supabase/migrations/20251121_add_min_profit_pct.sql (consolidated into main schema)

**Total Removed:** 28 files

---

## 📊 Repository Statistics

### Documentation
- **13 MD files** (organized by purpose)
- **4 categories**: Root, Architecture, Guides, System/Database
- **Clear folder structure** for easy navigation

### Code
- **Bot**: 3 core files, 1 strategy, 1 utility script
- **Web**: Full Next.js 15 app with API routes
- **Tests**: 6 test files with comprehensive coverage

### Database
- **1 consolidated schema file** (all migrations merged)
- **2 schema references** (SQL + markdown documentation)

---

## 🎯 Navigation Guide

**New to the project?**
→ Start with `README.md` → `QUICKSTART.md`

**Deploying updates?**
→ `QUICKSTART.md` (3-step deployment)

**Understanding architecture?**
→ `docs/architecture/EXECUTIVE_SUMMARY.md` → `docs/architecture/ARCHITECTURE_COMPARISON.md` → `docs/architecture/POLLING_OPTIMIZATION_GUIDE.md`

**Adding new competitions?**
→ `docs/guides/HOW_TO_DISCOVER_COMPETITIONS.md` → `docs/guides/ADD_COMPETITIONS_GUIDE.md`

**Configuring features?**
→ `docs/guides/BETFAIR_AUTOBET.md` / `docs/guides/BOOKMAKER_COVERAGE_UPGRADE.md`

**Database schema?**
→ `supabase-schema.sql` (canonical) or `docs/database/supabase-schema-md.md` (reference)

**Bot architecture?**
→ `docs/bot-architecture.md`

**Alerts system?**
→ `docs/ALERTS.md`

---

## 📁 Folder Structure

```
C:\ev\
├── README.md                    # Main documentation
├── QUICKSTART.md                # Quick deployment guide
├── REPO_STRUCTURE.md            # This file
├── supabase-schema.sql          # Consolidated DB schema
│
├── docs/
│   ├── architecture/            # Technical deep-dives
│   │   ├── EXECUTIVE_SUMMARY.md
│   │   ├── ARCHITECTURE_COMPARISON.md
│   │   └── POLLING_OPTIMIZATION_GUIDE.md
│   │
│   ├── guides/                  # Operational guides
│   │   ├── ADD_COMPETITIONS_GUIDE.md
│   │   ├── HOW_TO_DISCOVER_COMPETITIONS.md
│   │   ├── BOOKMAKER_COVERAGE_UPGRADE.md
│   │   └── BETFAIR_AUTOBET.md
│   │
│   ├── database/                # Database documentation
│   │   └── supabase-schema-md.md
│   │
│   ├── ALERTS.md                # System docs
│   └── bot-architecture.md
│
├── bot/                         # Betfair bot service
│   ├── lib/
│   │   ├── betfair-session.js
│   │   ├── betfair-utils.js
│   │   └── strategies/
│   │       └── epl-under25.js
│   └── scripts/
│       └── check-schema.js
│
├── src/                         # Next.js web application
│   ├── app/                     # Pages and API routes
│   ├── components/              # React components
│   ├── lib/                     # Core libraries
│   └── types/                   # TypeScript types
│
└── scripts/                     # Utility scripts
    └── verify-polling-setup.ts
```

---

## ✅ Maintenance Status

- 🟢 **Documentation**: Organized by purpose, no redundancy
- 🟢 **Code**: Clean, no diagnostic scripts or temporary files
- 🟢 **Database**: Single consolidated schema file
- 🟢 **Structure**: Clear folder hierarchy for easy navigation

**Last Cleanup:** November 22, 2025
