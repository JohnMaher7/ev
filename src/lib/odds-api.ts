import { config } from './config';

export interface OddsApiSport {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
}

export interface OddsApiEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: OddsApiBookmaker[];
}

export interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsApiMarket[];
}

export interface OddsApiMarket {
  key: string;
  last_update: string;
  outcomes: OddsApiOutcome[];
}

export interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}

export interface OddsApiResponse {
  success: boolean;
  data?: OddsApiEvent[];
  error?: string;
}

export class OddsApiClient {
  private baseUrl = 'https://api.the-odds-api.com/v4';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async makeRequest<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    
    // Add API key
    url.searchParams.set('apiKey', this.apiKey);
    
    // Add other parameters
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString());
    
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get all available sports
   */
  async getSports(): Promise<OddsApiSport[]> {
    return this.makeRequest<OddsApiSport[]>('/sports');
  }

  /**
   * Get odds for a specific sport
   */
  async getOdds(
    sport: string,
    regions: string = 'uk',
    markets: string = 'h2h,totals',
    oddsFormat: string = 'decimal',
    dateFormat: string = 'iso',
    bookmakers?: string
  ): Promise<OddsApiEvent[]> {
    const params: Record<string, string> = {
      regions,
      markets,
      oddsFormat,
      dateFormat,
    };

    if (bookmakers) {
      params.bookmakers = bookmakers;
    }

    return this.makeRequest<OddsApiEvent[]>(`/sports/${sport}/odds`, params);
  }

  /**
   * Get odds for any sport with ALL available bookmakers
   * Use this generic method instead of sport-specific wrappers
   * 
   * Professional Strategy: Request all available bookmakers to maximize consensus accuracy.
   * We only bet on exchanges, but use all books for fair value calculation.
   * API cost is per-request, not per-bookmaker, so no penalty for getting all data.
   * 
   * @param sport - Sport key from The Odds API (e.g., 'tennis_atp_us_open', 'soccer_efl_champ', 'darts_pdc_world_champs')
   * @param regions - Region code, defaults to 'uk'
   * @param markets - Market types, defaults to 'h2h,totals'
   */
  async getOddsWithAllowlist(sport: string, regions: string = 'uk', markets: string = 'h2h,totals'): Promise<OddsApiEvent[]> {
    // Don't pass bookmakers parameter - get ALL available bookmakers for maximum consensus data
    return this.getOdds(sport, regions, markets, 'decimal', 'iso');
  }

  /**
   * Check API usage and limits
   */
  async getUsage(): Promise<{
    requests_used: number;
    requests_remaining: number;
  }> {
    return this.makeRequest<{
      requests_used: number;
      requests_remaining: number;
    }>('/usage');
  }
}

// Singleton instance - only create if API key is configured
export const oddsApiClient = config.oddsApiKey && config.oddsApiKey.length > 0
  ? new OddsApiClient(config.oddsApiKey)
  : null;

/**
 * Convert Odds API response to our internal format
 */
export function convertOddsApiToSnapshots(events: OddsApiEvent[]): Array<{
  event_id: string;
  taken_at: string;
  market_key: string;
  bookmaker: string;
  is_exchange: boolean;
  selection: string;
  decimal_odds: number;
  point?: number;
  raw: unknown;
}> {
  const snapshots: Array<{
    event_id: string;
    taken_at: string;
    market_key: string;
    bookmaker: string;
    is_exchange: boolean;
    selection: string;
    decimal_odds: number;
    point?: number;
    raw: unknown;
  }> = [];

  const now = new Date().toISOString();

  for (const event of events) {
    if (!event.bookmakers) continue;

    for (const bookmaker of event.bookmakers) {
      // Identify exchanges vs sportsbooks
      // Exchanges have commission-based models and better liquidity
      const isExchange = ['betfair', 'betfair_ex_uk', 'smarkets', 'matchbook'].includes(bookmaker.key);

      for (const market of bookmaker.markets) {
        for (const outcome of market.outcomes) {
          snapshots.push({
            event_id: event.id,
            taken_at: now,
            market_key: market.key,
            bookmaker: bookmaker.key,
            is_exchange: isExchange,
            selection: outcome.name,
            decimal_odds: outcome.price,
            point: outcome.point, // Capture the line value from The Odds API
            raw: {
              event,
              bookmaker,
              market,
              outcome,
            },
          });
        }
      }
    }
  }

  return snapshots;
}

/**
 * Convert Odds API events to our events format
 */
export function convertOddsApiToEvents(events: OddsApiEvent[]): Array<{
  event_id: string;
  sport_key: string;
  commence_time: string;
  home: string;
  away: string;
  status: string;
}> {
  return events.map(event => ({
    event_id: event.id,
    sport_key: event.sport_key,
    commence_time: event.commence_time,
    home: event.home_team,
    away: event.away_team,
    status: 'upcoming',
  }));
}
