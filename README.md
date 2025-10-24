# EV Tennis & Soccer Scanner

EV Scanner is a modern web application for identifying +EV betting opportunities in tennis and soccer markets. The interface is optimised for speed, clarity, and professional use by traders.

## Product Overview

- **Live Alerts** – Real-time view of profitable opportunities with tier badges, implied edge, and contextual metadata.
- **Bet Ledger** – Settled vs. pending bet tracking including automatic ROI and P&L calculations.
- **Analytics** – Multi-chart performance dashboard covering realised vs expected returns, CLV, and volume trends.
- **Operations Console** – Health monitoring for ingestion jobs with manual discovery/poll triggers and configuration insight.

## Design System

| Token | Dark Hex | Light Hex | Usage |
| --- | --- | --- | --- |
| `--color-app-bg` | `#050914` | `#f1f5f9` | Root background |
| `--color-card` | `#0f1b33` | `#ffffff` | Cards/content surfaces |
| `--color-border` | `rgba(148,163,184,.16)` | `rgba(148,163,184,.35)` | Divider/border accents |
| `--color-text-primary` | `#e2e8f0` | `#0f172a` | Primary copy |
| Accents | `#14b8a6`, `#38bdf8`, `#f87171`, `#facc15` | same | Tier, status, focus states |

- **Typography** – Geist Sans & Mono (via Next fonts). Titles use 600 weight, data figures use mono to improve scanability.
- **Spacing** – 4/8/12/16/24px scale with generous padding inside cards to reduce visual noise.
- **Elevation** – `shadow-card` for primary panels, increases subtly on hover for interactive affordance.

## Tech Stack

- **Framework**: Next.js 15 App Router with React Server Components.
- **Data Layer**: API Routes backed by Supabase (PostgreSQL) and The Odds API.
- **Client State**: TanStack React Query 5 (global QueryClient in `src/app/providers.tsx`).
- **Styling**: Tailwind CSS v4 (utility-first) with custom design tokens.
- **Visualisation**: Recharts, dynamically imported per route for bundle splitting.
- **Deployment**: Vercel with scheduled cron triggers for discovery/poll routines.

## Setup

### 1. Environment Variables

Create a `.env.local` file with the following variables:

```env
# The Odds API Configuration
ODDS_API_KEY=your_odds_api_key_here

# App Configuration
NEXT_PUBLIC_APP_TIMEZONE=Europe/London
BOOKMAKER_ALLOWLIST=betfair,betfair_sportsbook,smarkets,matchbook,bet365,williamhill,skybet
EXCHANGE_COMMISSION_DEFAULT=0.02
POLL_MINUTES=60
DEMO_MODE=true

# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url_here
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key_here

# Vercel Configuration
VERCEL_URL=your_vercel_url_here
```

### 2. Database Setup

1. Create a new Supabase project
2. Run the SQL schema from `supabase-schema.sql` in your Supabase SQL editor
3. Update the Supabase environment variables in your `.env.local`

### 3. The Odds API

1. Sign up for an account at [The Odds API](https://the-odds-api.com/)
2. Get your API key and add it to your environment variables
3. Configure your bookmaker allowlist based on available bookmakers

### 4. Installation

```bash
npm install
npm run dev
```

## Alert Thresholds & Engine

Alert generation thresholds are defined centrally in `src/lib/config.ts` under `alertThresholds`. The alert engine (`src/lib/alerts.ts`) consumes these values so that changes are global:

- **Solid** alerts require edge ≥ `config.alertThresholds.solid`, positive EV, and sufficient market coverage.
- **Scout** alerts require edge ≥ `config.alertThresholds.scout` and EV ≥ 0.
- **Exchange Value** alerts compare sportsbook consensus vs. exchange consensus using `config.alertThresholds.exchangeValue`.

To adjust thresholds, edit the values in `config.ts` and redeploy. The admin panel `/admin` and alerts UI automatically reflect the updated defaults.

Visit `http://localhost:3000/alerts` to access the alerts view. The root route redirects there automatically.

## Core Screens

### Alerts (`/alerts`)
- Macrotile layout with summary cards (active count, average edge, tier mix).
- Filters: Minimum edge input (manual apply), tier dropdown, market dropdown.
- Wide grid removing horizontal scroll, quick actions for “Bet” modal or clearing entries.

### Bets (`/bets`)
- Settlement-aware ledger with inline status updates and derived metrics (total staked/P&L).
- Status filter with cached pagination, preventing re-fetch until applied.

### Performance (`/metrics`)
- Lazy-loaded charts comparing actual vs expected P&L, ROI, CLV, and volume per tier.
- Data refreshes every 60s with background loading so charts remain visible.

### Operations (`/admin`)
- Health cards for snapshots, candidates, API usage, error rate.
- Manual controls for discovery/poll worker jobs, system configuration snapshot, event audit trail.

## Data & API Endpoints

- `POST /api/discovery` – Trigger daily sports discovery and bootstrap data.
- `POST /api/poll` – Hourly odds polling and alert generation.
- `GET /api/candidates` – Alerts feed, supports `min_edge` and `alert_tier` filtering.
- `DELETE /api/candidates/:id` – Remove a single alert.
- `DELETE /api/candidates/clear-all` – Purge active alerts (admin only).
- `POST /api/bets` – Log a new bet execution.
- `POST /api/bets/[id]/settle` – Update bet status with returns/P&L.
- `GET /api/metrics` – Aggregated performance dataset for dashboards.

## Cron Jobs

The application uses Vercel cron jobs for automated operations:

- **Discovery**: Daily at 07:55 (before polling starts)
- **Polling**: Every hour from 08:00 to 22:00 Europe/London time

## Database Schema

The application uses the following main tables:

- `sports` - Available sports and their enabled status
- `events` - Sporting events with metadata
- `odds_snapshots` - Historical odds data
- `candidates` - Generated alerts
- `bets` - Logged bets and their outcomes
- `closing_consensus` - Closing line data for CLV calculation
- `metrics_daily` - Daily performance metrics

## Development

### Running Locally

```bash
npm run dev
```

### Building for Production

```bash
npm run build
npm run start:web
```

### Testing

```bash
npm run test
```

### Bundle Analysis (optional)

Add the analyzer as a dev dependency:

```bash
npm install --save-dev @next/bundle-analyzer
```

Wrap `next.config.ts`:

```ts
const withBundleAnalyzer = require("@next/bundle-analyzer")({ enabled: process.env.ANALYZE === "true" });

module.exports = withBundleAnalyzer({
  experimental: { turbotrace: true },
});
```

Run:

```bash
ANALYZE=true npm run build
```

Inspect the generated report to find heavy modules and confirm route-based splitting.

## Deployment

1. Connect your repository to Vercel
2. Set up environment variables in Vercel dashboard
3. Deploy - cron jobs will be automatically configured

## Monitoring & Operations

Use the Operations screen to:
- Monitor API call counts, errors, and substrate success rate.
- Inspect current config (timezone, poll interval, thresholds).
- Review latest discovery/poll timestamps and activity log.
- Run discovery/poll manually when debugging or replaying data.

## License

This project is for educational and research purposes. Please ensure compliance with local gambling laws and regulations.