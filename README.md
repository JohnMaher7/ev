# EV Tennis & Soccer Scanner

A minimal web application for identifying +EV betting opportunities in tennis and soccer markets using The Odds API.

## Features

- **Real-time Odds Monitoring**: Polls The Odds API every hour during active hours (08:00-22:00 Europe/London)
- **Fair Probability Calculation**: Robust consensus calculation using sportsbook and exchange data
- **Alert System**: Three-tier alert system (SOLID, SCOUT, EXCHANGE VALUE) with configurable thresholds
- **Bet Tracking**: Log bets, track performance, and calculate CLV (Closing Line Value)
- **Performance Analytics**: Comprehensive dashboard with P&L tracking, win rates, and margin analysis
- **Admin Panel**: Monitor system health, API usage, and manual operations

## Tech Stack

- **Frontend**: Next.js 15 (App Router), React Query, Tailwind CSS, Recharts
- **Backend**: Next.js API Routes, Supabase (PostgreSQL)
- **Deployment**: Vercel with cron jobs
- **Data Source**: The Odds API

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

## Alert System

### SOLID Alerts
- **Requirements**: ≥3 books OR (2 books AND ≥1 stable exchange)
- **Threshold**: ≥2.0 percentage points edge
- **Stake**: 25% Kelly with 2% bank cap
- **Purpose**: High-confidence value bets

### SCOUT Alerts
- **Requirements**: ≥2 books (exchanges optional)
- **Threshold**: ≥5.0 percentage points edge
- **Stake**: Fixed 0.5% bank cap
- **Purpose**: Early line arbitrage opportunities

### EXCHANGE VALUE Alerts
- **Requirements**: ≥3 books AND ≥1 stable exchange
- **Threshold**: ≥3.0 percentage points advantage on exchange
- **Stake**: Same as SOLID
- **Purpose**: Exchange vs sportsbook value

## API Endpoints

- `POST /api/discovery` - Run sports discovery and initial data collection
- `POST /api/poll` - Poll for new odds and generate alerts
- `GET /api/candidates` - Get alert candidates with filters
- `POST /api/bets` - Log a new bet
- `POST /api/bets/[id]/settle` - Settle a bet (win/loss/void)
- `GET /api/metrics` - Get performance metrics and KPIs

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
npm start
```

### Testing

```bash
npm run test
```

## Deployment

1. Connect your repository to Vercel
2. Set up environment variables in Vercel dashboard
3. Deploy - cron jobs will be automatically configured

## Monitoring

Use the Admin panel to:
- Monitor API call counts and errors
- View system health and last operation times
- Manually trigger discovery and polling
- Check sports configuration and thresholds

## License

This project is for educational and research purposes. Please ensure compliance with local gambling laws and regulations.